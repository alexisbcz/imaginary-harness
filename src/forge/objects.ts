// Git's object model: blobs, trees, commits and tags, hashed and encoded exactly as git does (SHA-1).

import { createHash } from "node:crypto";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Uint8Array;
}

export const ZERO_OID = "0".repeat(40);
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const isOid = (value: string) => /^[0-9a-f]{40}$/.test(value);

/** The object ID git gives `data` of `type`: SHA-1 of `"<type> <size>\0<data>"`. */
export function hashObject(type: ObjectType, data: Uint8Array): string {
  return createHash("sha1").update(`${type} ${data.byteLength}\0`).update(data).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  /** Octal mode as git writes it: 100644, 100755, 120000 (symlink), 160000 (submodule), 40000 (tree). */
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export const isTreeMode = (mode: string) => mode === "40000" || mode === "040000";

export function entryType(mode: string): "blob" | "tree" | "symlink" | "submodule" {
  if (isTreeMode(mode)) return "tree";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "submodule";
  return "blob";
}

/** Git sorts tree entries by name, a tree's name compared as if it ended with "/". */
function treeSortKey(entry: TreeEntry) {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    const x = treeSortKey(a);
    const y = treeSortKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    const mode = isTreeMode(entry.mode) ? "40000" : entry.mode;
    parts.push(encoder.encode(`${mode} ${entry.name}\0`), Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export function decodeTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = decoder.decode(data.subarray(offset, space));
    const name = decoder.decode(data.subarray(space + 1, nul));
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString("hex");
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Commits and tags

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
  /** Git's offset notation, like +0000 or -0700. */
  readonly timezone: string;
}

export interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
  /** Extra headers such as gpgsig, kept verbatim (continuation lines included). */
  readonly extraHeaders?: readonly [string, string][];
}

export function signatureNow(name: string, email: string, date = new Date()): Signature {
  return { name, email, timestamp: Math.floor(date.getTime() / 1000), timezone: "+0000" };
}

const formatSignature = (s: Signature) => `${s.name} <${s.email}> ${s.timestamp} ${s.timezone}`;

function parseSignature(value: string): Signature {
  const match = /^(.*) <(.*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!match) return { name: value, email: "", timestamp: 0, timezone: "+0000" };
  return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]), timezone: match[4]! };
}

/** An ISO-8601 date with the signature's own offset, as code.storage reports commit dates. */
export function signatureDate(s: Signature): string {
  const sign = s.timezone.startsWith("-") ? -1 : 1;
  const offsetMinutes = sign * (Number(s.timezone.slice(1, 3)) * 60 + Number(s.timezone.slice(3, 5)));
  const local = new Date((s.timestamp + offsetMinutes * 60) * 1000).toISOString().replace(/\.\d{3}Z$/, "");
  return offsetMinutes === 0 ? `${local}Z` : `${local}${s.timezone.slice(0, 3)}:${s.timezone.slice(3)}`;
}

export function encodeCommit(commit: Commit): Uint8Array {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatSignature(commit.author)}`, `committer ${formatSignature(commit.committer)}`);
  for (const [key, value] of commit.extraHeaders ?? []) lines.push(`${key} ${value.replace(/\n/g, "\n ")}`);
  const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return encoder.encode(`${lines.join("\n")}\n\n${message}`);
}

/** Headers, then a blank line, then the message; a header value continues on lines starting with a space. */
function parseHeaders(text: string) {
  const end = text.indexOf("\n\n");
  const head = end === -1 ? text : text.slice(0, end);
  const message = end === -1 ? "" : text.slice(end + 2);
  const headers: [string, string][] = [];
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && headers.length > 0) {
      headers[headers.length - 1]![1] += `\n${line.slice(1)}`;
    } else {
      const space = line.indexOf(" ");
      headers.push([line.slice(0, space), line.slice(space + 1)]);
    }
  }
  return { headers, message };
}

export function decodeCommit(data: Uint8Array): Commit {
  const { headers, message } = parseHeaders(decoder.decode(data));
  let tree = "";
  const parents: string[] = [];
  let author: Signature | undefined;
  let committer: Signature | undefined;
  const extraHeaders: [string, string][] = [];
  for (const [key, value] of headers) {
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parseSignature(value);
    else if (key === "committer") committer = parseSignature(value);
    else extraHeaders.push([key, value]);
  }
  author ??= parseSignature("");
  return { tree, parents, author, committer: committer ?? author, message, extraHeaders };
}

export interface Tag {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
}

export function decodeTag(data: Uint8Array): Tag {
  const { headers } = parseHeaders(decoder.decode(data));
  const get = (key: string) => headers.find(([k]) => k === key)?.[1] ?? "";
  return { object: get("object"), type: get("type") as ObjectType, tag: get("tag") };
}

/** A commit's message without its trailing newline, as APIs report it. */
export const messageOf = (commit: Commit) => commit.message.replace(/\n$/, "");
