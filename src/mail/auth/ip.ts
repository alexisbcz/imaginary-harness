// IPv4 and IPv6 addresses as integers, for the CIDR ranges of SPF's ip4, ip6, a and mx mechanisms.

import { isIP } from "node:net";

/** `::ffff:1.2.3.4`, as a dual-stack socket reports an IPv4 peer, is plain `1.2.3.4`. */
export const normalizeIp = (ip: string) =>
  ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");

function ipv4ToBigInt(ip: string): bigint {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet) & 255), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  let address = ip;
  // An embedded IPv4 tail: ::ffff:1.2.3.4
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToBigInt(v4[1]!);
    address = address.replace(
      v4[1]!,
      `${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`,
    );
  }
  const [head = "", tail] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array(Math.max(0, missing)).fill("0"),
          ...tailGroups,
        ];
  return groups.reduce(
    (acc, group) => (acc << 16n) | BigInt(parseInt(group || "0", 16)),
    0n,
  );
}

/** Whether `ip` lies in `network/prefix`; addresses of different families never match. */
export function inRange(ip: string, network: string, prefix?: number): boolean {
  const a = normalizeIp(ip);
  const b = normalizeIp(network);
  const family = isIP(a);
  if (family === 0 || family !== isIP(b)) return false;
  const bits = family === 4 ? 32 : 128;
  const length = prefix ?? bits;
  if (length < 0 || length > bits) return false;
  const toInt = family === 4 ? ipv4ToBigInt : ipv6ToBigInt;
  const shift = BigInt(bits - length);
  return toInt(a) >> shift === toInt(b) >> shift;
}

/** The reverse lookup name of an address: `4.3.2.1.in-addr.arpa`, or the nibbles of an IPv6 one. */
export function reverseName(ip: string): string {
  const address = normalizeIp(ip);
  if (isIP(address) === 4)
    return `${address.split(".").reverse().join(".")}.in-addr.arpa`;
  const hex = ipv6ToBigInt(address).toString(16).padStart(32, "0");
  return `${hex.split("").reverse().join(".")}.ip6.arpa`;
}
