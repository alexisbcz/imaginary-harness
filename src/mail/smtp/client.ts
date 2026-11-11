// Delivers a message to another server: finds the recipient domain's MX hosts (or a relay), connects, upgrades to
// TLS when offered (and insists when MTA-STS says so), and reports each recipient's outcome: sent, retry later,
// or failed for good.

import { connect, isIP } from "node:net";
import type { Resolver } from "../auth/dns.ts";
import { Connection } from "../net/connection.ts";
import { mtaStsPolicy, mxAllowed } from "./mta-sts.ts";

export type RecipientOutcome = {
  address: string;
  status: "sent" | "deferred" | "failed";
  detail: string;
  host?: string;
};

export type Relay = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  implicitTls: boolean;
};

/** `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465` (implicit TLS). */
export function parseRelay(url: string): Relay {
  const parsed = new URL(url);
  const implicitTls = parsed.protocol === "smtps:";
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (implicitTls ? 465 : 587)),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    implicitTls,
  };
}

/** SNI takes host names only. */
const tlsName = (host: string) => (isIP(host) ? {} : { servername: host });

class SmtpReplyError extends Error {
  constructor(
    readonly code: number,
    readonly text: string,
  ) {
    super(`${code} ${text}`);
  }
}

async function readReply(
  connection: Connection,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  for (;;) {
    const line = await connection.readLine(8192);
    const code = Number(line.slice(0, 3));
    lines.push(line.slice(4));
    if (line[3] !== "-") return { code, lines };
  }
}

async function command(
  connection: Connection,
  line: string | undefined,
  expect: (code: number) => boolean,
) {
  if (line !== undefined) connection.write(`${line}\r\n`);
  const reply = await readReply(connection);
  if (!expect(reply.code))
    throw new SmtpReplyError(reply.code, reply.lines.join(" "));
  return reply;
}

const ok = (code: number) => code >= 200 && code < 300;

/** Dot-stuffs a message and ends it with the lone dot. */
export function dotStuff(data: Uint8Array): Uint8Array {
  let text = Buffer.from(data).toString("latin1").replace(/\r?\n/g, "\r\n");
  if (!text.endsWith("\r\n")) text += "\r\n";
  text = text.replace(/^\./gm, "..");
  return Buffer.from(`${text}.\r\n`, "latin1");
}

