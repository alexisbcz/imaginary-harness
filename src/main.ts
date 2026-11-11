import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { Agent } from "./agent/agent.ts";
import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { PostgresStorage } from "./pi/postgres-storage.ts";
import index from "./web/index.html";

const context = BACKGROUND_CONTEXT;

const sql = new Bun.SQL(config.databaseUrl);
for (const file of await migrate(sql)) console.log(`[db] applied ${file}`);

const models = createModels();
models.setProvider(anthropicProvider());

const harness = await Harness.open(
  await PostgresStorage.open(sql, { schema: "pi" }),
  {
    models,
    registry: createRegistry(),
    onReport: (report) => console.error(`[pi] ${report.kind}:`, report.error),
  },
  context,
);

const agent = new Agent(sql, harness, context);
agent.start();

// The web app talks to Supabase directly; this server only serves it.
const server = Bun.serve({
  port: config.port,
  routes: { "/*": index },
  development: Bun.env.NODE_ENV !== "production" && { hmr: true, console: true },
});
console.log(`[web] ${server.url}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await agent.stop();
  await harness.close(context);
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
