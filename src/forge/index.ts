// The forge: a stateless `fetch` handler over Supabase Postgres. Mount it under any path, in Bun.serve locally or
// as a Vercel function:
//
//   <basePath>/api/v1/…                 code.storage-compatible API (`@pierre/storage` with `apiBaseUrl`)
//   <basePath>/git/<repo>.git/…         git smart HTTP (the SDK's `getRemoteURL()`, with `storageBaseUrl`)

import type { SQL } from "bun";
import { handleApi, json } from "./api.ts";
import { tokenOf, Unauthorized, verifyToken } from "./auth.ts";
import { infoRefs, receivePack, uploadPack } from "./protocol.ts";
import { RepoStore } from "./store.ts";

export interface ForgeOptions {
  readonly sql: SQL;
  /** Where the forge is mounted, like "/forge". */
  readonly basePath?: string;
  /** The public origin, like https://app.example.com; defaults to the request's. */
  readonly publicOrigin?: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, code-storage-agent, range, if-match, if-none-match, if-modified-since, if-unmodified-since, if-range",
  "access-control-expose-headers": "etag, x-blob-sha, x-last-commit-sha, content-range, content-length, accept-ranges",
  "access-control-max-age": "86400",
};

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorResponse(error: unknown, git: boolean) {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const message = error instanceof Error ? error.message : "Internal error";
  if (status === 500) console.error("[forge]", error);
  if (git) {
    const headers: Record<string, string> = { "content-type": "text/plain" };
    if (status === 401) headers["www-authenticate"] = 'Basic realm="forge"';
    return new Response(`${message}\n`, { status, headers });
  }
  return json({ error: message }, status);
}

export function createForge(options: ForgeOptions) {
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const repos = new RepoStore(options.sql);

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`)) return new Response("Not found", { status: 404 });
    const path = url.pathname.slice(basePath.length + 1);
    const origin = options.publicOrigin ?? url.origin;

    if (path.startsWith("api/v1/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      try {
        const response = await handleApi(
          { sql: options.sql, repos, gitBaseUrl: `${origin}${basePath}/git` },
          request,
          path.slice("api/v1/".length),
          tokenOf(request),
        );
        return withCors(response);
      } catch (error) {
        return withCors(errorResponse(error, false));
      }
    }

    const git = /^git\/([A-Za-z0-9][A-Za-z0-9._-]*?)(\+ephemeral|\+import)?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (git) {
      try {
        const token = tokenOf(request);
        if (!token) throw new Unauthorized("Authentication required");
        const claims = await verifyToken(repos, token);
        const [, repo, suffix, action] = git;
        if (claims.repo !== repo) throw new Unauthorized("This token is for another repository");
        const target = { claims, repo: repo!, ephemeral: suffix === "+ephemeral" };
        const ctx = { sql: options.sql, repos };
        if (action === "info/refs" && request.method === "GET") return await infoRefs(ctx, target, url.searchParams.get("service") ?? "");
        if (action === "git-upload-pack" && request.method === "POST") return await uploadPack(ctx, target, request);
        if (action === "git-receive-pack" && request.method === "POST") return await receivePack(ctx, target, request);
        return new Response("Method not allowed", { status: 405 });
      } catch (error) {
        return errorResponse(error, true);
      }
    }
    return new Response("Not found", { status: 404 });
  }

  return { fetch, repos };
}

export type Forge = ReturnType<typeof createForge>;
