// The forge's REST API, compatible with code.storage's v1 API: the `@pierre/storage` SDK works against it as is,
// with `apiBaseUrl` set to the forge. The token's `repo` claim names the repository every call is about.

import type { SQL } from "bun";
import { tarGz } from "./archive.ts";
import { requireScope, verifyToken, type Claims, type Scope } from "./auth.ts";
import { blame } from "./blame.ts";
import { diffTrees } from "./diff.ts";
import { mergeTrees } from "./merge.ts";
import {
  EMPTY_TREE_OID,
  encodeCommit,
  entryType,
  isOid,
  isTreeMode,
  messageOf,
  signatureDate,
  signatureNow,
  ZERO_OID,
  type Commit,
} from "./objects.ts";
import {
  BadRequest,
  Conflict,
  contentTypeOf,
  NotFound,
  ObjectStore,
  RepoStore,
  type RepoRecord,
} from "./store.ts";

export interface ApiContext {
  readonly sql: SQL;
  readonly repos: RepoStore;
  /** The public URL of git remotes, like https://host/forge/git, for `repo.url`. */
  readonly gitBaseUrl: string;
}

type Handler = (call: Call) => Promise<Response>;

interface Call {
  readonly request: Request;
  readonly url: URL;
  readonly ctx: ApiContext;
  readonly claims: Claims;
  readonly store: ObjectStore;
  body(): Promise<Record<string, unknown>>;
}

export const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";
const NOTES = "refs/notes/commits";

const bool = (value: unknown) => value === true || value === "true";
const str = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const limitOf = (url: URL, fallback = 100, max = 1000) =>
  Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? fallback) || fallback, 1),
    max,
  );

function signatureOf(value: unknown, fallback?: Commit["author"]) {
  const v = value as { name?: unknown; email?: unknown } | undefined;
  const name = str(v?.name);
  const email = str(v?.email);
  if (name && email) return signatureNow(name, email);
  if (fallback) return fallback;
  throw new BadRequest("author name and email are required");
}

