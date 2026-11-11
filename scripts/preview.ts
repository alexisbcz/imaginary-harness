// Serves the production build the way vercel.json routes it: static files from dist/, /forge/* rewritten to the
// forge function, /api/* to the functions, everything else to index.html. Run `bun run build` first.

import agent from "../api/agent.ts";
import forge from "../api/forge.ts";

const port = Number(Bun.env.PORT ?? 3000);
const functions: Record<
  string,
  { fetch(request: Request): Promise<Response> }
> = { "/api/forge": forge, "/api/agent": agent };

const server = Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/forge/")) {
      const rewritten = new URL(
        `/api/forge?__path=${encodeURIComponent(url.pathname.slice("/forge/".length))}`,
        url,
      );
      for (const [key, value] of url.searchParams)
        rewritten.searchParams.append(key, value);
      return forge.fetch(new Request(rewritten, request));
    }
    const fn = functions[url.pathname];
    if (fn) return fn.fetch(request);
    const file = Bun.file(`dist${url.pathname}`);
    if (url.pathname !== "/" && (await file.exists()))
      return new Response(file);
    return new Response(Bun.file("dist/index.html"), {
      headers: { "content-type": "text/html" },
    });
  },
});
console.log(`[preview] ${server.url}`);
