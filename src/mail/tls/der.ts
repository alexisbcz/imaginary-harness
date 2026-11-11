// Just enough ASN.1 DER to write a PKCS#10 certificate request (for ACME) and a self-signed X.509 certificate
// (for local development), signed with an ECDSA P-256 key: node:crypto signs, but writes neither.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

type Der = Uint8Array;

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const tlv = (tag: number, ...content: Uint8Array[]): Der => {
  const body = concat(content);
  return concat([Uint8Array.of(tag), length(body.length), body]);
};

const sequence = (...items: Der[]) => tlv(0x30, ...items);
const set = (...items: Der[]) => tlv(0x31, ...items);
const octets = (bytes: Uint8Array) => tlv(0x04, bytes);
const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const bitString = (bytes: Uint8Array) => tlv(0x03, Uint8Array.of(0), bytes);
const explicit = (n: number, content: Der) => tlv(0xa0 + n, content);

function integer(bytes: Uint8Array | number): Der {
  let value = typeof bytes === "number" ? Uint8Array.of(bytes) : bytes;
  while (value.length > 1 && value[0] === 0 && value[1]! < 0x80)
    value = value.subarray(1);
  if (value[0]! >= 0x80) value = concat([Uint8Array.of(0), value]);
  return tlv(0x02, value);
}

function oid(dotted: string): Der {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const arc of rest) {
    const chunk: number[] = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime after, as RFC 5280 asks. */
function time(date: Date): Der {
  const pad = (n: number) => String(n).padStart(2, "0");
  const body = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const year = date.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, new TextEncoder().encode(`${String(year).slice(2)}${body}`))
    : tlv(0x18, new TextEncoder().encode(`${year}${body}`));
}

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));
const name = (commonName: string) =>
  sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
const subjectAltNames = (names: string[]) =>
  sequence(
    oid("2.5.29.17"),
    octets(
      sequence(...names.map((n) => tlv(0x82, new TextEncoder().encode(n)))),
    ),
  );

const spkiOf = (key: KeyObject) =>
  new Uint8Array(createPublicKey(key).export({ type: "spki", format: "der" }));
const signDer = (data: Uint8Array, key: KeyObject) =>
  new Uint8Array(sign("sha256", data, { key, dsaEncoding: "der" }));

export const toPem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/.{1,64}/g, "$&\n")}-----END ${label}-----\n`;

export function newCertificateKey(): { key: KeyObject; pem: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    key: privateKey,
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** A certificate signing request for `names`, the first being the subject. DER, as ACME's finalize takes it. */
export function createCsr(names: string[], privateKeyPem: string): Uint8Array {
  const key = createPrivateKey(privateKeyPem);
  const extensionRequest = sequence(
    oid("1.2.840.113549.1.9.14"),
    set(sequence(subjectAltNames(names))),
  );
  const info = sequence(
    integer(0),
    name(names[0]!),
    spkiOf(key),
    tlv(0xa0, extensionRequest),
  );
  return sequence(info, ECDSA_SHA256, bitString(signDer(info, key)));
}

/** A self-signed certificate for `names`, valid for `days`: what the servers use until a real one is issued. */
export function createSelfSigned(
  names: string[],
  days = 825,
): { certificate: string; privateKey: string; expiresAt: Date } {
  const { key, pem } = newCertificateKey();
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + days * 86_400_000);
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const basicConstraints = sequence(oid("2.5.29.19"), octets(sequence()));
  const keyUsage = sequence(
    oid("2.5.29.15"),
    tlv(0x01, Uint8Array.of(0xff)),
    octets(tlv(0x03, Uint8Array.of(7, 0x80))),
  );
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    ECDSA_SHA256,
    name(names[0]!),
    sequence(time(notBefore), time(notAfter)),
    name(names[0]!),
    spkiOf(key),
    explicit(3, sequence(subjectAltNames(names), basicConstraints, keyUsage)),
  );
  const der = sequence(tbs, ECDSA_SHA256, bitString(signDer(tbs, key)));
  return {
    certificate: toPem("CERTIFICATE", der),
    privateKey: pem,
    expiresAt: notAfter,
  };
}