function commitInfo(oid: string, commit: Commit) {
  return {
    sha: oid,
    parent_shas: [...commit.parents],
    message: messageOf(commit),
    author_name: commit.author.name,
    author_email: commit.author.email,
    committer_name: commit.committer.name,
    committer_email: commit.committer.email,
    date: signatureDate(commit.author),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Refs

async function repoOf(call: Call): Promise<RepoRecord> {
  return call.ctx.repos.requireRepo(call.claims.org, call.claims.repo);
}

/** Resolves a branch, tag, full ref or commit SHA to a commit. Without `ref`, the default branch. */
async function resolve(
  call: Call,
  ref: string | undefined,
  ephemeral = false,
): Promise<{ oid: string; ref: string }> {
  const repo = await repoOf(call);
  const { org, repo: id } = call.claims;
  const name = ref ?? repo.defaultBranch;
  const candidates = name.startsWith("refs/")
    ? [name]
    : [`${HEADS}${name}`, `${TAGS}${name}`];
  for (const candidate of candidates) {
    const oid = await call.ctx.repos.ref(org, id, ephemeral, candidate);
    if (oid !== undefined)
      return { oid: (await call.store.peel(oid)).oid, ref: name };
  }
  // An ephemeral read falls back to the regular namespace, where its base usually lives.
  if (ephemeral) {
    for (const candidate of candidates) {
      const oid = await call.ctx.repos.ref(org, id, false, candidate);
      if (oid !== undefined)
        return { oid: (await call.store.peel(oid)).oid, ref: name };
    }
  }
  if (isOid(name) && (await call.store.read(name))?.type === "commit")
    return { oid: name, ref: name };
  if (/^[0-9a-f]{4,39}$/.test(name)) {
    const rows = await call.ctx.sql`
      SELECT oid FROM forge.objects WHERE org = ${org} AND type = 'commit' AND starts_with(oid, ${name}) LIMIT 2`;
    if (rows.length === 1) return { oid: rows[0].oid, ref: name };
  }
  throw new NotFound(`Ref ${name} not found`);
}

/** The tree of a ref, or the empty tree for a repository without commits yet (only when `ref` is omitted). */
async function treeAt(call: Call, ref: string | undefined, ephemeral: boolean) {
  try {
    const resolved = await resolve(call, ref, ephemeral);
    return { ...resolved, tree: (await call.store.commit(resolved.oid)).tree };
  } catch (error) {
    if (error instanceof NotFound && ref === undefined) {
      return {
        oid: "",
        ref: (await repoOf(call)).defaultBranch,
        tree: EMPTY_TREE_OID,
      };
    }
    throw error;
  }
}

interface RefUpdateResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Commits a new tree onto a branch: the branch's head, or `baseBranch`'s for a new branch, is the parent. Checks
 * `expectedHeadSha`, then moves the ref with compare-and-swap.
 */
async function commitToBranch(
  call: Call,
  options: {
    targetBranch: string;
    ephemeral: boolean;
    baseBranch?: string;
    ephemeralBase?: boolean;
    expectedHeadSha?: string;
    message: string;
    author: Commit["author"];
    committer?: Commit["committer"];
    /** The new tree from the parent's tree (undefined for an orphan). */
    tree: (
      parentTree: string | undefined,
      parent: string | undefined,
    ) => Promise<string>;
    /** Extra parents after the first, for merges. */
    extraParents?: string[];
    /** Skip the commit when the tree does not change. */
    allowEmpty?: boolean;
    ack: (commit: {
      commit_sha: string;
      tree_sha: string;
      target_branch: string;
      pack_bytes: number;
    }) => Record<string, unknown>;
  },
): Promise<RefUpdateResult> {
  const { org, repo } = call.claims;
  await repoOf(call);
  if (options.targetBranch.startsWith("refs/"))
    throw new BadRequest("targetBranch must not include refs/");
  const refName = `${HEADS}${options.targetBranch}`;
  // Without an expected head, a commit lands on whatever the head is: a concurrent commit makes it retry on top.
  const attempts = options.expectedHeadSha ? 1 : 8;
  let current: string | undefined;
  const failure = (
    status: string,
    message: string,
    http = 409,
  ): RefUpdateResult => ({
    status: http,
    body: {
      commit: null,
      result: {
        branch: options.targetBranch,
        old_sha: current ?? ZERO_OID,
        new_sha: current ?? ZERO_OID,
        success: false,
        status,
        message,
      },
    },
  });
  for (let attempt = 0; attempt < attempts; attempt++) {
    current = await call.ctx.repos.ref(org, repo, options.ephemeral, refName);
    if (
      options.expectedHeadSha &&
      options.expectedHeadSha !== (current ?? ZERO_OID)
    ) {
      return failure(
        "precondition_failed",
        `Branch ${options.targetBranch} is at ${current ?? "nothing"}, not ${options.expectedHeadSha}`,
      );
    }
    let parent = current;
    if (parent === undefined && options.baseBranch) {
      parent = (
        await resolve(call, options.baseBranch, options.ephemeralBase ?? false)
      ).oid;
    }
    const parentTree =
      parent === undefined ? undefined : (await call.store.commit(parent)).tree;
    const tree = await options.tree(parentTree, parent);
    const commitOid = call.store.writeCommit({
      tree,
      parents: [...(parent ? [parent] : []), ...(options.extraParents ?? [])],
      author: options.author,
      committer: options.committer ?? options.author,
      message: options.message,
    });
    const packBytes = await call.store.flush();
    const moved = await call.ctx.repos.updateRef(
      call.ctx.sql,
      org,
      repo,
      options.ephemeral,
      refName,
      current,
      commitOid,
    );
    if (!moved) continue;
    return {
      status: 200,
      body: {
        ...options.ack({
          commit_sha: commitOid,
          tree_sha: tree,
          target_branch: options.targetBranch,
          pack_bytes: packBytes,
        }),
        result: {
          branch: options.targetBranch,
          old_sha: current ?? ZERO_OID,
          new_sha: commitOid,
          success: true,
          status: "ok",
        },
      },
    };
  }
  return failure(
    "conflict",
    `Branch ${options.targetBranch} kept moving during the commit; retry`,
  );
}

/** The NDJSON body of commit-pack and diff-commit: a metadata line, then base64 chunks. */
async function readNdjson(request: Request) {
  const text = await request.text();
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new BadRequest("Empty request body");
  const metadata = JSON.parse(lines[0]!).metadata as
    Record<string, unknown> | undefined;
  if (!metadata) throw new BadRequest("The first line must hold the metadata");
  const blobs = new Map<string, Uint8Array[]>();
  const diff: Uint8Array[] = [];
  for (const line of lines.slice(1)) {
    const message = JSON.parse(line) as {
      blob_chunk?: { content_id: string; data: string };
      diff_chunk?: { data: string };
    };
    if (message.blob_chunk) {
      const chunks = blobs.get(message.blob_chunk.content_id) ?? [];
      chunks.push(Buffer.from(message.blob_chunk.data, "base64"));
      blobs.set(message.blob_chunk.content_id, chunks);
    } else if (message.diff_chunk) {
      diff.push(Buffer.from(message.diff_chunk.data, "base64"));
    }
  }
  return {
    metadata,
    blob: (id: string) => Buffer.concat(blobs.get(id) ?? []),
    blobCount: blobs.size,
    diff: Buffer.concat(diff).toString("utf8"),
  };
}

function validPath(path: string) {
  const clean = path.replace(/^\/+/, "");
  if (
    clean === "" ||
    clean
      .split("/")
      .some(
        (part) =>
          part === "" || part === "." || part === ".." || part === ".git",
      )
  ) {
    throw new BadRequest(`Invalid path: ${path}`);
  }
  return clean;
}

// ---------------------------------------------------------------------------------------------------------------
// Last commits of paths, for file metadata and headers

async function lastCommits(
  store: ObjectStore,
  head: string,
  paths: readonly string[],
  maxCommits = 1000,
) {
  const result = new Map<string, string>();
  let unresolved = [...paths];
  let previous: { oid: string; commit: Commit } | undefined;
  let steps = 0;
  for await (const item of store.walk([head])) {
    if (unresolved.length === 0 || steps++ >= maxCommits) break;
    const parentOid = item.commit.parents[0];
    const parentTree = parentOid
      ? (await store.commit(parentOid)).tree
      : undefined;
    const next: string[] = [];
    for (const path of unresolved) {
      const here = await store.entryAt(item.commit.tree, path);
      const there = parentTree
        ? await store.entryAt(parentTree, path)
        : undefined;
      if (here?.oid !== there?.oid) result.set(path, item.oid);
      else next.push(path);
    }
    unresolved = next;
    previous = item;
  }
  for (const path of unresolved) if (previous) result.set(path, previous.oid);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Endpoints

const routes: Record<string, { scope: Scope[]; handler: Handler }> = {};
const route = (
  method: string,
  path: string,
  scope: Scope[],
  handler: Handler,
) => {
  routes[`${method} ${path}`] = { scope, handler };
};

// -- Repositories ---------------------------------------------------------------------------------------------

route("POST", "repos", ["repo:write"], async (call) => {
  const body = await call.body();
  const { org, repo: id } = call.claims;
  const base = body.base_repo as Record<string, unknown> | undefined;
  let baseRepo: RepoRecord["baseRepo"] = null;
  let fork: { from: RepoRecord; sha?: string; ref?: string } | undefined;
  if (base) {
    if (base.provider !== "code") {
      return json(
        {
          error:
            "Syncing from external git providers is not supported by this forge",
        },
        501,
      );
    }
    const name = str(base.name);
    const token = str((base.auth as { token?: unknown } | undefined)?.token);
    if (!name || !token)
      throw new BadRequest("base_repo name and auth.token are required");
    const baseClaims = await verifyToken(call.ctx.repos, token);
    if (baseClaims.org !== org || baseClaims.repo !== name)
      throw new BadRequest("base_repo token is for another repository");
    requireScope(baseClaims, "git:read");
    fork = {
      from: await call.ctx.repos.requireRepo(org, name),
      sha: str(base.sha),
      ref: str(base.ref),
    };
    baseRepo = { provider: "code", owner: org, name };
  }
  const defaultBranch =
    str(body.default_branch) ?? fork?.ref ?? fork?.from.defaultBranch ?? "main";
  const repo = await call.ctx.repos.createRepo(
    org,
    id,
    defaultBranch,
    baseRepo,
  );
  if (fork) {
    if (fork.sha) {
      if ((await call.store.read(fork.sha))?.type !== "commit")
        throw new BadRequest(`Commit ${fork.sha} not found`);
      await call.ctx.repos.copyRefs(org, fork.from.id, id, {
        name: `${HEADS}${defaultBranch}`,
        oid: fork.sha,
      });
    } else if (fork.ref) {
      const oid = await call.ctx.repos.ref(
        org,
        fork.from.id,
        false,
        `${HEADS}${fork.ref}`,
      );
      if (oid === undefined)
        throw new NotFound(`Branch ${fork.ref} not found in ${fork.from.id}`);
      await call.ctx.repos.copyRefs(org, fork.from.id, id, {
        name: `${HEADS}${defaultBranch}`,
        oid,
      });
    } else {
      await call.ctx.repos.copyRefs(org, fork.from.id, id);
    }
  }
  return json(
    {
      repo_id: repo.id,
      url: `${call.ctx.gitBaseUrl}/${repo.id}.git`,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
    },
    201,
  );
});

route("GET", "repos", ["org:read"], async (call) => {
  const { repos, next } = await call.ctx.repos.listRepos(call.claims.org, {
    q: call.url.searchParams.get("q") ?? undefined,
    limit: limitOf(call.url, 20, 100),
    cursor: call.url.searchParams.get("cursor") ?? undefined,
  });
  return json({
    repos: repos.map((r: RepoRecord) => ({
      repo_id: r.id,
      url: `${call.ctx.gitBaseUrl}/${r.id}.git`,
      default_branch: r.defaultBranch,
      created_at: r.createdAt,
      base_repo: r.baseRepo,
    })),
    next_cursor: next ?? null,
    has_more: next !== undefined,
  });
});

route("GET", "repo", ["git:read"], async (call) => {
  const repo = await repoOf(call);
  return json({
    repo_id: repo.id,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    base_repo: repo.baseRepo,
  });
});

route("DELETE", "repos/delete", ["repo:write"], async (call) => {
  const deleted = await call.ctx.repos.deleteRepo(
    call.claims.org,
    call.claims.repo,
  );
  if (!deleted) throw new NotFound("Repository not found");
  return json({ repo_id: call.claims.repo, message: "Repository deleted" });
});

// -- Files ----------------------------------------------------------------------------------------------------

async function fileResponse(call: Call, head: boolean) {
  const params = call.url.searchParams;
  const path = validPath(params.get("path") ?? "");
  const ephemeral = bool(params.get("ephemeral"));
  const { oid: commitOid, tree } = await treeAt(
    call,
    params.get("ref") ?? undefined,
    ephemeral,
  );
  const entry = await call.store.entryAt(tree, path);
  if (entry === undefined || isTreeMode(entry.mode))
    throw new NotFound(`No file at ${path}`);
  const etag = `"${entry.oid}"`;
  const lastCommit = commitOid
    ? ((await lastCommits(call.store, commitOid, [path], 200)).get(path) ??
      commitOid)
    : "";
  const headers: Record<string, string> = {
    "content-type": contentTypeOf(path),
    etag,
    "x-blob-sha": entry.oid,
    "x-last-commit-sha": lastCommit,
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
  };
  if (call.request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  const ifMatch = call.request.headers.get("if-match");
  if (ifMatch && ifMatch !== etag && ifMatch !== "*")
    return new Response(null, { status: 412, headers });
  let data = (await call.store.read(entry.oid))!.data;
  const range = /^bytes=(\d*)-(\d*)$/.exec(
    call.request.headers.get("range") ?? "",
  );
  let status = 200;
  if (range) {
    const size = data.byteLength;
    const start =
      range[1] === "" ? Math.max(size - Number(range[2]), 0) : Number(range[1]);
    const end =
      range[1] === "" || range[2] === ""
        ? size - 1
        : Math.min(Number(range[2]), size - 1);
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${size}` },
      });
    }
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
    data = data.subarray(start, end + 1);
    status = 206;
  }
  headers["content-length"] = String(data.byteLength);
  return new Response(head ? null : (data as Uint8Array<ArrayBuffer>), {
    status,
    headers,
  });
}

route("GET", "repos/file", ["git:read"], (call) => fileResponse(call, false));
route("HEAD", "repos/file", ["git:read"], (call) => fileResponse(call, true));

/** The entries below `path` of a tree: all files when recursive, else the directory's own entries. */
async function listEntries(
  call: Call,
  tree: string,
  path: string,
  recursive: boolean,
) {
  const base = path.replace(/^\/+|\/+$/g, "");
  let dirOid = tree;
  if (base) {
    const dir = await call.store.entryAt(tree, base);
    if (dir === undefined || !isTreeMode(dir.mode))
      throw new NotFound(`No directory at ${base}`);
    dirOid = dir.oid;
  }
  if (recursive) {
    const files = await call.store.flatten(dirOid, base);
    return [...files.values()].map((e) => ({
      path: e.name,
      mode: e.mode,
      oid: e.oid,
    }));
  }
  return (await call.store.tree(dirOid)).map((e) => ({
    path: base ? `${base}/${e.name}` : e.name,
    mode: isTreeMode(e.mode) ? "040000" : e.mode,
    oid: e.oid,
  }));
}

function paginate<T>(items: T[], url: URL, fallback = 1000) {
  const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
  const limit = limitOf(url, fallback, 10000);
  const page = items.slice(offset, offset + limit);
  const more = offset + limit < items.length;
  return { page, next: more ? String(offset + limit) : null, more };
}

route("GET", "repos/files", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const { ref, tree } = await treeAt(
    call,
    params.get("ref") ?? undefined,
    bool(params.get("ephemeral")),
  );
  const recursive = params.get("recursive") !== "false";
  const entries = await listEntries(
    call,
    tree,
    params.get("path") ?? "",
    recursive,
  );
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const { page, next, more } = paginate(entries, call.url, 10000);
  return json({
    paths: page.filter((e) => entryType(e.mode) !== "tree").map((e) => e.path),
    ref,
    entries: page.map((e) => ({
      path: e.path,
      type: entryType(e.mode),
      mode: e.mode,
    })),
    next_cursor: next,
    has_more: more,
  });
});

route("GET", "repos/files/metadata", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const { oid, ref, tree } = await treeAt(
    call,
    params.get("ref") ?? undefined,
    bool(params.get("ephemeral")),
  );
  const recursive = params.get("recursive") !== "false";
  const entries = await listEntries(
    call,
    tree,
    params.get("path") ?? "",
    recursive,
  );
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const { page, next, more } = paginate(entries, call.url, 1000);
  const last = oid
    ? await lastCommits(
        call.store,
        oid,
        page.map((e) => e.path),
      )
    : new Map<string, string>();
  const sizes = new Map<string, number>();
  const blobOids = page
    .filter((e) => entryType(e.mode) === "blob")
    .map((e) => e.oid);
  for (let i = 0; i < blobOids.length; i += 500) {
    const rows = await call.ctx.sql.unsafe(
      `SELECT oid, size FROM forge.objects WHERE org = $1 AND oid = ANY(string_to_array($2, ','))`,
      [call.claims.org, blobOids.slice(i, i + 500).join(",")],
    );
    for (const row of rows) sizes.set(row.oid, Number(row.size));
  }
  const commits: Record<
    string,
    { author: string; date: string; message: string }
  > = {};
  for (const sha of new Set(last.values())) {
    const commit = await call.store.commit(sha);
    commits[sha] = {
      author: commit.author.name,
      date: signatureDate(commit.author),
      message: messageOf(commit),
    };
  }
  return json({
    files: page.map((e) => ({
      path: e.path,
      mode: e.mode,
      size: sizes.get(e.oid) ?? 0,
      last_commit_sha: last.get(e.path) ?? "",
      type: entryType(e.mode),
    })),
    commits,
    ref,
    next_cursor: next,
    has_more: more,
  });
});

route("POST", "repos/archive", ["git:read"], async (call) => {
  const body = await call.body();
  const { tree, oid } = await treeAt(call, str(body.ref), false);
  const include = (body.include_globs as string[] | undefined)?.map(
    (g) => new Bun.Glob(g),
  );
  const exclude = (body.exclude_globs as string[] | undefined)?.map(
    (g) => new Bun.Glob(g),
  );
  const maxBlob =
    typeof body.max_blob_size === "number" ? body.max_blob_size : Infinity;
  const prefix =
    str((body.archive as { prefix?: unknown } | undefined)?.prefix) ?? "";
  const files = [...(await call.store.flatten(tree)).values()].filter(
    (e) =>
      entryType(e.mode) !== "submodule" &&
      (!include || include.some((g) => g.match(e.name))) &&
      !exclude?.some((g) => g.match(e.name)),
  );
  const blobs = await call.store.readMany(files.map((f) => f.oid));
  const mtime = oid
    ? (await call.store.commit(oid)).committer.timestamp
    : Math.floor(Date.now() / 1000);
  const archive = tarGz(
    files
      .filter((f) => (blobs.get(f.oid)?.data.byteLength ?? 0) <= maxBlob)
      .map((f) => ({
        path: `${prefix}${prefix && !prefix.endsWith("/") ? "/" : ""}${f.name}`,
        mode: f.mode,
        data: blobs.get(f.oid)!.data,
      })),
    mtime,
  );
  return new Response(archive as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${call.claims.repo}.tar.gz"`,
    },
  });
});

// -- Branches and tags ----------------------------------------------------------------------------------------

route("GET", "repos/branches", ["git:read"], async (call) => {
  const refs = await call.ctx.repos.refs(
    call.claims.org,
    call.claims.repo,
    bool(call.url.searchParams.get("ephemeral")),
    HEADS,
  );
  const { page, next, more } = paginate(refs, call.url, 100);
  return json({
    branches: page.map((r, i) => ({
      cursor: String(Number(call.url.searchParams.get("cursor") ?? 0) + i + 1),
      name: r.name.slice(HEADS.length),
      head_sha: r.oid,
      created_at: r.createdAt,
    })),
    next_cursor: next,
    has_more: more,
  });
});

route("POST", "repos/branches/create", ["git:write"], async (call) => {
  const body = await call.body();
  const target = str(body.target_branch);
  if (!target || target.startsWith("refs/"))
    throw new BadRequest("target_branch is required, without refs/");
  const base = await resolve(
    call,
    str(body.base_ref) ?? str(body.base_branch),
    bool(body.base_is_ephemeral),
  );
  const ephemeral = bool(body.target_is_ephemeral);
  const created = await call.ctx.repos.updateRef(
    call.ctx.sql,
    call.claims.org,
    call.claims.repo,
    ephemeral,
    `${HEADS}${target}`,
    undefined,
    base.oid,
  );
  if (!created) throw new Conflict(`Branch ${target} already exists`);
  return json({
    message: `Branch ${target} created`,
    target_branch: target,
    target_is_ephemeral: ephemeral,
    commit_sha: base.oid,
  });
});

route("DELETE", "repos/branches", ["git:write"], async (call) => {
  const body = await call.body();
  const name = str(body.name);
  if (!name) throw new BadRequest("name is required");
  const ephemeral = bool(body.ephemeral);
  const repo = await repoOf(call);
  if (!ephemeral && name === repo.defaultBranch)
    throw new BadRequest("The default branch cannot be deleted");
  const deleted = await call.ctx.repos.updateRef(
    call.ctx.sql,
    call.claims.org,
    call.claims.repo,
    ephemeral,
    `${HEADS}${name}`,
    undefined,
    undefined,
  );
  if (!deleted) throw new NotFound(`Branch ${name} not found`);
  return json({ name, message: `Branch ${name} deleted`, ephemeral });
});

route("GET", "repos/tags", ["git:read"], async (call) => {
  const refs = await call.ctx.repos.refs(
    call.claims.org,
    call.claims.repo,
    false,
    TAGS,
  );
  const { page, next, more } = paginate(refs, call.url, 100);
  return json({
    tags: page.map((r, i) => ({
      cursor: String(Number(call.url.searchParams.get("cursor") ?? 0) + i + 1),
      name: r.name.slice(TAGS.length),
      sha: r.oid,
    })),
    next_cursor: next,
    has_more: more,
  });
});

route("POST", "repos/tags", ["git:write"], async (call) => {
  const body = await call.body();
  const name = str(body.name);
  if (!name || name.startsWith("refs/"))
    throw new BadRequest("name is required, without refs/");
  const target = await resolve(call, str(body.target));
  const created = await call.ctx.repos.updateRef(
    call.ctx.sql,
    call.claims.org,
    call.claims.repo,
    false,
    `${TAGS}${name}`,
    undefined,
    target.oid,
  );
  if (!created) throw new Conflict(`Tag ${name} already exists`);
  return json({ name, sha: target.oid, message: `Tag ${name} created` });
});

route("DELETE", "repos/tags", ["git:write"], async (call) => {
  const name = str((await call.body()).name);
  if (!name) throw new BadRequest("name is required");
  const deleted = await call.ctx.repos.updateRef(
    call.ctx.sql,
    call.claims.org,
    call.claims.repo,
    false,
    `${TAGS}${name}`,
    undefined,
    undefined,
  );
  if (!deleted) throw new NotFound(`Tag ${name} not found`);
  return json({ name, message: `Tag ${name} deleted` });
});

// -- History --------------------------------------------------------------------------------------------------

route("GET", "repos/commits", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const limit = limitOf(call.url, 20, 1000);
  const ephemeral = bool(params.get("ephemeral"));
  let start: string;
  try {
    start =
      params.get("cursor") ??
      (await resolve(call, params.get("branch") ?? undefined, ephemeral)).oid;
  } catch (error) {
    if (error instanceof NotFound && !params.get("branch"))
      return json({ commits: [], next_cursor: null, has_more: false });
    throw error;
  }
  const path = params.get("path")?.replace(/^\/+|\/+$/g, "");
  const commits: ReturnType<typeof commitInfo>[] = [];
  let next: string | null = null;
  let scanned = 0;
  for await (const { oid, commit } of call.store.walk([start])) {
    if (commits.length === limit) {
      next = oid;
      break;
    }
    if (path && scanned++ < 10000) {
      const parent = commit.parents[0]
        ? (await call.store.commit(commit.parents[0])).tree
        : undefined;
      const here = await call.store.entryAt(commit.tree, path);
      const there = parent ? await call.store.entryAt(parent, path) : undefined;
      if (here?.oid === there?.oid) continue;
    }
    commits.push(commitInfo(oid, commit));
  }
  return json({ commits, next_cursor: next, has_more: next !== null });
});

