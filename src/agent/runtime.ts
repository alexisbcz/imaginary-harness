// The agent's Harness on Supabase Postgres, with the forge-backed workspace, for the server and functions alike.
// With previews (the local server, where Docker runs), the agent can also check the app, add packages and run code.

import type { SQL } from "bun";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  Harness,
  type Extension,
} from "@earendil-works/pi-durable";
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
import { createNewsletterExtension } from "../newsletter/agent.ts";
import { createResearchExtension } from "../research/agent.ts";
import { NewsletterService } from "../newsletter/service.ts";
import { createSocialExtension } from "../social/agent.ts";
import { SocialService } from "../social/service.ts";
import { Agent, CHAT_INSTRUCTIONS, NEWSLETTER_INSTRUCTIONS, SOCIAL_INSTRUCTIONS } from "./agent.ts";
import { createBuilder, createSteps } from "./builder.ts";
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
    socialService?: SocialService;
    newsletterService?: NewsletterService;
  } = {},
) {
  const { previews } = options;
  const context = BACKGROUND_CONTEXT;
  const models = createModels();
  models.setProvider(anthropicProvider());
  const registry = createRegistry();
  // What a project's chats get: every extension but a copilot's or a plain chat's, which their conversations select.
  const projectExtensions: Extension[] = [];
  const install = (extension: Extension, forProjects = true) => {
    registry.install(extension);
    if (forProjects) projectExtensions.push(extension);
  };
  let store: WorkspaceStore | undefined;
  let shipping: Shipping | undefined;
  if (storage) {
    store = createWorkspaceStore(sql, storage, (projectId, changes) => {
      previews
        ?.apply(projectId, changes)
        .catch((error) => console.error("[preview] sync:", error));
    });
    shipping = createShipping({ sql, store, storage, previews });
    install(createWorkspace(sql, store));
    install(createBuilder(sql, store, previews, shipping));
  } else
    console.warn(
      "[agent] FORGE_PRIVATE_KEY is not set: the workspace tools are off (bun run forge:org <name> --write-env)",
    );
  // Containers need Docker, which only the local server has; the run_command sandbox shares it with previews.
  if (previews) install(createSandbox(sql));
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
  // Web research (blade.sh) for every agent: projects and mail here, the copilots below.
  const research = config.bladeApiKey ? createResearchExtension() : undefined;
  if (research) install(research);
  else console.warn("[agent] BLADE_API_KEY is not set: web research is off");
  const mail = createMailExtension(sql, mailService);
  install(mail.extension);
  // Social: a brand's copilot plans, drafts and schedules its posts (Zernio) and researches accounts (ScrapeCreators).
  const socialService = options.socialService ?? new SocialService(sql);
  const social = createSocialExtension(sql, socialService);
  install(social.extension, false);
  // Newsletter: a Substack publication's copilot drafts, revises and schedules its posts and Notes.
  const newsletterService = options.newsletterService ?? new NewsletterService(sql);
  const newsletter = createNewsletterExtension(sql, newsletterService);
  install(newsletter.extension, false);
  // A chat outside any project talks, researches and handles mail; its steps show as a project's do.
  const steps = createSteps(sql);
  install(steps, false);
  const harness = await Harness.open(
    await PostgresStorage.open(sql, {
      schema: "pi",
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    {
      models,
      registry,
      settings: { extensions: projectExtensions },
      onReport: (report) => console.error(`[pi] ${report.kind}:`, report.error),
    },
    context,
  );
  const agent = new Agent(sql, harness, context, store, {
    chat: {
      instructions: CHAT_INSTRUCTIONS,
      extensions: [steps, mail.extension, ...(research ? [research] : [])],
    },
    social: { instructions: SOCIAL_INSTRUCTIONS, extensions: [social.extension, ...(research ? [research] : [])] },
    newsletter: { instructions: NEWSLETTER_INSTRUCTIONS, extensions: [newsletter.extension, ...(research ? [research] : [])] },
  });
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
    socialService,
    newsletterService,
    async close() {
      await agent.stop();
      newsletterService.close();
      await assistant.stop();
      await harness.close(context);
    },
  };
}
