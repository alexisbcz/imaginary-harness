// The certificates the mail servers present: issued by ACME and renewed a month before they expire, read from
// files (certbot, Caddy...), or self-signed for local development. Servers ask for a SecureContext per name (SNI),
// so a renewal takes effect on the next connection without a restart.

import type { SQL } from "bun";
import { X509Certificate } from "node:crypto";
import { stat } from "node:fs/promises";
import { createSecureContext, type SecureContext } from "node:tls";
import type { MailConfig } from "../config.ts";
import { AcmeClient } from "./acme.ts";
import { createSelfSigned } from "./der.ts";

const RENEW_BEFORE_MS = 30 * 86_400_000;
const CHECK_EVERY_MS = 12 * 3_600_000;

export type CertificateInfo = {
  hostname: string;
  issuer: string;
  expiresAt: Date;
  names: string[];
  selfSigned: boolean;
};

function describe(certificate: string) {
  const x509 = new X509Certificate(certificate);
  const names = (x509.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((n) => n.startsWith("DNS:"))
    .map((n) => n.slice(4));
  return {
    issuer: x509.issuer.replace(/\n/g, ", "),
    expiresAt: new Date(x509.validTo),
    names,
    selfSigned: x509.issuer === x509.subject,
  };
}

export class Certificates {
  private context: SecureContext | undefined;
  private info: CertificateInfo | undefined;
  private timer: Timer | undefined;
  private fileStamp = 0;
  private pemPair: { cert: string; key: string } | undefined;
  /** Called after a new certificate is loaded (a renewal), with its PEM pair. */
  onChange: (pair: { cert: string; key: string }) => void = () => {};

  constructor(
    private readonly sql: SQL,
    private readonly config: MailConfig,
    /** Every name the certificate covers: the mail host first. */
    private readonly names: () => Promise<string[]>,
  ) {}

  get enabled() {
    return this.config.tls.mode !== "off";
  }

  /** The current certificate, for the doctor and the web page. */
  get current() {
    return this.info;
  }

  /** The context for TLS handshakes, loaded on first use. */
  secureContext(): SecureContext | undefined {
    return this.context;
  }

  /** The certificate chain and key as PEM, for a web server sharing the certificate. */
  get pem() {
    return this.pemPair;
  }

  private load(certificate: string, privateKey: string) {
    const changed =
      this.pemPair !== undefined && this.pemPair.cert !== certificate;
    this.context = createSecureContext({ cert: certificate, key: privateKey });
    this.pemPair = { cert: certificate, key: privateKey };
    if (changed) this.onChange(this.pemPair);
    const meta = describe(certificate);
    this.info = { hostname: this.config.hostname, ...meta };
  }

  private async stored() {
    const [row] = await this.sql<
      { certificate: string; private_key: string; expires_at: Date }[]
    >`
      SELECT certificate, private_key, expires_at FROM mail.certificates WHERE hostname = ${this.config.hostname}`;
    return row;
  }

  async save(certificate: string, privateKey: string) {
    const meta = describe(certificate);
    await this.sql`
      INSERT INTO mail.certificates (hostname, certificate, private_key, issuer, expires_at)
      VALUES (${this.config.hostname}, ${certificate}, ${privateKey}, ${meta.issuer}, ${meta.expiresAt})
      ON CONFLICT (hostname) DO UPDATE SET certificate = EXCLUDED.certificate, private_key = EXCLUDED.private_key,
        issuer = EXCLUDED.issuer, expires_at = EXCLUDED.expires_at, updated_at = now()`;
    this.load(certificate, privateKey);
  }

  /** Orders a certificate now, whatever the current one's expiry. */
  async issue() {
    const client = new AcmeClient(
      this.sql,
      this.config.acme.directory,
      this.config.acme.email,
    );
    const { certificate, privateKey } = await client.issue(await this.names());
    await this.save(certificate, privateKey);
  }

  /** Loads (or makes) the certificate, then keeps it current. */
  async start() {
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh().catch((error) => console.error("[tls]", error)),
      this.config.tls.mode === "files" ? 60_000 : CHECK_EVERY_MS,
    );
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  private async refresh() {
    const { mode, certFile, keyFile } = this.config.tls;
    if (mode === "off") return;
    if (mode === "files") {
      if (!certFile || !keyFile)
        throw new Error("MAIL_TLS=files needs MAIL_TLS_CERT and MAIL_TLS_KEY");
      const stamp = (await stat(certFile)).mtimeMs;
      if (stamp === this.fileStamp) return;
      this.fileStamp = stamp;
      this.load(
        await Bun.file(certFile).text(),
        await Bun.file(keyFile).text(),
      );
      console.log(`[tls] loaded ${certFile}`);
      return;
    }
    const stored = await this.stored();
    const wanted = await this.names();
    if (mode === "self-signed") {
      if (
        stored &&
        stored.expires_at.getTime() - Date.now() > RENEW_BEFORE_MS &&
        wanted.every((n) => describe(stored.certificate).names.includes(n))
      ) {
        this.load(stored.certificate, stored.private_key);
        return;
      }
      const self = createSelfSigned(wanted);
      await this.save(self.certificate, self.privateKey);
      console.log(
        `[tls] made a self-signed certificate for ${wanted.join(", ")}`,
      );
      return;
    }
    // ACME: keep serving what is stored (even a self-signed stand-in) while a new one is ordered.
    if (stored) this.load(stored.certificate, stored.private_key);
    const covers = stored
      ? wanted.every((n) => describe(stored.certificate).names.includes(n))
      : false;
    const fresh =
      stored &&
      !describe(stored.certificate).selfSigned &&
      stored.expires_at.getTime() - Date.now() > RENEW_BEFORE_MS;
    if (fresh && covers) return;
    if (!stored) {
      // Until the CA answers, STARTTLS still works with a stand-in.
      const self = createSelfSigned(wanted, 7);
      this.load(self.certificate, self.privateKey);
    }
    try {
      await this.issue();
    } catch (error) {
      console.error(
        `[tls] could not get a certificate for ${wanted.join(", ")}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
