// Supabase on the app's own origin, for a single VPS: the browser reaches Auth, PostgREST, Realtime (WebSocket)
// and Storage at https://app.example.com/{auth,rest,realtime,storage}/v1, which this server forwards to the Supabase
// API gateway listening on the loopback (compose.yml). One hostname, one certificate, no CORS.

type ProxySocket = {
  target: string;
  upstream?: WebSocket;
  pending: (string | Buffer)[];
};

const SERVICES = [
  "auth",
  "rest",
  "realtime",
  "storage",
  "functions",
  "graphql",
];

/** Headers that describe one hop, not the request. */
const HOP_BY_HOP = [
  "host",
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authorization",
];

export function createSupabaseProxy(upstream: string) {
  const base = upstream.replace(/\/+$/, "");

  async function forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    const response = await fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
      // @ts-expect-error: streaming request bodies need half duplex.
      duplex: "half",
    });
    // fetch already decompressed the body.
    const out = new Headers(response.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    });
  }

  const routes: Record<
    string,
    (
      request: Request,
      server: Bun.Server<ProxySocket>,
    ) => Response | Promise<Response> | undefined
  > = {};
  for (const service of SERVICES) {
    routes[`/${service}/v1/*`] = (request, server) => {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(request.url);
        const target = `${base.replace(/^http/, "ws")}${url.pathname}${url.search}`;
        if (server.upgrade(request, { data: { target, pending: [] } }))
          return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return forward(request);
    };
  }

  const websocket: Bun.WebSocketHandler<ProxySocket> = {
    open(ws) {
      const upstreamSocket = new WebSocket(ws.data.target);
      upstreamSocket.binaryType = "arraybuffer";
      ws.data.upstream = upstreamSocket;
      upstreamSocket.onopen = () => {
        for (const message of ws.data.pending)
          upstreamSocket.send(message as never);
        ws.data.pending = [];
      };
      upstreamSocket.onmessage = (event) =>
        ws.send(event.data as string | ArrayBuffer);
      upstreamSocket.onclose = () => ws.close();
      upstreamSocket.onerror = () => ws.close();
    },
    message(ws, message) {
      const upstreamSocket = ws.data.upstream;
      if (upstreamSocket?.readyState === WebSocket.OPEN)
        upstreamSocket.send(message as never);
      else ws.data.pending.push(message);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  };

  return { routes, websocket };
}
