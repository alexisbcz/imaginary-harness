// The mail server's settings, from the environment (Bun loads `.env`). Locally the servers listen on high ports so
// they need no privileges; `bun run mail setup` writes the production values on a VPS.

import { hostname } from "node:os";

const env = Bun.env;
const production = env.NODE_ENV === "production";
const port = (name: string, fallback: number) => Number(env[name] ?? fallback);

export type TlsMode = "acme" | "files" | "self-signed" | "off";

export const mailConfig = {
  /** Whether the app's server also runs the mail servers (one process on a VPS). */
  enabled: env.MAIL_ENABLED === "true" || env.MAIL_ENABLED === "1",
  /** The server's own name: its MX target, its EHLO and banner, its certificate's name. */
  hostname: (
    env.MAIL_HOSTNAME ?? (production ? hostname() : "localhost")
  ).toLowerCase(),
  /** The domain `mail setup` creates first, where every user may take an address. */
  primaryDomain: env.MAIL_DOMAIN?.toLowerCase(),
  /** Where to listen: all interfaces by default. */
  listen: env.MAIL_LISTEN ?? "0.0.0.0",
  ports: {
    /** Inbound mail from the internet (MX). */
    smtp: port("MAIL_SMTP_PORT", production ? 25 : 2525),
    /** Mail clients sending, with STARTTLS and AUTH. */
    submission: port("MAIL_SUBMISSION_PORT", production ? 587 : 2587),
    /** Mail clients sending over implicit TLS. */
    submissions: port("MAIL_SUBMISSIONS_PORT", production ? 465 : 2465),
    imap: port("MAIL_IMAP_PORT", production ? 143 : 2143),
    imaps: port("MAIL_IMAPS_PORT", production ? 993 : 2993),
    /** Plain HTTP for ACME challenges and MTA-STS, when the web server does not listen on port 80 itself. 0: off. */
    http: port("MAIL_HTTP_PORT", 0),
  },
  tls: {
    mode: (env.MAIL_TLS ?? (production ? "acme" : "self-signed")) as TlsMode,
    certFile: env.MAIL_TLS_CERT,
    keyFile: env.MAIL_TLS_KEY,
  },
  acme: {
    email: env.ACME_EMAIL,
    directory:
      env.ACME_DIRECTORY ?? "https://acme-v02.api.letsencrypt.org/directory",
  },
  /** The largest message accepted, in bytes. */
  maxSize: Number(env.MAIL_MAX_SIZE ?? 26_214_400),
  /**
   * A smarthost for outgoing mail, `smtp://user:password@smtp.example.com:587`, for VPS providers that block port
   * 25. Without it, mail goes straight to each recipient's MX.
   */
  relay: env.MAIL_RELAY,
  /** The address the server is reachable at from the internet, for the SPF record and the PTR check. */
  publicIp: env.MAIL_PUBLIC_IP,
  /** DNS servers for SPF, DKIM, DMARC and MX lookups; the system's by default. */
  dnsServers: env.MAIL_DNS_SERVERS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Reject, rather than file in Junk, mail whose domain's DMARC policy says reject. */
  enforceDmarc: env.MAIL_ENFORCE_DMARC !== "false",
} as const;

export type MailConfig = typeof mailConfig;
