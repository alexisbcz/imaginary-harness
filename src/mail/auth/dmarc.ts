// DMARC (RFC 7489): whether the domain a reader sees in From is the one SPF or DKIM vouched for, and what that
// domain asks receivers to do when neither does.

import { DnsTempError, type Resolver } from "./dns.ts";
import type { DkimResult } from "./dkim.ts";
import type { SpfOutcome } from "./spf.ts";

export type DmarcPolicy = "none" | "quarantine" | "reject";

export type DmarcResult = {
  result: "pass" | "fail" | "none" | "temperror" | "permerror";
  domain: string;
  /** What the domain asks for a failing message, after `pct`. */
  policy: DmarcPolicy;
  spfAligned: boolean;
  dkimAligned: boolean;
  record?: Record<string, string>;
};

/**
 * Second-level suffixes under which registrations are one label deeper (`example.co.uk`). A short list rather
 * than the Public Suffix List: enough for alignment of the common cases, and it errs towards strict alignment.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "com.br",
  "net.br",
  "org.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "co.in",
  "net.in",
  "org.in",
  "co.za",
  "org.za",
  "com.mx",
  "com.ar",
  "com.tr",
  "com.sg",
  "com.hk",
  "com.tw",
  "co.kr",
  "co.il",
  "gouv.fr",
  "asso.fr",
  "nom.fr",
]);

/** The organizational domain: the registered name under its public suffix. */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

const aligned = (a: string, b: string, mode: string) =>
  mode === "s"
    ? a.toLowerCase() === b.toLowerCase()
    : organizationalDomain(a) === organizationalDomain(b);

async function recordOf(resolver: Resolver, domain: string) {
  const records = (await resolver.txt(`_dmarc.${domain}`)).filter((r) =>
    /^v=DMARC1\s*(;|$)/i.test(r),
  );
  if (records.length !== 1) return undefined;
  const tags: Record<string, string> = {};
  for (const pair of records[0]!.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0)
      tags[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
  }
  return tags;
}

/** Evaluates DMARC for the From domain, given the SPF result of the envelope and the DKIM results of the message. */
export async function checkDmarc(options: {
  resolver: Resolver;
  fromDomain: string;
  spf: SpfOutcome;
  dkim: DkimResult[];
  /** For `pct`: a number in [0, 100); random by default. */
  sample?: number;
}): Promise<DmarcResult> {
  const fromDomain = options.fromDomain.toLowerCase();
  const empty = {
    domain: fromDomain,
    policy: "none" as const,
    spfAligned: false,
    dkimAligned: false,
  };
  let record: Record<string, string> | undefined;
  let isSubdomain = false;
  try {
    record = await recordOf(options.resolver, fromDomain);
    const org = organizationalDomain(fromDomain);
    if (!record && org !== fromDomain) {
      record = await recordOf(options.resolver, org);
      isSubdomain = record !== undefined;
    }
  } catch (error) {
    if (error instanceof DnsTempError) return { ...empty, result: "temperror" };
    throw error;
  }
  if (!record) return { ...empty, result: "none" };
  const policyTag = (
    isSubdomain ? (record.sp ?? record.p) : record.p
  )?.toLowerCase();
  if (
    policyTag !== "none" &&
    policyTag !== "quarantine" &&
    policyTag !== "reject"
  )
    return { ...empty, record, result: "permerror" };

  const spfAligned =
    options.spf.result === "pass" &&
    aligned(options.spf.domain, fromDomain, record.aspf ?? "r");
  const dkimAligned = options.dkim.some(
    (d) =>
      d.result === "pass" &&
      d.domain !== undefined &&
      aligned(d.domain, fromDomain, record.adkim ?? "r"),
  );
  const pass = spfAligned || dkimAligned;
  const pct = Math.min(100, Math.max(0, Number(record.pct ?? 100)));
  const sample = options.sample ?? Math.random() * 100;
  // A message outside `pct` gets the next policy down.
  let policy: DmarcPolicy = policyTag;
  if (!pass && sample >= pct)
    policy = policyTag === "reject" ? "quarantine" : "none";
  return {
    result: pass ? "pass" : "fail",
    domain: fromDomain,
    policy,
    spfAligned,
    dkimAligned,
    record,
  };
}
