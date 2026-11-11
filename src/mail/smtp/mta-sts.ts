// MTA-STS (RFC 8461): a domain's promise that its MX hosts speak TLS with valid certificates. Outbound delivery
// fetches and caches policies; the web server publishes ours at https://mta-sts.<domain>/.well-known/mta-sts.txt.

import type { Resolver } from "../auth/dns.ts";

export type MtaStsPolicy = {
  mode: "enforce" | "testing" | "none";
  mx: string[];
  maxAge: number;
};

const cache = new Map<
  string,
  { id: string; policy: MtaStsPolicy; until: number }
>();

export function parsePolicy(text: string): MtaStsPolicy | undefined {
  const fields: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    (fields[line.slice(0, colon).trim().toLowerCase()] ??= []).push(
      line.slice(colon + 1).trim(),
    );
  }
  if (fields.version?.[0] !== "STSv1") return undefined;
  const mode = fields.mode?.[0];
  if (mode !== "enforce" && mode !== "testing" && mode !== "none")
    return undefined;
  return {
    mode,
    mx: fields.mx ?? [],
    maxAge: Number(fields.max_age?.[0] ?? 86400),
  };
}

/** `*.example.com` matches one label under example.com, as the specification says. */
export function mxAllowed(policy: MtaStsPolicy, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return policy.mx.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
      const rest = name.slice(name.indexOf(".") + 1);
      return rest === p.slice(2) && name.indexOf(".") > 0;
    }
    return p === name;
  });
}

export async function mtaStsPolicy(
  resolver: Resolver,
  domain: string,
): Promise<MtaStsPolicy | undefined> {
  const record = (await resolver.txt(`_mta-sts.${domain}`)).find((r) =>
    /^v=STSv1/i.test(r),
  );
  if (!record) return undefined;
  const id = record.match(/id=([A-Za-z0-9]+)/)?.[1] ?? "";
  const cached = cache.get(domain);
  if (cached && cached.id === id && cached.until > Date.now())
    return cached.policy;
  const response = await fetch(
    `https://mta-sts.${domain}/.well-known/mta-sts.txt`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) return cached?.policy;
  const policy = parsePolicy(await response.text());
  if (policy)
    cache.set(domain, {
      id,
      policy,
      until: Date.now() + Math.min(policy.maxAge, 31_557_600) * 1000,
    });
  return policy;
}

/** Our policy for a domain: enforce, with the mail host as its only MX. */
export const ourPolicy = (
  mailHost: string,
  mode: "enforce" | "testing" = "enforce",
) => `version: STSv1\nmode: ${mode}\nmx: ${mailHost}\nmax_age: 604800\n`;
