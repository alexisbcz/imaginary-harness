// The DNS records a domain needs to send and receive mail through this server, and a live check of each: what the
// CLI's `mail dns` and `mail doctor` print and what the web app's setup page shows. Required records gate sending
// (a domain is verified once they all check out); recommended ones make delivery and client setup better.

import { connect } from "node:net";
import type { Resolver } from "./auth/dns.ts";
import { reverseName } from "./auth/ip.ts";
import { checkSpf } from "./auth/spf.ts";
import { parseTags } from "./auth/dkim.ts";
import type { MailConfig } from "./config.ts";
import type { Domain } from "./store.ts";

export type DnsRecord = {
  id: string;
  type: "MX" | "TXT" | "CNAME" | "A" | "AAAA" | "SRV" | "PTR";
  /** The full name. */
  name: string;
  value: string;
  /** What it is for, in one line. */
  purpose: string;
  required: boolean;
};

export type RecordCheck = DnsRecord & {
  ok: boolean;
  found: string[];
  note?: string;
};

export type DomainReport = {
  domain: string;
  verified: boolean;
  checks: RecordCheck[];
  checkedAt: string;
};

/** The records to publish for a domain. */
export function domainRecords(
  domain: Domain,
  config: MailConfig,
  addresses: string[],
): DnsRecord[] {
  const host = config.hostname;
  const d = domain.name;
  const ipv4 = addresses.find((a) => !a.includes(":"));
  const spf =
    host === d || !ipv4 ? "v=spf1 mx -all" : `v=spf1 mx ip4:${ipv4} -all`;
  return [
    {
      id: "mx",
      type: "MX",
      name: d,
      value: `10 ${host}.`,
      purpose: "Mail for the domain comes to this server",
      required: true,
    },
    {
      id: "spf",
      type: "TXT",
      name: d,
      value: spf,
      purpose: "SPF: this server may send for the domain",
      required: true,
    },
    {
      id: "dkim",
      type: "TXT",
      name: `${domain.dkim_selector}._domainkey.${d}`,
      value: domain.dkim_record,
      purpose: "DKIM: the key that signs the domain's mail",
      required: true,
    },
    {
      id: "dmarc",
      type: "TXT",
      name: `_dmarc.${d}`,
      value: `v=DMARC1; p=quarantine; adkim=s; aspf=r; rua=mailto:postmaster@${d}`,
      purpose: "DMARC: what receivers do with mail that fails SPF and DKIM",
      required: true,
    },
    {
      id: "mta-sts-host",
      type: "CNAME",
      name: `mta-sts.${d}`,
      value: `${host}.`,
      purpose: "MTA-STS: where the policy is served",
      required: false,
    },
    {
      id: "mta-sts",
      type: "TXT",
      name: `_mta-sts.${d}`,
      value: `v=STSv1; id=${domain.dkim_selector.replace(/\D/g, "") || "1"}`,
      purpose: "MTA-STS: other servers must use TLS to reach this one",
      required: false,
    },
    {
      id: "tls-rpt",
      type: "TXT",
      name: `_smtp._tls.${d}`,
      value: `v=TLSRPTv1; rua=mailto:postmaster@${d}`,
      purpose: "TLS reports from other servers",
      required: false,
    },
    {
      id: "autoconfig",
      type: "CNAME",
      name: `autoconfig.${d}`,
      value: `${host}.`,
      purpose: "Thunderbird and others find the settings",
      required: false,
    },
    {
      id: "srv-imaps",
      type: "SRV",
      name: `_imaps._tcp.${d}`,
      value: `0 1 993 ${host}.`,
      purpose: "Mail clients find IMAP (RFC 6186)",
      required: false,
    },
    {
      id: "srv-submissions",
      type: "SRV",
      name: `_submissions._tcp.${d}`,
      value: `0 1 465 ${host}.`,
      purpose: "Mail clients find SMTP",
      required: false,
    },
  ];
}

/** Records for the server itself, published once: its address and the reverse lookup the VPS provider sets. */
export function hostRecords(
  config: MailConfig,
  addresses: string[],
): DnsRecord[] {
  return addresses.flatMap((ip) => [
    {
      id: `host-${ip}`,
      type: ip.includes(":") ? ("AAAA" as const) : ("A" as const),
      name: config.hostname,
      value: ip,
      purpose: "The mail host's address",
      required: true,
    },
    {
      id: `ptr-${ip}`,
      type: "PTR" as const,
      name: reverseName(ip),
      value: `${config.hostname}.`,
      purpose:
        "Reverse DNS, set in your VPS provider's panel: receivers distrust servers without it",
      required: true,
    },
  ]);
}

const clean = (name: string) => name.toLowerCase().replace(/\.$/, "");
const squash = (value: string) => value.replace(/\s+/g, "").toLowerCase();

