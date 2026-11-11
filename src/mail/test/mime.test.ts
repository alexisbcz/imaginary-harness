import { describe, expect, it } from "bun:test";
import { parseAddressList, canonicalAddress } from "../mime/address.ts";
import { buildMessage } from "../mime/build.ts";
import {
  decodeQuotedPrintable,
  decodeWords,
  encodeQuotedPrintable,
  encodeWord,
} from "../mime/encoding.ts";
import {
  parseMessage,
  partByPath,
  partText,
  summarize,
} from "../mime/parse.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const latin = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe("encodings", () => {
  it("decodes encoded words, joining adjacent ones", () => {
    expect(decodeWords("=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?Q?_cr=C3=A8me?=")).toBe(
      "Café crème",
    );
    expect(decodeWords("=?iso-8859-1?q?Andr=E9?= Pirard")).toBe("André Pirard");
  });

  it("round-trips quoted-printable, with long lines and trailing spaces", () => {
    const text = `${"é".repeat(60)} end \nsecond line=`;
    const encoded = encodeQuotedPrintable(text);
    for (const line of encoded.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(76);
    expect(new TextDecoder().decode(decodeQuotedPrintable(encoded))).toBe(
      text.replace(/\n/g, "\r\n"),
    );
  });

  it("encodes non-ASCII words and leaves ASCII alone", () => {
    expect(encodeWord("Hello")).toBe("Hello");
    expect(
      decodeWords(
        encodeWord("Réunion de lundi — ordre du jour très détaillé et complet"),
      ),
    ).toBe("Réunion de lundi — ordre du jour très détaillé et complet");
  });
});

describe("addresses", () => {
  it("parses names, quotes, comments and groups", () => {
    expect(
      parseAddressList(
        `"Doe, Jane" <jane@example.com>, bob@example.org (Bob), Team: a@x.io, b@x.io;`,
      ),
    ).toEqual([
      { name: "Doe, Jane", address: "jane@example.com" },
      { name: "Bob", address: "bob@example.org" },
      { name: "", address: "a@x.io" },
      { name: "", address: "b@x.io" },
    ]);
    expect(
      parseAddressList("=?UTF-8?B?w4lsb2RpZQ==?= <elodie@example.fr>")[0]!.name,
    ).toBe("Élodie");
  });

  it("drops plus tags for delivery", () => {
    expect(canonicalAddress("Ada+News@Example.COM")).toBe("ada@example.com");
  });
});

describe("messages", () => {
  it("builds a message that parses back to the same content", () => {
    const { raw, messageId } = buildMessage({
      from: { name: "Ada Lovelace", address: "ada@example.com" },
      to: [{ name: "Charles", address: "charles@example.org" }],
      subject: "Notes on the Engine — état",
      text: "Hello Charles,\n\nThe notes are attached.",
      html: "<p>Hello Charles,</p><p>The notes are <b>attached</b>.</p>",
      attachments: [
        {
          filename: "notes été.txt",
          contentType: "text/plain",
          content: bytes("Note G"),
        },
      ],
      inReplyTo: "<earlier@example.org>",
      references: ["<first@example.org>", "<earlier@example.org>"],
    });
    expect(raw).not.toMatch(/[^\r]\n/);
    const summary = summarize(parseMessage(bytes(raw)));
    expect(summary.subject).toBe("Notes on the Engine — état");
    expect(summary.from).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.com",
    });
    expect(summary.text.trimEnd()).toBe(
      "Hello Charles,\r\n\r\nThe notes are attached.",
    );
    expect(summary.html).toContain("<b>attached</b>");
    expect(summary.messageId).toBe(messageId);
    expect(summary.references).toEqual([
      "<first@example.org>",
      "<earlier@example.org>",
    ]);
    expect(summary.attachments).toHaveLength(1);
    expect(summary.attachments[0]!).toMatchObject({
      filename: "notes été.txt",
      contentType: "text/plain",
      size: 6,
    });
  });

  it("numbers parts the way IMAP does", () => {
    const raw = [
      "From: a@b.c",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=E9",
      "--inner",
      "Content-Type: text/html",
      "",
      "<p>Café</p>",
      "--inner--",
      "--outer",
      "Content-Type: application/pdf; name=report.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0=",
      "--outer--",
      "",
    ].join("\r\n");
    const message = parseMessage(latin(raw));
    expect(partText(message, partByPath(message.root, "1.1")!)).toBe("Café");
    expect(partByPath(message.root, "1.2")!.contentType.subtype).toBe("html");
    expect(partByPath(message.root, "2")!.contentType.params.name).toBe(
      "report.pdf",
    );
    const summary = summarize(message);
    expect(summary.text).toBe("Café");
    expect(
      summary.attachments.map((a) => [a.path, a.filename, a.size]),
    ).toEqual([["2", "report.pdf", 5]]);
  });

  it("reads a single-part message without a Content-Type", () => {
    const message = parseMessage(bytes("Subject: hi\r\n\r\nplain body\r\n"));
    expect(summarize(message).text).toBe("plain body\r\n");
    expect(partByPath(message.root, "1")).toBe(message.root);
  });
});
