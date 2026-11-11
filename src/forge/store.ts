// The forge's storage on Supabase Postgres (`forge` schema): repositories, refs and zlib-compressed git objects.

import type { SQL } from "bun";
import { deflateSync, inflateSync } from "node:zlib";
import {
  decodeCommit,
  decodeTree,
  EMPTY_TREE_OID,
  encodeCommit,
  encodeTree,
  entryType,
  hashObject,
  isTreeMode,
  type Commit,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from "./objects.ts";

export interface RepoRecord {
  readonly org: string;
  readonly id: string;
  readonly defaultBranch: string;
  readonly baseRepo: { provider: string; owner: string; name: string } | null;
  readonly createdAt: string;
}

export interface RefRecord {
  readonly name: string;
  readonly oid: string;
  readonly createdAt: string;
}

export class NotFound extends Error {
  readonly status = 404;
}

export class Conflict extends Error {
  readonly status = 409;
}

export class BadRequest extends Error {
  readonly status = 400;
}

const BATCH = 500;

type Executor = Pick<SQL, "unsafe">;

function toRepo(row: Record<string, unknown>): RepoRecord {
  return {
    org: row.org as string,
    id: row.id as string,
    defaultBranch: row.default_branch as string,
    baseRepo: (row.base_repo as RepoRecord["baseRepo"]) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

/** Objects of one organization, with a cache: objects never change once written. */
export class ObjectStore {
  private readonly cache = new Map<string, GitObject>();
  /** Objects written in this request but maybe not flushed yet. */
  private readonly pending = new Map<string, GitObject>();

  constructor(
    private readonly sql: Executor,
    readonly org: string,
  ) {}

  /** Reads several objects in a few round trips; missing ones are absent from the result. */
  async readMany(oids: Iterable<string>): Promise<Map<string, GitObject>> {
    const found = new Map<string, GitObject>();
    const missing: string[] = [];
    for (const oid of new Set(oids)) {
      const known = this.cache.get(oid) ?? this.pending.get(oid);
      if (known) found.set(oid, known);
      else missing.push(oid);
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const rows = await this.sql.unsafe(
        `SELECT oid, type, data FROM forge.objects WHERE org = $1 AND oid = ANY(string_to_array($2, ','))`,
        [this.org, chunk.join(",")],
      );
      for (const row of rows) {
        const object = {
          type: row.type as ObjectType,
          data: new Uint8Array(inflateSync(row.data)),
        };
        this.cache.set(row.oid, object);
        found.set(row.oid, object);
      }
    }
    return found;
  }

  async read(oid: string): Promise<GitObject | undefined> {
    return (await this.readMany([oid])).get(oid);
  }

  async readType<T extends ObjectType>(
    oid: string,
    type: T,
  ): Promise<Uint8Array> {
    const object = await this.read(oid);
    if (object === undefined) throw new NotFound(`Object ${oid} not found`);
    if (object.type !== type)
      throw new BadRequest(`Object ${oid} is a ${object.type}, not a ${type}`);
    return object.data;
  }

  async exists(oids: Iterable<string>): Promise<Set<string>> {
    const present = new Set<string>();
    const unknown: string[] = [];
    for (const oid of new Set(oids)) {
      if (this.cache.has(oid) || this.pending.has(oid)) present.add(oid);
      else unknown.push(oid);
    }
    for (let i = 0; i < unknown.length; i += BATCH) {
      const rows = await this.sql.unsafe(
        `SELECT oid FROM forge.objects WHERE org = $1 AND oid = ANY(string_to_array($2, ','))`,
        [this.org, unknown.slice(i, i + BATCH).join(",")],
      );
      for (const row of rows) present.add(row.oid);
    }
    return present;
  }

  /** Stages an object for `flush()` and returns its ID. */
  write(type: ObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (!this.cache.has(oid)) this.pending.set(oid, { type, data });
    return oid;
  }

  /** Writes the staged objects, skipping those already stored. */
  async flush(sql: Executor = this.sql): Promise<number> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    let bytes = 0;
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const params: unknown[] = [];
      const values = chunk.map(([oid, object], index) => {
        const data = deflateSync(object.data);
        bytes += data.length;
        params.push(this.org, oid, object.type, object.data.byteLength, data);
        const base = index * 5;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      });
      await sql.unsafe(
        `INSERT INTO forge.objects (org, oid, type, size, data) VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`,
        params,
      );
      for (const [oid, object] of chunk) this.cache.set(oid, object);
    }
    return bytes;
  }

  // -- Typed reads ---------------------------------------------------------------------------------------------

  async commit(oid: string): Promise<Commit> {
    return decodeCommit(await this.readType(oid, "commit"));
  }

  async tree(oid: string): Promise<TreeEntry[]> {
    if (oid === EMPTY_TREE_OID) return [];
    return decodeTree(await this.readType(oid, "tree"));
  }

  /** Peels a tag (or a chain of them) to the object it points at. */
  async peel(oid: string): Promise<{ oid: string; type: ObjectType }> {
    let current = oid;
    for (let depth = 0; depth < 10; depth++) {
      const object = await this.read(current);
      if (object === undefined)
        throw new NotFound(`Object ${current} not found`);
      if (object.type !== "tag") return { oid: current, type: object.type };
      current = /^object ([0-9a-f]{40})/.exec(
        new TextDecoder().decode(object.data),
      )![1]!;
    }
    throw new BadRequest("Tag chain too deep");
  }

  /** Every file below `treeOid`, path → entry, recursively. */
  async flatten(
    treeOid: string,
    prefix = "",
    into = new Map<string, TreeEntry>(),
  ): Promise<Map<string, TreeEntry>> {
    let level: { prefix: string; oid: string }[] = [{ prefix, oid: treeOid }];
    while (level.length > 0) {
      const objects = await this.readMany(
        level.map((t) => t.oid).filter((oid) => oid !== EMPTY_TREE_OID),
      );
      const next: { prefix: string; oid: string }[] = [];
      for (const { prefix: base, oid } of level) {
        if (oid === EMPTY_TREE_OID) continue;
        const object = objects.get(oid);
        if (object === undefined) throw new NotFound(`Tree ${oid} not found`);
        for (const entry of decodeTree(object.data)) {
          const path = base ? `${base}/${entry.name}` : entry.name;
          if (isTreeMode(entry.mode))
            next.push({ prefix: path, oid: entry.oid });
          else into.set(path, { ...entry, name: path });
        }
      }
      level = next;
    }
    return into;
  }

  /** The entry at `path` in `treeOid` (a tree for a directory), or undefined. */
  async entryAt(treeOid: string, path: string): Promise<TreeEntry | undefined> {
    const parts = path.split("/").filter(Boolean);
    let current: TreeEntry = { mode: "40000", name: "", oid: treeOid };
    for (const part of parts) {
      if (!isTreeMode(current.mode)) return undefined;
      const entry = (await this.tree(current.oid)).find((e) => e.name === part);
      if (entry === undefined) return undefined;
      current = entry;
    }
    return current;
  }

  /**
   * Writes a new tree: `base` with `changes` applied, path → blob entry to upsert, or null to delete. Empty
   * directories disappear, as in git. Returns the root tree's ID.
   */
  async applyChanges(
    baseTree: string | undefined,
    changes: Map<string, { mode: string; oid: string } | null>,
  ) {
    type Dir = {
      entries: Map<string, TreeEntry>;
      dirs: Map<string, Dir>;
      oid?: string;
      loaded: boolean;
    };
    const load = async (dir: Dir) => {
      if (dir.loaded) return;
      dir.loaded = true;
      if (dir.oid === undefined) return;
      for (const entry of await this.tree(dir.oid)) {
        if (isTreeMode(entry.mode))
          dir.dirs.set(entry.name, {
            entries: new Map(),
            dirs: new Map(),
            oid: entry.oid,
            loaded: false,
          });
        else dir.entries.set(entry.name, entry);
      }
    };
    const root: Dir = {
      entries: new Map(),
      dirs: new Map(),
      oid: baseTree,
      loaded: false,
    };
    const touched = new Set<Dir>();
    for (const [path, change] of changes) {
      const parts = path.split("/");
      const name = parts.pop()!;
      // Walk down to the parent directory, creating it for an upsert; a deletion of a missing path does nothing.
      const chain: Dir[] = [root];
      await load(root);
      let missing = false;
      for (const part of parts) {
        const parent = chain[chain.length - 1]!;
        let child = parent.dirs.get(part);
        if (child === undefined) {
          if (change === null) {
            missing = true;
            break;
          }
          parent.entries.delete(part); // a file becomes a directory
          child = { entries: new Map(), dirs: new Map(), loaded: true };
          parent.dirs.set(part, child);
        }
        await load(child);
        chain.push(child);
      }
      if (missing) continue;
      for (const dir of chain) touched.add(dir);
      const dir = chain[chain.length - 1]!;
      if (change === null) {
        dir.entries.delete(name);
        dir.dirs.delete(name);
      } else {
        dir.dirs.delete(name); // a directory becomes a file
        dir.entries.set(name, { mode: change.mode, name, oid: change.oid });
      }
    }
    const write = (dir: Dir): string | undefined => {
      if (!touched.has(dir)) return dir.oid;
      const entries: TreeEntry[] = [...dir.entries.values()];
      for (const [name, child] of dir.dirs) {
        const oid = write(child);
        if (oid !== undefined && oid !== EMPTY_TREE_OID)
          entries.push({ mode: "40000", name, oid });
      }
      return entries.length === 0
        ? EMPTY_TREE_OID
        : this.write("tree", encodeTree(entries));
    };
    const oid = write(root) ?? EMPTY_TREE_OID;
    if (oid === EMPTY_TREE_OID) this.write("tree", encodeTree([]));
    return oid;
  }

  writeCommit(commit: Commit): string {
    return this.write("commit", encodeCommit(commit));
  }

  /** Commits reachable from `heads`, newest first by committer date, parents after children. */
  async *walk(
    heads: readonly string[],
    stopAt: ReadonlySet<string> = new Set(),
  ) {
    const seen = new Set<string>(stopAt);
    const queue: { oid: string; commit: Commit }[] = [];
    const push = async (oids: string[]) => {
      const fresh = oids.filter((oid) => !seen.has(oid));
      for (const oid of fresh) seen.add(oid);
      const objects = await this.readMany(fresh);
      for (const oid of fresh) {
        const object = objects.get(oid);
        if (object?.type === "commit")
          queue.push({ oid, commit: decodeCommit(object.data) });
      }
      queue.sort(
        (a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp,
      );
    };
    await push([...heads]);
    while (queue.length > 0) {
      const next = queue.shift()!;
      yield next;
      await push([...next.commit.parents]);
    }
  }

  /** The best common ancestor of two commits, or undefined for unrelated histories. */
  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const ancestorsOfA = new Set<string>();
    for await (const { oid } of this.walk([a])) ancestorsOfA.add(oid);
    for await (const { oid } of this.walk([b]))
      if (ancestorsOfA.has(oid)) return oid;
    return undefined;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    for await (const { oid } of this.walk([descendant]))
      if (oid === ancestor) return true;
    return false;
  }
}

export { entryType };

// ---------------------------------------------------------------------------------------------------------------
// Repositories and refs

export class RepoStore {
  constructor(private readonly sql: SQL) {}

  async orgKeys(org: string): Promise<string[] | undefined> {
    const [row] = await this
      .sql`SELECT public_keys FROM forge.orgs WHERE name = ${org}`;
    if (row === undefined) return undefined;
    // Bun returns text[] as an array.
    return row.public_keys as string[];
  }

  async createOrg(name: string, publicKey: string) {
    await this.sql.unsafe(
      `INSERT INTO forge.orgs (name, public_keys) VALUES ($1, ARRAY[$2])
        ON CONFLICT (name) DO UPDATE SET public_keys = forge.orgs.public_keys || ARRAY[$2]`,
      [name, publicKey],
    );
  }

  async repo(org: string, id: string): Promise<RepoRecord | undefined> {
    const [row] = await this
      .sql`SELECT * FROM forge.repos WHERE org = ${org} AND id = ${id}`;
    return row === undefined ? undefined : toRepo(row);
  }

  async requireRepo(org: string, id: string): Promise<RepoRecord> {
    const repo = await this.repo(org, id);
    if (repo === undefined) throw new NotFound("Repository not found");
    return repo;
  }

  async createRepo(
    org: string,
    id: string,
    defaultBranch: string,
    baseRepo: RepoRecord["baseRepo"],
  ) {
    const rows = await this.sql`
      INSERT INTO forge.repos (org, id, default_branch, base_repo)
      VALUES (${org}, ${id}, ${defaultBranch}, ${baseRepo === null ? null : JSON.stringify(baseRepo)}::jsonb)
      ON CONFLICT DO NOTHING RETURNING *`;
    if (rows.length === 0) throw new Conflict("Repository already exists");
    return toRepo(rows[0]);
  }

  async deleteRepo(org: string, id: string) {
    const rows = await this
      .sql`DELETE FROM forge.repos WHERE org = ${org} AND id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async listRepos(
    org: string,
    options: { q?: string; limit: number; cursor?: string },
  ) {
    const offset = Number(options.cursor ?? 0) || 0;
    const rows = await this.sql.unsafe(
      `SELECT * FROM forge.repos WHERE org = $1 AND ($2::text IS NULL OR id ILIKE '%' || $2 || '%')
        ORDER BY created_at DESC, id OFFSET $3 LIMIT $4`,
      [org, options.q ?? null, offset, options.limit + 1],
    );
    return {
      repos: rows.slice(0, options.limit).map(toRepo),
      next:
        rows.length > options.limit
          ? String(offset + options.limit)
          : undefined,
    };
  }

  async refs(
    org: string,
    repo: string,
    ephemeral: boolean,
    prefix = "refs/",
  ): Promise<RefRecord[]> {
    const rows = await this.sql`
      SELECT name, oid, created_at FROM forge.refs
      WHERE org = ${org} AND repo = ${repo} AND ephemeral = ${ephemeral} AND starts_with(name, ${prefix})
      ORDER BY name`;
    return rows.map((r: Record<string, unknown>) => ({
      name: r.name as string,
      oid: r.oid as string,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }

  async ref(
    org: string,
    repo: string,
    ephemeral: boolean,
    name: string,
  ): Promise<string | undefined> {
    const [row] = await this.sql`
      SELECT oid FROM forge.refs WHERE org = ${org} AND repo = ${repo} AND ephemeral = ${ephemeral} AND name = ${name}`;
    return row?.oid;
  }

  /**
   * Moves a ref from `oldOid` (undefined: must not exist) to `newOid` (undefined: delete), atomically. Returns
   * false when the ref was not at `oldOid`.
   */
  async updateRef(
    tx: Executor,
    org: string,
    repo: string,
    ephemeral: boolean,
    name: string,
    oldOid: string | undefined,
    newOid: string | undefined,
  ): Promise<boolean> {
    if (newOid === undefined) {
      const rows = await tx.unsafe(
        `DELETE FROM forge.refs WHERE org = $1 AND repo = $2 AND ephemeral = $3 AND name = $4 AND ($5::text IS NULL OR oid = $5) RETURNING name`,
        [org, repo, ephemeral, name, oldOid ?? null],
      );
      return rows.length > 0;
    }
    if (oldOid === undefined) {
      const rows = await tx.unsafe(
        `INSERT INTO forge.refs (org, repo, ephemeral, name, oid) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING name`,
        [org, repo, ephemeral, name, newOid],
      );
      return rows.length > 0;
    }
    const rows = await tx.unsafe(
      `UPDATE forge.refs SET oid = $6, updated_at = now() WHERE org = $1 AND repo = $2 AND ephemeral = $3 AND name = $4 AND oid = $5 RETURNING name`,
      [org, repo, ephemeral, name, oldOid, newOid],
    );
    return rows.length > 0;
  }

  /** Copies every non-ephemeral ref of a repository to a fork (objects are shared by the organization). */
  async copyRefs(
    org: string,
    from: string,
    to: string,
    only?: { name: string; oid: string },
  ) {
    if (only) {
      await this
        .sql`INSERT INTO forge.refs (org, repo, name, oid) VALUES (${org}, ${to}, ${only.name}, ${only.oid})`;
      return;
    }
    await this.sql`
      INSERT INTO forge.refs (org, repo, ephemeral, name, oid)
      SELECT org, ${to}, false, name, oid FROM forge.refs WHERE org = ${org} AND repo = ${from} AND ephemeral = false`;
  }
}

/** A blob's content type by extension, for raw file responses. */
export function contentTypeOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
  };
  return types[ext] ?? "application/octet-stream";
}

export const typeOfEntry = (entry: TreeEntry) => entryType(entry.mode);
