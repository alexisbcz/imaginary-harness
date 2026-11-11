// Starts the mail servers: SMTP for the internet (25) and for clients (587, 465), IMAP (143, 993), the outbound
// queue and the certificate keeper, around one MailService. The app's server starts them when MAIL_ENABLED is set;
// `bun run mail serve` runs them alone.

import type { Server } from "node:net";
import type { SQL } from "bun";
import { systemResolver, type Resolver } from "./auth/dns.ts";
import { mailConfig, type MailConfig } from "./config.ts";
import { listenImap } from "./imap/server.ts";
import { OutboundQueue } from "./queue.ts";
import { MailService } from "./service.ts";
import { listenSmtp } from "./smtp/server.ts";
import { MailStore } from "./store.ts";
import { Certificates } from "./tls/certificates.ts";

export type MailRuntime = Awaited<ReturnType<typeof startMail>>;

/** The server's public addresses: configured, or what the mail hostname resolves to. */
export async function serverAddresses(
  config: MailConfig,
  resolver: Resolver,
): Promise<string[]> {
  if (config.publicIp) return config.publicIp.split(",").map((ip) => ip.trim());
  return [
    ...(await resolver.a(config.hostname).catch(() => [])),
    ...(await resolver.aaaa(config.hostname).catch(() => [])),
  ];
}

/**
 * Every name the certificate covers: the mail host, the web app's host, and each domain's `mta-sts.` and
 * `autoconfig.` names once they point at this server (an ACME order fails whole when one name does not).
 */
export async function certificateNames(
  store: MailStore,
  config: MailConfig,
  resolver: Resolver,
  webHost?: string,
): Promise<string[]> {
  const names = new Set([config.hostname]);
  if (webHost && webHost !== "localhost" && !webHost.startsWith("127."))
    names.add(webHost);
  if (config.tls.mode !== "acme") return [...names];
  const ours = new Set(await serverAddresses(config, resolver));
  for (const domain of await store.domains()) {
    for (const prefix of ["mta-sts", "autoconfig"]) {
      const name = `${prefix}.${domain.name}`;
      const addresses = await resolver.a(name).catch(() => []);
      if (addresses.length && addresses.every((a) => ours.has(a)))
        names.add(name);
    }
  }
  return [...names];
}

export async function startMail(
  sql: SQL,
  options: { config?: MailConfig; resolver?: Resolver; webHost?: string } = {},
) {
  const config = options.config ?? mailConfig;
  const resolver = options.resolver ?? systemResolver(config.dnsServers);
  const store = new MailStore(sql);
  const service = new MailService(sql, store, config, resolver);
  const certificates = new Certificates(sql, config, () =>
    certificateNames(store, config, resolver, options.webHost),
  );
  await certificates.start();
  const queue = new OutboundQueue(service);
  queue.start();
  const tls = () => certificates.secureContext();
  const host = config.listen;
  const servers: Server[] = [];
  const smtpOptions = {
    hostname: config.hostname,
    maxSize: config.maxSize,
    handler: service.smtpHandler(),
    tls,
    log: (line: string) => console.log(line),
  };
  const listeners: [string, () => Promise<Server>][] = [
    [
      `smtp :${config.ports.smtp}`,
      () =>
        listenSmtp({ mode: "mx", port: config.ports.smtp, host }, smtpOptions),
    ],
    [
      `submission :${config.ports.submission}`,
      () =>
        listenSmtp(
          { mode: "submission", port: config.ports.submission, host },
          smtpOptions,
        ),
    ],
    [
      `imap :${config.ports.imap}`,
      () =>
        listenImap(
          { port: config.ports.imap, host },
          { hostname: config.hostname, service, maxSize: config.maxSize, tls },
        ),
    ],
  ];
  if (certificates.enabled) {
    listeners.push(
      [
        `submissions :${config.ports.submissions}`,
        () =>
          listenSmtp(
            {
              mode: "submission",
              port: config.ports.submissions,
              host,
              implicitTls: true,
            },
            smtpOptions,
          ),
      ],
      [
        `imaps :${config.ports.imaps}`,
        () =>
          listenImap(
            { port: config.ports.imaps, host, implicitTls: true },
            {
              hostname: config.hostname,
              service,
              maxSize: config.maxSize,
              tls,
            },
          ),
      ],
    );
  }
  for (const [name, listen] of listeners) {
    try {
      servers.push(await listen());
    } catch (error) {
      // A port in use (or a privileged one without the capability) should not take the rest down.
      console.error(
        `[mail] could not listen on ${name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  console.log(
    `[mail] ${config.hostname}: ${listeners.map(([name]) => name).join(", ")} (TLS: ${config.tls.mode})`,
  );
  return {
    config,
    store,
    service,
    queue,
    certificates,
    resolver,
    async stop() {
      for (const server of servers) server.close();
      certificates.stop();
      await queue.stop();
    },
  };
}
