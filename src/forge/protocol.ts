// Git's smart HTTP protocol (v0, stateless RPC): what `git clone`, `git fetch` and `git push` speak to the forge.

import { gunzipSync } from "node:zlib";
import { requireScope, type Claims } from "./auth.ts";
import { decodeCommit, decodeTag, decodeTree, isTreeMode, ZERO_OID, type GitObject } from "./objects.ts";
import { FLUSH, pktLine, readPack, readPktLines, sideband, writePack } from "./pack.ts";
import { ObjectStore, type RepoStore } from "./store.ts";
import type { SQL } from "bun";

const AGENT = "agent=richelieu-forge/1";
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta no-progress allow-tip-sha1-in-want allow-reachable-sha1-in-want ${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs atomic ofs-delta quiet ${AGENT}`;

export interface GitContext {
  readonly sql: SQL;
  readonly repos: RepoStore;
}

export interface GitTarget {
  readonly claims: Claims;
  readonly repo: string;
  readonly ephemeral: boolean;
}

const concat = (parts: Uint8Array[]) => Buffer.concat(parts);

function respond(body: Uint8Array, contentType: string) {
  return new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": contentType, "cache-control": "no-cache" } });
}

async function advertisedRefs(ctx: GitContext, target: GitTarget, store: ObjectStore) {
  const repo = await ctx.repos.requireRepo(target.claims.org, target.repo);
  const refs = (await ctx.repos.refs(target.claims.org, target.repo, target.ephemeral)).filter((r) => !r.name.startsWith("refs/notes/") || !target.ephemeral);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const head = refs.find((r) => r.name === headRef);
  const lines: { oid: string; name: string }[] = [];
  if (head) lines.push({ oid: head.oid, name: "HEAD" });
  const objects = await store.readMany(refs.filter((r) => r.name.startsWith("refs/tags/")).map((r) => r.oid));
  for (const ref of refs) {
    lines.push({ oid: ref.oid, name: ref.name });
    const object = objects.get(ref.oid);
    if (object?.type === "tag") lines.push({ oid: (await store.peel(ref.oid)).oid, name: `${ref.name}^{}` });
  }
  return { lines, headRef, head };
}

/** `GET /info/refs?service=…`: the refs and capabilities. */
export async function infoRefs(ctx: GitContext, target: GitTarget, service: string) {
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return new Response("Dumb HTTP is not supported; use a git client with smart HTTP", { status: 403 });
  }
  requireScope(target.claims, service === "git-upload-pack" ? "git:read" : "git:write");
  const store = new ObjectStore(ctx.sql, target.claims.org);
  const { lines, headRef, head } = await advertisedRefs(ctx, target, store);
  const caps = service === "git-upload-pack" ? `${UPLOAD_CAPS}${head ? ` symref=HEAD:${headRef}` : ""}` : RECEIVE_CAPS;
  const out: Uint8Array[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (lines.length === 0) {
    out.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, i) => out.push(pktLine(i === 0 ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`)));
  }
  out.push(FLUSH);
  return respond(concat(out), `application/x-${service}-advertisement`);
}

async function requestBody(request: Request) {
  const raw = new Uint8Array(await request.arrayBuffer());
  return request.headers.get("content-encoding") === "gzip" ? new Uint8Array(gunzipSync(raw)) : raw;
}

