// Local server: the web app, the forge, and the agent following new messages through Realtime.

import { openAgent } from "./agent/runtime.ts";
import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createServices, FORGE_PATH } from "./server/services.ts";
import index from "./web/index.html";

const { sql, forge, storage } = createServices();
for (const file of await migrate(sql)) console.log(`[db] applied ${file}`);

const { agent, close } = await openAgent(sql, storage);
agent.start();

const server = Bun.serve({
  port: config.port,
  routes: {
    [`${FORGE_PATH}/*`]: (request) => forge.fetch(request),
    // The deployed app pings its agent function after sending; here the agent already follows Realtime.
    "/api/agent": () => new Response(null, { status: 202 }),
    "/*": index,
  },
  development: Bun.env.NODE_ENV !== "production" && { hmr: true, console: true },
});
console.log(`[web] ${server.url}`);
console.log(`[forge] ${config.publicUrl}${FORGE_PATH}/api/v1 and ${config.publicUrl}${FORGE_PATH}/git/<repo>.git`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await close();
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
