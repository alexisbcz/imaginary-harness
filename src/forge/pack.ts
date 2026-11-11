// Git packfiles (version 2) and pkt-lines, the wire formats of git's smart HTTP protocol.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { hashObject, type GitObject, type ObjectType } from "./objects.ts";

const TYPE_CODES: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const CODE_TYPES: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** Applies a git delta to `base`. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[pos++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const baseSize = varint();
  if (baseSize !== base.length) throw new Error("Delta base size mismatch");
  const out = new Uint8Array(varint());
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++)
        if (op & (1 << i)) offset |= delta[pos++]! << (8 * i);
      for (let i = 0; i < 3; i++)
        if (op & (0x10 << i)) size |= delta[pos++]! << (8 * i);
      if (size === 0) size = 0x10000;
      out.set(base.subarray(offset >>> 0, (offset >>> 0) + size), outPos);
      outPos += size;
    } else if (op > 0) {
      out.set(delta.subarray(pos, pos + op), outPos);
      pos += op;
      outPos += op;
    } else {
      throw new Error("Invalid delta opcode 0");
    }
  }
  if (outPos !== out.length) throw new Error("Delta result size mismatch");
  return out;
}

/**
 * Every object of a packfile, deltas resolved. `external` reads the base of a REF_DELTA the pack does not hold,
 * as a thin pack sent by `git push` refers to objects the server already has.
 */
export async function readPack(
  pack: Uint8Array,
  external: (oids: string[]) => Promise<Map<string, GitObject>>,
): Promise<Map<string, GitObject>> {
  const buf = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (buf.length < 32 || buf.toString("latin1", 0, 4) !== "PACK")
    throw new Error("Not a packfile");
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3)
    throw new Error(`Unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const checksum = createHash("sha1")
    .update(buf.subarray(0, buf.length - 20))
    .digest();
  if (!checksum.equals(buf.subarray(buf.length - 20)))
    throw new Error("Pack checksum mismatch");

  type Raw = {
    offset: number;
    code: number;
    data: Uint8Array;
    baseOffset?: number;
    baseOid?: string;
  };
  const raws: Raw[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let byte = buf[pos++]!;
    const code = (byte >> 4) & 7;
    while (byte & 0x80) byte = buf[pos++]!; // the inflated size, which zlib tells us anyway
    const raw: Raw = { offset, code, data: new Uint8Array() };
    if (code === OFS_DELTA) {
      byte = buf[pos++]!;
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++]!;
        distance = ((distance + 1) << 7) | (byte & 0x7f);
      }
      raw.baseOffset = offset - distance;
    } else if (code === REF_DELTA) {
      raw.baseOid = buf.toString("hex", pos, pos + 20);
      pos += 20;
    } else if (!(code in CODE_TYPES)) {
      throw new Error(`Unknown pack object type ${code}`);
    }
    const inflated = inflateSync(buf.subarray(pos), {
      info: true,
    } as never) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    raw.data = new Uint8Array(inflated.buffer);
    pos += inflated.engine.bytesWritten;
    raws.push(raw);
  }

  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const add = (raw: Raw, object: GitObject) => {
    byOffset.set(raw.offset, object);
    byOid.set(hashObject(object.type, object.data), object);
  };
  for (const raw of raws)
    if (raw.code in CODE_TYPES)
      add(raw, { type: CODE_TYPES[raw.code]!, data: raw.data });

  // Resolve deltas until none is left: a delta's base can itself be a delta, anywhere in the pack.
  let pending = raws.filter((raw) => !(raw.code in CODE_TYPES));
  while (pending.length > 0) {
    const missing = pending
      .filter((r) => r.baseOid !== undefined && !byOid.has(r.baseOid))
      .map((r) => r.baseOid!);
    if (missing.length > 0)
      for (const [oid, object] of await external(missing))
        byOid.set(oid, object);
    const next: Raw[] = [];
    for (const raw of pending) {
      const base =
        raw.baseOffset !== undefined
          ? byOffset.get(raw.baseOffset)
          : byOid.get(raw.baseOid!);
      if (base === undefined) next.push(raw);
      else add(raw, { type: base.type, data: applyDelta(base.data, raw.data) });
    }
    if (next.length === pending.length)
      throw new Error("Pack has deltas whose base is missing");
    pending = next;
  }
  // Only the pack's own objects: bases read from storage stay out.
  const own = new Map<string, GitObject>();
  for (const object of byOffset.values())
    own.set(hashObject(object.type, object.data), object);
  return own;
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

/** A version 2 packfile of whole objects (no deltas). */
export function writePack(objects: Iterable<GitObject>): Uint8Array {
  const parts: Buffer[] = [];
  let count = 0;
  for (const object of objects) {
    let size = object.data.byteLength;
    const header = [(TYPE_CODES[object.type] << 4) | (size & 0x0f)];
    size >>>= 4;
    while (size > 0) {
      header[header.length - 1]! |= 0x80;
      header.push(size & 0x7f);
      size >>>= 7;
    }
    parts.push(Buffer.from(header), deflateSync(object.data));
    count++;
  }
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(count, 8);
  const body = Buffer.concat([head, ...parts]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------------------------
// pkt-lines

const encoder = new TextEncoder();

export const FLUSH = encoder.encode("0000");

export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const length = (bytes.byteLength + 4).toString(16).padStart(4, "0");
  return Buffer.concat([encoder.encode(length), bytes]);
}

/** Wraps `data` in side-band channel `band` (1: pack data, 2: progress, 3: error), in 64 KiB packets. */
export function sideband(band: 1 | 2 | 3, data: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const max = 65515;
  for (
    let offset = 0;
    offset < data.byteLength || offset === 0;
    offset += max
  ) {
    packets.push(
      pktLine(
        Buffer.concat([
          Buffer.from([band]),
          data.subarray(offset, offset + max),
        ]),
      ),
    );
    if (data.byteLength === 0) break;
  }
  return packets;
}

/** Reads pkt-lines from the start of `buf` up to a flush (or the end); returns them and where they stopped. */
export function readPktLines(
  buf: Uint8Array,
  start = 0,
): { lines: string[]; end: number } {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pos = start;
  while (pos + 4 <= buf.byteLength) {
    const length = parseInt(decoder.decode(buf.subarray(pos, pos + 4)), 16);
    if (Number.isNaN(length)) throw new Error("Invalid pkt-line");
    if (length === 0) return { lines, end: pos + 4 };
    if (length < 4) {
      pos += 4; // delim (0001) or response-end (0002)
      continue;
    }
    lines.push(
      decoder.decode(buf.subarray(pos + 4, pos + length)).replace(/\n$/, ""),
    );
    pos += length;
  }
  return { lines, end: pos };
}