route("GET", "repos/commit", ["git:read"], async (call) => {
  const sha = (
    await resolve(call, call.url.searchParams.get("sha") ?? undefined)
  ).oid;
  const commit = await call.store.commit(sha);
  const signature = commit.extraHeaders?.find(([key]) => key === "gpgsig")?.[1];
  let payload: string | undefined;
  if (signature) {
    payload = new TextDecoder().decode(
      encodeCommit({
        ...commit,
        extraHeaders: commit.extraHeaders?.filter(([k]) => k !== "gpgsig"),
      }),
    );
  }
  return json({
    commit: {
      ...commitInfo(sha, commit),
      ...(signature ? { signature, payload } : {}),
    },
  });
});

route("GET", "repos/blame", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const path = validPath(params.get("path") ?? "");
  const { oid, ref } = await resolve(
    call,
    params.get("ref") ?? undefined,
    bool(params.get("ephemeral")),
  );
  let lines = await blame(call.store, oid, path);
  const ranges = params
    .getAll("range")
    .map((r) => r.split(/[-,:]/).map(Number) as [number, number]);
  if (ranges.length > 0)
    lines = lines.filter((l) =>
      ranges.some(([a, b]) => l.line_number >= a && l.line_number <= (b || a)),
    );
  return json({ ref, path, commit_sha: oid, lines });
});

