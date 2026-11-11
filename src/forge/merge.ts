// Three-way merges of trees and of text files, with git's conflict markers when both sides change the same lines.

import { structuredPatch } from "diff";
import type { TreeEntry } from "./objects.ts";
import type { ObjectStore } from "./store.ts";

const decoder = new TextDecoder();
const isBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0);

/** Lines with their newline kept, so a merge restores the text exactly. */
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Changed ranges of `base` (0-based, end exclusive) and their replacement lines. */
function hunksOf(base: string, side: string) {
  const patch = structuredPatch("", "", base, side, undefined, undefined, { context: 0 });
  return patch.hunks.map((hunk) => {
    const start = hunk.oldStart - 1; // jsdiff counts from 1, an insertion included
    return {
      start,
      end: start + hunk.oldLines,
      lines: hunk.lines.filter((l) => l.startsWith("+")).map((l) => `${l.slice(1)}\n`),
    };
  });
}

/**
 * Merges two descendants of `base` line by line. Changes to separate lines combine; changes to the same lines
 * conflict unless identical. Returns the text, with conflict markers where needed, and whether it conflicts.
 */
export function mergeText(base: string, ours: string, theirs: string, labels = { ours: "ours", theirs: "theirs" }) {
  const baseLines = splitLines(base.endsWith("\n") || base === "" ? base : `${base}\n`);
  const a = hunksOf(base, ours).map((h) => ({ ...h, side: "ours" as const }));
  const b = hunksOf(base, theirs).map((h) => ({ ...h, side: "theirs" as const }));
  const all = [...a, ...b].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let conflicted = false;
  let cursor = 0;
  let i = 0;
  while (i < all.length) {
    // Group hunks whose base ranges overlap (or touch at the same insertion point).
    const group = [all[i]!];
    let end = all[i]!.end;
    let j = i + 1;
    while (j < all.length && (all[j]!.start < end || (all[j]!.start === end && all[j]!.start === group[0]!.start))) {
      end = Math.max(end, all[j]!.end);
      group.push(all[j]!);
      j++;
    }
    const start = group[0]!.start;
    out.push(...baseLines.slice(cursor, start));
    const render = (side: "ours" | "theirs") => {
      const hunks = group.filter((h) => h.side === side);
      if (hunks.length === 0) return baseLines.slice(start, end);
      const lines: string[] = [];
      let at = start;
      for (const h of hunks) {
        lines.push(...baseLines.slice(at, h.start), ...h.lines);
        at = h.end;
      }
      lines.push(...baseLines.slice(at, end));
      return lines;
    };
    const mine = render("ours");
    const yours = render("theirs");
    const sides = new Set(group.map((h) => h.side));
    if (sides.size === 1 || mine.join("") === yours.join("")) {
      out.push(...(sides.has("ours") ? mine : yours));
    } else {
      conflicted = true;
      out.push(`<<<<<<< ${labels.ours}\n`, ...mine, "=======\n", ...yours, `>>>>>>> ${labels.theirs}\n`);
    }
    cursor = end;
    i = j;
  }
  out.push(...baseLines.slice(cursor));
  let text = out.join("");
  if (!ours.endsWith("\n") && !theirs.endsWith("\n") && text.endsWith("\n")) text = text.slice(0, -1);
  return { text, conflicted };
}

export interface TreeConflict {
  path: string;
  base?: TreeEntry;
  ours?: TreeEntry;
  theirs?: TreeEntry;
  /** The merged text with conflict markers, for a text file both sides changed. */
  merged?: string;
}

/** Merges trees `ours` and `theirs` from their common `base` tree. Writes merged blobs; returns the changes to ours. */
export async function mergeTrees(store: ObjectStore, base: string | undefined, ours: string, theirs: string, labels?: { ours: string; theirs: string }) {
  const [b, o, t] = await Promise.all([
    base === undefined ? new Map<string, TreeEntry>() : store.flatten(base),
    store.flatten(ours),
    store.flatten(theirs),
  ]);
  const same = (x?: TreeEntry, y?: TreeEntry) => x?.oid === y?.oid && x?.mode === y?.mode;
  const changes = new Map<string, { mode: string; oid: string } | null>();
  const conflicts: TreeConflict[] = [];
  const paths = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
  const contended: string[] = [];
  for (const path of paths) {
    const [x, y, z] = [b.get(path), o.get(path), t.get(path)];
    if (same(y, z) || same(x, z)) continue; // theirs agrees, or theirs did not change it
    if (same(x, y)) {
      changes.set(path, z === undefined ? null : { mode: z.mode, oid: z.oid });
      continue;
    }
    contended.push(path);
  }
  const blobs = await store.readMany(contended.flatMap((p) => [b.get(p)?.oid, o.get(p)?.oid, t.get(p)?.oid]).filter((x): x is string => !!x));
  for (const path of contended) {
    const [x, y, z] = [b.get(path), o.get(path), t.get(path)];
    if (y === undefined || z === undefined) {
      conflicts.push({ path, base: x, ours: y, theirs: z }); // modified on one side, deleted on the other
      continue;
    }
    const [bd, od, td] = [x ? blobs.get(x.oid)!.data : new Uint8Array(), blobs.get(y.oid)!.data, blobs.get(z.oid)!.data];
    if (isBinary(bd) || isBinary(od) || isBinary(td) || y.mode !== z.mode) {
      conflicts.push({ path, base: x, ours: y, theirs: z });
      continue;
    }
    const merged = mergeText(decoder.decode(bd), decoder.decode(od), decoder.decode(td), labels);
    if (merged.conflicted) conflicts.push({ path, base: x, ours: y, theirs: z, merged: merged.text });
    else changes.set(path, { mode: y.mode, oid: store.write("blob", new TextEncoder().encode(merged.text)) });
  }
  conflicts.sort((p, q) => (p.path < q.path ? -1 : 1));
  return { changes, conflicts };
}
