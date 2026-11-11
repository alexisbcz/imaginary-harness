// The app builder's side of the agent: tools that check the running app and add packages to it, the steps the
// chat shows while the agent works, chat-only mode, and the instructions that make the agent an app builder.

import type { SQL } from "bun";
import {
  defineExtension,
  defineTool,
  hook,
  section,
  ToolTask,
} from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import type { Previews } from "../builder/previews.ts";
import type { WorkspaceStore } from "./workspace.ts";

/** Tools that change the project, which chat-only mode blocks. */
const WRITING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "add_dependencies",
  "restore_version",
  "run_sql",
]);
/** Arguments too long to keep in a step. */
const BULKY_ARGUMENTS = new Set(["contents", "old_text", "new_text", "sql"]);
const MAX_TYPECHECK_CHARACTERS = 12_000;

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  isError,
});

/** The answer the conversation is writing: its assistant row, and the mode of the message it answers. */
async function currentReply(sql: SQL, conversationId: number) {
  const [reply] = await sql<{ id: string; mode: string }[]>`
    SELECT m.id, u.mode FROM public.messages m
    JOIN public.threads t ON t.id = m.thread_id
    JOIN public.messages u ON u.id = m.reply_to
    WHERE t.conversation_id = ${conversationId} AND m.role = 'assistant' AND m.status = 'streaming'
    ORDER BY m.created_at DESC LIMIT 1`;
  return reply;
}

/** Adds a step to the reply, or updates the step of the same call: a rerun after a crash finds its step. */
async function recordStep(
  sql: SQL,
  replyId: string,
  step: Record<string, unknown>,
) {
  // Sent as text and parsed by Postgres: a string parameter cast straight to jsonb would arrive as a JSON string.
  const json = JSON.stringify(step);
  await sql`
    UPDATE public.messages SET steps = CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(steps) s WHERE s->>'id' = ${step.id as string})
        THEN (SELECT jsonb_agg(CASE WHEN s->>'id' = ${step.id as string} THEN s || ${json}::text::jsonb ELSE s END)
              FROM jsonb_array_elements(steps) s)
      ELSE steps || jsonb_build_array(${json}::text::jsonb)
    END
    WHERE id = ${replyId}`;
}

/** The arguments worth showing: short strings and lists, without file contents. */
function shownArguments(args: Record<string, unknown>) {
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (BULKY_ARGUMENTS.has(key)) continue;
    if (typeof value === "string") shown[key] = value.slice(0, 200);
    else if (Array.isArray(value)) shown[key] = value.slice(0, 20).map(String);
    else if (typeof value === "number" || typeof value === "boolean")
      shown[key] = value;
  }
  return shown;
}

function resultSummary(result: { output?: unknown; isError?: boolean }) {
  const first = Array.isArray(result.output)
    ? (result.output[0] as { text?: string } | undefined)
    : undefined;
  return first?.text?.split("\n")[0]?.slice(0, 200);
}

