// The official `@pierre/storage` SDK, unchanged, against the forge.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupForge } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setupForge>>;
beforeAll(async () => {
  env = await setupForge();
});
afterAll(() => env.teardown());

const author = { name: "Ada", email: "ada@example.com" };
const text = async (response: Response) => response.text();

describe("repositories", () => {
  test("create, find, list and delete", async () => {
    const repo = await env.storage.createRepo({ id: "first" });
    expect(repo.id).toBe("first");
    expect(repo.defaultBranch).toBe("main");
    await expect(env.storage.createRepo({ id: "first" })).rejects.toThrow("already exists");
    const found = await env.storage.findOne({ id: "first" });
    expect(found?.defaultBranch).toBe("main");
    expect(await env.storage.findOne({ id: "nope" })).toBeNull();
    const list = await env.storage.listRepos();
    expect(list.repos.map((r) => r.repoId)).toContain("first");
    expect((await env.storage.deleteRepo({ id: "first" })).repoId).toBe("first");
    expect(await env.storage.findOne({ id: "first" })).toBeNull();
  });

  test("rejects a token signed with another key", async () => {
    const { GitStorage } = await import("@pierre/storage");
    const { exportPKCS8, generateKeyPair } = await import("jose");
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const intruder = new GitStorage({ name: env.org, key: await exportPKCS8(privateKey), apiBaseUrl: `${env.origin}/forge` });
    await expect(intruder.createRepo({ id: "intrusion" })).rejects.toThrow();
  });
});

