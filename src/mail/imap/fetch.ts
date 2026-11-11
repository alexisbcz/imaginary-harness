// What FETCH returns: ENVELOPE and BODYSTRUCTURE built from the parsed message, and BODY[section]<partial> cut from
// its raw bytes, so a client gets exactly what was sent, signatures intact.

import { parseAddressList } from "../mime/address.ts";
import { binaryString, bytesOf, encodeWord } from "../mime/encoding.ts";
import {
  header,
  parseHeaders,
  type Header,
  type ParsedMessage,
  type Part,
  partByPath,
} from "../mime/parse.ts";
import { ParseError } from "./parser.ts";

/** A response piece: text, or bytes sent as a literal. */
export type Piece = string | { literal: Uint8Array };

/** An IMAP string: quoted when it can be, a literal otherwise. NIL for undefined. */
export function istring(value: string | undefined | null): Piece {
  if (value === undefined || value === null) return "NIL";
  if (/^[\x20-\x7e]*$/.test(value) && value.length < 1000)
    return `"${value.replace(/(["\\])/g, "\\$1")}"`;
  return { literal: new TextEncoder().encode(value) };
}

/** Bytes as an IMAP string: quoted if plain ASCII, a literal otherwise. */
export function ibytes(bytes: Uint8Array): Piece {
  if (bytes.length < 200 && bytes.every((b) => b >= 0x20 && b <= 0x7e))
    return istring(binaryString(bytes));
  return { literal: bytes };
}

export function join(pieces: Piece[], separator = " "): Piece[] {
  const out: Piece[] = [];
  pieces.forEach((piece, i) => {
    if (i > 0) out.push(separator);
    out.push(piece);
  });
  return out;
}

/** A parenthesized list of groups of pieces: groups are separated by spaces. */
export function list(groups: Piece[][]): Piece[] {
  const out: Piece[] = ["("];
  groups.forEach((group, i) => {
    if (i > 0) out.push(" ");
    out.push(...group);
  });
  out.push(")");
  return out;
}

const one = (piece: Piece): Piece[] => [piece];

function addresses(headers: Header[], name: string): Piece[] {
  const parsed = parseAddressList(header(headers, name));
  if (parsed.length === 0) return ["NIL"];
  return list(
    parsed.map((a) => {
      const at = a.address.lastIndexOf("@");
      return list([
        one(istring(a.name ? encodeWord(a.name) : undefined)),
        ["NIL"],
        one(istring(a.address.slice(0, at))),
        one(istring(a.address.slice(at + 1))),
      ]);
    }),
  );
}

/** ENVELOPE, from the header values as they were written (encoded words kept). */
export function envelope(headers: Header[]): Piece[] {
  const from = addresses(headers, "from");
  const pick = (name: string) =>
    header(headers, name) ? addresses(headers, name) : from;
  return list([
    one(istring(header(headers, "date"))),
    one(istring(header(headers, "subject"))),
    from,
    pick("sender"),
    pick("reply-to"),
    addresses(headers, "to"),
    addresses(headers, "cc"),
    addresses(headers, "bcc"),
    one(istring(header(headers, "in-reply-to"))),
    one(istring(header(headers, "message-id"))),
  ]);
}

const paramList = (params: Record<string, string>): Piece[] =>
  Object.keys(params).length
    ? list(
        Object.entries(params).flatMap(([k, v]) => [
          one(istring(k.toUpperCase())),
          one(istring(v)),
        ]),
      )
    : ["NIL"];

const lineCount = (message: ParsedMessage, part: Part) => {
  let lines = 0;
  for (let i = part.bodyStart; i < part.end; i++)
    if (message.raw[i] === 0x0a) lines++;
  return lines;
};

/** BODYSTRUCTURE (with extension data) or BODY (without). */
export function bodyStructure(
  message: ParsedMessage,
  part: Part,
  extended: boolean,
): Piece[] {
  const { type, subtype, params } = part.contentType;
  const disposition = part.disposition
    ? list([
        one(istring(part.disposition.type.toUpperCase())),
        paramList(part.disposition.params),
      ])
    : ["NIL"];
  const language = one(istring(header(part.headers, "content-language")));
  const location = one(istring(header(part.headers, "content-location")));
  if (type === "multipart") {
    // Children follow each other without spaces: ((...)(...) "MIXED" ...).
    const children = part.children.length
      ? part.children.flatMap((child) =>
          bodyStructure(message, child, extended),
        )
      : ['("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0)'];
    const ext = extended
      ? [
          " ",
          ...paramList(params),
          " ",
          ...disposition,
          " ",
          ...language,
          " ",
          ...location,
        ]
      : [];
    return ["(", ...children, " ", istring(subtype.toUpperCase()), ...ext, ")"];
  }
  const fields: Piece[][] = [
    one(istring(type.toUpperCase())),
    one(istring(subtype.toUpperCase())),
    paramList(params),
    one(istring(header(part.headers, "content-id"))),
    one(istring(header(part.headers, "content-description"))),
    one(istring(part.encoding.toUpperCase())),
    [String(part.end - part.bodyStart)],
  ];
  if (type === "message" && subtype === "rfc822" && part.message) {
    fields.push(
      envelope(part.message.headers),
      bodyStructure(message, part.message, extended),
      [String(lineCount(message, part))],
    );
  } else if (type === "text") fields.push([String(lineCount(message, part))]);
  if (extended)
    fields.push(
      one(istring(header(part.headers, "content-md5"))),
      disposition,
      language,
      location,
    );
  return list(fields);
}

