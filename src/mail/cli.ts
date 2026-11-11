// `bun run mail <command>`: set up and run the mail server from a terminal, with nothing else needed.
//
//   setup                      interactive first-time setup (or with flags, for scripts): .env, domain, DNS records
//   doctor [domain]            checks DNS, reverse DNS, port 25, TLS and the listeners, and says what to fix
//   dns <domain> [--zone]      the records to publish, as a table or a zone file
//   serve                      runs SMTP, IMAP and the outbound queue alone (without the web app)
//   domain add|list|remove     domains this server receives mail for
//   dkim rotate <domain>       a new DKIM key under a new selector
//   user add <email>           a Richelieu account (Supabase Auth), for a CLI-only install
//   account add|list|catch-all addresses on the domains
//   password <address|email>   an app password for a mail client
//   cert issue|status          the TLS certificate
//   queue [retry]              the outbound queue
//   send                       a test message

import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { config as appConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { systemResolver } from "./auth/dns.ts";
import { mailConfig, type MailConfig } from "./config.ts";
import {
  canReachPort25,
  checkDomain,
  checkHost,
  domainRecords,
  hostRecords,
  zoneFile,
  type RecordCheck,
} from "./dns-records.ts";
import { serverAddresses, startMail } from "./runtime.ts";
import { MailService } from "./service.ts";
import { MailStore } from "./store.ts";
import { Certificates } from "./tls/certificates.ts";

const tty = process.stdout.isTTY;
const color = (code: number) => (text: string) =>
  tty ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = color(1);
const dim = color(2);
const green = color(32);
const red = color(31);
const yellow = color(33);
const cyan = color(36);

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags[key!] = inline;
      else if (next !== undefined && !next.startsWith("--")) {
        flags[key!] = next;
        i++;
      } else flags[key!] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const flag = (flags: Flags, name: string) =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;

function fail(message: string): never {
  console.error(red(`✗ ${message}`));
  process.exit(1);
}

/** Asks on the terminal, with a default; flags answer first, and --yes takes the defaults. */
function ask(
  question: string,
  fallback: string | undefined,
  flags: Flags,
  name: string,
): string {
  const given = flag(flags, name);
  if (given) return given;
  if (flags.yes || !process.stdin.isTTY) {
    if (fallback === undefined) fail(`--${name} is required`);
    return fallback;
  }
  const answer = prompt(
    `${bold(question)}${fallback ? dim(` [${fallback}]`) : ""}`,
  )?.trim();
  return answer || fallback || ask(question, fallback, flags, name);
}

/** A public address of this machine, from its interfaces: what a VPS usually has. */
function detectPublicIps(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const a = entry.address;
      const isPrivate =
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
          a,
        ) || /^(fe80|fc|fd)/i.test(a);
      if (!isPrivate) found.push(a);
    }
  }
  return found;
}