// -- Diffs ----------------------------------------------------------------------------------------------------

route("GET", "repos/branches/diff", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const branch = params.get("branch");
  if (!branch) throw new BadRequest("branch is required");
  const repo = await repoOf(call);
  const baseName = params.get("base") ?? repo.defaultBranch;
  const head = await resolve(call, branch, bool(params.get("ephemeral")));
  const base = await resolve(
    call,
    baseName,
    bool(params.get("ephemeral_base")),
  );
  const mergeBase = await call.store.mergeBase(head.oid, base.oid);
  const fromTree = mergeBase
    ? (await call.store.commit(mergeBase)).tree
    : undefined;
  const diff = await diffTrees(
    call.store,
    fromTree,
    (await call.store.commit(head.oid)).tree,
    params.getAll("path"),
  );
  return json({
    branch,
    base: baseName,
    ...(mergeBase ? { merge_base_sha: mergeBase } : {}),
    ...diff,
  });
});

route("GET", "repos/diff", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const sha = (await resolve(call, params.get("sha") ?? undefined)).oid;
  const commit = await call.store.commit(sha);
  const baseSha = params.get("baseSha")
    ? (await resolve(call, params.get("baseSha")!)).oid
    : commit.parents[0];
  const fromTree = baseSha
    ? (await call.store.commit(baseSha)).tree
    : undefined;
  const diff = await diffTrees(
    call.store,
    fromTree,
    commit.tree,
    params.getAll("path"),
  );
  return json({ sha, ...(baseSha ? { base_sha: baseSha } : {}), ...diff });
});

