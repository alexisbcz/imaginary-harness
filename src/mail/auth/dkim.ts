// DKIM (RFC 6376, and RFC 8463 for Ed25519): signs outgoing messages with the domain's key, and verifies every
// signature of incoming ones against the key its selector publishes in DNS.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { binaryString, bytesOf } from "../mime/encoding.ts";
import { parseHeaders, type Header } from "../mime/parse.ts";
import { DnsTempError, type Resolver } from "./dns.ts";

export type DkimAlgorithm = "rsa-sha256" | "ed25519-sha256";

/** What a signature covers: the headers that make the message what it is. `from` twice, so none can be added. */
const SIGNED_HEADERS = [
  "from",
  "from",
  "reply-to",
  "subject",
  "date",
  "to",
  "cc",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "list-unsubscribe",
];

/** The header block and the body of a raw message, split at the first empty line. */
export function splitMessage(raw: string): { headers: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { headers: raw, body: "" };
  return {
    headers: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

const toCrlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

export function canonicalizeBody(
  body: string,
  mode: "simple" | "relaxed",
): string {
  let text = toCrlf(body);
  if (mode === "relaxed") {
    text = text
      .split("\r\n")
      .map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""))
      .join("\r\n");
  }
  text = text.replace(/(\r\n)*$/, "");
  if (text === "") return mode === "simple" ? "\r\n" : "";
  return `${text}\r\n`;
}

