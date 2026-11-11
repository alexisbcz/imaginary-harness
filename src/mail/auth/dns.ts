// The DNS lookups mail needs, behind one interface so tests (and the doctor's dry runs) can answer them. A name that
// does not exist answers an empty list; a lookup that fails (timeout, SERVFAIL) throws `DnsTempError`, which SPF
// and DMARC report as `temperror` rather than as a missing record.

import { promises as dns } from "node:dns";

export type MxRecord = { exchange: string; priority: number };

export interface Resolver {
  txt(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  mx(name: string): Promise<MxRecord[]>;
  ptr(ip: string): Promise<string[]>;
}

export class DnsTempError extends Error {}

const MISSING = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENONAME"]);

async function lookup<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (MISSING.has(code)) return [];
    throw new DnsTempError(`DNS lookup failed: ${code || String(error)}`);
  }
}

export function systemResolver(servers?: string[]): Resolver {
  const resolver = new dns.Resolver({ timeout: 5_000, tries: 2 });
  if (servers?.length) resolver.setServers(servers);
  return {
    txt: (name) =>
      lookup(async () =>
        (await resolver.resolveTxt(name)).map((chunks) => chunks.join("")),
      ),
    a: (name) => lookup(() => resolver.resolve4(name)),
    aaaa: (name) => lookup(() => resolver.resolve6(name)),
    mx: (name) =>
      lookup(async () =>
        (await resolver.resolveMx(name)).map(({ exchange, priority }) => ({
          exchange,
          priority,
        })),
      ),
    ptr: (ip) => lookup(() => resolver.reverse(ip)),
  };
}

/** A resolver answering from a table, for tests: `{ "TXT example.com": ["v=spf1 -all"] }`. */
export function staticResolver(records: Record<string, unknown[]>): Resolver {
  const get = <T>(type: string, name: string) => {
    const key = `${type} ${name.toLowerCase().replace(/\.$/, "")}`;
    const value = records[key];
    if (value && value.length === 1 && value[0] === "TEMPFAIL")
      throw new DnsTempError("DNS lookup failed: SERVFAIL");
    return Promise.resolve((value ?? []) as T[]);
  };
  return {
    txt: (name) => get("TXT", name),
    a: (name) => get("A", name),
    aaaa: (name) => get("AAAA", name),
    mx: (name) => get("MX", name),
    ptr: (ip) => get("PTR", ip),
  };
}
