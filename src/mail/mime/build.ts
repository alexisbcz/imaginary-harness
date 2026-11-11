// Writes messages: the headers a well-behaved client sends, a text and an HTML alternative, and attachments, with
// CRLF line ends and lines short enough for any server.

import { formatAddress, type Address } from "./address.ts";
import {
  encodeBase64Lines,
  encodeQuotedPrintable,
  encodeWord,
} from "./encoding.ts";

export type OutgoingAttachment = {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
};

export type OutgoingMessage = {
  from: Address;
  to: Address[];
  cc?: Address[];
  /** Left out of the headers; only the envelope carries them. */
  bcc?: Address[];
  replyTo?: Address[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  date?: Date;
  headers?: Record<string, string>;
};

const randomToken = () => crypto.randomUUID().replace(/-/g, "");

export const newMessageId = (domain: string) => `<${randomToken()}@${domain}>`;

/** RFC 5322 date, `Tue, 11 Nov 2026 21:37:00 +0000`. */
export function formatDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** Folds a header line at spaces so no line passes 78 characters. */
export function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 && !value.includes("\r\n")) return line;
  const out: string[] = [];
  for (const segment of line.split("\r\n")) {
    let rest = segment;
    while (rest.length > 78) {
      let cut = rest.lastIndexOf(" ", 78);
      if (cut <= name.length + 1) cut = rest.indexOf(" ", 78);
      if (cut <= 0) break;
      out.push(rest.slice(0, cut));
      rest = ` ${rest.slice(cut + 1)}`;
    }
    out.push(rest);
  }
  return out
    .map((l, i) => (i === 0 || /^[ \t]/.test(l) ? l : ` ${l}`))
    .join("\r\n");
}

const addressList = (addresses: Address[]) =>
  addresses.map((a) => formatAddress(a, encodeWord)).join(", ");

const textPart = (subtype: "plain" | "html", body: string) =>
  `Content-Type: text/${subtype}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(body)}\r\n`;

function attachmentPart(attachment: OutgoingAttachment): string {
  const name = attachment.filename.replace(/["\\\r\n]/g, "_");
  const ascii = /^[\x20-\x7e]*$/.test(name);
  // RFC 2231 for names that are not ASCII; most clients also read the encoded-word form of `name`.
  const filenameParam = ascii
    ? `filename="${name}"`
    : `filename*=utf-8''${encodeURIComponent(name)}`;
  const nameParam = ascii ? `name="${name}"` : `name="${encodeWord(name)}"`;
  const headers = [
    foldHeader("Content-Type", `${attachment.contentType}; ${nameParam}`),
    "Content-Transfer-Encoding: base64",
    foldHeader(
      "Content-Disposition",
      `${attachment.contentId ? "inline" : "attachment"}; ${filenameParam}`,
    ),
  ];
  if (attachment.contentId)
    headers.push(`Content-ID: <${attachment.contentId}>`);
  return `${headers.join("\r\n")}\r\n\r\n${encodeBase64Lines(attachment.content)}`;
}

function multipart(
  subtype: string,
  parts: string[],
): { headers: string; body: string } {
  const boundary = `=_${randomToken()}`;
  return {
    headers: `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    body: `${parts.map((part) => `--${boundary}\r\n${part}`).join("\r\n")}\r\n--${boundary}--\r\n`,
  };
}

/** The message as bytes on the wire, and its Message-ID. */
export function buildMessage(message: OutgoingMessage): {
  raw: string;
  messageId: string;
} {
  const domain = message.from.address.split("@")[1] ?? "localhost";
  const messageId = message.messageId ?? newMessageId(domain);
  const headers = [
    foldHeader("From", addressList([message.from])),
    message.to.length ? foldHeader("To", addressList(message.to)) : undefined,
    message.cc?.length ? foldHeader("Cc", addressList(message.cc)) : undefined,
    message.replyTo?.length
      ? foldHeader("Reply-To", addressList(message.replyTo))
      : undefined,
    foldHeader("Subject", encodeWord(message.subject)),
    `Date: ${formatDate(message.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}` : undefined,
    message.references?.length
      ? foldHeader("References", message.references.join(" "))
      : undefined,
    "MIME-Version: 1.0",
    ...Object.entries(message.headers ?? {}).map(([name, value]) =>
      foldHeader(name, value),
    ),
  ].filter((line): line is string => line !== undefined);

  const text = message.text ?? "";
  const alternatives = message.html
    ? multipart("alternative", [
        textPart("plain", text),
        textPart("html", message.html),
      ])
    : undefined;
  const inline = (message.attachments ?? []).filter((a) => a.contentId);
  const attached = (message.attachments ?? []).filter((a) => !a.contentId);

  let content = alternatives
    ? { headers: alternatives.headers, body: alternatives.body }
    : {
        headers:
          "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable",
        body: `${encodeQuotedPrintable(text)}\r\n`,
      };
  if (inline.length) {
    const related = multipart("related", [
      `${content.headers}\r\n\r\n${content.body}`,
      ...inline.map(attachmentPart),
    ]);
    content = related;
  }
  if (attached.length) {
    content = multipart("mixed", [
      `${content.headers}\r\n\r\n${content.body}`,
      ...attached.map(attachmentPart),
    ]);
  }
  return {
    raw: `${headers.join("\r\n")}\r\n${content.headers}\r\n\r\n${content.body}`,
    messageId,
  };
}

/** `Re: ` once, whatever the subject already starts with. */
export const replySubject = (subject: string) =>
  /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;

/** The quoted original under a reply: `On <date>, <name> wrote:` and the text with `> ` in front. */
export function quoteText(
  text: string,
  from: string,
  date: Date | undefined,
): string {
  const when = date ? date.toUTCString() : "an earlier date";
  return `\n\nOn ${when}, ${from} wrote:\n${text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")}`;
}
