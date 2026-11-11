// The agent's workspace: one git repository per project (thread) on the forge, written through the
// `@pierre/storage` SDK (each change is a commit). `public.files` mirrors each repository's head, so the app shows it
// through Supabase (RLS + Realtime). The store is shared by the agent's tools, the app's API (hand edits, history,
// restore) and the previews, which `onChange` keeps in sync.

import type { SQL } from "bun";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { GitStorage, type Repo } from "@pierre/storage";

const MAX_FILE_CHARACTERS = 200_000;
const AGENT = { name: "Richelieu", email: "agent@richelieu.ai" };

export type Thread = { id: string; user_id: string };
/** New contents per path; `null` deletes the file. */
export type FileChanges = Record<string, string | null>;
export type Version = {
  sha: string;
  message: string;
  author: string;
  date: string;
};

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

/** A workspace-relative path: no leading slash, no `.` or `..` segment, no empty segment. */
export function normalizePath(path: string): string {
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
      `Invalid path "${path}": use a relative path like src/App.tsx`,
    );
  }
  return parts.join("/");
}

/** The app template every project starts from, read once from `templates/app`. */
let template: Promise<Record<string, string>> | undefined;
export function templateFiles() {
  template ??= (async () => {
    const root = new URL("../../templates/app/", import.meta.url).pathname;
    const files: Record<string, string> = {};
    for await (const path of new Bun.Glob("**/*").scan({
      cwd: root,
      dot: true,
    })) {
      files[path] = await Bun.file(root + path).text();
    }
    return files;
  })();
  return template;
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export function createWorkspaceStore(
  sql: SQL,
  storage: GitStorage,
  onChange: (threadId: string, changes: FileChanges) => void = () => {},
) {
  async function threadOfConversation(conversationId: number) {
    const [thread] = await sql<Thread[]>`
      SELECT id, user_id FROM public.threads WHERE conversation_id = ${conversationId}`;
    if (thread === undefined)
      throw new Error("This conversation has no workspace");
    return thread;
  }

  async function thread(threadId: string) {
    const [found] = await sql<Thread[]>`
      SELECT id, user_id FROM public.threads WHERE id = ${threadId}`;
    if (found === undefined) throw new Error(`Unknown project ${threadId}`);
    return found;
  }

  /** The thread's repository, created with its first commit. */
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
    ref?: string,
  ): Promise<string | undefined> {
    if (!repo) return undefined;
    const response = await repo
      .getFileStream({ path, ref })
      .catch((error: { status?: number }) => {
        if (error.status === 404) return undefined;
        throw error;
      });
    return response ? response.text() : undefined;
  }

  /** Every path at `ref` (default: the head), following pages. */
  async function listPaths(repo: Repo, ref?: string) {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.listFiles({ ref, cursor });
      paths.push(...page.paths);
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
    return paths;
  }

  /**
   * Commits several changes at once (unchanged files are left out), then mirrors them into `public.files`.
   * Returns the paths that changed, empty when nothing did.
   */
  async function commitFiles(
    thread: Thread,
    changes: FileChanges,
    message: string,
    author = AGENT,
  ) {
    const repo = (await repoOf(thread.id, true))!;
    const effective: {
      path: string;
      contents: string | null;
      previous: string | undefined;
    }[] = [];
    for (const [rawPath, contents] of Object.entries(changes)) {
      const path = normalizePath(rawPath);
      if (contents !== null && contents.length > MAX_FILE_CHARACTERS)
        throw new Error(
          `Files hold at most ${MAX_FILE_CHARACTERS} characters: ${path}`,
        );
      const previous = await readFile(repo, path);
      if (previous === (contents ?? undefined)) continue;
      effective.push({ path, contents, previous });
    }
    if (effective.length === 0) return [];

    let builder = repo.createCommit({
      targetBranch: "main",
      commitMessage: message,
      author,
    });
    for (const change of effective)
      builder =
        change.contents === null
          ? builder.deletePath(change.path)
          : builder.addFileFromString(change.path, change.contents);
    const result = await builder.send();

    await sql.begin(async (tx) => {
      for (const { path, contents, previous } of effective) {
        if (contents === null) {
          await tx`DELETE FROM public.files WHERE thread_id = ${thread.id} AND path = ${path}`;
        } else {
          await tx`
            INSERT INTO public.files (thread_id, user_id, path, contents, previous, commit_sha)
            VALUES (${thread.id}, ${thread.user_id}, ${path}, ${contents}, ${previous ?? null}, ${result.commitSha})
            ON CONFLICT (thread_id, path) DO UPDATE
              SET contents = excluded.contents, previous = excluded.previous, commit_sha = excluded.commit_sha, updated_at = now()`;
        }
      }
    });
    onChange(
      thread.id,
      Object.fromEntries(effective.map((c) => [c.path, c.contents])),
    );
    return effective.map((c) => c.path);
  }

  /** Starts an empty project from the app template, in one commit. Does nothing once the project has files. */
  async function seed(thread: Thread) {
    const repo = await repoOf(thread.id, false);
    if (repo && (await listPaths(repo)).length > 0) return false;
    await commitFiles(
      thread,
      await templateFiles(),
      "Start from the app template",
    );
    return true;
  }

  /** The project's commits, newest first. */
  async function history(threadId: string, limit = 100): Promise<Version[]> {
    const repo = await repoOf(threadId, false);
    if (!repo) return [];
    const { commits } = await repo
      .listCommits({ branch: "main", limit })
      .catch(() => ({ commits: [] }));
    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message.trim(),
      author: commit.authorName,
      date: new Date(commit.date).toISOString(),
    }));
  }

  /** The unified diff a commit made. */
  async function diff(threadId: string, sha: string) {
    const repo = await repoOf(threadId, false);
    if (!repo) throw new Error("This project has no history");
    const result = await repo.getCommitDiff({ sha });
    return result.files;
  }

  /** Brings every file back to what it was at `sha`, as a new commit on top. */
  async function restore(thread: Thread, sha: string, author = AGENT) {
    const repo = await repoOf(thread.id, false);
    if (!repo) throw new Error("This project has no history");
    const [then, now] = await Promise.all([
      listPaths(repo, sha),
      listPaths(repo),
    ]);
    const changes: FileChanges = {};
    for (const path of now) if (!then.includes(path)) changes[path] = null;
    for (const path of then)
      changes[path] = (await readFile(repo, path, sha)) ?? null;
    return commitFiles(
      thread,
      changes,
      `Restore the version ${sha.slice(0, 7)}`,
      author,
    );
  }

  /** Every file at the head, from the mirror. */
  async function files(threadId: string) {
    const rows = await sql<{ path: string; contents: string }[]>`
      SELECT path, contents FROM public.files WHERE thread_id = ${threadId}`;
    return Object.fromEntries(rows.map((row) => [row.path, row.contents]));
  }

  return {
    thread,
    threadOfConversation,
    repoOf,
    readFile,
    listPaths,
    commitFiles,
    seed,
    history,
    diff,
    restore,
    files,
  };
}