// -- Writes ---------------------------------------------------------------------------------------------------

route("POST", "repos/commit-pack", ["git:write"], async (call) => {
  const { metadata, blob, blobCount } = await readNdjson(call.request);
  const files =
    (metadata.files as {
      path: string;
      content_id: string;
      operation?: string;
      mode?: string;
    }[]) ?? [];
  const author = signatureOf(metadata.author);
  const result = await commitToBranch(call, {
    targetBranch: str(metadata.target_branch) ?? "",
    ephemeral: bool(metadata.ephemeral),
    baseBranch: str(metadata.base_branch),
    ephemeralBase: bool(metadata.ephemeral_base),
    expectedHeadSha: str(metadata.expected_head_sha),
    message: str(metadata.commit_message) ?? "",
    author,
    committer: metadata.committer ? signatureOf(metadata.committer) : undefined,
    tree: async (parentTree) => {
      const changes = new Map<string, { mode: string; oid: string } | null>();
      for (const file of files) {
        const path = validPath(file.path);
        if (file.operation === "delete") changes.set(path, null);
        else
          changes.set(path, {
            mode: file.mode ?? "100644",
            oid: call.store.write("blob", blob(file.content_id)),
          });
      }
      return call.store.applyChanges(parentTree, changes);
    },
    ack: (commit) => ({ commit: { ...commit, blob_count: blobCount } }),
  });
  return json(result.body, result.status);
});

