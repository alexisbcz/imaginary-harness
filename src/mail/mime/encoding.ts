// The encodings of RFC 2045 and RFC 2047: base64, quoted-printable, and encoded words in headers, decoded to text
// through the charsets `TextDecoder` knows.

const latin1 = new TextDecoder("latin1");
const utf8 = new TextEncoder();

/** Bytes to a string with one character per byte, the way raw headers are read. */
export const binaryString = (bytes: Uint8Array) => latin1.decode(bytes);

/** A string with one character per byte back to its bytes. */
export function bytesOf(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

/** Text in `charset`, falling back to UTF-8, then Latin-1, for charsets the platform does not know. */
export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
  const label = charset.trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  try {
    return new TextDecoder(label === "us-ascii" ? "utf-8" : label).decode(
      bytes,
    );
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return latin1.decode(bytes);
    }
  }
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  return Uint8Array.from(Buffer.from(clean, "base64"));
}

/** Base64 in lines of 76 characters, as MIME bodies are written. */
export function encodeBase64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  return encoded.replace(/.{1,76}/g, "$&\r\n");
}

export function decodeQuotedPrintable(text: string): Uint8Array {
  const out: number[] = [];
  const source = text.replace(/[ \t]+(\r?\n)/g, "$1"); // trailing whitespace is padding
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "=") {
      const next = source.slice(i + 1, i + 3);
      if (next.startsWith("\r\n")) {
        i += 2;
        continue;
      }
      if (next.startsWith("\n")) {
        i += 1;
        continue;
      }
      if (/^[0-9A-Fa-f]{2}$/.test(next)) {
        out.push(parseInt(next, 16));
        i += 2;
        continue;
      }
    }
    out.push(char.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Quoted-printable of UTF-8 text, in lines of at most 76 characters, with CRLF line ends. */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r?\n/g, "\n").split("\n");
  return lines
    .map((line) => {
      let encoded = "";
      for (const byte of utf8.encode(line)) {
        const char = String.fromCharCode(byte);
        encoded +=
          (byte >= 33 && byte <= 126 && byte !== 61) ||
          byte === 32 ||
          byte === 9
            ? char
            : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
      // Whitespace at the end of a line would be stripped in transit.
      encoded = encoded.replace(
        /[ \t]$/,
        (space) =>
          `=${space.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
      );
      const wrapped: string[] = [];
      while (encoded.length > 76) {
        let cut = 75;
        // Never split an =XX escape.
        const escape = encoded.lastIndexOf("=", cut);
        if (escape > cut - 3) cut = escape;
        wrapped.push(`${encoded.slice(0, cut)}=`);
        encoded = encoded.slice(cut);
      }
      wrapped.push(encoded);
      return wrapped.join("\r\n");
    })
    .join("\r\n");
}

/** Decodes the RFC 2047 encoded words of a header value: `=?utf-8?B?...?=` and `=?iso-8859-1?Q?...?=`. */
export function decodeWords(value: string): string {
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = value.replace(
    /(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g,
    "$1",
  );
  return joined.replace(
    /=\?([^?*]+)(?:\*[^?]+)?\?([BbQq])\?([^?]*)\?=/g,
    (_, charset: string, encoding: string, data: string) => {
      const bytes =
        encoding.toUpperCase() === "B"
          ? decodeBase64(data)
          : decodeQuotedPrintable(data.replace(/_/g, " "));
      return decodeCharset(bytes, charset);
    },
  );
}

/** A header value as an encoded word when it is not plain ASCII; plain ASCII is returned as is. */
export function encodeWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Encoded words are at most 75 characters: split the text into chunks that fit, on character boundaries.
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`)
    .join("\r\n ");
}

/** RFC 2231 parameter continuations and charsets (`filename*0*=utf-8''...`), merged into plain values. */
export function mergeParameters(
  raw: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const continued: Record<
    string,
    { index: number; value: string; encoded: boolean }[]
  > = {};
  for (const [key, value] of Object.entries(raw)) {
    const match = key.match(/^([^*]+)\*(\d+)?(\*)?$/);
    if (!match) {
      result[key] = value;
      continue;
    }
    const [, name, index, star] = match;
    (continued[name!] ??= []).push({
      index: index === undefined ? 0 : Number(index),
      value,
      encoded: star === "*" || (index === undefined && key.endsWith("*")),
    });
  }
  for (const [name, parts] of Object.entries(continued)) {
    parts.sort((a, b) => a.index - b.index);
    let charset = "utf-8";
    const bytes: number[] = [];
    parts.forEach((part, position) => {
      let value = part.value;
      if (part.encoded) {
        if (position === 0) {
          const [cs, , rest] = value.split("'");
          if (rest !== undefined) {
            charset = cs || "utf-8";
            value = rest;
          }
        }
        value.replace(
          /%([0-9A-Fa-f]{2})|[\s\S]/g,
          (whole, hex: string | undefined) => {
            if (hex) bytes.push(parseInt(hex, 16));
            else for (const b of utf8.encode(whole)) bytes.push(b);
            return "";
          },
        );
      } else for (const b of utf8.encode(value)) bytes.push(b);
    });
    result[name] = decodeCharset(Uint8Array.from(bytes), charset);
  }
  return result;
}
