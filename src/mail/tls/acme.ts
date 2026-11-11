// An ACME client (RFC 8555) for Let's Encrypt or any other CA: one account per directory, HTTP-01 challenges
// answered from Postgres by whichever process serves port 80 (`/.well-known/acme-challenge/<token>`), and
// certificates stored in `mail.certificates` for every process to load.

import type { SQL } from "bun";
import {
  calculateJwkThumbprint,
  exportJWK,
  FlattenedSign,
  generateKeyPair,
  importJWK,
  type JWK,
} from "jose";
import { createCsr, newCertificateKey } from "./der.ts";

type Directory = {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  meta?: { termsOfService?: string };
};
type Order = {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: unknown;
};
type Authorization = {
  status: string;
  identifier: { value: string };
  challenges: {
    type: string;
    url: string;
    token: string;
    status: string;
    error?: unknown;
  }[];
};

const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly problem?: { type?: string; detail?: string },
  ) {
    super(message);
  }
}

export class AcmeClient {
  private directory?: Directory;
  private nonce?: string;
  private key?: CryptoKey;
  private jwk?: JWK;
  private kid?: string;

  constructor(
    private readonly sql: SQL,
    private readonly directoryUrl: string,
    private readonly email: string | undefined,
    private readonly log: (line: string) => void = (line) =>
      console.log(`[acme] ${line}`),
  ) {}

  private async dir(): Promise<Directory> {
    if (!this.directory) {
      const response = await fetch(this.directoryUrl);
      if (!response.ok)
        throw new AcmeError(`The ACME directory answered ${response.status}`);
      this.directory = (await response.json()) as Directory;
    }
    return this.directory;
  }

  private async newNonce(): Promise<string> {
    const response = await fetch((await this.dir()).newNonce, {
      method: "HEAD",
    });
    const nonce = response.headers.get("replay-nonce");
    if (!nonce) throw new AcmeError("The ACME server gave no nonce");
    return nonce;
  }

