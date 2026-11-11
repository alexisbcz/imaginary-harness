// Tokens: ES256 JWTs an organization signs with its private key, as the `@pierre/storage` SDK mints them
// (`iss` = organization, `repo`, `scopes`, `exp`). The forge checks them against the organization's public keys.

import { decodeJwt, importSPKI, jwtVerify, type CryptoKey } from "jose";
import type { RepoStore } from "./store.ts";

export type Scope = "git:read" | "git:write" | "repo:write" | "org:read";

export interface Claims {
  readonly org: string;
  readonly repo: string;
  readonly scopes: readonly string[];
}

export class Unauthorized extends Error {
  readonly status = 401;
}

export class Forbidden extends Error {
  readonly status = 403;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string) {
  let key = keyCache.get(pem);
  if (key === undefined) {
    key = importSPKI(pem, "ES256");
    keyCache.set(pem, key);
  }
  return key;
}

/** Verifies `token` against its issuer's keys. */
export async function verifyToken(repos: RepoStore, token: string): Promise<Claims> {
  let issuer: string | undefined;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    throw new Unauthorized("Malformed token");
  }
  if (!issuer) throw new Unauthorized("Token has no issuer");
  const keys = await repos.orgKeys(issuer);
  if (keys === undefined) throw new Unauthorized("Unknown organization");
  for (const pem of keys) {
    try {
      const { payload } = await jwtVerify(token, await importKey(pem), { algorithms: ["ES256"], issuer });
      const scopes = Array.isArray(payload.scopes) ? payload.scopes.map(String) : [];
      if (typeof payload.repo !== "string" || payload.repo === "") throw new Unauthorized("Token has no repository");
      return { org: issuer, repo: payload.repo, scopes };
    } catch (error) {
      if (error instanceof Unauthorized) throw error;
      // Try the next key; a rotation keeps two.
    }
  }
  throw new Unauthorized("Invalid or expired token");
}

/** Throws unless the claims carry one of `scopes`. `git:write` implies `git:read`; `repo:write` implies both. */
export function requireScope(claims: Claims, ...scopes: Scope[]) {
  const granted = new Set(claims.scopes);
  if (granted.has("repo:write")) granted.add("git:write");
  if (granted.has("git:write")) granted.add("git:read");
  if (!scopes.some((scope) => granted.has(scope))) {
    throw new Forbidden(`Token lacks the ${scopes.join(" or ")} scope`);
  }
}

/** The bearer token of a request: `Authorization: Bearer`, or the password of HTTP Basic (git's remote URL). */
export function tokenOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(":");
    return colon === -1 ? decoded : decoded.slice(colon + 1);
  }
  return undefined;
}
