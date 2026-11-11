// The agent's workspace: one git repository per thread on the forge, written through the `@pierre/storage` SDK
// (each change is a commit). `public.files` mirrors each repository's head, so the app shows it through Supabase
// (RLS + Realtime) with Pierre's tree and diff components.

import type { SQL } from "bun";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { GitStorage, type Repo } from "@pierre/storage";

const MAX_FILE_CHARACTERS = 200_000;
const AUTHOR = { name: "Richelieu", email: "agent@richelieu.ai" };

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

/** A workspace-relative path: no leading slash, no `.` or `..` segment, no empty segment. */
function normalizePath(path: string): string {
  const parts = path
    .trim()
    .replace(/^\.?\/+/, "")
    .split("/");
  if (
    parts.some(
      (part) => part === "" || part === "." || part === ".." || part === ".git",
    )
  ) {
    throw new Error(
      `Invalid path "${path}": use a relative path like src/index.ts`,
    );
  }
  return parts.join("/");
}

export function createWorkspace(sql: SQL, storage: GitStorage) {
  async function threadOf(conversationId: number) {
    const [thread] = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM public.threads WHERE conversation_id = ${conversationId}`;
    if (thread === undefined)
      throw new Error("This conversation has no workspace");
    return thread;
  }

  /** The thread's repository, created with its first file. */
  async function repoOf(
    threadId: string,
    create: boolean,
  ): Promise<Repo | undefined> {
    const found = await storage.findOne({ id: threadId });
    if (found || !create) return found ?? undefined;
    try {
      return await storage.createRepo({ id: threadId });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists"))
        return (await storage.findOne({ id: threadId }))!;
      throw error;
    }
  }

  async function readFile(
    repo: Repo | undefined,
    path: string,
  ): Promise<string | undefined> {
    if (!repo) return undefined;
    const response = await repo
      .getFileStream({ path })
      .catch((error: { status?: number }) => {
        if (error.status === 404) return undefined;
        throw error;
      });
    return response ? response.text() : undefined;
  }

  /** Commits `contents` at `path` (or deletes it), then mirrors the head into `public.files`. */
  async function commit(
    thread: { id: string; user_id: string },
    path: string,
    contents: string | null,
    message: string,
  ) {
    if (contents !== null && contents.length > MAX_FILE_CHARACTERS) {
      throw new Error(`Files hold at most ${MAX_FILE_CHARACTERS} characters`);
    }
    const repo = (await repoOf(thread.id, true))!;
    const previous = await readFile(repo, path);
    if (previous === (contents ?? undefined))
      return { changed: false, created: false };
    const builder = repo.createCommit({
      targetBranch: "main",
      commitMessage: message,
      author: AUTHOR,
    });
    const result = await (
      contents === null
        ? builder.deletePath(path)
        : builder.addFileFromString(path, contents)
    ).send();
    if (contents === null) {
      await sql`DELETE FROM public.files WHERE thread_id = ${thread.id} AND path = ${path}`;
    } else {
      await sql`
        INSERT INTO public.files (thread_id, user_id, path, contents, previous, commit_sha)
        VALUES (${thread.id}, ${thread.user_id}, ${path}, ${contents}, ${previous ?? null}, ${result.commitSha})
        ON CONFLICT (thread_id, path) DO UPDATE
          SET contents = excluded.contents, previous = excluded.previous, commit_sha = excluded.commit_sha, updated_at = now()`;
    }
    return { changed: true, created: previous === undefined };
  }

  const listFiles = defineTool({
    name: "list_files",
    description:
      "List the paths of the files in this conversation's workspace.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const thread = await threadOf(api.conversationId);
      const repo = await repoOf(thread.id, false);
      const paths = repo ? (await repo.listFiles()).paths : [];
      return text(
        paths.length === 0 ? "The workspace is empty." : paths.join("\n"),
      );
    },
  });

  const readFileTool = defineTool({
    name: "read_file",
    description: "Read a file of the workspace.",
    parameters: obj({
      path: str({ description: "Workspace-relative path, like src/index.ts" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const contents = await readFile(await repoOf(thread.id, false), path);
      if (contents === undefined) throw new Error(`No file at ${path}`);
      return text(contents);
    },
  });

  const messageParameter = opt(
    str({ description: "A short commit message, like a git commit subject" }),
  );

  const writeFileTool = defineTool({
    name: "write_file",
    description:
      "Create a file in the workspace, or replace all of its contents; each change is a git commit. The user sees " +
      "the workspace as a file tree and each change as a diff, so prefer files over long code blocks in the answer.",
    parameters: obj({
      path: str({ description: "Workspace-relative path, like src/index.ts" }),
      contents: str({ description: "The whole new contents of the file" }),
      message: messageParameter,
    }),
    // Writing the same contents again changes nothing, so a rerun after a crash is harmless.
    replay: "safe",
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const { changed, created } = await commit(
        thread,
        path,
        args.contents,
        args.message ?? `Write ${path}`,
      );
      return text(
        changed
          ? `${created ? "Created" : "Updated"} ${path}`
          : `${path} already had these contents`,
      );
    },
  });

  const editFileTool = defineTool({
    name: "edit_file",
    description:
      "Replace one exact, unique occurrence of `old_text` with `new_text` in a workspace file; a git commit.",
    parameters: obj({
      path: str({ description: "Workspace-relative path, like src/index.ts" }),
      old_text: str({
        description: "Text to replace; it must occur exactly once in the file",
      }),
      new_text: str({ description: "Replacement text" }),
      message: messageParameter,
    }),
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const contents = await readFile(await repoOf(thread.id, false), path);
      if (contents === undefined) throw new Error(`No file at ${path}`);
      const first = contents.indexOf(args.old_text);
      if (first === -1) throw new Error(`old_text does not occur in ${path}`);
      if (contents.indexOf(args.old_text, first + 1) !== -1) {
        throw new Error(
          `old_text occurs more than once in ${path}; include more surrounding text`,
        );
      }
      const next =
        contents.slice(0, first) +
        args.new_text +
        contents.slice(first + args.old_text.length);
      await commit(thread, path, next, args.message ?? `Edit ${path}`);
      return text(`Edited ${path}`);
    },
  });

  const deleteFileTool = defineTool({
    name: "delete_file",
    description: "Delete a file of the workspace; a git commit.",
    parameters: obj({
      path: str({ description: "Workspace-relative path, like src/index.ts" }),
      message: messageParameter,
    }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = await threadOf(api.conversationId);
      const path = normalizePath(args.path);
      const { changed } = await commit(
        thread,
        path,
        null,
        args.message ?? `Delete ${path}`,
      );
      return text(changed ? `Deleted ${path}` : `No file at ${path}`);
    },
  });

  return defineExtension({
    name: "workspace",
    tools: [
      listFiles,
      readFileTool,
      writeFileTool,
      editFileTool,
      deleteFileTool,
    ],
    sections: [
      section(
        "workspace",
        () =>
          "This conversation has a workspace: a git repository of text files. When the user asks for code, " +
          "documents or other files, write them with write_file or change them with edit_file, then summarize " +
          "what changed.",
      ),
    ],
  });
}
