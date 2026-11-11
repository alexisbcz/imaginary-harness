// SPF (RFC 7208): whether the connecting address may send for the envelope sender's domain. Implements every
// mechanism and modifier with the specification's limits: ten DNS-querying terms, two void lookups, ten MX or PTR
// names per mechanism.

import { isIP } from "node:net";
import { DnsTempError, type Resolver } from "./dns.ts";
import { inRange, normalizeIp, reverseName } from "./ip.ts";

export type SpfResult =
  "pass" | "fail" | "softfail" | "neutral" | "none" | "permerror" | "temperror";

export type SpfOutcome = {
  result: SpfResult;
  domain: string;
  /** The mechanism that matched, or why the check ended. */
  reason: string;
};

class PermError extends Error {}

const QUALIFIERS: Record<string, SpfResult> = {
  "+": "pass",
  "-": "fail",
  "~": "softfail",
  "?": "neutral",
};

type Context = {
  resolver: Resolver;
  ip: string;
  sender: string;
  helo: string;
  lookups: number;
  voids: number;
};

async function spfRecord(
  ctx: Context,
  domain: string,
): Promise<string | undefined> {
  const records = (await ctx.resolver.txt(domain)).filter((r) =>
    /^v=spf1(\s|$)/i.test(r),
  );
  if (records.length > 1)
    throw new PermError(`${domain} has several SPF records`);
  return records[0];
}

/** Expands `%{d}`, `%{i}`, `%{s}`... (RFC 7208 section 7). */
function expand(ctx: Context, domain: string, spec: string): string {
  const [local = "postmaster", senderDomain = ctx.helo] = ctx.sender.includes(
    "@",
  )
    ? ctx.sender.split(/@(?=[^@]*$)/)
    : ["postmaster", ctx.sender || ctx.helo];
  return spec.replace(
    /%(?:\{([slodiphcrtv])(\d*)(r?)([.\-+,/_=]*)\}|%|_|-)/gi,
    (
      whole,
      letter?: string,
      digits?: string,
      reverse?: string,
      delimiters?: string,
    ) => {
      if (whole === "%%") return "%";
      if (whole === "%_") return " ";
      if (whole === "%-") return "%20";
      const ip = normalizeIp(ctx.ip);
      const values: Record<string, string> = {
        s: ctx.sender || `postmaster@${ctx.helo}`,
        l: local,
        o: senderDomain,
        d: domain,
        i:
          isIP(ip) === 4
            ? ip
            : reverseName(ip)
                .replace(/\.ip6\.arpa$/, "")
                .split(".")
                .reverse()
                .join("."),
        p: "unknown",
        h: ctx.helo,
        v: isIP(ip) === 4 ? "in-addr" : "ip6",
      };
      let value = values[letter!.toLowerCase()] ?? "";
      const split = new RegExp(
        `[${(delimiters || ".").replace(/[\\\]-]/g, "\\$&")}]`,
      );
      let parts = value.split(split);
      if (reverse) parts = parts.reverse();
      if (digits) parts = parts.slice(-Number(digits));
      value = parts.join(".");
      return letter === letter!.toUpperCase()
        ? encodeURIComponent(value)
        : value;
    },
  );
}

function countLookup(ctx: Context) {
  if (++ctx.lookups > 10) throw new PermError("more than 10 DNS lookups");
}

async function addressesOf(ctx: Context, name: string): Promise<string[]> {
  const family = isIP(normalizeIp(ctx.ip));
  const found =
    family === 4 ? await ctx.resolver.a(name) : await ctx.resolver.aaaa(name);
  return found;
}

function noteVoid(ctx: Context, results: unknown[]) {
  if (results.length === 0 && ++ctx.voids > 2)
    throw new PermError("more than 2 void DNS lookups");
}

/** `domain/cidr4//cidr6` → its parts. */
function splitCidr(value: string, fallback: string) {
  const match = value.match(/^([^/]*)(?:\/(\d+))?(?:\/\/(\d+))?$/);
  if (!match) throw new PermError(`invalid term ${value}`);
  return {
    domain: match[1] || fallback,
    v4: match[2] ? Number(match[2]) : 32,
    v6: match[3] ? Number(match[3]) : 128,
  };
}

