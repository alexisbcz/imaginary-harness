// Packfiles written by git itself (with OFS and REF deltas, thin or not) read back exactly; ours pass `git index-pack`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashObject, type GitObject } from "../objects.ts";
import { readPack, writePack } from "../pack.ts";
import { git } from "./helpers.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-pack-"));
  await git(dir, "init", "-q");
  const lines = Array.from({ length: 2000 }, (_, i) => `const value${i} = ${i};`);
  for (let round = 0; round < 3; round++) {
    lines[round * 100] = `// changed in round ${round}`;
    await writeFile(join(dir, "big.ts"), `${lines.join("\n")}\n`);
    await writeFile(join(dir, `small-${round}.txt`), `round ${round}\n`);
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", `round ${round}`);
  }
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function pack(args: string[], input: string) {
  const proc = Bun.spawn(["git", "pack-objects", "--stdout", ...args], { cwd: dir, stdin: new TextEncoder().encode(input), stdout: "pipe" });
  return new Uint8Array(await new Response(proc.stdout).arrayBuffer());
}

async function objectsOf(range: string) {
  const out = await git(dir, "rev-list", "--objects", range);
  return new Set(out.split("\n").map((line) => line.slice(0, 40)));
}

test("reads a full pack with OFS deltas", async () => {
  const data = await pack(["--revs", "--delta-base-offset"], "HEAD\n");
  const objects = await readPack(data, async () => new Map());
  expect(new Set(objects.keys())).toEqual(await objectsOf("HEAD"));
  for (const [oid, object] of objects) expect(hashObject(object.type, object.data)).toBe(oid);
});

test("reads REF deltas and a thin pack whose bases live elsewhere", async () => {
  const all = await readPack(await pack(["--revs"], "HEAD\n"), async () => new Map());
  const thin = await pack(["--revs", "--thin"], "HEAD\n^HEAD~1\n");
  const asked: string[] = [];
  const objects = await readPack(thin, async (oids) => {
    asked.push(...oids);
    return new Map(oids.map((oid) => [oid, all.get(oid)!] as [string, GitObject]));
  });
  expect(asked.length).toBeGreaterThan(0); // the big file came as a delta against the previous version
  expect(new Set(objects.keys())).toEqual(await objectsOf("HEAD~1..HEAD"));
});

test("git accepts the packs the forge writes", async () => {
  const objects = await readPack(await pack(["--revs"], "HEAD\n"), async () => new Map());
  const ours = writePack(objects.values());
  const proc = Bun.spawn(["git", "index-pack", "--stdin", "--fix-thin"], { cwd: dir, stdin: ours, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
});
