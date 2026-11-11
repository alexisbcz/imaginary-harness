import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { tar } from "./tar.ts";

test("writes an archive the system tar extracts, long and non-ASCII paths included", async () => {
  const files = {
    "index.html": "<!doctype html>",
    "src/App.tsx": "export const é = 'ü'\n",
    "src/components/ui/a-very-long-directory-name-to-push-the-path-over-one-hundred-bytes/and-a-long-file-name.tsx":
      "x".repeat(1500),
    "empty.txt": "",
  };
  const directory = await mkdtemp(join(tmpdir(), "tar-test-"));
  try {
    const archive = join(directory, "files.tar");
    await Bun.write(archive, tar(files));
    await $`tar -xf ${archive} -C ${directory}`.quiet();
    for (const [path, contents] of Object.entries(files))
      expect(await readFile(join(directory, path), "utf8")).toBe(contents);
    const listing = await $`tar -tvf ${archive}`.text();
    expect(listing).toContain("1000");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads back what docker cp writes, and its own archives", async () => {
  const { untar } = await import("./tar.ts");
  const files = { "a.txt": "hello", "dir/b.js": "x".repeat(700) };
  const read = untar(tar(files));
  expect(Object.keys(read).sort()).toEqual(["a.txt", "dir/b.js"]);
  expect(new TextDecoder().decode(read["dir/b.js"])).toBe(files["dir/b.js"]);

  // The system tar, with a directory entry and a PAX long name.
  const directory = await mkdtemp(join(tmpdir(), "untar-test-"));
  try {
    const long = `${"d".repeat(120)}/file.txt`;
    await Bun.write(join(directory, "src", long), "deep");
    await Bun.write(join(directory, "src", "top.css"), "body{}");
    const archive =
      await $`tar --format=pax -cf - -C ${join(directory, "src")} .`.arrayBuffer();
    const extracted = untar(new Uint8Array(archive));
    expect(new TextDecoder().decode(extracted[`./${long}`])).toBe("deep");
    expect(new TextDecoder().decode(extracted["./top.css"])).toBe("body{}");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