route("POST", "repos/diff-commit", ["git:write"], async (call) => {
  const { metadata, diff } = await readNdjson(call.request);
  const { parsePatch, applyPatch } = await import("diff");
  const result = await commitToBranch(call, {
    targetBranch: str(metadata.target_branch) ?? "",
    ephemeral: bool(metadata.ephemeral),
    baseBranch: str(metadata.base_branch),
    ephemeralBase: bool(metadata.ephemeral_base),
    expectedHeadSha: str(metadata.expected_head_sha),
    message: str(metadata.commit_message) ?? "",
    author: signatureOf(metadata.author),
    committer: metadata.committer ? signatureOf(metadata.committer) : undefined,
    tree: async (parentTree) => {
      const changes = new Map<string, { mode: string; oid: string } | null>();
      const strip = (name: string | undefined) =>
        name && name !== "/dev/null" ? name.replace(/^[ab]\//, "") : undefined;
      for (const patch of parsePatch(diff)) {
        const oldPath = strip(patch.oldFileName);
        const newPath = strip(patch.newFileName);
        const existing =
          oldPath && parentTree
            ? await call.store.entryAt(parentTree, oldPath)
            : undefined;
        const original = existing
          ? new TextDecoder().decode(
              (await call.store.read(existing.oid))!.data,
            )
          : "";
        if (!newPath) {
          if (!oldPath) continue;
          changes.set(validPath(oldPath), null);
          continue;
        }
        const patched = applyPatch(original, patch);
        if (patched === false)
          throw new Conflict(
            `The diff does not apply to ${oldPath ?? newPath}`,
          );
        if (oldPath && oldPath !== newPath)
          changes.set(validPath(oldPath), null);
        changes.set(validPath(newPath), {
          mode: existing?.mode ?? "100644",
          oid: call.store.write("blob", new TextEncoder().encode(patched)),
        });
      }
      return call.store.applyChanges(parentTree, changes);
    },
    ack: (commit) => ({ commit: { ...commit, blob_count: 0 } }),
  });
  return json(result.body, result.status);
});

route("POST", "repos/restore-commit", ["git:write"], async (call) => {
  const metadata = ((await call.body()).metadata ?? {}) as Record<
    string,
    unknown
  >;
  const targetSha = str(metadata.target_commit_sha);
  if (!targetSha) throw new BadRequest("target_commit_sha is required");
  const target = await resolve(call, targetSha);
  const targetCommit = await call.store.commit(target.oid);
  const result = await commitToBranch(call, {
    targetBranch: str(metadata.target_branch) ?? "",
    ephemeral: false,
    expectedHeadSha: str(metadata.expected_head_sha),
    message:
      str(metadata.commit_message) ?? `Restore ${target.oid.slice(0, 7)}`,
    author: signatureOf(metadata.author),
    committer: metadata.committer ? signatureOf(metadata.committer) : undefined,
    tree: async () => targetCommit.tree,
    ack: (commit) => ({ commit }),
  });
  return json(result.body, result.status);
});

// -- Merges ---------------------------------------------------------------------------------------------------

async function mergePlan(
  call: Call,
  source: string,
  target: string,
  sourceEphemeral: boolean,
  targetEphemeral: boolean,
) {
  const s = await resolve(call, source, sourceEphemeral);
  const t = await resolve(call, target, targetEphemeral);
  const base = await call.store.mergeBase(s.oid, t.oid);
  let result: "merge_commit" | "fast_forward" | "no_op" = "merge_commit";
  if (base === s.oid) result = "no_op";
  else if (base === t.oid) result = "fast_forward";
  const baseTree = base ? (await call.store.commit(base)).tree : undefined;
  const [sourceTree, targetTree] = [
    (await call.store.commit(s.oid)).tree,
    (await call.store.commit(t.oid)).tree,
  ];
  const merged =
    result === "merge_commit"
      ? await mergeTrees(call.store, baseTree, targetTree, sourceTree, {
          ours: target,
          theirs: source,
        })
      : { changes: new Map(), conflicts: [] };
  return { s, t, base, result, targetTree, sourceTree, ...merged };
}

route("GET", "repos/merge/preview", ["git:read"], async (call) => {
  const params = call.url.searchParams;
  const source = params.get("source_branch")!;
  const target = params.get("target_branch")!;
  const plan = await mergePlan(call, source, target, false, false);
  const withContent = bool(params.get("include_content"));
  const blobOf = async (entry?: { oid: string }, content?: string) => {
    if (!entry && content === undefined)
      return { truncated: false, binary: false };
    const data =
      content !== undefined
        ? new TextEncoder().encode(content)
        : (await call.store.read(entry!.oid))!.data;
    const binary = data.subarray(0, 8000).includes(0);
    return {
      ...(entry ? { oid: entry.oid } : {}),
      ...(withContent && !binary
        ? { content: new TextDecoder().decode(data.subarray(0, 256 * 1024)) }
        : {}),
      truncated: data.byteLength > 256 * 1024,
      binary,
    };
  };
  return json({
    status: plan.conflicts.length > 0 ? "conflicted" : "clean",
    result: plan.result,
    source_branch: source,
    target_branch: target,
    source_tip_sha: plan.s.oid,
    target_tip_sha: plan.t.oid,
    ...(plan.base ? { merge_base_sha: plan.base } : {}),
    conflict_paths: plan.conflicts.map((c) => c.path),
    conflicts: await Promise.all(
      plan.conflicts.map(async (c) => ({
        path: c.path,
        result: await blobOf(undefined, c.merged),
        base: await blobOf(c.base),
        ours: await blobOf(c.ours),
        theirs: await blobOf(c.theirs),
      })),
    ),
    filtered_conflicts: [],
  });
});

route("POST", "repos/merge", ["git:write"], async (call) => {
  const body = await call.body();
  const source = str(body.source_branch)!;
  const target = str(body.target_branch)!;
  const strategy = str(body.strategy) ?? "merge";
  const squash = bool(body.squash);
  const sourceEphemeral = bool(body.source_is_ephemeral);
  const targetEphemeral = bool(body.target_is_ephemeral);
  const plan = await mergePlan(
    call,
    source,
    target,
    sourceEphemeral,
    targetEphemeral,
  );
  if (
    !plan.base &&
    !bool(body.allow_unrelated_histories) &&
    plan.result === "merge_commit"
  ) {
    throw new Conflict("Refusing to merge unrelated histories");
  }
  if (body.expected_target_sha && body.expected_target_sha !== plan.t.oid) {
    throw new Conflict(
      `Branch ${target} is at ${plan.t.oid}, not ${body.expected_target_sha}`,
    );
  }
  const promoted = await (async () => {
    let count = 0;
    const exclude = new Set<string>();
    for await (const { oid } of call.store.walk([plan.t.oid])) exclude.add(oid);
    for await (const _ of call.store.walk([plan.s.oid], exclude)) count++;
    return count;
  })();
  const refName = `${HEADS}${target}`;
  const response = (resultKind: string, commitSha: string, treeSha: string) =>
    json({
      result: resultKind,
      commit_sha: commitSha,
      tree_sha: treeSha,
      source: { branch: source, ephemeral: sourceEphemeral, sha: plan.s.oid },
      target: {
        branch: target,
        ephemeral: targetEphemeral,
        old_sha: plan.t.oid,
        new_sha: commitSha,
      },
      ...(plan.base ? { merge_base_sha: plan.base } : {}),
      promoted_commits: resultKind === "no_op" ? 0 : promoted,
    });
  if (plan.result === "no_op")
    return response("no_op", plan.t.oid, plan.targetTree);
  const canFastForward = plan.result === "fast_forward";
  if (strategy === "ff_only" && !canFastForward)
    throw new Conflict(`${target} cannot fast-forward to ${source}`);
  if (canFastForward && !squash && strategy !== "merge") {
    const moved = await call.ctx.repos.updateRef(
      call.ctx.sql,
      call.claims.org,
      call.claims.repo,
      targetEphemeral,
      refName,
      plan.t.oid,
      plan.s.oid,
    );
    if (!moved)
      throw new Conflict(`Branch ${target} moved during the merge; retry`);
    return response("fast_forward", plan.s.oid, plan.sourceTree);
  }
  if (plan.conflicts.length > 0) {
    return json(
      {
        error: `Merge conflicts in ${plan.conflicts.map((c) => c.path).join(", ")}`,
      },
      409,
    );
  }
  const tree = canFastForward
    ? plan.sourceTree
    : await call.store.applyChanges(plan.targetTree, plan.changes);
  const author = signatureOf(
    body.author,
    signatureNow("Forge", "forge@localhost"),
  );
  const commitOid = call.store.writeCommit({
    tree,
    parents: squash ? [plan.t.oid] : [plan.t.oid, plan.s.oid],
    author,
    committer: body.committer ? signatureOf(body.committer) : author,
    message:
      str(body.commit_message) ??
      (squash
        ? `Squash ${source} into ${target}`
        : `Merge branch '${source}' into ${target}`),
  });
  await call.store.flush();
  const moved = await call.ctx.repos.updateRef(
    call.ctx.sql,
    call.claims.org,
    call.claims.repo,
    targetEphemeral,
    refName,
    plan.t.oid,
    commitOid,
  );
  if (!moved)
    throw new Conflict(`Branch ${target} moved during the merge; retry`);
  return response(squash ? "squash" : "merge_commit", commitOid, tree);
});

// -- Search ---------------------------------------------------------------------------------------------------

route("POST", "repos/grep", ["git:read"], async (call) => {
  const body = await call.body();
  const query = (body.query ?? {}) as {
    pattern?: string;
    case_sensitive?: boolean;
  };
  if (!query.pattern) throw new BadRequest("query.pattern is required");
  const caseSensitive = query.case_sensitive ?? true;
  let regex: RegExp;
  try {
    regex = new RegExp(query.pattern, caseSensitive ? "" : "i");
  } catch {
    throw new BadRequest("query.pattern is not a valid regular expression");
  }
  const { oid, ref, tree } = await treeAt(
    call,
    str(body.ref),
    bool(body.ephemeral),
  );
  const filters = (body.file_filters ?? {}) as {
    include_globs?: string[];
    exclude_globs?: string[];
    extension_filters?: string[];
  };
  const include = filters.include_globs?.map((g) => new Bun.Glob(g));
  const exclude = filters.exclude_globs?.map((g) => new Bun.Glob(g));
  const extensions = filters.extension_filters?.map((e) =>
    e.replace(/^\./, ""),
  );
  const scope = (body.paths as string[] | undefined) ?? [];
  const context = (body.context ?? {}) as { before?: number; after?: number };
  const limits = (body.limits ?? {}) as {
    max_lines?: number;
    max_matches_per_file?: number;
  };
  const pagination = (body.pagination ?? {}) as {
    cursor?: string;
    limit?: number;
  };
  const files = [...(await call.store.flatten(tree)).values()]
    .filter((e) => entryType(e.mode) === "blob")
    .filter(
      (e) =>
        scope.length === 0 ||
        scope.some(
          (p) => e.name === p || e.name.startsWith(`${p.replace(/\/$/, "")}/`),
        ),
    )
    .filter(
      (e) =>
        (!include || include.some((g) => g.match(e.name))) &&
        !exclude?.some((g) => g.match(e.name)),
    )
    .filter(
      (e) => !extensions || extensions.includes(e.name.split(".").pop() ?? ""),
    )
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const offset = Number(pagination.cursor ?? 0) || 0;
  const pageSize = pagination.limit ?? 100;
  const maxLines = limits.max_lines ?? 10000;
  const matches: {
    path: string;
    lines: { line_number: number; text: string; type: string }[];
  }[] = [];
  let lineTotal = 0;
  let index = offset;
  for (
    ;
    index < files.length && matches.length < pageSize && lineTotal < maxLines;
    index++
  ) {
    const entry = files[index]!;
    const data = (await call.store.read(entry.oid))!.data;
    if (data.subarray(0, 8000).includes(0)) continue;
    const lines = new TextDecoder().decode(data).split("\n");
    const hits: number[] = [];
    for (
      let i = 0;
      i < lines.length &&
      hits.length < (limits.max_matches_per_file ?? Infinity);
      i++
    )
      if (regex.test(lines[i]!)) hits.push(i);
    if (hits.length === 0) continue;
    const shown = new Map<number, string>();
    for (const hit of hits) {
      for (
        let i = Math.max(0, hit - (context.before ?? 0));
        i <= Math.min(lines.length - 1, hit + (context.after ?? 0));
        i++
      ) {
        if (!shown.has(i) || i === hit)
          shown.set(i, hits.includes(i) ? "match" : "context");
      }
    }
    const fileLines = [...shown.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, type]) => ({ line_number: i + 1, text: lines[i]!, type }));
    lineTotal += fileLines.length;
    matches.push({ path: entry.name, lines: fileLines });
  }
  const more = index < files.length;
  return json({
    query: { pattern: query.pattern, case_sensitive: caseSensitive },
    repo: { ref, commit: oid },
    matches,
    next_cursor: more ? String(index) : null,
    has_more: more,
  });
});