/** Objects reachable from `wants`, minus what the client has (reachable from `haves`). */
async function objectsToSend(store: ObjectStore, wants: string[], haves: string[]): Promise<GitObject[]> {
  // Commits the client lacks; the commits it has stop the walk.
  const known = new Set<string>();
  for await (const { oid } of store.walk(haves)) known.add(oid);
  const commits: { oid: string; tree: string }[] = [];
  const out = new Map<string, GitObject>();
  const peeledWants: string[] = [];
  for (const want of wants) {
    let oid = want;
    let object = await store.read(oid);
    while (object?.type === "tag") {
      out.set(oid, object);
      oid = decodeTag(object.data).object;
      object = await store.read(oid);
    }
    if (object === undefined) throw new Error(`Object ${want} not found`);
    if (object.type === "commit") peeledWants.push(oid);
    else out.set(oid, object);
  }
  for await (const { oid, commit } of store.walk(peeledWants, known)) {
    commits.push({ oid, tree: commit.tree });
  }
  // Trees and blobs the client already has: those of the boundary commits it holds.
  const uninteresting = new Set<string>();
  const boundary = new Set<string>();
  const commitObjects = await store.readMany(commits.map((c) => c.oid));
  for (const { oid } of commits) {
    out.set(oid, commitObjects.get(oid)!);
    for (const parent of decodeCommit(commitObjects.get(oid)!.data).parents) if (known.has(parent)) boundary.add(parent);
  }
  for (const oid of boundary) {
    const tree = (await store.commit(oid)).tree;
    uninteresting.add(tree);
    for (const entry of (await store.flatten(tree)).values()) uninteresting.add(entry.oid);
    // Subtrees too, so unchanged directories are skipped whole.
    let level = [tree];
    while (level.length > 0) {
      const objects = await store.readMany(level);
      const next: string[] = [];
      for (const oid2 of level) {
        for (const entry of decodeTree(objects.get(oid2)?.data ?? new Uint8Array())) {
          if (isTreeMode(entry.mode) && !uninteresting.has(`t:${entry.oid}`)) {
            uninteresting.add(entry.oid);
            uninteresting.add(`t:${entry.oid}`);
            next.push(entry.oid);
          }
        }
      }
      level = next;
    }
  }
  // Walk the new commits' trees level by level, skipping what the client has.
  let level = [...new Set(commits.map((c) => c.tree))].filter((t) => !uninteresting.has(t));
  const seen = new Set<string>(level);
  while (level.length > 0) {
    const trees = await store.readMany(level);
    const next: string[] = [];
    const blobs: string[] = [];
    for (const oid of level) {
      const tree = trees.get(oid);
      if (tree === undefined) throw new Error(`Tree ${oid} not found`);
      out.set(oid, tree);
      for (const entry of decodeTree(tree.data)) {
        if (entry.mode === "160000" || uninteresting.has(entry.oid) || seen.has(entry.oid)) continue;
        seen.add(entry.oid);
        if (isTreeMode(entry.mode)) next.push(entry.oid);
        else blobs.push(entry.oid);
      }
    }
    const blobObjects = await store.readMany(blobs);
    for (const oid of blobs) {
      const blob = blobObjects.get(oid);
      if (blob === undefined) throw new Error(`Blob ${oid} not found`);
      out.set(oid, blob);
    }
    level = next;
  }
  return [...out.values()];
}

/** `POST /git-upload-pack`: negotiation, then the pack (fetch and clone). */
export async function uploadPack(ctx: GitContext, target: GitTarget, request: Request) {
  requireScope(target.claims, "git:read");
  const store = new ObjectStore(ctx.sql, target.claims.org);
  const body = await requestBody(request);
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let sideBand = false;
  let pos = 0;
  while (pos < body.byteLength) {
    const { lines, end } = readPktLines(body, pos);
    for (const line of lines) {
      if (line.startsWith("want ")) {
        const [, oid, ...caps] = line.split(" ");
        wants.push(oid!);
        if (caps.includes("side-band-64k") || caps.includes("side-band")) sideBand = true;
      } else if (line.startsWith("have ")) haves.push(line.slice(5, 45));
      else if (line === "done") done = true;
    }
    if (end === pos) break;
    pos = end;
  }
  // Wants must be refs' targets or reachable from them; the forge shares objects across an organization.
  const refs = await ctx.repos.refs(target.claims.org, target.repo, target.ephemeral);
  const tips = new Set(refs.map((r) => r.oid));
  for (const want of wants) {
    if (tips.has(want)) continue;
    let reachable = false;
    for await (const { oid } of store.walk([...tips])) if (oid === want) { reachable = true; break; }
    if (!reachable) return respond(concat([pktLine(`ERR upload-pack: not our ref ${want}\n`)]), "application/x-git-upload-pack-result");
  }
  const common = [...(await store.exists(haves))].filter((oid) => haves.includes(oid));
  const out: Uint8Array[] = [];
  if (!done) {
    // A negotiation round: say which haves are common; the client sends more, then "done".
    for (const oid of common) out.push(pktLine(`ACK ${oid} common\n`));
    out.push(pktLine("NAK\n"));
    return respond(concat(out), "application/x-git-upload-pack-result");
  }
  out.push(pktLine(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : "NAK\n"));
  const pack = writePack(await objectsToSend(store, wants, common));
  if (sideBand) {
    out.push(...sideband(1, pack), FLUSH);
  } else {
    out.push(pack);
  }
  return respond(concat(out), "application/x-git-upload-pack-result");
}