/** The bytes of a BODY[...] section of a message. */
export function section(message: ParsedMessage, spec: string): Uint8Array {
  const raw = message.raw;
  const match = spec.match(
    /^((?:\d+\.)*\d+)?\.?(HEADER\.FIELDS\.NOT|HEADER\.FIELDS|HEADER|TEXT|MIME)?(?:\s*\(([^)]*)\))?$/i,
  );
  if (!match) throw new ParseError(`Bad section ${spec}`);
  const [, path = "", rawKind, fieldList] = match;
  const kind = rawKind?.toUpperCase();
  let part: Part | undefined = message.root;
  if (path) {
    part = partByPath(message.root, path);
    if (!part) return new Uint8Array();
  }
  // HEADER and TEXT of a part mean those of the message it encloses.
  const target =
    path &&
    (kind === "HEADER" || kind === "TEXT" || kind?.startsWith("HEADER.FIELDS"))
      ? (part.message ?? part)
      : part;
  switch (kind) {
    case undefined:
      return path ? raw.subarray(part.bodyStart, part.end) : raw;
    case "MIME":
    case "HEADER":
      return raw.subarray(target.headerStart, target.bodyStart);
    case "TEXT":
      return raw.subarray(target.bodyStart, target.end);
    default: {
      const names = new Set(
        (fieldList ?? "")
          .replace(/"/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((n) => n.toLowerCase()),
      );
      const not = kind === "HEADER.FIELDS.NOT";
      const headers = parseHeaders(
        binaryString(raw.subarray(target.headerStart, target.bodyStart)),
      );
      const kept = headers.filter(
        (h) => names.has(h.name.toLowerCase()) !== not,
      );
      return bytesOf(
        `${kept.map((h) => `${h.raw.replace(/\r?\n/g, "\r\n")}\r\n`).join("")}\r\n`,
      );
    }
  }
}

export type FetchItem =
  | {
      kind:
        | "UID"
        | "FLAGS"
        | "INTERNALDATE"
        | "RFC822.SIZE"
        | "ENVELOPE"
        | "BODYSTRUCTURE"
        | "BODY"
        | "MODSEQ";
    }
  | { kind: "RFC822" | "RFC822.HEADER" | "RFC822.TEXT" }
  | {
      kind: "SECTION";
      peek: boolean;
      section: string;
      partial?: [number, number];
      label: string;
    };

/** FETCH's item list: `(FLAGS BODY.PEEK[HEADER.FIELDS (FROM)]<0.512>)`, or a macro. */
export function parseFetchItems(tokens: {
  type: string;
  value?: string;
  items?: unknown[];
}): FetchItem[] {
  const atoms: string[] =
    tokens.type === "list"
      ? (tokens.items as { value: string }[]).map((t) => t.value)
      : [tokens.value ?? ""];
  const items: FetchItem[] = [];
  for (const raw of atoms) {
    const atom = raw.toUpperCase();
    if (atom === "ALL")
      items.push(
        { kind: "FLAGS" },
        { kind: "INTERNALDATE" },
        { kind: "RFC822.SIZE" },
        { kind: "ENVELOPE" },
      );
    else if (atom === "FAST")
      items.push(
        { kind: "FLAGS" },
        { kind: "INTERNALDATE" },
        { kind: "RFC822.SIZE" },
      );
    else if (atom === "FULL")
      items.push(
        { kind: "FLAGS" },
        { kind: "INTERNALDATE" },
        { kind: "RFC822.SIZE" },
        { kind: "ENVELOPE" },
        { kind: "BODY" },
      );
    else if (
      [
        "UID",
        "FLAGS",
        "INTERNALDATE",
        "RFC822.SIZE",
        "ENVELOPE",
        "BODYSTRUCTURE",
        "BODY",
        "MODSEQ",
        "RFC822",
        "RFC822.HEADER",
        "RFC822.TEXT",
      ].includes(atom)
    )
      items.push({ kind: atom as "UID" });
    else {
      const match = raw.match(
        /^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i,
      );
      if (!match) throw new ParseError(`Unknown fetch item ${raw}`);
      const spec = match[2]!.toUpperCase().replace(/\s+/g, " ");
      items.push({
        kind: "SECTION",
        peek: match[1] !== undefined,
        section: spec,
        partial:
          match[3] !== undefined
            ? [Number(match[3]), Number(match[4])]
            : undefined,
        label: `BODY[${spec}]${match[3] !== undefined ? `<${match[3]}>` : ""}`,
      });
    }
  }
  return items;
}

/** INTERNALDATE: `11-Nov-2026 21:37:00 +0000`. */
export function formatInternalDate(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** `11-Nov-2026 21:37:00 +0100` (APPEND) or `11-Nov-2026` (SEARCH) to a Date. */
export function parseImapDate(value: string): Date | undefined {
  const match = value
    .trim()
    .match(
      /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}))?$/,
    );
  if (!match) return undefined;
  const month = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(match[2]!.toLowerCase());
  if (month < 0) return undefined;
  const [
    ,
    d,
    ,
    y,
    hh = "0",
    mm = "0",
    ss = "0",
    sign = "+",
    zh = "0",
    zm = "0",
  ] = match;
  const offset = (sign === "-" ? -1 : 1) * (Number(zh) * 60 + Number(zm));
  return new Date(
    Date.UTC(Number(y), month, Number(d), Number(hh), Number(mm), Number(ss)) -
      offset * 60_000,
  );
}
