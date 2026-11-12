// Local server: the web app, the forge, the builder's API and live previews, and the agent following new messages
// through Realtime.
//
// `bun --hot` re-runs this module on every change. The stateful parts (database, agent, previews) start once per
// process and survive reloads; a reload only swaps the server's routes. Restart the server to reload the agent.

import { openAgent } from "./agent/runtime.ts";
import { dockerAvailable, Previews } from "./builder/previews.ts";
import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { systemResolver } from "./mail/auth/dns.ts";
import { mailConfig } from "./mail/config.ts";
import { startMail, type MailRuntime } from "./mail/runtime.ts";
import { MailService } from "./mail/service.ts";
import { MailStore } from "./mail/store.ts";
import { challengeResponse } from "./mail/tls/acme.ts";
import { createBuilderApi } from "./server/builder-api.ts";
import { createMailApi } from "./server/mail-api.ts";
import { createSocialApi } from "./server/social-api.ts";
import { SocialService } from "./social/service.ts";
import { createSupabaseProxy } from "./server/supabase-proxy.ts";
import { createServices, FORGE_PATH } from "./server/services.ts";
import index from "./web/index.html";

async function boot() {
  const { sql, forge, storage } = createServices();
  for (const file of await migrate(sql)) console.log(`[db] applied ${file}`);

  // Previews run in Docker; without it the app builds but shows no preview.
  let previews: Previews | undefined;
  if (await dockerAvailable()) {
    previews = new Previews((threadId) =>
      opened.store ? opened.store.files(threadId) : Promise.resolve({}),
    );
    await previews.start();
  } else console.warn("[preview] Docker is not available: previews are off");

  // Plain HTTP: ACME challenges (before the certificate below is ordered) and a redirect to HTTPS.
  const challengePort = config.https
    ? config.httpPort
    : mailConfig.enabled
      ? mailConfig.ports.http
      : 0;
  const http = challengePort
    ? Bun.serve({
        port: challengePort,
        fetch: (request) => {
          const url = new URL(request.url);
          const token = url.pathname.match(
            /^\/\.well-known\/acme-challenge\/([\w-]+)$/,
          )?.[1];
          if (token) return challengeResponse(sql, token);
          if (!config.https) return new Response("Not found", { status: 404 });
          url.protocol = "https:";
          url.port = config.httpsPort === 443 ? "" : String(config.httpsPort);
          return Response.redirect(url.toString(), 301);
        },
      })
    : undefined;

  // Mail: SMTP, IMAP, the outbound queue and the certificate, in this process when MAIL_ENABLED is set.
  let mail: MailRuntime | undefined;
  if (mailConfig.enabled)
    mail = await startMail(sql, {
      webHost: new URL(config.publicUrl).hostname,
    });
  const mailService =
    mail?.service ??
    new MailService(
      sql,
      new MailStore(sql),
      mailConfig,
      systemResolver(mailConfig.dnsServers),
    );
  // A renewed certificate reaches the mail servers on the next connection; the web server restarts to take it
  // (systemd starts it again).
  if (mail && config.https)
    mail.certificates.onChange = () => {
      console.log("[tls] new certificate: restarting to serve it");
      void shutdown();
    };

  const opened = await openAgent(sql, storage, { previews, mailService });
  opened.agent.start();
  opened.assistant.start();

  // Watched social accounts are read again once a day; the check runs every hour, and once shortly after start.
  const refreshWatchlist = () =>
    void opened.socialService
      .refreshStale()
      .then((count) => count && console.log(`[social] refreshed ${count} watched accounts`))
      .catch((error) => console.warn("[social] watchlist:", error));
  const watchTimer = setInterval(refreshWatchlist, 60 * 60_000);
  setTimeout(refreshWatchlist, 30_000);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(watchTimer);
    await globalThis.richelieuServer?.stop();
    await http?.stop();
    await opened.close();
    await mail?.stop();
    await previews?.stop();
    await sql.close();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Published apps, on their own origin.
  const sites = opened.shipping
    ? Bun.serve({
        port: config.sitesPort,
        fetch: (request) => opened.shipping!.serveSite(request),
      })
    : undefined;
  if (sites) console.log(`[sites] ${config.sitesUrl}`);

  return {
    sql,
    forge,
    storage,
    previews,
    store: opened.store,
    shipping: opened.shipping,
    mailService,
    socialService: opened.socialService,
    certificates: mail?.certificates,
  };
}

declare global {
  var richelieu: ReturnType<typeof boot> | undefined;
  var richelieuServer: Bun.Server<any> | undefined;
}

globalThis.richelieu ??= boot();
const booted = await globalThis.richelieu;
const { sql, forge, store, previews, shipping, certificates } = booted;
// A process booted before mail existed (a `bun --hot` reload) gets a mail service on the fly; restart it to run the
// mail servers and the assistant.
const mailService =
  booted.mailService ??
  new MailService(
    sql,
    new MailStore(sql),
    mailConfig,
    systemResolver(mailConfig.dnsServers),
  );
const mailApi = createMailApi({ sql, service: mailService, certificates });
// Stateless but for a cache: made again on each `bun --hot` reload, so the API runs the latest code. The copilot's
// service is the boot's; restart to reload it.
const socialApi = createSocialApi({ service: new SocialService(sql) });
const tls = config.https ? certificates?.pem : undefined;
if (config.https && !tls)
  console.warn(
    "[web] WEB_HTTPS is set but there is no certificate yet (MAIL_ENABLED and MAIL_TLS=acme issue one)",
  );

// Its WebSocket handler only runs for upgrades its routes start, which exist only with SUPABASE_PROXY.
const proxy = createSupabaseProxy(config.supabaseUrl);

const server = Bun.serve({
  port: tls ? config.httpsPort : config.port,
  ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
  routes: {
    [`${FORGE_PATH}/*`]: (request) => forge.fetch(request),
    // The deployed app pings its agent function after sending; here the agent already follows Realtime.
    "/api/agent": () => new Response(null, { status: 202 }),
    ...createBuilderApi({ sql, store, previews, shipping }),
    ...mailApi.api,
    ...socialApi,
    ...mailApi.wellKnown,
    ...(config.supabaseProxy ? proxy.routes : {}),
    "/*": index,
  },
  websocket: proxy.websocket,
  development: Bun.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});
if (!globalThis.richelieuServer) {
  console.log(`[web] ${server.url}`);
  console.log(
    `[forge] ${config.publicUrl}${FORGE_PATH}/api/v1 and ${config.publicUrl}${FORGE_PATH}/git/<repo>.git`,
  );
}
globalThis.richelieuServer = server;