const VALID_REF = /^refs\/(heads|tags|notes)\/[^\0\s~^:?*[\\]+$/;

/** `POST /git-receive-pack`: ref updates and their pack (push). */
export async function receivePack(ctx: GitContext, target: GitTarget, request: Request) {
  requireScope(target.claims, "git:write");
  const { org } = target.claims;
  await ctx.repos.requireRepo(org, target.repo);
  const store = new ObjectStore(ctx.sql, org);
  const body = await requestBody(request);
  const { lines, end } = readPktLines(body, 0);
  let caps: string[] = [];
  const commands = lines.map((line, i) => {
    let text = line;
    if (i === 0 && line.includes("\0")) {
      const [first = "", ...rest] = line.split("\0");
      text = first;
      caps = rest.join(" ").split(" ");
    }
    const [oldOid, newOid, name] = text.split(" ") as [string, string, string];
    return { oldOid, newOid, name };
  });
  const report: string[] = [];
  let unpack = "ok";
  try {
    if (end < body.byteLength) {
      const objects = await readPack(body.subarray(end), (oids) => store.readMany(oids));
      for (const object of objects.values()) store.write(object.type, object.data);
      await store.flush();
    }
  } catch (error) {
    unpack = error instanceof Error ? error.message : "unpack failed";
  }
  const atomic = caps.includes("atomic");
  const results = new Map<string, string | undefined>();
  if (unpack === "ok") {
    for (const command of commands) {
      if (!VALID_REF.test(command.name)) results.set(command.name, "invalid ref name");
      else if (command.newOid !== ZERO_OID && (await store.read(command.newOid)) === undefined) results.set(command.name, "missing object");
    }
    const apply = async (tx: Pick<SQL, "unsafe">) => {
      for (const command of commands) {
        if (results.has(command.name)) continue;
        const ok = await ctx.repos.updateRef(
          tx,
          org,
          target.repo,
          target.ephemeral,
          command.name,
          command.oldOid === ZERO_OID ? undefined : command.oldOid,
          command.newOid === ZERO_OID ? undefined : command.newOid,
        );
        results.set(command.name, ok ? undefined : "fetch first");
        if (!ok && atomic) throw new Error("atomic push failed");
      }
    };
    if (atomic) {
      if ([...results.values()].some(Boolean)) {
        for (const c of commands) if (!results.get(c.name)) results.set(c.name, "atomic push failed");
      } else {
        try {
          await ctx.sql.begin(apply);
        } catch {
          for (const c of commands) if (!results.get(c.name)) results.set(c.name, "atomic push failed");
        }
      }
    } else {
      await apply(ctx.sql);
    }
  }
  report.push(`unpack ${unpack}\n`);
  for (const command of commands) {
    const error = unpack === "ok" ? results.get(command.name) : "unpacker error";
    report.push(error ? `ng ${command.name} ${error}\n` : `ok ${command.name}\n`);
  }
  const out = [...report.map((line) => pktLine(line)), FLUSH];
  const reply = caps.includes("side-band-64k") ? concat([...sideband(1, concat(out)), FLUSH]) : concat(out);
  return respond(reply, "application/x-git-receive-pack-result");
}
