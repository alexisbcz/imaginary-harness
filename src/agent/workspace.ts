// The agent's workspace: one set of files per thread, kept in `public.files`, where the app reads them through
// Supabase (RLS + Realtime) and shows them with Pierre's tree and diff components.

import type { SQL } from "bun";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

const MAX_FILE_CHARACTERS = 200_000;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** A workspace-relative path: no leading slash, no `.` or `..` segment, no empty segment. */
function normalizePath(path: string): string {
  const parts = path.trim().replace(/^\.?\/+/, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid path "${path}": use a relative path like src/index.ts`);
  }
  return parts.join("/");
}

export function createWorkspace(sql: SQL) {
  async function threadOf(conversationId: number) {
    const [thread] = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM public.threads WHERE conversation_id = ${conversationId}`;
    if (thread === undefined) throw new Error("This conversation has no workspace");
    return thread;
  }

  async function readFile(threadId: string, path: string) {
    const [file] = await sql<{ contents: string }[]>`
      SELECT contents FROM public.files WHERE thread_id = ${threadId} AND path = ${path}`;
    return file?.contents;
  }

  async function writeFile(threadId: string, userId: string, path: string, contents: string) {
    if (contents.length > MAX_FILE_CHARACTERS) throw new Error(`Files hold at most ${MAX_FILE_CHARACTERS} characters`);
    const [row] = await sql<{ created: boolean }[]>`
      INSERT INTO public.files AS f (thread_id, user_id, path, contents, previous)
      VALUES (${threadId}, ${userId}, ${path}, ${contents}, NULL)
      ON CONFLICT (thread_id, path) DO UPDATE
        SET previous = CASE WHEN f.contents = excluded.contents THEN f.previous ELSE f.contents END,
            contents = excluded.contents,
            updated_at = now()
      RETURNING (xmax = 0) AS created`;
    return row!.created;
  }

  const listFiles = defineTool({
    name: "list_files",
    description: "List the paths of the files in this conversation's workspace.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const thread = await threadOf(api.conversationId);
      const rows = await sql<{ path: string }[]>`
        SELECT path FROM public.files WHERE thread_id = ${thread.id} ORDER BY path`;
      return text(rows.length === 0 ? "The workspace is empty." : rows.map((row) => row.path).join("\n"));
    },
  });

  const readFileTool = defineTool({
    name: "read_file",
    description: "Read a file of the workspace.",
    parameters: obj({ path: str({ description: "Workspace-relative path, like src/index.ts" }) }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const contents = await readFile(thread.id, path);
      if (contents === undefined) throw new Error(`No file at ${path}`);
      return text(contents);
    },
  });

  const writeFileTool = defineTool({
    name: "write_file",
    description:
      "Create a file in the workspace, or replace all of its contents. The user sees the workspace as a file tree " +
      "and each change as a diff, so prefer files over long code blocks in the answer.",
    parameters: obj({
      path: str({ description: "Workspace-relative path, like src/index.ts" }),
      contents: str({ description: "The whole new contents of the file" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const created = await writeFile(thread.id, thread.user_id, path, args.contents);
      return text(`${created ? "Created" : "Updated"} ${path}`);
    },
  });

  const editFileTool = defineTool({
    name: "edit_file",
    description: "Replace one exact, unique occurrence of `old_text` with `new_text` in a workspace file.",
    parameters: obj({
      path: str({ description: "Workspace-relative path, like src/index.ts" }),
      old_text: str({ description: "Text to replace; it must occur exactly once in the file" }),
      new_text: str({ description: "Replacement text" }),
    }),
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const contents = await readFile(thread.id, path);
      if (contents === undefined) throw new Error(`No file at ${path}`);
      const first = contents.indexOf(args.old_text);
      if (first === -1) throw new Error(`old_text does not occur in ${path}`);
      if (contents.indexOf(args.old_text, first + 1) !== -1) {
        throw new Error(`old_text occurs more than once in ${path}; include more surrounding text`);
      }
      const next = contents.slice(0, first) + args.new_text + contents.slice(first + args.old_text.length);
      await writeFile(thread.id, thread.user_id, path, next);
      return text(`Edited ${path}`);
    },
  });

  return defineExtension({
    name: "workspace",
    tools: [listFiles, readFileTool, writeFileTool, editFileTool],
    sections: [
      section(
        "workspace",
        () =>
          "This conversation has a workspace of text files. When the user asks for code, documents or other " +
          "files, write them with write_file or change them with edit_file, then summarize what changed.",
      ),
    ],
  });
}
