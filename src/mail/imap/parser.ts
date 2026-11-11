// IMAP command syntax (RFC 3501 / 9051): atoms, quoted strings, literals, parenthesized lists, sequence sets, and
// mailbox names in modified UTF-7. Literals are read by the session (they need a continuation response); the
// tokenizer gets the command as segments: text, then a literal's bytes, then text again.

export type Token =
  | { type: "atom"; value: string }
  | { type: "string"; value: string; bytes?: Uint8Array }
  | { type: "list"; items: Token[] }
  | { type: "nil" };

export class ParseError extends Error {}

/** A command as read off the wire: text segments with literals between them. */
export type Segment = string | Uint8Array;

const ATOM_END = new Set([" ", "(", ")", "{", '"', "\r", "\n"]);

export function tokenize(segments: Segment[]): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  const push = (token: Token) => stack[stack.length - 1]!.push(token);
  for (const segment of segments) {
    if (typeof segment !== "string") {
      push({
        type: "string",
        value: new TextDecoder().decode(segment),
        bytes: segment,
      });
      continue;
    }
    let i = 0;
    while (i < segment.length) {
      const char = segment[i]!;
      if (char === " ") {
        i++;
      } else if (char === "(") {
        const list: Token = { type: "list", items: [] };
        push(list);
        stack.push(list.items);
        i++;
      } else if (char === ")") {
        if (stack.length === 1) throw new ParseError("Unbalanced parenthesis");
        stack.pop();
        i++;
      } else if (char === '"') {
        let value = "";
        i++;
        while (i < segment.length && segment[i] !== '"') {
          if (segment[i] === "\\") i++;
          value += segment[i] ?? "";
          i++;
        }
        if (segment[i] !== '"') throw new ParseError("Unterminated string");
        i++;
        // Quoted strings arrive as bytes on the wire: decode them as UTF-8.
        push({
          type: "string",
          value: Buffer.from(value, "latin1").toString("utf8"),
        });
      } else if (char === "{") {
        // A literal marker; its bytes are the next segment.
        const close = segment.indexOf("}", i);
        if (close === -1) throw new ParseError("Bad literal");
        i = close + 1;
      } else {
        let value = "";
        while (i < segment.length && !ATOM_END.has(segment[i]!)) {
          // Brackets carry spaces and parentheses: BODY[HEADER.FIELDS (FROM TO)]<0.100>
          if (segment[i] === "[") {
            const close = segment.indexOf("]", i);
            if (close === -1) throw new ParseError("Unbalanced bracket");
            value += segment.slice(i, close + 1);
            i = close + 1;
            continue;
          }
          value += segment[i];
          i++;
        }
        push(
          value.toUpperCase() === "NIL"
            ? { type: "nil" }
            : { type: "atom", value },
        );
      }
    }
  }
  if (stack.length !== 1) throw new ParseError("Unbalanced parenthesis");
  return root;
}

/** The literal a line announces at its end: `{12}` (wait for "+") or `{12+}` (LITERAL+, sent at once). */
export function literalAtEnd(
  line: string,
): { size: number; nonSync: boolean } | undefined {
  const match = line.match(/\{(\d+)(\+?)\}$/);
  return match
    ? { size: Number(match[1]), nonSync: match[2] === "+" }
    : undefined;
}

/** A token as text: an atom's or a string's value. */
export function text(token: Token | undefined): string {
  if (!token) throw new ParseError("Missing argument");
  if (token.type === "atom" || token.type === "string") return token.value;
  if (token.type === "nil") return "";
  throw new ParseError("Expected a string");
}

// Sequence sets --------------------------------------------------------------------------------------------

/** `1:3,7,10:*` against the largest number in use; `*` alone is the largest. Returns the numbers as a set test. */
export function parseSequenceSet(
  value: string,
  max: number,
): (n: number) => boolean {
  if (!/^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(value))
    throw new ParseError(`Bad sequence set ${value}`);
  const ranges = value.split(",").map((part) => {
    const [a, b = a] = part.split(":");
    const from = a === "*" ? max : Number(a);
    const to = b === "*" ? max : Number(b);
    return [Math.min(from, to), Math.max(from, to)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Numbers as a compact sequence set: [1,2,3,7] → "1:3,7". */
export function formatSequenceSet(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}:${sorted[i]}`);
  }
  return parts.join(",");
}

// Modified UTF-7 (RFC 3501 section 5.1.3) -------------------------------------------------------------------

export function encodeMailboxName(name: string): string {
  return name.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, (chunk) => {
    const utf16 = Buffer.alloc(chunk.length * 2);
    for (let i = 0; i < chunk.length; i++)
      utf16.writeUInt16BE(chunk.charCodeAt(i), i * 2);
    return `&${utf16.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
  });
}

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, encoded: string) => {
    if (encoded === "") return "&";
    const bytes = Buffer.from(encoded.replace(/,/g, "/"), "base64");
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  });
}

/** IMAP's LIST wildcards: `*` matches anything, `%` anything but the hierarchy delimiter. */
export function mailboxMatcher(
  pattern: string,
  delimiter = "/",
): (name: string) => boolean {
  const source = pattern
    .split("")
    .map((c) =>
      c === "*"
        ? ".*"
        : c === "%"
          ? `[^${delimiter}]*`
          : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  const regex = new RegExp(
    `^${source}$`,
    pattern.toUpperCase().startsWith("INBOX") ? "i" : "",
  );
  return (name) => regex.test(name);
}