// -- Notes ----------------------------------------------------------------------------------------------------

async function notesState(call: Call, ref: string) {
  const head = await call.ctx.repos.ref(
    call.claims.org,
    call.claims.repo,
    false,
    ref,
  );
  const tree = head ? (await call.store.commit(head)).tree : undefined;
  return { head, tree };
}

async function readNote(call: Call, tree: string | undefined, sha: string) {
  if (!tree) return undefined;
  // Git's fan-out (ab/cdef…) or a flat name.
  const entry =
    (await call.store.entryAt(tree, sha)) ??
    (await call.store.entryAt(tree, `${sha.slice(0, 2)}/${sha.slice(2)}`));
  return entry
    ? new TextDecoder().decode((await call.store.read(entry.oid))!.data)
    : undefined;
}

route("GET", "repos/notes", ["git:read"], async (call) => {
  const sha = (
    await resolve(call, call.url.searchParams.get("sha") ?? undefined)
  ).oid;
  const ref = call.url.searchParams.get("ref") ?? NOTES;
  const { head, tree } = await notesState(call, ref);
  const note = await readNote(call, tree, sha);
  if (note === undefined) throw new NotFound(`No note for ${sha}`);
  return json({ sha, note: note.replace(/\n$/, ""), ref_sha: head });
});