export function canonicalizeHeader(
  header: Header,
  mode: "simple" | "relaxed",
): string {
  if (mode === "simple") return `${header.raw}\r\n`;
  const value = header.raw
    .slice(header.raw.indexOf(":") + 1)
    .replace(/\r?\n/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${header.name.toLowerCase().trim()}:${value}\r\n`;
}

/** The headers named in `h=`, each picked from the bottom up, as the specification requires. */
function selectHeaders(headers: Header[], names: string[]): Header[] {
  const used = new Map<string, number>();
  const picked: Header[] = [];
  for (const name of names) {
    const key = name.toLowerCase().trim();
    const matching = headers.filter((h) => h.name.toLowerCase() === key);
    const count = used.get(key) ?? 0;
    const header = matching[matching.length - 1 - count];
    used.set(key, count + 1);
    if (header) picked.push(header);
  }
  return picked;
}

export function parseTags(value: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of value.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    tags[pair.slice(0, eq).trim()] = pair.slice(eq + 1).replace(/\s+/g, "");
  }
  return tags;
}

/** A fresh key pair and the DNS TXT value publishing it. RSA 2048 by default: every receiver checks it. */
export function generateDkimKey(algorithm: DkimAlgorithm = "rsa-sha256") {
  if (algorithm === "ed25519-sha256") {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    return {
      privateKey: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      dnsValue: `v=DKIM1; k=ed25519; p=${Buffer.from(raw).toString("base64")}`,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    dnsValue: `v=DKIM1; k=rsa; p=${Buffer.from(spki).toString("base64")}`,
  };
}

const algorithmOf = (key: KeyObject): DkimAlgorithm =>
  key.asymmetricKeyType === "ed25519" ? "ed25519-sha256" : "rsa-sha256";

function signData(
  algorithm: DkimAlgorithm,
  data: string,
  key: KeyObject,
): string {
  const bytes = bytesOf(data);
  if (algorithm === "ed25519-sha256")
    return sign(
      null,
      createHash("sha256").update(bytes).digest(),
      key,
    ).toString("base64");
  return sign("sha256", bytes, key).toString("base64");
}

/**
 * Signs a raw message (relaxed/relaxed) and returns it with the `DKIM-Signature` header on top. The message's
 * line ends become CRLF, as they travel.
 */
export function signMessage(
  rawMessage: string,
  options: { domain: string; selector: string; privateKey: string; now?: Date },
): string {
  const raw = toCrlf(rawMessage);
  const key = createPrivateKey(options.privateKey);
  const algorithm = algorithmOf(key);
  const { headers: block, body } = splitMessage(raw);
  const headers = parseHeaders(block);
  const present = new Set(headers.map((h) => h.name.toLowerCase()));
  // Sign what is there; `from` twice covers a second From someone might add.
  const names = SIGNED_HEADERS.filter(
    (name, index) => present.has(name) || (name === "from" && index === 1),
  );
  const bodyHash = createHash("sha256")
    .update(bytesOf(canonicalizeBody(body, "relaxed")))
    .digest("base64");
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
  // The header is signed exactly as it is sent, folded, with b= empty: folds become spaces in relaxed mode, so
  // signing another layout would not verify.
  const tags = [
    `v=1;`,
    `a=${algorithm};`,
    `c=relaxed/relaxed;`,
    `d=${options.domain};`,
    `s=${options.selector};`,
    `t=${timestamp};`,
  ];
  const lines: string[] = [];
  let line = "DKIM-Signature:";
  const push = (piece: string, separator = " ") => {
    if (line.length + separator.length + piece.length > 76) {
      lines.push(line);
      line = `\t${piece}`;
    } else line += `${separator}${piece}`;
  };
  for (const tag of tags) push(tag);
  // h= folds at its colons, where the grammar allows whitespace.
  names.forEach((name, index) =>
    push(
      `${index === 0 ? "h=" : ""}${name}${index === names.length - 1 ? ";" : ":"}`,
      index === 0 ? " " : "",
    ),
  );
  push(`bh=${bodyHash};`);
  push("b=");
  lines.push(line);
  const head = lines.join("\r\n");
  const unsigned: Header = { name: "DKIM-Signature", value: "", raw: head };
  const data =
    selectHeaders(headers, names)
      .map((h) => canonicalizeHeader(h, "relaxed"))
      .join("") + canonicalizeHeader(unsigned, "relaxed").replace(/\r\n$/, "");
  const signature = signData(algorithm, data, key);
  const folded = signature
    .replace(/.{1,72}/g, "$&\r\n\t")
    .replace(/\r\n\t$/, "");
  return `${head}\r\n\t${folded}\r\n${raw}`;
}

export type DkimResult = {
  result:
    "pass" | "fail" | "neutral" | "temperror" | "permerror" | "policy" | "none";
  domain?: string;
  selector?: string;
  algorithm?: string;
  reason?: string;
};

async function publicKeyOf(
  resolver: Resolver,
  selector: string,
  domain: string,
) {
  const records = await resolver.txt(`${selector}._domainkey.${domain}`);
  const record = records.map(parseTags).find((tags) => tags.p !== undefined);
  if (!record) return undefined;
  if (record.p === "") return { revoked: true as const };
  const der = Buffer.from(record.p!, "base64");
  const type = (record.k ?? "rsa").toLowerCase();
  if (type === "ed25519") {
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      der,
    ]);
    return {
      key: createPublicKey({ key: spki, format: "der", type: "spki" }),
      type,
      tags: record,
    };
  }
  try {
    return {
      key: createPublicKey({ key: der, format: "der", type: "spki" }),
      type,
      tags: record,
    };
  } catch {
    return {
      key: createPublicKey({ key: der, format: "der", type: "pkcs1" }),
      type,
      tags: record,
    };
  }
}

async function verifyOne(
  raw: string,
  headers: Header[],
  body: string,
  signatureHeader: Header,
  resolver: Resolver,
  now: Date,
): Promise<DkimResult> {
  const tags = parseTags(
    signatureHeader.raw.slice(signatureHeader.raw.indexOf(":") + 1),
  );
  const domain = tags.d?.toLowerCase();
  const selector = tags.s;
  const base = { domain, selector, algorithm: tags.a };
  if (
    tags.v !== "1" ||
    !domain ||
    !selector ||
    !tags.h ||
    !tags.bh ||
    tags.b === undefined ||
    !tags.a
  )
    return {
      ...base,
      result: "permerror",
      reason: "the signature misses a required tag",
    };
  if (tags.a !== "rsa-sha256" && tags.a !== "ed25519-sha256")
    return {
      ...base,
      result: "neutral",
      reason: `unsupported algorithm ${tags.a}`,
    };
  const signedNames = tags.h.split(":").map((n) => n.toLowerCase());
  if (!signedNames.includes("from"))
    return { ...base, result: "permerror", reason: "From is not signed" };
  if (tags.i && !tags.i.toLowerCase().endsWith(domain))
    return { ...base, result: "permerror", reason: "i= is outside d=" };
  if (tags.x && Number(tags.x) < now.getTime() / 1000)
    return { ...base, result: "neutral", reason: "the signature expired" };
  const [headerMode = "simple", bodyMode = "simple"] = (
    tags.c ?? "simple/simple"
  )
    .toLowerCase()
    .split("/") as ("simple" | "relaxed")[];

  let canonicalBody = canonicalizeBody(body, bodyMode);
  if (tags.l !== undefined)
    canonicalBody = canonicalBody.slice(0, Number(tags.l));
  const bodyHash = createHash("sha256")
    .update(bytesOf(canonicalBody))
    .digest("base64");
  if (bodyHash !== tags.bh)
    return { ...base, result: "fail", reason: "the body hash does not match" };

  let published;
  try {
    published = await publicKeyOf(resolver, selector, domain);
  } catch (error) {
    if (error instanceof DnsTempError)
      return { ...base, result: "temperror", reason: error.message };
    return {
      ...base,
      result: "permerror",
      reason: "the published key is invalid",
    };
  }
  if (!published)
    return {
      ...base,
      result: "permerror",
      reason: `no key at ${selector}._domainkey.${domain}`,
    };
  if ("revoked" in published)
    return { ...base, result: "permerror", reason: "the key was revoked" };
  if ((published.type === "ed25519") !== (tags.a === "ed25519-sha256"))
    return {
      ...base,
      result: "permerror",
      reason: "the key type does not match the algorithm",
    };

  // The signature header itself, with b= emptied.
  const stripped: Header = {
    ...signatureHeader,
    raw: signatureHeader.raw.replace(/(\bb=)[^;]*/, "$1"),
  };
  const data =
    selectHeaders(headers, signedNames)
      .map((h) => canonicalizeHeader(h, headerMode))
      .join("") + canonicalizeHeader(stripped, headerMode).replace(/\r\n$/, "");
  const signature = Buffer.from(tags.b, "base64");
  const bytes = bytesOf(data);
  const ok =
    tags.a === "ed25519-sha256"
      ? verify(
          null,
          createHash("sha256").update(bytes).digest(),
          published.key,
          signature,
        )
      : verify("sha256", bytes, published.key, signature);
  if (!ok)
    return { ...base, result: "fail", reason: "the signature does not verify" };
  if (
    published.key.asymmetricKeyType === "rsa" &&
    (published.key.asymmetricKeyDetails?.modulusLength ?? 0) < 1024
  )
    return {
      ...base,
      result: "policy",
      reason: "the key is shorter than 1024 bits",
    };
  return { ...base, result: "pass" };
}

/** Every DKIM signature of a message, verified. An unsigned message gives `[{ result: "none" }]`. */
export async function verifyDkim(
  rawMessage: Uint8Array | string,
  resolver: Resolver,
  now = new Date(),
): Promise<DkimResult[]> {
  const raw = toCrlf(
    typeof rawMessage === "string" ? rawMessage : binaryString(rawMessage),
  );
  const { headers: block, body } = splitMessage(raw);
  const headers = parseHeaders(block);
  const signatures = headers
    .filter((h) => h.name.toLowerCase() === "dkim-signature")
    .slice(0, 8);
  if (signatures.length === 0) return [{ result: "none" }];
  return Promise.all(
    signatures.map((signature) =>
      verifyOne(raw, headers, body, signature, resolver, now),
    ),
  );
}
