// Parses an RFC 5322 message into its headers and MIME tree, keeping byte offsets, which IMAP's BODY[section]
// fetches need, and reads the parts a mail client shows: the text, the HTML and the attachments.

import { parseAddressList, type Address } from "./address.ts";
import {
  binaryString,
  decodeBase64,
  decodeCharset,
  decodeQuotedPrintable,
  decodeWords,
  mergeParameters,
} from "./encoding.ts";

export type Header = { name: string; value: string; raw: string };

export type ContentType = {
  type: string;
  subtype: string;
  params: Record<string, string>;
};

export type Part = {
  /** IMAP's part number: "1", "1.2"... The root of a single-part message is "1" too, as IMAP numbers it. */
  path: string;
  headers: Header[];
  contentType: ContentType;
  disposition?: { type: string; params: Record<string, string> };
  encoding: string;
  /** Byte offsets in the raw message: the part's header block, and its body. */
  headerStart: number;
  bodyStart: number;
  end: number;
  children: Part[];
  /** For message/rfc822 parts: the enclosed message. */
  message?: Part;
};

export type ParsedMessage = {
  raw: Uint8Array;
  root: Part;
  headers: Header[];
};

const CRLF_CRLF = /\r?\n\r?\n/;

/** Splits a header block into headers, unfolding continuation lines. */
export function parseHeaders(block: string): Header[] {
  const headers: Header[] = [];
  for (const line of block.split(/\r?\n(?![ \t])/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({
      name: line.slice(0, colon).trim(),
      value: line
        .slice(colon + 1)
        .replace(/\r?\n[ \t]/g, " ")
        .trim(),
      raw: line,
    });
  }
  return headers;
}

/** `type; a=b; c="d"`, with parameter names lowercased. */
export function parseParams(value: string): {
  value: string;
  params: Record<string, string>;
} {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && quoted) {
      current += value[++i] ?? "";
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  const raw: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    raw[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return {
    value: parts[0]!.trim().toLowerCase(),
    params: mergeParameters(raw),
  };
}

export const header = (headers: Header[], name: string) =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export const headersNamed = (headers: Header[], name: string) =>
  headers
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value);

function contentTypeOf(
  headers: Header[],
  parentIsDigest: boolean,
): ContentType {
  const value = header(headers, "content-type");
  if (!value)
    return {
      type: parentIsDigest ? "message" : "text",
      subtype: parentIsDigest ? "rfc822" : "plain",
      params: { charset: "us-ascii" },
    };
  const { value: mime, params } = parseParams(value);
  const [type = "text", subtype = "plain"] = mime.split("/");
  return { type, subtype, params };
}

/** Where the blank line ending the header block is: the body's start. */
function splitAt(text: string, from: number, end: number) {
  const slice = text.slice(from, end);
  if (/^\r?\n/.test(slice))
    return {
      headerEnd: from,
      bodyStart: from + (slice.startsWith("\r\n") ? 2 : 1),
    };
  const match = CRLF_CRLF.exec(slice);
  if (!match) return { headerEnd: end, bodyStart: end };
  return {
    headerEnd: from + match.index,
    bodyStart: from + match.index + match[0].length,
  };
}

function parsePart(
  text: string,
  start: number,
  end: number,
  path: string,
  parentIsDigest = false,
  depth = 0,
): Part {
  const { headerEnd, bodyStart } = splitAt(text, start, end);
  const headers = parseHeaders(text.slice(start, headerEnd));
  const contentType = contentTypeOf(headers, parentIsDigest);
  const dispositionValue = header(headers, "content-disposition");
  const disposition = dispositionValue
    ? (({ value, params }) => ({ type: value, params }))(
        parseParams(dispositionValue),
      )
    : undefined;
  const part: Part = {
    path,
    headers,
    contentType,
    disposition,
    encoding: (
      header(headers, "content-transfer-encoding") ?? "7bit"
    ).toLowerCase(),
    headerStart: start,
    bodyStart,
    end,
    children: [],
  };
  if (depth > 32) return part; // a hostile message nests forever

  if (contentType.type === "multipart" && contentType.params.boundary) {
    const boundary = `--${contentType.params.boundary}`;
    const body = text.slice(bodyStart, end);
    // Boundaries start a line; the CRLF before one belongs to it.
    const positions: { at: number; after: number; closing: boolean }[] = [];
    let index = 0;
    while ((index = body.indexOf(boundary, index)) !== -1) {
      const atLineStart = index === 0 || body[index - 1] === "\n";
      if (atLineStart) {
        const closing = body.startsWith("--", index + boundary.length);
        const lineEnd = body.indexOf("\n", index);
        const lineStart =
          index > 0 ? (body[index - 2] === "\r" ? index - 2 : index - 1) : 0;
        positions.push({
          at: lineStart,
          after: lineEnd === -1 ? body.length : lineEnd + 1,
          closing,
        });
        if (closing) break;
      }
      index += boundary.length;
    }
    for (let i = 0; i < positions.length - 1; i++) {
      if (positions[i]!.closing) break;
      const childStart = bodyStart + positions[i]!.after;
      const childEnd = bodyStart + positions[i + 1]!.at;
      part.children.push(
        parsePart(
          text,
          childStart,
          Math.max(childStart, childEnd),
          path === "" ? String(i + 1) : `${path}.${i + 1}`,
          contentType.subtype === "digest",
          depth + 1,
        ),
      );
    }
    // A multipart without a closing boundary still has its last part.
    const last = positions.at(-1);
    if (last && !last.closing) {
      const childStart = bodyStart + last.after;
      if (childStart < end)
        part.children.push(
          parsePart(
            text,
            childStart,
            end,
            path === ""
              ? String(positions.length)
              : `${path}.${positions.length}`,
            false,
            depth + 1,
          ),
        );
    }
  } else if (
    contentType.type === "message" &&
    contentType.subtype === "rfc822" &&
    !["base64", "quoted-printable"].includes(part.encoding)
  ) {
    part.message = parsePart(text, bodyStart, end, path, false, depth + 1);
  }
  return part;
}

export function parseMessage(raw: Uint8Array): ParsedMessage {
  const text = binaryString(raw);
  const root = parsePart(text, 0, text.length, "");
  return { raw, root, headers: root.headers };
}

/** A part's body after its transfer encoding, as bytes. */
export function partBytes(message: ParsedMessage, part: Part): Uint8Array {
  const body = binaryString(message.raw.subarray(part.bodyStart, part.end));
  if (part.encoding === "base64") return decodeBase64(body);
  if (part.encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return message.raw.subarray(part.bodyStart, part.end);
}

/** A text part's body as text, in its charset. */
export const partText = (message: ParsedMessage, part: Part) =>
  decodeCharset(partBytes(message, part), part.contentType.params.charset);

/** Every leaf part, depth first; enclosed messages are leaves (shown as attachments). */
export function leaves(part: Part): Part[] {
  if (part.children.length) return part.children.flatMap(leaves);
  return [part];
}

/** A part by its IMAP number ("1.2"), looking inside enclosed messages too. */
export function partByPath(root: Part, path: string): Part | undefined {
  if (path === "") return root;
  let current: Part | undefined = root;
  for (const segment of path.split(".")) {
    if (!current) return undefined;
    const index = Number(segment);
    const container: Part = current.message ?? current;
    if (container.children.length === 0) {
      // A single-part message's only part is "1".
      current = index === 1 ? container : undefined;
    } else current = container.children[index - 1];
  }
  return current;
}

export type Attachment = {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  inline: boolean;
};

export type Summary = {
  subject: string;
  from: Address | undefined;
  sender: Address | undefined;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  date: Date | undefined;
  messageId: string | undefined;
  inReplyTo: string | undefined;
  references: string[];
  text: string;
  html: string | undefined;
  attachments: Attachment[];
};

/** `<a@b> <c@d>` → ["<a@b>", "<c@d>"]. */
export const messageIds = (value: string | undefined) =>
  value?.match(/<[^<>\s]+>/g) ?? [];

/** Plain text from HTML, for a message that only has HTML: its snippet and the agent's reading. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What a mail client shows of a message. */
export function summarize(message: ParsedMessage): Summary {
  const h = message.headers;
  const first = (name: string) => parseAddressList(header(h, name))[0];
  let text: string | undefined;
  let html: string | undefined;
  const attachments: Attachment[] = [];

  const visit = (part: Part, inAlternative: boolean) => {
    const { type, subtype } = part.contentType;
    if (type === "multipart") {
      // In an alternative, the last part is the richest; keep the first plain text and the last HTML.
      for (const child of part.children)
        visit(child, subtype === "alternative");
      return;
    }
    const filename =
      part.disposition?.params.filename ?? part.contentType.params.name;
    // A body is plain text or HTML that is not marked as an attachment and has no file name.
    const isBody =
      type === "text" &&
      (subtype === "plain" || subtype === "html") &&
      part.disposition?.type !== "attachment" &&
      filename === undefined;
    if (isBody && subtype === "plain") {
      if (text === undefined) text = partText(message, part);
      return;
    }
    if (isBody && subtype === "html") {
      if (html === undefined || inAlternative) html = partText(message, part);
      return;
    }
    const size = partBytes(message, part).length;
    attachments.push({
      path: part.path || "1",
      filename: decodeWords(
        filename ??
          (type === "message"
            ? "message.eml"
            : `part-${part.path || "1"}.${subtype}`),
      ),
      contentType: `${type}/${subtype}`,
      size,
      contentId: header(part.headers, "content-id")?.replace(/^<|>$/g, ""),
      inline:
        part.disposition?.type === "inline" ||
        (!part.disposition && header(part.headers, "content-id") !== undefined),
    });
  };
  visit(message.root, false);

  const dateHeader = header(h, "date");
  const date = dateHeader
    ? new Date(dateHeader.replace(/\s*\([^)]*\)\s*$/, ""))
    : undefined;
  return {
    subject: decodeWords(header(h, "subject") ?? ""),
    from: first("from"),
    sender: first("sender"),
    replyTo: parseAddressList(header(h, "reply-to")),
    to: parseAddressList(header(h, "to")),
    cc: parseAddressList(header(h, "cc")),
    bcc: parseAddressList(header(h, "bcc")),
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    messageId: messageIds(header(h, "message-id"))[0],
    inReplyTo: messageIds(header(h, "in-reply-to"))[0],
    references: messageIds(header(h, "references")),
    text: text ?? (html ? htmlToText(html) : ""),
    html,
    attachments,
  };
}
