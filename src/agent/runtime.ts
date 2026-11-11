// The agent's Harness on Supabase Postgres, with the forge-backed workspace, for the server and functions alike.

import type { SQL } from "bun";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { GitStorage } from "@pierre/storage";
import { PostgresStorage } from "../pi/postgres-storage.ts";
import { Agent } from "./agent.ts";
import { createSandbox, dockerAvailable } from "./sandbox.ts";
import { createWorkspace } from "./workspace.ts";

export async function openAgent(
  sql: SQL,
  storage: GitStorage | undefined,
  options: { lockTimeoutMs?: number } = {},
) {
  const context = BACKGROUND_CONTEXT;
  const models = createModels();
  models.setProvider(anthropicProvider());
  const registry = createRegistry();
  if (storage) registry.install(createWorkspace(sql, storage));
  else
    console.warn(
      "[agent] FORGE_PRIVATE_KEY is not set: the workspace tools are off (bun run forge:org <name> --write-env)",
    );
  if (await dockerAvailable()) registry.install(createSandbox(sql));
  else
    console.warn(
      "[agent] Docker is not available: the run_command tool is off, so the agent cannot run code",
    );
  const harness = await Harness.open(
    await PostgresStorage.open(sql, {
      schema: "pi",
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    {
      models,
      registry,
      onReport: (report) => console.error(`[pi] ${report.kind}:`, report.error),
    },
    context,
  );
  const agent = new Agent(sql, harness, context);
  return {
    agent,
    async close() {
      await agent.stop();
      await harness.close(context);
    },
  };
}