export function createBuilder(
  sql: SQL,
  store: WorkspaceStore,
  previews: Previews | undefined,
) {
  const checkApp = defineTool({
    name: "check_app",
    description:
      "Check the app: typecheck the project, and gather the errors its preview reported (build errors, uncaught " +
      "exceptions, console errors) and the dev server's latest log. Call it after a round of changes, and fix what " +
      "it reports before telling the user you are done.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      if (!previews)
        return text(
          "Previews are off on this server: the app cannot be checked here.",
          true,
        );
      const thread = await store.threadOfConversation(api.conversationId);
      const typecheck = await previews.exec(thread.id, [
        "node",
        "node_modules/typescript/bin/tsc",
        "-b",
        "--noEmit",
        "--pretty",
        "false",
      ]);
      const typeErrors = (typecheck.stdout + typecheck.stderr).trim();
      const pageErrors = previews.errors(thread.id);
      const log = await previews.logs(thread.id, 30);
      const sections = [
        typecheck.exitCode === 0
          ? "Typecheck: no errors."
          : `Typecheck errors:\n${typeErrors.slice(0, MAX_TYPECHECK_CHARACTERS)}`,
        pageErrors.length === 0
          ? "Preview: no errors reported."
          : `Preview errors, oldest first (some may predate your last change):\n${pageErrors
              .map(
                (e) =>
                  `- ${e.message}${e.stack ? `\n  ${e.stack.split("\n").slice(0, 4).join("\n  ")}` : ""}`,
              )
              .join("\n")}`,
        `Dev server log (latest lines):\n${log || "(empty)"}`,
      ];
      // The errors are now in the agent's hands; the next check shows only new ones.
      previews.clearErrors(thread.id);
      return text(
        sections.join("\n\n"),
        typecheck.exitCode !== 0 || pageErrors.length > 0,
      );
    },
  });

  const addDependencies = defineTool({
    name: "add_dependencies",
    description:
      "Install npm packages into the app (`npm install`) and record them in package.json. The template already " +
      "has React, Tailwind, every shadcn/ui component, lucide-react, recharts, date-fns, sonner and more: check " +
      "package.json before adding anything.",
    parameters: obj({
      packages: arr(str(), {
        description:
          "Package names, optionally with a version: zod, @tanstack/react-query@5",
      }),
    }),
    execute: async (args, api) => {
      if (!previews)
        return text(
          "Previews are off on this server: packages cannot be installed here.",
          true,
        );
      const packages = args.packages.map((p) => p.trim()).filter(Boolean);
      if (packages.length === 0) return text("No packages given.", true);
      if (
        packages.some(
          (p) => !/^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*|-]+)?$/.test(p),
        )
      )
        return text(
          "Give package names only, like zod or @scope/name@1.2.",
          true,
        );
      const thread = await store.threadOfConversation(api.conversationId);
      const install = await previews.exec(
        thread.id,
        [
          "npm",
          "install",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
          ...packages,
        ],
        300_000,
      );
      if (install.exitCode !== 0)
        return text(
          `npm install failed:\n${(install.stdout + install.stderr).trim().slice(-4000)}`,
          true,
        );
      const manifest = await previews.exec(thread.id, ["cat", "package.json"]);
      await store.commitFiles(
        thread,
        { "package.json": manifest.stdout },
        `Add ${packages.join(", ")}`,
      );
      return text(`Installed ${packages.join(", ")}.`);
    },
  });

  return defineExtension({
    name: "builder",
    tools: [checkApp, addDependencies],
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api) {
          if (call.parent) return undefined;
          const reply = await currentReply(sql, api.conversationId);
          if (!reply) return undefined;
          if (reply.mode === "chat" && WRITING_TOOLS.has(call.name)) {
            return {
              block:
                "The user is in chat mode: discuss and plan, but do not change the project. Tell them to switch " +
                "to build mode when they want the change made.",
            };
          }
          await recordStep(sql, reply.id, {
            id: call.id,
            tool: call.name,
            args: shownArguments(call.arguments),
            status: "running",
          });
          return undefined;
        },
        async afterTool(call, result, api) {
          if (call.parent) return undefined;
          const reply = await currentReply(sql, api.conversationId);
          if (reply)
            await recordStep(sql, reply.id, {
              id: call.id,
              status: result.isError ? "error" : "done",
              // What went wrong is worth showing; a success's first line (often a file's) is not.
              ...(result.isError ? { summary: resultSummary(result) } : {}),
            });
          return undefined;
        },
      }),
    ],
    sections: [
      section(
        "builder",
        () =>
          `You build web apps with the user, who watches the app run in a live preview while you work.

The project is a Vite + React + TypeScript app styled with Tailwind CSS v4, made with the shadcn CLI:
- Every shadcn/ui component is installed under src/components/ui (import from "@/components/ui/<name>"). Use them rather than writing your own.
- Icons come from lucide-react. Charts from recharts. Toasts from sonner. Dates with date-fns.
- src/main.tsx mounts src/App.tsx inside the ThemeProvider; the theme's colors are CSS variables in src/index.css. Restyle the app there.
- "@/" points to src/. The app has no router yet: add react-router with add_dependencies when it needs pages.

How to work:
- Read the files you are about to change first. Make focused changes with edit_file; write_file for new files or rewrites.
- Name the app: set <title> in index.html to its name on your first build.
- Split the app into components under src/components and pages under src/pages; keep files small.
- Build real, polished interfaces: sensible layout, spacing and hierarchy, responsive down to phone width, empty and loading states. Fill them with realistic sample data, never lorem ipsum.
- After a round of changes, call check_app and fix every error it reports before you finish.
- When the user's message points at an element of the preview, it gives the element's source location (path:line:column): change that place.
- Answer briefly: what you built or changed, in a few lines. Never paste the code you wrote into the answer: the user sees it in the code view.
- In chat mode, the user wants to talk, not change anything: answer, and propose a plan when it helps.`,
      ),
    ],
  });
}