describe("commits and reads", () => {
  test("createCommit, files, commits, diffs", async () => {
    const repo = await env.storage.createRepo({ id: "app" });
    const first = await repo
      .createCommit({ targetBranch: "main", commitMessage: "Initial commit", author })
      .addFileFromString("README.md", "# App\n")
      .addFileFromString("src/index.ts", "export const one = 1;\n")
      .addFile("bin/run.sh", new TextEncoder().encode("#!/bin/sh\necho hi\n"), { mode: "100755" })
      .send();
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.refUpdate.oldSha).toBe("0".repeat(40));
    expect(first.blobCount).toBe(3);

    const second = await repo
      .createCommit({ targetBranch: "main", commitMessage: "Add two", author, expectedHeadSha: first.commitSha })
      .addFileFromString("src/index.ts", "export const one = 1;\nexport const two = 2;\n")
      .deletePath("README.md")
      .send();
    expect(second.refUpdate.oldSha).toBe(first.commitSha);

    // A stale expected head is refused.
    await expect(
      repo.createCommit({ targetBranch: "main", commitMessage: "Stale", author, expectedHeadSha: first.commitSha }).addFileFromString("x", "x").send(),
    ).rejects.toThrow();

    const files = await repo.listFiles();
    expect(files.paths.sort()).toEqual(["bin/run.sh", "src/index.ts"]);
    expect(await text(await repo.getFileStream({ path: "src/index.ts" }))).toContain("two");
    expect(await text(await repo.getFileStream({ path: "src/index.ts", ref: first.commitSha }))).not.toContain("two");

    const meta = await repo.listFilesWithMetadata();
    const index = meta.files.find((f) => f.path === "src/index.ts")!;
    expect(index.lastCommitSha).toBe(second.commitSha);
    expect(meta.files.find((f) => f.path === "bin/run.sh")!.lastCommitSha).toBe(first.commitSha);

    const commits = await repo.listCommits();
    expect(commits.commits.map((c) => c.message)).toEqual(["Add two", "Initial commit"]);
    const { commit } = await repo.getCommit({ sha: second.commitSha });
    expect(commit.parentShas).toEqual([first.commitSha]);
    expect(commit.authorEmail).toBe("ada@example.com");

    const diff = await repo.getCommitDiff({ sha: second.commitSha });
    expect(diff.files.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "deleted"],
      ["src/index.ts", "modified"],
    ]);
    expect(diff.stats.additions).toBe(1);
    expect(diff.files[1]!.raw).toContain("+export const two = 2;");
  });

  test("branches, branch diff, merge and tags", async () => {
    const repo = await env.storage.createRepo({ id: "branches" });
    await repo.createCommit({ targetBranch: "main", commitMessage: "Base", author }).addFileFromString("a.txt", "one\ntwo\nthree\n").send();
    await repo.createBranch({ baseBranch: "main", targetBranch: "feature" });
    await repo.createCommit({ targetBranch: "feature", commitMessage: "Feature", author }).addFileFromString("a.txt", "one\ntwo\nthree\nfour\n").send();
    await repo.createCommit({ targetBranch: "main", commitMessage: "Main", author }).addFileFromString("a.txt", "zero\none\ntwo\nthree\n").send();

    const branches = await repo.listBranches();
    expect(branches.branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);

    const branchDiff = await repo.getBranchDiff({ branch: "feature" });
    expect(branchDiff.files.map((f) => f.path)).toEqual(["a.txt"]);

    const preview = await repo.previewMerge({ sourceBranch: "feature", targetBranch: "main" });
    expect(preview.status).toBe("clean");
    const merge = await repo.merge({ sourceBranch: "feature", targetBranch: "main", strategy: "ff_prefer", author });
    expect(merge.result).toBe("merge_commit");
    expect(await text(await repo.getFileStream({ path: "a.txt" }))).toBe("zero\none\ntwo\nthree\nfour\n");

    await repo.createTag({ name: "v1", target: "main" });
    expect((await repo.listTags()).tags.map((t) => t.name)).toEqual(["v1"]);
    await repo.deleteTag({ name: "v1" });
    await repo.deleteBranch({ name: "feature" });
    expect((await repo.listBranches()).branches.map((b) => b.name)).toEqual(["main"]);
  });

  test("conflicting merge is reported", async () => {
    const repo = await env.storage.createRepo({ id: "conflict" });
    await repo.createCommit({ targetBranch: "main", commitMessage: "Base", author }).addFileFromString("f", "a\n").send();
    await repo.createBranch({ baseBranch: "main", targetBranch: "x" });
    await repo.createCommit({ targetBranch: "x", commitMessage: "X", author }).addFileFromString("f", "x\n").send();
    await repo.createCommit({ targetBranch: "main", commitMessage: "Y", author }).addFileFromString("f", "y\n").send();
    const preview = await repo.previewMerge({ sourceBranch: "x", targetBranch: "main", includeContent: true });
    expect(preview.status).toBe("conflicted");
    expect(preview.conflicts[0]!.result.content).toContain("<<<<<<<");
    await expect(repo.merge({ sourceBranch: "x", targetBranch: "main", strategy: "merge" })).rejects.toThrow();
  });

  test("fork, grep, blame, notes, restore, archive, diff commit", async () => {
    const base = await env.storage.createRepo({ id: "template" });
    const c1 = await base.createCommit({ targetBranch: "main", commitMessage: "One", author }).addFileFromString("src/app.ts", "const a = 1;\nconst b = 2;\n").send();
    const c2 = await base.createCommit({ targetBranch: "main", commitMessage: "Two", author }).addFileFromString("src/app.ts", "const a = 1;\nconst b = 3;\n").send();

    const fork = await env.storage.createRepo({ id: "fork", baseRepo: { id: "template" } });
    expect((await fork.listFiles()).paths).toEqual(["src/app.ts"]);

    const grep = await fork.grep({ query: { pattern: "b = \\d" } });
    expect(grep.matches[0]!.lines[0]!.lineNumber).toBe(2);

    const blame = await fork.getBlame({ path: "src/app.ts" });
    expect(blame.lines.map((l) => l.commitSha)).toEqual([c1.commitSha, c2.commitSha]);

    await fork.createNote({ sha: c2.commitSha, note: "reviewed" });
    await fork.appendNote({ sha: c2.commitSha, note: "approved" });
    expect((await fork.getNote({ sha: c2.commitSha })).note).toBe("reviewed\n\napproved");

    const restored = await fork.restoreCommit({ targetBranch: "main", targetCommitSha: c1.commitSha, author });
    expect(await text(await fork.getFileStream({ path: "src/app.ts", ref: restored.commitSha }))).toContain("b = 2");

    const archive = await fork.getArchiveStream();
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(50);

    const fromDiff = await fork.createCommitFromDiff({
      targetBranch: "main",
      commitMessage: "Patch",
      author,
      diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 10;\n const b = 2;\n",
    });
    expect(await text(await fork.getFileStream({ path: "src/app.ts", ref: fromDiff.commitSha }))).toBe("const a = 10;\nconst b = 2;\n");
  });
});
