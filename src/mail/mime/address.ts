// Address lists of RFC 5322 (`From`, `To`, `Cc`...): display names, quoted strings, comments and groups.

import { decodeWords } from "./encoding.ts";

export type Address = { name: string; address: string };

/** Splits on `sep` outside quotes, angle brackets and comments. */
function splitOutside(value: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let angle = false;
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && quoted) {
      current += char + (value[++i] ?? "");
      continue;
    }
    if (char === '"' && depth === 0) quoted = !quoted;
    else if (!quoted && char === "(") depth++;
    else if (!quoted && char === ")") depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && char === "<") angle = true;
    else if (!quoted && depth === 0 && char === ">") angle = false;
    if (char === sep && !quoted && depth === 0 && !angle) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

const stripComments = (value: string) => {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && quoted) {
      out += char + (value[++i] ?? "");
      continue;
    }
    if (char === '"' && depth === 0) quoted = !quoted;
    if (!quoted && char === "(") {
      depth++;
      continue;
    }
    if (!quoted && char === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
};

const unquote = (value: string) =>
  value
    .trim()
    .replace(/^"([\s\S]*)"$/, "$1")
    .replace(/\\([\s\S])/g, "$1");

/** One mailbox: `Name <a@b>`, `a@b`, or `a@b (Name)`. */
function parseMailbox(raw: string): Address | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const angle = text.match(/^([\s\S]*?)<([^>]*)>\s*$/);
  if (angle) {
    const name = decodeWords(unquote(stripComments(angle[1]!)));
    return { name: name.trim(), address: angle[2]!.trim() };
  }
  const comment = text.match(/\(([^)]*)\)/);
  const address = stripComments(text).trim();
  return { name: comment ? decodeWords(comment[1]!.trim()) : "", address };
}

/** Every mailbox of an address list, groups flattened. */
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  const addresses: Address[] = [];
  for (const part of splitOutside(value.replace(/\r?\n[ \t]/g, " "), ",")) {
    // A group: `Team: a@b, c@d;`. Its members follow the colon.
    const group = part.match(/^[^"<]*?:([\s\S]*?);?\s*$/);
    const members =
      group && !part.includes("<") ? splitOutside(group[1]!, ",") : [part];
    for (const member of members) {
      const mailbox = parseMailbox(member.replace(/;\s*$/, ""));
      if (mailbox && mailbox.address.includes("@")) addresses.push(mailbox);
    }
  }
  return addresses;
}

/** A mailbox for a header: the name quoted when it needs to be, and encoded when it is not ASCII. */
export function formatAddress(
  { name, address }: Address,
  encode: (value: string) => string,
): string {
  if (!name) return address;
  const display = /^[\x20-\x7e]*$/.test(name)
    ? /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)
      ? name
      : `"${name.replace(/(["\\])/g, "\\$1")}"`
    : encode(name);
  return `${display} <${address}>`;
}

/** The domain of an address, lowercased. */
export const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** `local+tag@domain` → `local@domain`, lowercased: the mailbox plus addressing delivers to. */
export function canonicalAddress(address: string): string {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).split("+")[0]!;
  return `${local}@${address.slice(at + 1)}`.toLowerCase();
}

/** A plausible address: what SMTP and the API accept. */
export const isAddress = (value: string) =>
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
    value,
  ) && value.length <= 254;
