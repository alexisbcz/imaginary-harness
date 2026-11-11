// The git CLI against the forge's smart HTTP endpoint, with remote URLs from the `@pierre/storage` SDK.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, setupForge } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setupForge>>;
let dir: string;
beforeAll(async () => {
  env = await setupForge();
  dir = await mkdtemp(join(tmpdir(), "forge-git-"));
});
afterAll(async () => {
  await env.teardown();
  await rm(dir, { recursive: true, force: true });
});

const author = { name: "Ada", email: "ada@example.com" };

test("clone an empty repository, push, and read the push through the SDK", async () => {
  const repo = await env.storage.createRepo({ id: "pushed" });
  const url = await env.remote(repo);
  await git(dir, "clone", url, "pushed");
  const work = join(dir, "pushed");
  await writeFile(join(work, "hello.txt"), "hello\n");
  await Bun.$`mkdir -p ${join(work, "src/deep")}`;
  await writeFile(join(work, "src/deep/a.ts"), "export const a = 1;\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "First push");
  await git(work, "push", "origin", "main");

  const head = await git(work, "rev-parse", "HEAD");
  const commits = await repo.listCommits();
  expect(commits.commits[0]!.sha).toBe(head);
  expect(commits.commits[0]!.message).toBe("First push");
  expect((await repo.listFiles()).paths.sort()).toEqual(["hello.txt", "src/deep/a.ts"]);
  expect(await (await repo.getFileStream({ path: "src/deep/a.ts" })).text()).toBe("export const a = 1;\n");
});

test("SDK commits reach git through fetch, and a thin-pack push goes back", async () => {
  const repo = await env.storage.createRepo({ id: "roundtrip" });
  const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  await repo.createCommit({ targetBranch: "main", commitMessage: "From the SDK", author }).addFileFromString("big.txt", `${big}\n`).send();

  const url = await env.remote(repo);
  await git(dir, "clone", url, "roundtrip");
  const work = join(dir, "roundtrip");
  expect(await Bun.file(join(work, "big.txt")).text()).toBe(`${big}\n`);

  // A small change to a big file: git pushes it as a delta against the blob the server has.
  await writeFile(join(work, "big.txt"), `${big}\nline 400\n`);
  await git(work, "commit", "-am", "Append a line");
  await git(work, "push");

  await repo.createCommit({ targetBranch: "main", commitMessage: "SDK again", author }).addFileFromString("sdk.txt", "sdk\n").send();
  await git(work, "pull", "--ff-only");
  expect(await git(work, "log", "--format=%s")).toBe("SDK again\nAppend a line\nFrom the SDK");
  expect(await (await repo.getFileStream({ path: "big.txt" })).text()).toEndWith("line 400\n");
});

test("branches and tags over git, and non-fast-forward pushes are refused", async () => {
  const repo = await env.storage.createRepo({ id: "refs" });
  const url = await env.remote(repo);
  await git(dir, "clone", url, "refs");
  const work = join(dir, "refs");
  await writeFile(join(work, "a"), "a\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "a");
  await git(work, "push", "origin", "main");
  await git(work, "switch", "-c", "topic");
  await writeFile(join(work, "b"), "b\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "b");
  await git(work, "tag", "-a", "v1", "-m", "Version 1");
  await git(work, "push", "origin", "topic", "v1");

  expect((await repo.listBranches()).branches.map((b) => b.name).sort()).toEqual(["main", "topic"]);
  expect((await repo.listTags()).tags.map((t) => t.name)).toEqual(["v1"]);

  // Someone else moves main; a stale push must fail.
  await repo.createCommit({ targetBranch: "main", commitMessage: "Remote change", author }).addFileFromString("r", "r\n").send();
  await git(work, "switch", "main");
  await writeFile(join(work, "c"), "c\n");
  await git(work, "add", ".");
  await git(work, "commit", "-m", "c");
  await expect(git(work, "push", "origin", "main")).rejects.toThrow();

  await git(work, "push", "origin", "--delete", "topic");
  expect((await repo.listBranches()).branches.map((b) => b.name)).toEqual(["main"]);

  // A fresh clone gets the annotated tag.
  await git(dir, "clone", url, "refs2");
  expect(await git(join(dir, "refs2"), "tag")).toBe("v1");
});

test("ephemeral branches live apart from git's view", async () => {
  const repo = await env.storage.createRepo({ id: "ephemeral" });
  await repo.createCommit({ targetBranch: "main", commitMessage: "Base", author }).addFileFromString("f", "f\n").send();
  await repo
    .createCommit({ targetBranch: "scratch", baseBranch: "main", ephemeral: true, commitMessage: "Scratch", author })
    .addFileFromString("g", "g\n")
    .send();
  expect((await repo.listBranches()).branches.map((b) => b.name)).toEqual(["main"]);
  expect((await repo.listBranches({ ephemeral: true })).branches.map((b) => b.name)).toEqual(["scratch"]);
  const ephemeralUrl = (await repo.getEphemeralRemoteURL()).replace(/^https:/, "http:");
  const out = await git(dir, "ls-remote", ephemeralUrl);
  expect(out).toContain("refs/heads/scratch");
  expect(await git(dir, "ls-remote", await env.remote(repo))).not.toContain("scratch");
});

test("git refuses without a token, and with a token for another repository", async () => {
  const a = await env.storage.createRepo({ id: "private-a" });
  await env.storage.createRepo({ id: "private-b" });
  const withoutToken = (await env.remote(a)).replace(/\/\/t:[^@]+@/, "//");
  await expect(git(dir, "ls-remote", withoutToken)).rejects.toThrow();
  const wrong = (await env.remote(a)).replace("private-a.git", "private-b.git");
  await expect(git(dir, "ls-remote", wrong)).rejects.toThrow();
});