/** Sets keys in .env, keeping every other line. */
async function writeEnv(values: Record<string, string>) {
  const file = Bun.file(".env");
  const current = (await file.exists()) ? await file.text() : "";
  const keys = new Set(Object.keys(values));
  const kept = current
    .split("\n")
    .filter((line) => !keys.has(line.split("=")[0]!.trim()));
  const added = Object.entries(values).map(
    ([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`,
  );
  await Bun.write(
    file,
    `${kept.join("\n").replace(/\n*$/, "\n")}${added.join("\n")}\n`,
  );
}

function printRecords(
  checks: (RecordCheck | ReturnType<typeof domainRecords>[number])[],
) {
  for (const record of checks) {
    const check = "ok" in record ? record : undefined;
    const mark = check
      ? check.ok
        ? green("✓")
        : record.required
          ? red("✗")
          : yellow("○")
      : record.required
        ? "•"
        : dim("○");
    console.log(
      `  ${mark} ${bold(record.type.padEnd(5))} ${cyan(record.name)}`,
    );
    console.log(`        ${record.value}`);
    console.log(
      `        ${dim(record.purpose)}${record.required ? "" : dim(" (recommended)")}`,
    );
    if (check && !check.ok) {
      if (check.found.length)
        console.log(`        ${yellow("found:")} ${check.found.join(" | ")}`);
      else console.log(`        ${yellow("not found")}`);
    }
    if (check?.note) console.log(`        ${yellow(check.note)}`);
  }
}

async function open(config: MailConfig = mailConfig) {
  const sql = new Bun.SQL(appConfig.databaseUrl);
  await migrate(sql);
  const resolver = systemResolver(config.dnsServers);
  const store = new MailStore(sql);
  const service = new MailService(sql, store, config, resolver);
  return { sql, store, service, resolver, config };
}

async function userByEmail(sql: Bun.SQL, email: string): Promise<string> {
  const [user] = await sql<
    { id: string }[]
  >`SELECT id FROM auth.users WHERE lower(email) = ${email.toLowerCase()}`;
  if (!user)
    fail(
      `No Richelieu account for ${email}. Sign up in the web app, or: bun run mail user add ${email}`,
    );
  return user.id;
}

// Commands -----------------------------------------------------------------------------------------------

async function setup(flags: Flags) {
  console.log(bold("\nRichelieu mail setup\n"));
  console.log(dim("Answers go to .env; press enter to keep a default.\n"));
  const domain = ask(
    "Domain to receive mail for (example.com):",
    mailConfig.primaryDomain,
    flags,
    "domain",
  ).toLowerCase();
  const hostname = ask(
    "This server's mail hostname:",
    mailConfig.hostname !== "localhost"
      ? mailConfig.hostname
      : `mail.${domain}`,
    flags,
    "hostname",
  ).toLowerCase();
  const detected = detectPublicIps();
  const ip = ask(
    "This server's public IP address(es), comma-separated:",
    mailConfig.publicIp ?? (detected.join(",") || undefined),
    flags,
    "ip",
  );
  const tls = ask(
    "TLS certificates (acme, files, self-signed):",
    mailConfig.tls.mode === "self-signed" ? "acme" : mailConfig.tls.mode,
    flags,
    "tls",
  );
  const acmeEmail =
    tls === "acme"
      ? ask(
          "Email for Let's Encrypt notices:",
          mailConfig.acme.email ?? `postmaster@${domain}`,
          flags,
          "acme-email",
        )
      : undefined;
  const relay = flag(flags, "relay");
  const https =
    ask(
      "Serve the web app over HTTPS from this process (yes/no):",
      "yes",
      flags,
      "https",
    ) === "yes";
  const webHost = https
    ? ask(
        "The web app's hostname:",
        new URL(appConfig.publicUrl).hostname === "localhost"
          ? `app.${domain}`
          : new URL(appConfig.publicUrl).hostname,
        flags,
        "web-host",
      )
    : undefined;

  const env: Record<string, string> = {
    NODE_ENV: "production",
    MAIL_ENABLED: "true",
    MAIL_DOMAIN: domain,
    MAIL_HOSTNAME: hostname,
    MAIL_PUBLIC_IP: ip,
    MAIL_TLS: tls,
  };
  if (acmeEmail) env.ACME_EMAIL = acmeEmail;
  if (relay) env.MAIL_RELAY = relay;
  if (https && webHost) {
    env.WEB_HTTPS = "true";
    env.PUBLIC_URL = `https://${webHost}`;
  }
  await writeEnv(env);
  console.log(green(`\n✓ .env updated (${Object.keys(env).join(", ")})`));

  const config: MailConfig = {
    ...mailConfig,
    hostname,
    primaryDomain: domain,
    publicIp: ip,
    tls: { ...mailConfig.tls, mode: tls as MailConfig["tls"]["mode"] },
  };
  const { sql, store } = await open(config);
  let record = await store.domain(domain);
  if (!record) {
    record = await store.createDomain({ name: domain, open: true });
    console.log(
      green(
        `✓ ${domain} added, with a DKIM key (selector ${record.dkim_selector})`,
      ),
    );
  } else console.log(dim(`• ${domain} is already set up`));

  const owner = flag(flags, "user");
  if (owner) {
    const userId = await userByEmail(sql, owner);
    const local = ask(
      `Address for ${owner} on ${domain}:`,
      owner.split("@")[0],
      flags,
      "address",
    );
    const account = await store
      .createAccount({ userId, domain, localPart: local })
      .catch((error) => fail(error.message));
    console.log(green(`✓ ${account.address} created`));
  }

  const addresses = ip
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(bold(`\nPublish these DNS records:\n`));
  printRecords([
    ...hostRecords(config, addresses),
    ...domainRecords(record, config, addresses),
  ]);
  if (webHost)
    console.log(
      `\n  • ${bold("A    ")} ${cyan(webHost)}\n        ${addresses[0] ?? "<this server>"}\n        ${dim("The web app")}`,
    );
  console.log(`\n${dim("As a zone file:")} bun run mail dns ${domain} --zone`);
  console.log(bold("\nThen:"));
  console.log(`  1. Open ports 25, 80, 443, 465, 587 and 993 in the firewall.`);
  console.log(
    `  2. Set the reverse DNS (PTR) of ${addresses.join(", ") || "the server"} to ${hostname} in your provider's panel.`,
  );
  console.log(
    `  3. Check everything: ${cyan(`bun run mail doctor ${domain}`)}`,
  );
  console.log(
    `  4. Start: ${cyan("bun run start")} ${dim("(or the systemd service from deploy/vps)")}\n`,
  );
  await sql.close();
}

async function doctor(positional: string[]) {
  const { sql, store, resolver, config } = await open();
  let problems = 0;
  const line = (ok: boolean | "warn", text: string) => {
    if (ok === false) problems++;
    console.log(
      `  ${ok === true ? green("✓") : ok === "warn" ? yellow("○") : red("✗")} ${text}`,
    );
  };
  console.log(bold(`\nMail host ${config.hostname}\n`));
  const addresses = await serverAddresses(config, resolver);
  line(
    addresses.length > 0,
    addresses.length
      ? `Public address: ${addresses.join(", ")}`
      : "No public address: set MAIL_PUBLIC_IP or an A record for the hostname",
  );
  const hostChecks = await checkHost(config, resolver, addresses);
  printRecords(hostChecks);
  problems += hostChecks.filter((c) => c.required && !c.ok).length;
  if (config.relay)
    line(true, `Outgoing mail goes through ${new URL(config.relay).hostname}`);
  else {
    const open25 = await canReachPort25();
    line(
      open25 ? true : false,
      open25
        ? "Outgoing port 25 is open"
        : "Outgoing port 25 is blocked: ask your provider to open it, or set MAIL_RELAY",
    );
  }
  const [cert] = await sql<
    { issuer: string; expires_at: Date }[]
  >`SELECT issuer, expires_at FROM mail.certificates WHERE hostname = ${config.hostname}`;
  if (config.tls.mode === "off")
    line("warn", "TLS is off: clients cannot connect securely");
  else if (!cert && config.tls.mode !== "files")
    line(
      false,
      "No certificate yet: start the server, or run `bun run mail cert issue`",
    );
  else if (cert) {
    const days = Math.round(
      (cert.expires_at.getTime() - Date.now()) / 86_400_000,
    );
    line(
      days > 14 ? true : days > 0 ? "warn" : false,
      `Certificate from ${cert.issuer.match(/CN=([^,]+)/)?.[1] ?? cert.issuer}, ${days} days left`,
    );
  }
  for (const [name, port] of Object.entries(config.ports)) {
    if (!port) continue;
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(1500, () => (socket.destroy(), resolve(false)));
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    line(
      listening ? true : "warn",
      `${name} (${port}) ${listening ? "is listening" : "is not listening here (is the server running?)"}`,
    );
  }

  const domains = positional[0]
    ? [await store.domain(positional[0])].filter((d) => d !== undefined)
    : await store.domains();
  if (positional[0] && domains.length === 0)
    fail(
      `${positional[0]} is not on this server: bun run mail domain add ${positional[0]}`,
    );
  for (const domain of domains) {
    console.log(bold(`\n${domain.name}\n`));
    const report = await checkDomain(domain, config, resolver, addresses);
    await store.saveChecks(domain.id, report as never, report.verified);
    printRecords(report.checks);
    if (!report.verified) problems++;
    console.log(
      report.verified
        ? green(`\n  ✓ ${domain.name} is verified: it can send`)
        : red(
            `\n  ✗ ${domain.name} cannot send until the required records check out`,
          ),
    );
  }
  console.log(
    problems
      ? red(`\n${problems} problem(s) to fix.\n`)
      : green("\nEverything checks out.\n"),
  );
  await sql.close();
  process.exit(problems ? 1 : 0);
}

async function dns(positional: string[], flags: Flags) {
  const name =
    positional[0] ??
    mailConfig.primaryDomain ??
    fail("Usage: bun run mail dns <domain> [--zone]");
  const { sql, store, resolver, config } = await open();
  const domain =
    (await store.domain(name)) ?? fail(`${name} is not on this server`);
  const addresses = await serverAddresses(config, resolver);
  const records = domainRecords(domain, config, addresses);
  if (flags.zone)
    console.log(zoneFile([...hostRecords(config, addresses), ...records]));
  else printRecords([...hostRecords(config, addresses), ...records]);
  await sql.close();
}

async function serve() {
  const sql = new Bun.SQL(appConfig.databaseUrl);
  for (const file of await migrate(sql)) console.log(`[db] applied ${file}`);
  const mail = await startMail(sql, {
    webHost: new URL(appConfig.publicUrl).hostname,
  });
  const stop = async () => {
    await mail.stop();
    await sql.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function domainCommand(positional: string[], flags: Flags) {
  const [action, name] = positional;
  const { sql, store } = await open();
  if (action === "add") {
    if (!name)
      fail("Usage: bun run mail domain add <domain> [--owner <email>]");
    const owner = flag(flags, "owner");
    const userId = owner ? await userByEmail(sql, owner) : null;
    const domain = await store.createDomain({ name, userId, open: !userId });
    console.log(
      green(
        `✓ ${domain.name} added${owner ? ` for ${owner}` : " (open: every user may take an address)"}`,
      ),
    );
    console.log(`Its records: ${cyan(`bun run mail dns ${domain.name}`)}`);
  } else if (action === "remove") {
    const domain =
      (await store.domain(name ?? "")) ?? fail(`No domain ${name}`);
    await store.deleteDomain(domain.id);
    console.log(
      green(`✓ ${domain.name} removed, with its addresses and their mail`),
    );
  } else {
    for (const domain of await store.domains()) {
      const accounts = (await store.accounts()).filter(
        (a) => a.domain_id === domain.id,
      ).length;
      console.log(
        `${domain.verified_at ? green("✓") : yellow("○")} ${bold(domain.name)} ${dim(`${accounts} address(es), selector ${domain.dkim_selector}${domain.open ? ", open" : ""}`)}`,
      );
    }
  }
  await sql.close();
}

async function userCommand(positional: string[], flags: Flags) {
  const [action, email] = positional;
  if (action !== "add" || !email)
    fail(
      "Usage: bun run mail user add <email> [--name <name>] [--password <password>]",
    );
  const supabase = createClient(
    appConfig.supabaseUrl,
    appConfig.serviceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const name = flag(flags, "name") ?? email.split("@")[0]!;
  const password =
    flag(flags, "password") ??
    crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error) fail(error.message);
  console.log(
    green(
      `✓ ${email} can sign in to Richelieu${flag(flags, "password") ? "" : ` with the password ${bold(password)}`}`,
    ),
  );
  if (flags.address) {
    const { sql, store } = await open();
    const [local, domain] = String(flags.address).split("@");
    const account = await store.createAccount({
      userId: data.user!.id,
      domain: domain!,
      localPart: local!,
      displayName: name,
    });
    console.log(green(`✓ ${account.address} created`));
    await sql.close();
  }
}

async function accountCommand(positional: string[], flags: Flags) {
  const [action, address, value] = positional;
  const { sql, store } = await open();
  if (action === "add") {
    if (!address?.includes("@"))
      fail(
        "Usage: bun run mail account add <local@domain> --user <email> [--name <display name>]",
      );
    const owner =
      flag(flags, "user") ??
      fail("--user <email> names the Richelieu account that owns the address");
    const userId = await userByEmail(sql, owner);
    const [local, domain] = address.split("@");
    const account = await store
      .createAccount({
        userId,
        domain: domain!,
        localPart: local!,
        displayName: flag(flags, "name"),
      })
      .catch((e) => fail(e.message));
    console.log(green(`✓ ${account.address} created for ${owner}`));
    console.log(
      `A password for mail clients: ${cyan(`bun run mail password ${account.address}`)}`,
    );
  } else if (action === "catch-all") {
    const account =
      (await store.account(address ?? "")) ?? fail(`No address ${address}`);
    await sql`UPDATE public.mail_accounts SET catch_all = ${value !== "off"} WHERE id = ${account.id}`;
    console.log(
      green(
        `✓ ${account.address} ${value !== "off" ? "now catches" : "no longer catches"} mail to unknown addresses of its domain`,
      ),
    );
  } else {
    for (const account of await store.accounts()) {
      const [owner] = await sql<
        { email: string }[]
      >`SELECT email FROM auth.users WHERE id = ${account.user_id}`;
      console.log(
        `${bold(account.address)} ${dim(`${owner?.email ?? "?"}, assistant: ${account.assistant}${account.catch_all ? ", catch-all" : ""}`)}`,
      );
    }
  }
  await sql.close();
}

async function passwordCommand(positional: string[], flags: Flags) {
  const who =
    positional[0] ??
    fail(
      "Usage: bun run mail password <address or account email> [--name <device>]",
    );
  const { sql, store } = await open();
  const account = await store.account(who);
  const userId = account?.user_id ?? (await userByEmail(sql, who));
  const { password } = await store.createAppPassword(
    userId,
    flag(flags, "name") ?? "Mail client",
  );
  const accounts = await store.accounts(userId);
  console.log(green("✓ App password created. It is shown once:\n"));
  console.log(`    ${bold(password)}\n`);
  console.log(
    `  Sign in as ${accounts.map((a) => cyan(a.address)).join(" or ") || "(no address yet)"}`,
  );
  console.log(
    dim(
      `  IMAP ${mailConfig.hostname}:${mailConfig.ports.imaps} (TLS), SMTP ${mailConfig.hostname}:${mailConfig.ports.submissions} (TLS) or ${mailConfig.ports.submission} (STARTTLS)\n`,
    ),
  );
  await sql.close();
}

async function certCommand(positional: string[]) {
  const { sql, store, resolver, config } = await open();
  const { certificateNames } = await import("./runtime.ts");
  const certificates = new Certificates(sql, config, () =>
    certificateNames(
      store,
      config,
      resolver,
      new URL(appConfig.publicUrl).hostname,
    ),
  );
  if (positional[0] === "issue") {
    if (config.tls.mode !== "acme") fail("MAIL_TLS is not acme");
    console.log(
      dim(
        "Port 80 of every name must reach this machine, served by `bun run start` (or MAIL_HTTP_PORT=80).",
      ),
    );
    await certificates.issue();
    console.log(
      green(
        `✓ Issued for ${certificates.current?.names.join(", ")}, until ${certificates.current?.expiresAt.toDateString()}`,
      ),
    );
  } else {
    const [cert] = await sql<
      { issuer: string; expires_at: Date; updated_at: Date }[]
    >`SELECT issuer, expires_at, updated_at FROM mail.certificates WHERE hostname = ${config.hostname}`;
    if (!cert) console.log(yellow("No certificate yet."));
    else
      console.log(
        `${config.hostname}: ${cert.issuer}\n  expires ${cert.expires_at.toISOString()}, updated ${cert.updated_at.toISOString()}`,
      );
  }
  await sql.close();
}

async function queueCommand(positional: string[]) {
  const { sql } = await open();
  if (positional[0] === "retry") {
    const rows =
      await sql`UPDATE mail.outbound_recipients SET next_attempt_at = now() WHERE status = 'queued' RETURNING address`;
    console.log(
      green(`✓ ${rows.length} recipient(s) will be retried on the next round`),
    );
  } else {
    const rows = await sql<
      {
        address: string;
        status: string;
        attempts: number;
        last_error: string | null;
        next_attempt_at: Date;
        mail_from: string;
      }[]
    >`
      SELECT r.address, r.status, r.attempts, r.last_error, r.next_attempt_at, o.mail_from FROM mail.outbound_recipients r
      JOIN mail.outbound o ON o.id = r.outbound_id WHERE r.status = 'queued' OR o.created_at > now() - interval '1 day'
      ORDER BY o.created_at DESC LIMIT 50`;
    if (rows.length === 0) console.log(dim("Nothing in the queue today."));
    for (const r of rows) {
      const mark =
        r.status === "sent"
          ? green("✓")
          : r.status === "failed"
            ? red("✗")
            : yellow("…");
      console.log(
        `${mark} ${r.mail_from} → ${bold(r.address)} ${dim(`${r.attempts} attempt(s)${r.status === "queued" ? `, next ${r.next_attempt_at.toISOString()}` : ""}`)}`,
      );
      if (r.last_error && r.status !== "sent")
        console.log(`    ${dim(r.last_error.slice(0, 200))}`);
    }
  }
  await sql.close();
}

async function sendCommand(flags: Flags) {
  const from =
    flag(flags, "from") ??
    fail(
      "Usage: bun run mail send --from <address> --to <address> [--subject] [--text]",
    );
  const to = flag(flags, "to") ?? fail("--to is required");
  const { sql, store, service } = await open();
  const account = (await store.account(from)) ?? fail(`No address ${from}`);
  const result = await service.compose(account, {
    to: [{ name: "", address: to }],
    subject: flag(flags, "subject") ?? "Hello from Richelieu",
    text:
      flag(flags, "text") ??
      `This is a test message from ${mailConfig.hostname}.`,
  });
  console.log(
    green(
      `✓ ${result.local.length ? "Delivered locally" : "Queued"}; follow it with: bun run mail queue`,
    ),
  );
  await sql.close();
}

const HELP = `${bold("bun run mail")} <command>

  ${bold("setup")}                       first-time setup: .env, the domain, its DNS records ${dim("(--domain --hostname --ip --tls --acme-email --relay --user --yes)")}
  ${bold("doctor")} [domain]             check DNS, reverse DNS, port 25, TLS and the listeners
  ${bold("dns")} <domain> [--zone]       the DNS records to publish
  ${bold("serve")}                       run SMTP, IMAP and the queue without the web app
  ${bold("domain")} add|list|remove      ${dim("add <domain> [--owner <email>]")}
  ${bold("dkim rotate")} <domain>        a new DKIM key
  ${bold("user add")} <email>            a Richelieu account ${dim("[--name] [--password] [--address local@domain]")}
  ${bold("account")} add|list|catch-all  ${dim("add <local@domain> --user <email> [--name]; catch-all <address> on|off")}
  ${bold("password")} <address|email>    an app password for mail clients ${dim("[--name <device>]")}
  ${bold("cert")} issue|status           the TLS certificate
  ${bold("queue")} [retry]               outgoing mail
  ${bold("send")}                        a test message ${dim("--from --to [--subject] [--text]")}
`;

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "setup":
      await setup(flags);
      break;
    case "doctor":
      await doctor(positional);
      break;
    case "dns":
      await dns(positional, flags);
      break;
    case "serve":
      await serve();
      break;
    case "domain":
      await domainCommand(positional, flags);
      break;
    case "dkim": {
      if (positional[0] !== "rotate" || !positional[1])
        fail("Usage: bun run mail dkim rotate <domain>");
      const { sql, store } = await open();
      const domain =
        (await store.domain(positional[1])) ??
        fail(`No domain ${positional[1]}`);
      const rotated = await store.rotateDkim(domain.id);
      console.log(
        green(`✓ New key under selector ${rotated.dkim_selector}. Publish:`),
      );
      console.log(
        `  TXT ${cyan(`${rotated.dkim_selector}._domainkey.${rotated.name}`)}\n      ${rotated.dkim_record}`,
      );
      console.log(
        dim(
          `  Keep the old selector's record a few days, for mail still in flight.`,
        ),
      );
      await sql.close();
      break;
    }
    case "user":
      await userCommand(positional, flags);
      break;
    case "account":
      await accountCommand(positional, flags);
      break;
    case "password":
      await passwordCommand(positional, flags);
      break;
    case "cert":
      await certCommand(positional);
      break;
    case "queue":
      await queueCommand(positional);
      break;
    case "send":
      await sendCommand(flags);
      break;
    default:
      console.log(HELP);
      if (command && command !== "help") process.exit(1);
  }
}