async function checkRecord(
  record: DnsRecord,
  resolver: Resolver,
  config: MailConfig,
  addresses: string[],
): Promise<RecordCheck> {
  const result = (
    ok: boolean,
    found: string[],
    note?: string,
  ): RecordCheck => ({ ...record, ok, found, note });
  try {
    switch (record.id) {
      case "mx": {
        const mx = await resolver.mx(record.name);
        const found = mx.map((m) => `${m.priority} ${m.exchange}`);
        const ok = mx.some((m) => clean(m.exchange) === config.hostname);
        const others = mx.filter((m) => clean(m.exchange) !== config.hostname);
        return result(
          ok,
          found,
          ok && others.length
            ? `Other MX hosts also receive: ${others.map((m) => m.exchange).join(", ")}`
            : undefined,
        );
      }
      case "spf": {
        const txt = (await resolver.txt(record.name)).filter((t) =>
          /^v=spf1/i.test(t),
        );
        if (txt.length !== 1)
          return result(
            false,
            txt,
            txt.length ? "Publish one SPF record only: merge them" : undefined,
          );
        // What matters is that the policy lets this server's addresses through.
        const outcomes = await Promise.all(
          addresses.map((ip) =>
            checkSpf({
              resolver,
              ip,
              sender: `postmaster@${record.name}`,
              helo: config.hostname,
            }),
          ),
        );
        const ok =
          addresses.length > 0 && outcomes.every((o) => o.result === "pass");
        return result(
          ok,
          txt,
          ok
            ? undefined
            : `SPF gives ${outcomes.map((o) => o.result).join(", ") || "no address to test"} for this server`,
        );
      }
      case "dkim": {
        const txt = await resolver.txt(record.name);
        const want = parseTags(record.value).p;
        const ok = txt.some((t) => parseTags(t).p === want);
        return result(
          ok,
          txt.map((t) => (t.length > 80 ? `${t.slice(0, 77)}…` : t)),
          !ok && txt.length ? "A different key is published here" : undefined,
        );
      }
      case "dmarc": {
        const txt = (await resolver.txt(record.name)).filter((t) =>
          /^v=DMARC1/i.test(t),
        );
        return result(
          txt.length === 1,
          txt,
          txt.length > 1 ? "Publish one DMARC record only" : undefined,
        );
      }
      case "mta-sts": {
        const txt = (await resolver.txt(record.name)).filter((t) =>
          /^v=STSv1/i.test(t),
        );
        return result(txt.length === 1, txt);
      }
      case "tls-rpt": {
        const txt = (await resolver.txt(record.name)).filter((t) =>
          /^v=TLSRPTv1/i.test(t),
        );
        return result(txt.length === 1, txt);
      }
      case "mta-sts-host":
      case "autoconfig": {
        // A CNAME or an A record will do, as long as it reaches this server.
        const found = await resolver.a(record.name);
        const ok =
          found.length > 0 && found.every((a) => addresses.includes(a));
        return result(ok, found);
      }
      case "srv-imaps":
      case "srv-submissions": {
        // SRV needs its own lookup; resolve it through node:dns directly.
        const { promises } = await import("node:dns");
        const found = await promises.resolveSrv(record.name).catch(() => []);
        const ok = found.some((s) => clean(s.name) === config.hostname);
        return result(
          ok,
          found.map((s) => `${s.priority} ${s.weight} ${s.port} ${s.name}`),
        );
      }
      default: {
        if (record.type === "A" || record.type === "AAAA") {
          const found =
            record.type === "A"
              ? await resolver.a(record.name)
              : await resolver.aaaa(record.name);
          return result(found.includes(record.value), found);
        }
        if (record.type === "PTR") {
          const ip = record.id.slice(4);
          const found = await resolver.ptr(ip);
          const ok = found.some((name) => clean(name) === config.hostname);
          return result(ok, found);
        }
        const txt = await resolver.txt(record.name);
        return result(
          txt.some((t) => squash(t) === squash(record.value)),
          txt,
        );
      }
    }
  } catch (error) {
    return result(
      false,
      [],
      `Lookup failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function checkDomain(
  domain: Domain,
  config: MailConfig,
  resolver: Resolver,
  addresses: string[],
): Promise<DomainReport> {
  const records = domainRecords(domain, config, addresses);
  const checks = await Promise.all(
    records.map((r) => checkRecord(r, resolver, config, addresses)),
  );
  return {
    domain: domain.name,
    verified: checks.every((c) => c.ok || !c.required),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkHost(
  config: MailConfig,
  resolver: Resolver,
  addresses: string[],
): Promise<RecordCheck[]> {
  return Promise.all(
    hostRecords(config, addresses).map((r) =>
      checkRecord(r, resolver, config, addresses),
    ),
  );
}

/**
 * Whether this machine can open connections to port 25 elsewhere: many VPS providers block it until asked, and
 * outgoing mail then needs MAIL_RELAY.
 */
export function canReachPort25(
  host = "gmail-smtp-in.l.google.com",
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 25 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A zone-file snippet of the records, to paste into a DNS provider that imports BIND files. */
export function zoneFile(records: DnsRecord[]): string {
  return records
    .filter((r) => r.type !== "PTR")
    .map((r) => {
      const value =
        r.type === "TXT"
          ? r.value
              .match(/.{1,250}/g)!
              .map((chunk) => `"${chunk}"`)
              .join(" ")
          : r.value;
      return `${r.name}.\t3600\tIN\t${r.type}\t${value}`;
    })
    .join("\n");
}
