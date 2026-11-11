// Line-by-line blame along first parents: each line goes to the commit that last changed it.

import { structuredPatch } from "diff";
import { signatureDate, type Commit } from "./objects.ts";
import type { ObjectStore } from "./store.ts";

const decoder = new TextDecoder();

export interface BlameLine {
  line_number: number;
  commit_sha: string;
  original_line_number: number;
  original_path: string;
  previous_commit_sha?: string;
  author_name: string;
  author_email: string;
  author_time: string;
  committer_name: string;
  committer_email: string;
  committer_time: string;
  summary: string;
}

/** Maps each line of `newer` that is unchanged in `older` to its 0-based line there. */
function unchangedLines(older: string, newer: string, count: number): (number | undefined)[] {
  const map: (number | undefined)[] = new Array(count);
  const patch = structuredPatch("", "", older, newer, undefined, undefined, { context: 0 });
  let oldLine = 0;
  let newLine = 0;
  for (const hunk of patch.hunks) {
    const hunkNew = hunk.newStart - 1; // jsdiff counts from 1, a deletion included
    while (newLine < hunkNew) map[newLine++] = oldLine++;
    oldLine += hunk.oldLines;
    newLine += hunk.newLines;
  }
  while (newLine < count) map[newLine++] = oldLine++;
  return map;
}

export async function blame(store: ObjectStore, head: string, path: string, maxCommits = 2000): Promise<BlameLine[]> {
  const contentAt = async (commit: Commit) => {
    const entry = await store.entryAt(commit.tree, path);
    if (entry === undefined || entry.mode === "40000") return undefined;
    return decoder.decode((await store.read(entry.oid))!.data);
  };
  let oid = head;
  let commit = await store.commit(oid);
  let text = await contentAt(commit);
  if (text === undefined) throw new Error(`No file at ${path}`);
  const countLines = (value: string) => (value === "" ? 0 : value.split("\n").length - (value.endsWith("\n") ? 1 : 0));
  const lineCount = countLines(text);
  const result: BlameLine[] = new Array(lineCount);
  // Lines still to attribute: their position in the current commit's version → their final line number.
  let pending = new Map<number, number>();
  for (let i = 0; i < lineCount; i++) pending.set(i, i);

  const attribute = (to: string, c: Commit, current: number, final: number, previous?: string) => {
    result[final] = {
      line_number: final + 1,
      commit_sha: to,
      original_line_number: current + 1,
      original_path: path,
      ...(previous ? { previous_commit_sha: previous } : {}),
      author_name: c.author.name,
      author_email: c.author.email,
      author_time: signatureDate(c.author),
      committer_name: c.committer.name,
      committer_email: c.committer.email,
      committer_time: signatureDate(c.committer),
      summary: c.message.split("\n")[0] ?? "",
    };
  };

  for (let steps = 0; pending.size > 0; steps++) {
    const parentOid = commit.parents[0];
    const parent = parentOid && steps < maxCommits ? await store.commit(parentOid) : undefined;
    const parentText = parent ? await contentAt(parent) : undefined;
    if (parent === undefined || parentText === undefined) {
      for (const [current, final] of pending) attribute(oid, commit, current, final);
      break;
    }
    const map = unchangedLines(parentText, text!, countLines(text!));
    const next = new Map<number, number>();
    for (const [current, final] of pending) {
      const older = map[current];
      if (older === undefined) attribute(oid, commit, current, final, parentOid);
      else next.set(older, final);
    }
    pending = next;
    oid = parentOid!;
    commit = parent;
    text = parentText;
  }
  return result;
}