async function writeNote(call: Call, method: "POST" | "DELETE") {
  const body = await call.body();
  const sha = (await resolve(call, str(body.sha))).oid;
  const ref = str(body.ref) ?? NOTES;
  const { head, tree } = await notesState(call, ref);
  const result = (
    status: number,
    success: boolean,
    statusLabel: string,
    message: string,
    newRef = head ?? ZERO_OID,
  ) =>
    json(
      {
        sha,
        target_ref: ref,
        ...(head ? { base_commit: head } : {}),
        new_ref_sha: newRef,
        result: { success, status: statusLabel, message },
      },
      status,
    );
  if (body.expected_ref_sha && body.expected_ref_sha !== (head ?? ZERO_OID)) {
    return result(
      409,
      false,
      "precondition_failed",
      `${ref} is at ${head ?? "nothing"}`,
    );
  }
  const existing = await readNote(call, tree, sha);
  let content: string | null;
  if (method === "DELETE") {
    if (existing === undefined)
      return result(404, false, "not_found", `No note for ${sha}`);
    content = null;
  } else if (body.action === "append" && existing !== undefined) {
    content = `${existing.replace(/\n$/, "")}\n\n${String(body.note)}\n`;
  } else {
    if (existing !== undefined && body.action !== "append")
      return result(409, false, "conflict", `A note already exists for ${sha}`);
    content = `${String(body.note)}\n`;
  }
  const changes = new Map<string, { mode: string; oid: string } | null>([
    [`${sha.slice(0, 2)}/${sha.slice(2)}`, null],
    [sha, null],
  ]);
  if (content !== null)
    changes.set(sha, {
      mode: "100644",
      oid: call.store.write("blob", new TextEncoder().encode(content)),
    });
  const newTree = await call.store.applyChanges(tree, changes);
  const author = signatureOf(
    body.author,
    signatureNow("Forge", "forge@localhost"),
  );
  const commit = call.store.writeCommit({
    tree: newTree,
    parents: head ? [head] : [],
    author,
    committer: author,
    message:
      method === "DELETE"
        ? `Notes removed by 'git notes remove'`
        : `Notes added by 'git notes ${body.action === "append" ? "append" : "add"}'`,
  });
  await call.store.flush();
  const moved = await call.ctx.repos.updateRef(
    call.ctx.sql,
    call.claims.org,
    call.claims.repo,
    false,
    ref,
    head,
    commit,
  );
  if (!moved) return result(409, false, "conflict", `${ref} moved; retry`);
  return result(200, true, "ok", "Note updated", commit);
}

route("POST", "repos/notes", ["git:write"], (call) => writeNote(call, "POST"));
route("DELETE", "repos/notes", ["git:write"], (call) =>
  writeNote(call, "DELETE"),
);

route("GET", "repos/notes/refs", ["git:read"], async (call) => {
  const prefix = call.url.searchParams.get("prefix") ?? "refs/notes/";
  const refs = await call.ctx.repos.refs(
    call.claims.org,
    call.claims.repo,
    false,
    prefix.startsWith("refs/") ? prefix : `refs/notes/${prefix}`,
  );
  const { page, next, more } = paginate(refs, call.url, 100);
  return json({
    refs: page.map((r, i) => ({
      cursor: String(i + 1),
      ref: r.name,
      sha: r.oid,
    })),
    next_cursor: next,
    has_more: more,
    prefix,
  });
});

// -- Unsupported ----------------------------------------------------------------------------------------------

const unsupported: Handler = async () =>
  json(
    {
      error:
        "Syncing with external git providers is not supported by this forge",
    },
    501,
  );
route("POST", "repos/pull-upstream", ["git:write"], unsupported);
route("POST", "repos/git-credentials", ["repo:write"], unsupported);
route("PUT", "repos/git-credentials", ["repo:write"], unsupported);
route("DELETE", "repos/git-credentials", ["repo:write"], unsupported);

// ---------------------------------------------------------------------------------------------------------------

/** Serves `/api/v1/<path>`. */
export async function handleApi(
  ctx: ApiContext,
  request: Request,
  path: string,
  token: string | undefined,
) {
  const entry = routes[`${request.method} ${path}`];
  if (entry === undefined)
    return json(
      { error: `No route for ${request.method} /api/v1/${path}` },
      404,
    );
  if (!token) return json({ error: "Missing bearer token" }, 401);
  const claims = await verifyToken(ctx.repos, token);
  requireScope(claims, ...entry.scope);
  let parsed: Record<string, unknown> | undefined;
  const call: Call = {
    request,
    url: new URL(request.url),
    ctx,
    claims,
    store: new ObjectStore(ctx.sql, claims.org),
    body: async () => {
      if (parsed === undefined) {
        const text = await request.text();
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      return parsed;
    },
  };
  return entry.handler(call);
}
