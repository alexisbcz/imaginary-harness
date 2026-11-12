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
import type { Shipping } from "../builder/shipping.ts";
import type { WorkspaceStore } from "./workspace.ts";

/** Tools that change the project, which chat-only mode blocks. */
const WRITING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "add_dependencies",
  "restore_version",
  "run_sql",
  "send_mail",
]);
/** Arguments too long to keep in a step. */
const BULKY_ARGUMENTS = new Set(["contents", "old_text", "new_text", "sql"]);
const MAX_TYPECHECK_CHARACTERS = 12_000;

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  isError,
});

/** The answer the conversation is writing: its assistant row, and the mode of the message it answers. */
export async function currentReply(sql: SQL, conversationId: number) {
  const [reply] = await sql<{ id: string; mode: string }[]>`
    SELECT m.id, u.mode FROM public.messages m
    JOIN public.threads t ON t.id = m.thread_id
    JOIN public.messages u ON u.id = m.reply_to
    WHERE t.conversation_id = ${conversationId} AND m.role = 'assistant' AND m.status = 'streaming'
    ORDER BY m.created_at DESC LIMIT 1`;
  return reply;
}

/** Adds a step to the reply, or updates the step of the same call: a rerun after a crash finds its step. */
export async function recordStep(
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
export function shownArguments(args: Record<string, unknown>) {
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

export function resultSummary(result: { output?: unknown; isError?: boolean }) {
  const first = Array.isArray(result.output)
    ? (result.output[0] as { text?: string } | undefined)
    : undefined;
  return first?.text?.split("\n")[0]?.slice(0, 200);
}

type StepCall = { id: string; name: string; arguments: Record<string, unknown>; parent?: unknown };

function startedStep(call: StepCall) {
  return {
    id: call.id,
    tool: call.name,
    args: shownArguments(call.arguments),
    status: "running",
  };
}

async function finishStep(
  sql: SQL,
  call: StepCall,
  result: { output?: unknown; isError?: boolean },
  api: { conversationId: number },
) {
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
}

/** Shows each tool call of a chat outside any project as a step, as the builder does in a project's chats. */
export function createSteps(sql: SQL) {
  return defineExtension({
    name: "steps",
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api) {
          if (call.parent) return undefined;
          const reply = await currentReply(sql, api.conversationId);
          if (reply) await recordStep(sql, reply.id, startedStep(call));
          return undefined;
        },
        afterTool: (call, result, api) => finishStep(sql, call, result, api),
      }),
    ],
  });
}

export function createBuilder(
  sql: SQL,
  store: WorkspaceStore,
  previews: Previews | undefined,
  shipping: Shipping | undefined,
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
      const project = await store.projectOfConversation(api.conversationId);
      const typecheck = await previews.exec(project.id, [
        "node",
        "node_modules/typescript/bin/tsc",
        "-b",
        "--noEmit",
        "--pretty",
        "false",
      ]);
      const typeErrors = (typecheck.stdout + typecheck.stderr).trim();
      const pageErrors = previews.errors(project.id);
      const log = await previews.logs(project.id, 30);
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
      previews.clearErrors(project.id);
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
      const project = await store.projectOfConversation(api.conversationId);
      const install = await previews.exec(
        project.id,
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
      const manifest = await previews.exec(project.id, ["cat", "package.json"]);
      await store.commitFiles(
        project,
        { "package.json": manifest.stdout },
        `Add ${packages.join(", ")}`,
      );
      return text(`Installed ${packages.join(", ")}.`);
    },
  });

  const enableDatabase = defineTool({
    name: "enable_database",
    description:
      "Give the app a database (Postgres through Supabase, with auth), when it needs to keep data across visits or " +
      "users: sign-in, saved records, shared data. Creates the app's own schema, installs @supabase/supabase-js, and " +
      "writes src/lib/supabase.ts (export `supabase`) and .env. Then create tables with run_sql.",
    parameters: obj({}),
    execute: async (_args, api) => {
      if (!shipping) return text("Databases are off on this server.", true);
      const project = await store.projectOfConversation(api.conversationId);
      const schema = await shipping.enableDatabase(project);
      return text(
        `The database is ready: schema ${schema}. Import { supabase } from "@/lib/supabase"; queries reach this ` +
          'schema\'s tables by name (supabase.from("todos")). Create tables with run_sql.',
      );
    },
  });

  const runSql = defineTool({
    name: "run_sql",
    description:
      "Run SQL in the app's database, in one transaction, inside the app's own schema (unqualified names land " +
      "there). Use it to create and change tables, and to look at data. Every table the app reads in the browser " +
      "needs row level security and grants: `alter table x enable row level security;` + policies, and " +
      "`grant select, insert, update, delete on x to anon, authenticated;`. Tie rows to users with " +
      "`user_id uuid not null default uid()` and policies on `uid() = user_id`: the schema's own uid() is the " +
      "signed-in user's id (auth.uid() is out of reach). " +
      "Returns the last statement's rows (50 at most).",
    parameters: obj({
      sql: str({ description: "One or more SQL statements" }),
    }),
    execute: async (args, api) => {
      if (!shipping) return text("Databases are off on this server.", true);
      const project = await store.projectOfConversation(api.conversationId);
      try {
        const rows = await shipping.runSql(project.id, args.sql);
        return text(
          rows.length
            ? JSON.stringify(rows, null, 1).slice(0, 8000)
            : "Done (no rows).",
        );
      } catch (error) {
        return text(
          `SQL error: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  });

  return defineExtension({
    name: "builder",
    tools: [checkApp, addDependencies, enableDatabase, runSql],
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
          await recordStep(sql, reply.id, startedStep(call));
          return undefined;
        },
        afterTool: (call, result, api) => finishStep(sql, call, result, api),
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
- When the app must keep data (accounts, saved items, anything shared or lasting), call enable_database, create the tables with run_sql (with row level security), then use supabase from "@/lib/supabase". For sign-in, use supabase.auth (email and password). Without a database, keep state in React or localStorage.
- The app may be published under a sub-path: if you add react-router, give the router basename={import.meta.env.BASE_URL}.
- When the user's message points at an element of the preview, it gives the element's source location (path:line:column): change that place.
- Answer briefly: what you built or changed, in a few lines. Never paste the code you wrote into the answer: the user sees it in the code view.
- In chat mode, the user wants to talk, not change anything: answer, and propose a plan when it helps.`,
      ),
    ],
  });
}
