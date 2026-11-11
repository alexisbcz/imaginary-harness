// Tree-to-tree diffs in git's unified format, per file, as code.storage reports them.

import { formatPatch, structuredPatch } from "diff";
import type { TreeEntry } from "./objects.ts";
import type { ObjectStore } from "./store.ts";

export interface FileDiffRaw {
  path: string;
  state: string;
  old_path: string | null;
  raw: string;
  bytes: number;
  is_eof: boolean;
  additions: number;
  deletions: number;
}

export interface FilteredFileRaw {
  path: string;
  state: string;
  old_path: string | null;
  bytes: number;
  is_eof: boolean;
}

/** Files larger than this are listed without their patch. */
const MAX_PATCH_BYTES = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });
const isBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0);

function filePatch(path: string, state: "A" | "M" | "D", before: TreeEntry | undefined, after: TreeEntry | undefined, oldText: string, newText: string) {
  const header = [`diff --git a/${path} b/${path}`];
  if (state === "A") header.push(`new file mode ${after!.mode}`);
  if (state === "D") header.push(`deleted file mode ${before!.mode}`);
  if (state === "M" && before!.mode !== after!.mode) header.push(`old mode ${before!.mode}`, `new mode ${after!.mode}`);
  const short = (oid: string | undefined) => (oid ?? "0".repeat(40)).slice(0, 7);
  header.push(`index ${short(before?.oid)}..${short(after?.oid)}${state === "M" && before!.mode === after!.mode ? ` ${after!.mode}` : ""}`);
  const patch = structuredPatch(
    state === "A" ? "/dev/null" : `a/${path}`,
    state === "D" ? "/dev/null" : `b/${path}`,
    oldText,
    newText,
    undefined,
    undefined,
    { context: 3 },
  );
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  // formatPatch writes an "Index:" and "===" preamble; git's format starts at the --- line.
  const body = patch.hunks.length === 0 ? "" : formatPatch(patch).replace(/^(?:Index:.*\n)?(?:=+\n)?/, "");
  return { raw: `${header.join("\n")}\n${body}`, additions, deletions };
}

/** The changes from tree `from` (undefined: empty) to tree `to`, restricted to `paths` when given. */
export async function diffTrees(store: ObjectStore, from: string | undefined, to: string, paths?: readonly string[]) {
  const [before, after] = await Promise.all([
    from === undefined ? new Map<string, TreeEntry>() : store.flatten(from),
    store.flatten(to),
  ]);
  const inScope = (path: string) => !paths || paths.length === 0 || paths.some((p) => path === p || path.startsWith(`${p.replace(/\/$/, "")}/`));
  const changes: { path: string; state: "A" | "M" | "D"; before?: TreeEntry; after?: TreeEntry }[] = [];
  for (const [path, entry] of after) {
    if (!inScope(path)) continue;
    const old = before.get(path);
    if (old === undefined) changes.push({ path, state: "A", after: entry });
    else if (old.oid !== entry.oid || old.mode !== entry.mode) changes.push({ path, state: "M", before: old, after: entry });
  }
  for (const [path, entry] of before) if (inScope(path) && !after.has(path)) changes.push({ path, state: "D", before: entry });
  changes.sort((a, b) => (a.path < b.path ? -1 : 1));

  const blobs = await store.readMany(changes.flatMap((c) => [c.before?.oid, c.after?.oid]).filter((o): o is string => !!o));
  const files: FileDiffRaw[] = [];
  const filtered: FilteredFileRaw[] = [];
  const stats = { files: 0, additions: 0, deletions: 0, changes: 0 };
  for (const change of changes) {
    const oldData = change.before ? blobs.get(change.before.oid)?.data ?? new Uint8Array() : new Uint8Array();
    const newData = change.after ? blobs.get(change.after.oid)?.data ?? new Uint8Array() : new Uint8Array();
    const bytes = Math.max(oldData.byteLength, newData.byteLength);
    stats.files++;
    if (bytes > MAX_PATCH_BYTES) {
      filtered.push({ path: change.path, state: change.state, old_path: null, bytes, is_eof: true });
      continue;
    }
    let result: { raw: string; additions: number; deletions: number };
    if (isBinary(oldData) || isBinary(newData)) {
      result = {
        raw: `diff --git a/${change.path} b/${change.path}\nBinary files ${change.before ? `a/${change.path}` : "/dev/null"} and ${change.after ? `b/${change.path}` : "/dev/null"} differ\n`,
        additions: 0,
        deletions: 0,
      };
    } else {
      result = filePatch(change.path, change.state, change.before, change.after, decoder.decode(oldData), decoder.decode(newData));
    }
    stats.additions += result.additions;
    stats.deletions += result.deletions;
    stats.changes += result.additions + result.deletions;
    files.push({
      path: change.path,
      state: change.state,
      old_path: null,
      raw: result.raw,
      bytes: new TextEncoder().encode(result.raw).byteLength,
      is_eof: true,
      additions: result.additions,
      deletions: result.deletions,
    });
  }
  return { stats, files, filtered_files: filtered };
}
