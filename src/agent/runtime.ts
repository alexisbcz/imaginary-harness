// The agent's Harness on Supabase Postgres, with the forge-backed workspace, for the server and functions alike.
// With previews (the local server, where Docker runs), the agent can also check the app, add packages and run code.

import type { SQL } from "bun";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { GitStorage } from "@pierre/storage";
import type { Previews } from "../builder/previews.ts";
import { config } from "../config.ts";
import { createMailExtension } from "../mail/agent.ts";
import { MailAssistant } from "../mail/assistant.ts";
import { systemResolver } from "../mail/auth/dns.ts";
import { mailConfig } from "../mail/config.ts";
import { MailService } from "../mail/service.ts";
import { MailStore } from "../mail/store.ts";
import { createShipping, type Shipping } from "../builder/shipping.ts";
import { PostgresStorage } from "../pi/postgres-storage.ts";
import { Agent } from "./agent.ts";
import { createBuilder } from "./builder.ts";
import { createSandbox } from "./sandbox.ts";
import {
  createWorkspace,
  createWorkspaceStore,
  type WorkspaceStore,
} from "./workspace.ts";

export async function openAgent(
  sql: SQL,
  storage: GitStorage | undefined,
  options: {
    lockTimeoutMs?: number;
    previews?: Previews;
    mailService?: MailService;
  } = {},
) {
  const { previews } = options;
  const context = BACKGROUND_CONTEXT;
  const models = createModels();
  models.setProvider(anthropicProvider());
  const registry = createRegistry();
  let store: WorkspaceStore | undefined;
  let shipping: Shipping | undefined;
  if (storage) {
    store = createWorkspaceStore(sql, storage, (threadId, changes) => {
      previews
        ?.apply(threadId, changes)
        .catch((error) => console.error("[preview] sync:", error));
    });
    shipping = createShipping({ sql, store, storage, previews });
    registry.install(createWorkspace(store));
    registry.install(createBuilder(sql, store, previews, shipping));
  } else
    console.warn(
      "[agent] FORGE_PRIVATE_KEY is not set: the workspace tools are off (bun run forge:org <name> --write-env)",
    );
  // Containers need Docker, which only the local server has; the run_command sandbox shares it with previews.
  if (previews) registry.install(createSandbox(sql));
  // Mail: the agent reads and writes the user's mail, and the assistant reads new mail as it arrives. Sending
  // only queues; the mail server's queue delivers (`MAIL_ENABLED`, or `bun run mail serve`).
  const mailService =
    options.mailService ??
    new MailService(
      sql,
      new MailStore(sql),
      mailConfig,
      systemResolver(mailConfig.dnsServers),
    );
  const mail = createMailExtension(sql, mailService);
  registry.install(mail.extension);
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
  const agent = new Agent(sql, harness, context, store);
  const assistant = new MailAssistant(
    sql,
    harness,
    context,
    mailService,
    mail,
    config.model,
  );
  return {
    agent,
    assistant,
    store,
    shipping,
    mailService,
    async close() {
      await agent.stop();
      await assistant.stop();
      await harness.close(context);
    },
  };
}