  /** A signed POST (`payload` undefined: POST-as-GET), retried once on a stale nonce. */
  private async post(
    url: string,
    payload: unknown,
    retry = true,
  ): Promise<Response> {
    const nonce = this.nonce ?? (await this.newNonce());
    this.nonce = undefined;
    const header = {
      alg: "ES256",
      nonce,
      url,
      ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }),
    };
    const body =
      payload === undefined
        ? new Uint8Array()
        : new TextEncoder().encode(JSON.stringify(payload));
    const jws = await new FlattenedSign(body)
      .setProtectedHeader(header)
      .sign(this.key!);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/jose+json" },
      body: JSON.stringify(jws),
    });
    this.nonce = response.headers.get("replay-nonce") ?? undefined;
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        type?: string;
        detail?: string;
      };
      if (retry && problem.type === "urn:ietf:params:acme:error:badNonce")
        return this.post(url, payload, false);
      throw new AcmeError(
        `ACME ${new URL(url).pathname}: ${problem.detail ?? response.status}`,
        problem,
      );
    }
    return response;
  }

  /** The account for this directory, created (and its key stored) the first time. */
  private async account() {
    if (this.kid) return;
    const [stored] = await this.sql<{ jwk: JWK; url: string | null }[]>`
      SELECT jwk, url FROM mail.acme_accounts WHERE directory = ${this.directoryUrl}`;
    if (stored) {
      this.jwk = {
        kty: stored.jwk.kty,
        crv: stored.jwk.crv,
        x: stored.jwk.x,
        y: stored.jwk.y,
      };
      this.key = (await importJWK(stored.jwk, "ES256")) as CryptoKey;
    } else {
      const { privateKey, publicKey } = await generateKeyPair("ES256", {
        extractable: true,
      });
      this.key = privateKey as CryptoKey;
      this.jwk = await exportJWK(publicKey);
      await this
        .sql`INSERT INTO mail.acme_accounts (directory, jwk) VALUES (${this.directoryUrl}, ${JSON.stringify(await exportJWK(privateKey))}::text::jsonb)`;
    }
    // newAccount finds an existing account by its key, so this is safe to repeat.
    const response = await this.post((await this.dir()).newAccount, {
      termsOfServiceAgreed: true,
      ...(this.email ? { contact: [`mailto:${this.email}`] } : {}),
    });
    this.kid = response.headers.get("location") ?? undefined;
    if (!this.kid) throw new AcmeError("The ACME server gave no account URL");
    await this
      .sql`UPDATE mail.acme_accounts SET url = ${this.kid} WHERE directory = ${this.directoryUrl}`;
  }

  private async poll<T extends { status: string }>(
    url: string,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const value = (await (await this.post(url, undefined)).json()) as T;
      if (done(value) || value.status === "invalid") return value;
      await Bun.sleep(Math.min(1000 * 2 ** Math.min(attempt, 3), 5000));
    }
    throw new AcmeError(`Timed out waiting for the ${what}`);
  }

  /**
   * Orders a certificate for `names`, answers its HTTP-01 challenges through `mail.acme_challenges`, and returns the
   * certificate chain and its key. Port 80 of every name must reach a server serving those challenges.
   */
  async issue(
    names: string[],
  ): Promise<{ certificate: string; privateKey: string }> {
    await this.account();
    const thumbprint = await calculateJwkThumbprint(this.jwk!, "sha256");
    this.log(`ordering a certificate for ${names.join(", ")}`);
    const orderResponse = await this.post((await this.dir()).newOrder, {
      identifiers: names.map((value) => ({ type: "dns", value })),
    });
    const orderUrl = orderResponse.headers.get("location")!;
    let order = (await orderResponse.json()) as Order;
    const tokens: string[] = [];
    try {
      for (const url of order.authorizations) {
        const authorization = (await (
          await this.post(url, undefined)
        ).json()) as Authorization;
        if (authorization.status === "valid") continue;
        const challenge = authorization.challenges.find(
          (c) => c.type === "http-01",
        );
        if (!challenge)
          throw new AcmeError(
            `No HTTP-01 challenge for ${authorization.identifier.value}`,
          );
        tokens.push(challenge.token);
        await this
          .sql`INSERT INTO mail.acme_challenges (token, key_authorization) VALUES (${challenge.token}, ${`${challenge.token}.${thumbprint}`})
          ON CONFLICT (token) DO UPDATE SET key_authorization = EXCLUDED.key_authorization`;
        await this.post(challenge.url, {});
        const settled = await this.poll<Authorization>(
          url,
          (a) => a.status === "valid",
          `validation of ${authorization.identifier.value}`,
        );
        if (settled.status !== "valid") {
          const error = settled.challenges.find((c) => c.type === "http-01")
            ?.error as { detail?: string } | undefined;
          throw new AcmeError(
            `${authorization.identifier.value} failed validation: ${error?.detail ?? "invalid"}`,
          );
        }
        this.log(`${authorization.identifier.value} validated`);
      }
      const { pem } = newCertificateKey();
      await this.post(order.finalize, {
        csr: base64url(createCsr(names, pem)),
      });
      order = await this.poll<Order>(
        orderUrl,
        (o) => o.status === "valid",
        "certificate",
      );
      if (order.status !== "valid" || !order.certificate)
        throw new AcmeError(`The order ended ${order.status}`);
      const certificate = await (
        await this.post(order.certificate, undefined)
      ).text();
      this.log(`issued for ${names.join(", ")}`);
      return { certificate, privateKey: pem };
    } finally {
      if (tokens.length)
        await this
          .sql`DELETE FROM mail.acme_challenges WHERE token = ANY(${this.sql.array(tokens, "text")})`;
    }
  }
}

/** The answer to an HTTP-01 challenge, for the web server's `/.well-known/acme-challenge/:token` route. */
export async function challengeResponse(
  sql: SQL,
  token: string,
): Promise<Response> {
  const [row] = await sql<
    { key_authorization: string }[]
  >`SELECT key_authorization FROM mail.acme_challenges WHERE token = ${token}`;
  return row
    ? new Response(row.key_authorization, {
        headers: { "Content-Type": "text/plain" },
      })
    : new Response("Not found", { status: 404 });
}
