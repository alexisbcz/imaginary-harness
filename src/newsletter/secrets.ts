// Substack session cookies at rest: AES-256-GCM, keyed by NEWSLETTER_SECRET (or, when it is unset, the service role
// key, which the server holds anyway). The table that keeps them has no grant for the browser either.

import { config } from "../config.ts";

let key: Promise<CryptoKey> | undefined;

function keyOf(secret: string) {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`richelieu:newsletter:${secret}`))
    .then((digest) => crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]));
}

const theKey = () => (key ??= keyOf(Bun.env.NEWSLETTER_SECRET || config.serviceRoleKey));

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

export async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await theKey(), new TextEncoder().encode(plain));
  return `v1:${b64(iv)}:${b64(sealed)}`;
}

export async function open(sealed: string): Promise<string> {
  const [version, iv, data] = sealed.split(":");
  if (version !== "v1" || !iv || !data) throw new Error("Unknown secret format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
    await theKey(),
    Buffer.from(data, "base64"),
  );
  return new TextDecoder().decode(plain);
}