async function checkHost(
  ctx: Context,
  domain: string,
  depth: number,
): Promise<SpfOutcome> {
  if (depth > 10) throw new PermError("include loop");
  const record = await spfRecord(ctx, domain);
  if (record === undefined)
    return { result: "none", domain, reason: `no SPF record at ${domain}` };
  const terms = record.split(/\s+/).slice(1).filter(Boolean);
  let redirect: string | undefined;
  const family = isIP(normalizeIp(ctx.ip));
  const prefixFor = (cidr: { v4: number; v6: number }) =>
    family === 4 ? cidr.v4 : cidr.v6;

  for (const term of terms) {
    const modifier = term.match(/^([a-z][a-z0-9_.-]*)=(.*)$/i);
    if (modifier) {
      if (modifier[1]!.toLowerCase() === "redirect") redirect = modifier[2]!;
      continue;
    }
    const match = term.match(/^([+\-~?]?)([a-z0-9]+)(?::(.*?))?(\/.*)?$/i);
    if (!match) throw new PermError(`invalid term ${term}`);
    const qualifier = QUALIFIERS[match[1] || "+"]!;
    const mechanism = match[2]!.toLowerCase();
    const argument =
      match[3] !== undefined ? expand(ctx, domain, match[3]) : undefined;
    const cidr = splitCidr(`${argument ?? ""}${match[4] ?? ""}`, domain);
    let matched = false;

    switch (mechanism) {
      case "all":
        matched = true;
        break;
      case "ip4":
      case "ip6": {
        const [network, prefix] = (match[3] ?? "").split("/");
        const bits = (match[4] ?? "").replace(/^\//, "") || prefix;
        matched = inRange(ctx.ip, network!, bits ? Number(bits) : undefined);
        break;
      }
      case "a": {
        countLookup(ctx);
        const addresses = await addressesOf(ctx, cidr.domain);
        noteVoid(ctx, addresses);
        matched = addresses.some((address) =>
          inRange(ctx.ip, address, prefixFor(cidr)),
        );
        break;
      }
      case "mx": {
        countLookup(ctx);
        const exchanges = await ctx.resolver.mx(cidr.domain);
        noteVoid(ctx, exchanges);
        if (exchanges.length > 10) throw new PermError("more than 10 MX names");
        for (const { exchange } of exchanges) {
          const addresses = await addressesOf(ctx, exchange);
          if (
            addresses.some((address) =>
              inRange(ctx.ip, address, prefixFor(cidr)),
            )
          ) {
            matched = true;
            break;
          }
        }
        break;
      }
      case "ptr": {
        countLookup(ctx);
        const target = (argument ?? domain).toLowerCase();
        const names = (await ctx.resolver.ptr(normalizeIp(ctx.ip))).slice(
          0,
          10,
        );
        for (const name of names) {
          const host = name.toLowerCase().replace(/\.$/, "");
          if (host !== target && !host.endsWith(`.${target}`)) continue;
          if (
            (await addressesOf(ctx, host)).some((address) =>
              inRange(ctx.ip, address),
            )
          ) {
            matched = true;
            break;
          }
        }
        break;
      }
      case "include": {
        countLookup(ctx);
        if (!argument) throw new PermError("include without a domain");
        const included = await checkHost(ctx, argument, depth + 1);
        if (included.result === "none")
          throw new PermError(`include ${argument} has no SPF record`);
        if (included.result === "permerror" || included.result === "temperror")
          return included;
        matched = included.result === "pass";
        break;
      }
      case "exists": {
        countLookup(ctx);
        if (!argument) throw new PermError("exists without a domain");
        const addresses = await ctx.resolver.a(argument);
        noteVoid(ctx, addresses);
        matched = addresses.length > 0;
        break;
      }
      default:
        throw new PermError(`unknown mechanism ${mechanism}`);
    }
    if (matched)
      return { result: qualifier, domain, reason: `${domain}: ${term}` };
  }

  if (redirect) {
    countLookup(ctx);
    const target = expand(ctx, domain, redirect);
    const outcome = await checkHost(ctx, target, depth + 1);
    if (outcome.result === "none")
      throw new PermError(`redirect ${target} has no SPF record`);
    return outcome;
  }
  return {
    result: "neutral",
    domain,
    reason: `${domain}: no mechanism matched`,
  };
}

/**
 * Checks the envelope sender (`MAIL FROM`), or the HELO name when the sender is empty (a bounce), against the
 * connecting address.
 */
export async function checkSpf(options: {
  resolver: Resolver;
  ip: string;
  sender: string;
  helo: string;
}): Promise<SpfOutcome> {
  const sender = options.sender || `postmaster@${options.helo}`;
  const domain = sender.slice(sender.lastIndexOf("@") + 1).toLowerCase();
  const ctx: Context = { ...options, sender, lookups: 0, voids: 0 };
  try {
    return await checkHost(ctx, domain, 0);
  } catch (error) {
    if (error instanceof PermError)
      return { result: "permerror", domain, reason: error.message };
    if (error instanceof DnsTempError)
      return { result: "temperror", domain, reason: error.message };
    throw error;
  }
}