/** The agent's file tools over the store. */
export function createWorkspace(store: WorkspaceStore) {
  const listFiles = defineTool({
    name: "list_files",
    description: "List the paths of the files in this project.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const thread = await store.threadOfConversation(api.conversationId);
      const repo = await store.repoOf(thread.id, false);
      const paths = repo ? await store.listPaths(repo) : [];
      return text(
        paths.length === 0 ? "The project is empty." : paths.join("\n"),
      );
    },
  });

  const readFileTool = defineTool({
    name: "read_file",
    description: "Read a file of the project.",
    parameters: obj({
      path: str({ description: "Project-relative path, like src/App.tsx" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = await store.threadOfConversation(api.conversationId);
      const path = normalizePath(args.path);
      const contents = await store.readFile(
        await store.repoOf(thread.id, false),
        path,
      );
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
      "Create a file in the project, or replace all of its contents; each change is a git commit and shows in the " +
      "live preview right away.",
    parameters: obj({
      path: str({ description: "Project-relative path, like src/App.tsx" }),
      contents: str({ description: "The whole new contents of the file" }),
      message: messageParameter,
    }),
    // Writing the same contents again changes nothing, so a rerun after a crash is harmless.
    replay: "safe",
    execute: async (args, api) => {
      const thread = await store.threadOfConversation(api.conversationId);
      const path = normalizePath(args.path);
      const existed =
        (await store.readFile(await store.repoOf(thread.id, false), path)) !==
        undefined;
      const changed = await store.commitFiles(
        thread,
        { [path]: args.contents },
        args.message ?? `Write ${path}`,
      );
      return text(
        changed.length > 0
          ? `${existed ? "Updated" : "Created"} ${path}`
          : `${path} already had these contents`,
      );
    },
  });

  const editFileTool = defineTool({
    name: "edit_file",
    description:
      "Replace one exact, unique occurrence of `old_text` with `new_text` in a project file; a git commit.",
    parameters: obj({
      path: str({ description: "Project-relative path, like src/App.tsx" }),
      old_text: str({
        description: "Text to replace; it must occur exactly once in the file",
      }),
      new_text: str({ description: "Replacement text" }),
      message: messageParameter,
    }),
    execute: async (args, api) => {
      const thread = await store.threadOfConversation(api.conversationId);
      const path = normalizePath(args.path);
      const contents = await store.readFile(
        await store.repoOf(thread.id, false),
        path,
      );
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
      await store.commitFiles(
        thread,
        { [path]: next },
        args.message ?? `Edit ${path}`,
      );
      return text(`Edited ${path}`);
    },
  });

  const deleteFileTool = defineTool({
    name: "delete_file",
    description: "Delete a file of the project; a git commit.",
    parameters: obj({
      path: str({ description: "Project-relative path, like src/App.tsx" }),
      message: messageParameter,
    }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = await store.threadOfConversation(api.conversationId);
      const path = normalizePath(args.path);
      const changed = await store.commitFiles(
        thread,
        { [path]: null },
        args.message ?? `Delete ${path}`,
      );
      return text(
        changed.length > 0 ? `Deleted ${path}` : `No file at ${path}`,
      );
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
          "This conversation is a project: a git repository holding a web app, which the user sees running in a " +
          "live preview next to the chat. Change it with write_file and edit_file; every change is a commit and " +
          "reaches the preview at once.",
      ),
    ],
  });
}
