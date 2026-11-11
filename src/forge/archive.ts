// A tree as a gzip-compressed tar archive, as `git archive --format=tar.gz` writes it.

import { gzipSync } from "node:zlib";

const encoder = new TextEncoder();

function header(name: string, size: number, mode: number, type: "0" | "2" | "5" | "L", mtime: number, linkname = "") {
  const block = new Uint8Array(512);
  const put = (value: string, offset: number, length: number) => block.set(encoder.encode(value).subarray(0, length), offset);
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0");
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${octal(sum, 7)}\0`, 148, 8);
  return block;
}

export interface ArchiveEntry {
  path: string;
  mode: string;
  data: Uint8Array;
}

export function tarGz(entries: readonly ArchiveEntry[], mtime: number): Uint8Array {
  const blocks: Uint8Array[] = [];
  const pad = (size: number) => new Uint8Array((512 - (size % 512)) % 512);
  for (const entry of entries) {
    const bytes = encoder.encode(entry.path);
    // Names over 100 bytes go first in a GNU long-name entry.
    if (bytes.byteLength > 99) {
      const long = encoder.encode(`${entry.path}\0`);
      blocks.push(header("././@LongLink", long.byteLength, 0o644, "L", mtime), long, pad(long.byteLength));
    }
    if (entry.mode === "120000") {
      blocks.push(header(entry.path, 0, 0o777, "2", mtime, new TextDecoder().decode(entry.data)));
      continue;
    }
    const mode = entry.mode === "100755" ? 0o755 : 0o644;
    blocks.push(header(entry.path, entry.data.byteLength, mode, "0", mtime), entry.data, pad(entry.data.byteLength));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks));
}