function openSocket(host: string, port: number, timeoutMs: number) {
  return new Promise<import("node:net").Socket>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** One SMTP transaction with one host. Throws when the host could not be talked to at all. */
async function transact(options: {
  host: string;
  port: number;
  helo: string;
  from: string;
  recipients: string[];
  data: Uint8Array;
  requireTls: boolean;
  verifyTls: boolean;
  implicitTls?: boolean;
  auth?: { username: string; password: string };
}): Promise<RecipientOutcome[]> {
  const socket = await openSocket(options.host, options.port, 30_000);
  const connection = new Connection(socket, 5 * 60_000);
  try {
    if (options.implicitTls)
      await connection.upgradeClient({
        ...tlsName(options.host),
        rejectUnauthorized: options.verifyTls,
      });
    await command(connection, undefined, (c) => c === 220);
    let ehlo = await command(connection, `EHLO ${options.helo}`, ok).catch(
      async (error) => {
        if (error instanceof SmtpReplyError && error.code >= 500)
          return command(connection, `HELO ${options.helo}`, ok);
        throw error;
      },
    );
    const has = (name: string) =>
      ehlo.lines.some((line) => line.toUpperCase().startsWith(name));
    if (!connection.secure && has("STARTTLS")) {
      await command(connection, "STARTTLS", (c) => c === 220);
      await connection.upgradeClient({
        ...tlsName(options.host),
        rejectUnauthorized: options.verifyTls,
      });
      ehlo = await command(connection, `EHLO ${options.helo}`, ok);
    }
    if (options.requireTls && !connection.secure)
      throw new SmtpReplyError(
        450,
        "4.7.10 The server offers no TLS, which the domain's policy requires",
      );
    if (options.auth) {
      const token = Buffer.from(
        `\0${options.auth.username}\0${options.auth.password}`,
      ).toString("base64");
      await command(connection, `AUTH PLAIN ${token}`, (c) => c === 235);
    }
    const size = ehlo.lines.some((l) => l.toUpperCase().startsWith("SIZE"))
      ? ` SIZE=${options.data.length}`
      : "";
    const eightBit =
      options.data.some((b) => b > 127) &&
      ehlo.lines.some((l) => l.toUpperCase() === "8BITMIME")
        ? " BODY=8BITMIME"
        : "";
    await command(
      connection,
      `MAIL FROM:<${options.from}>${size}${eightBit}`,
      ok,
    );
    const outcomes: RecipientOutcome[] = [];
    const accepted: string[] = [];
    for (const address of options.recipients) {
      connection.write(`RCPT TO:<${address}>\r\n`);
      const reply = await readReply(connection);
      const detail = `${reply.code} ${reply.lines.join(" ")}`;
      if (ok(reply.code)) accepted.push(address);
      else
        outcomes.push({
          address,
          status: reply.code >= 500 ? "failed" : "deferred",
          detail,
          host: options.host,
        });
    }
    if (accepted.length === 0) {
      connection.write("QUIT\r\n");
      return outcomes;
    }
    await command(connection, "DATA", (c) => c === 354);
    await connection.writeAsync(dotStuff(options.data));
    const final = await readReply(connection);
    const detail = `${final.code} ${final.lines.join(" ")}`;
    const status = ok(final.code)
      ? "sent"
      : final.code >= 500
        ? "failed"
        : "deferred";
    for (const address of accepted)
      outcomes.push({ address, status, detail, host: options.host });
    connection.write("QUIT\r\n");
    return outcomes;
  } catch (error) {
    if (error instanceof SmtpReplyError) {
      const status = error.code >= 500 ? "failed" : "deferred";
      return options.recipients.map((address) => ({
        address,
        status,
        detail: error.message,
        host: options.host,
      }));
    }
    throw error;
  } finally {
    connection.close();
  }
}

/** The hosts that take mail for a domain, best first: its MX records, or the domain itself without any. */
export async function mailHosts(
  resolver: Resolver,
  domain: string,
): Promise<string[] | "null-mx"> {
  const records = await resolver.mx(domain);
  if (
    records.length === 1 &&
    (records[0]!.exchange === "" || records[0]!.exchange === ".")
  )
    return "null-mx";
  if (records.length)
    return records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.replace(/\.$/, ""));
  const addresses = [
    ...(await resolver.a(domain)),
    ...(await resolver.aaaa(domain)),
  ];
  return addresses.length ? [domain] : [];
}

/**
 * Delivers one message to recipients of one domain. Tries the domain's hosts in turn until one answers; a host
 * that answers decides each recipient's outcome.
 */
export async function deliverToDomain(options: {
  resolver: Resolver;
  domain: string;
  helo: string;
  from: string;
  recipients: string[];
  data: Uint8Array;
  relay?: Relay;
  port?: number;
}): Promise<RecipientOutcome[]> {
  const all = (status: RecipientOutcome["status"], detail: string) =>
    options.recipients.map((address) => ({ address, status, detail }));
  if (options.relay) {
    const { relay } = options;
    try {
      return await transact({
        host: relay.host,
        port: relay.port,
        helo: options.helo,
        from: options.from,
        recipients: options.recipients,
        data: options.data,
        requireTls: true,
        verifyTls: true,
        implicitTls: relay.implicitTls,
        auth: relay.username
          ? { username: relay.username, password: relay.password ?? "" }
          : undefined,
      });
    } catch (error) {
      return all(
        "deferred",
        `Relay ${relay.host}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  let hosts: string[] | "null-mx";
  try {
    hosts = await mailHosts(options.resolver, options.domain);
  } catch (error) {
    return all(
      "deferred",
      `DNS: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (hosts === "null-mx")
    return all("failed", `${options.domain} accepts no mail (null MX)`);
  if (hosts.length === 0)
    return all("failed", `${options.domain} has no mail server`);
  const policy = await mtaStsPolicy(options.resolver, options.domain).catch(
    () => undefined,
  );
  const enforce = policy?.mode === "enforce";
  const allowed = enforce
    ? hosts.filter((host) => mxAllowed(policy!, host))
    : hosts;
  if (allowed.length === 0)
    return all(
      "deferred",
      `No MX of ${options.domain} matches its MTA-STS policy`,
    );
  let lastError = "no host answered";
  for (const host of allowed.slice(0, 5)) {
    try {
      return await transact({
        host,
        port: options.port ?? 25,
        helo: options.helo,
        from: options.from,
        recipients: options.recipients,
        data: options.data,
        requireTls: enforce,
        verifyTls: enforce,
      });
    } catch (error) {
      lastError = `${host}: ${error instanceof Error ? error.message : error}`;
    }
  }
  return all("deferred", lastError);
}
