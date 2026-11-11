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

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
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
    certificates: mail?.certificates,
  };
}

declare global {
  var richelieu: ReturnType<typeof boot> | undefined;
  var richelieuServer: Bun.Server<undefined> | undefined;
}

globalThis.richelieu ??= boot();
const { sql, forge, store, previews, shipping, mailService, certificates } =
  await globalThis.richelieu;
const mailApi = createMailApi({ sql, service: mailService, certificates });
const tls = config.https ? certificates?.pem : undefined;
if (config.https && !tls)
  console.warn(
    "[web] WEB_HTTPS is set but there is no certificate yet (MAIL_ENABLED and MAIL_TLS=acme issue one)",
  );

const server = Bun.serve({
  port: tls ? config.httpsPort : config.port,
  ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
  routes: {
    [`${FORGE_PATH}/*`]: (request) => forge.fetch(request),
    // The deployed app pings its agent function after sending; here the agent already follows Realtime.
    "/api/agent": () => new Response(null, { status: 202 }),
    ...createBuilderApi({ sql, store, previews, shipping }),
    ...mailApi.api,
    ...mailApi.wellKnown,
    "/*": index,
  },
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
