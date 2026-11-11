// Local server: the web app, the forge, the builder's API and live previews, and the agent following new messages
// through Realtime.
//
// `bun --hot` re-runs this module on every change. The stateful parts (database, agent, previews) start once per
// process and survive reloads; a reload only swaps the server's routes. Restart the server to reload the agent.

import { openAgent } from "./agent/runtime.ts";
import { dockerAvailable, Previews } from "./builder/previews.ts";
import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createBuilderApi } from "./server/builder-api.ts";
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

  const opened = await openAgent(sql, storage, { previews });
  opened.agent.start();

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await globalThis.richelieuServer?.stop();
    await opened.close();
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
  };
}

declare global {
  var richelieu: ReturnType<typeof boot> | undefined;
  var richelieuServer: Bun.Server<undefined> | undefined;
}

globalThis.richelieu ??= boot();
const { sql, forge, store, previews, shipping } = await globalThis.richelieu;

const server = Bun.serve({
  port: config.port,
  routes: {
    [`${FORGE_PATH}/*`]: (request) => forge.fetch(request),
    // The deployed app pings its agent function after sending; here the agent already follows Realtime.
    "/api/agent": () => new Response(null, { status: 202 }),
    ...createBuilderApi({ sql, store, previews, shipping }),
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
