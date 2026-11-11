// The builder's HTTP API, beside the web app on the local server: previews, history, restore, hand edits,
// publishing, the app's database and git clone URLs. Each
// request carries the user's Supabase access token, and reaches only the user's own projects.

import type { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import type { Previews } from "../builder/previews.ts";
import type { Shipping } from "../builder/shipping.ts";
import type { WorkspaceStore } from "../agent/workspace.ts";
import { config } from "../config.ts";

type Request = Bun.BunRequest<string> & { params: Record<string, string> };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_CACHE_MS = 60_000;

export function createBuilderApi({
  sql,
  store,
  previews,
  shipping,
}: {
  sql: SQL;
  store: WorkspaceStore | undefined;
  previews: Previews | undefined;
  shipping: Shipping | undefined;
}) {
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tokens = new Map<string, { userId: string; until: number }>();

  async function userOf(request: Request) {
    const token = request.headers
      .get("authorization")
      ?.replace(/^Bearer /i, "");
    if (!token) throw new HttpError(401, "Sign in first");
    const cached = tokens.get(token);
    if (cached && cached.until > Date.now()) return cached.userId;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, "Sign in again");
    tokens.set(token, {
      userId: data.user.id,
      until: Date.now() + TOKEN_CACHE_MS,
    });
    return data.user.id;
  }

  /** The project, when the request's user owns it. */
  async function project(request: Request) {
    const userId = await userOf(request);
    const [thread] = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM public.threads WHERE id = ${request.params.id} AND user_id = ${userId}`;
    if (!thread) throw new HttpError(404, "No such project");
    return thread;
  }

  function need<T>(value: T | undefined, what: string): T {
    if (value === undefined)
      throw new HttpError(503, `${what} is off on this server`);
    return value;
  }

  const handle =
    (handler: (request: Request) => Promise<unknown>) =>
    async (request: Request) => {
      try {
        const result = await handler(request);
        return result instanceof Response
          ? result
          : Response.json(result ?? { ok: true });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 500) console.error("[api]", error);
        return Response.json({ error: message }, { status });
      }
    };

  return {
    "/api/projects/:id/preview": {
      GET: handle(async (request) => {
        const thread = await project(request);
        return await need(previews, "Previews").status(thread.id);
      }),
      POST: handle(async (request) => {
        const thread = await project(request);
        const url = await need(previews, "Previews").ensure(thread.id);
        return { state: "running", url };
      }),
    },
    "/api/projects/:id/preview/restart": {
      POST: handle(async (request) => {
        const thread = await project(request);
        const url = await need(previews, "Previews").restart(thread.id);
        return { state: "running", url };
      }),
    },
    "/api/projects/:id/preview/errors": {
      POST: handle(async (request) => {
        const thread = await project(request);
        const body = (await request.json()) as {
          message?: unknown;
          stack?: unknown;
        };
        if (typeof body.message !== "string")
          throw new HttpError(400, "message is required");
        need(previews, "Previews").reportError(thread.id, {
          message: body.message.slice(0, 4000),
          stack:
            typeof body.stack === "string"
              ? body.stack.slice(0, 4000)
              : undefined,
        });
        return { ok: true };
      }),
    },
    "/api/projects/:id/history": {
      GET: handle(async (request) => {
        const thread = await project(request);
        return {
          versions: await need(store, "The workspace").history(thread.id),
        };
      }),
    },
    "/api/projects/:id/history/:sha": {
      GET: handle(async (request) => {
        const thread = await project(request);
        if (!/^[0-9a-f]{40}$/.test(request.params.sha!))
          throw new HttpError(400, "Invalid version");
        return {
          files: await need(store, "The workspace").diff(
            thread.id,
            request.params.sha!,
          ),
        };
      }),
    },
    "/api/projects/:id/restore": {
      POST: handle(async (request) => {
        const thread = await project(request);
        const { sha } = (await request.json()) as { sha?: unknown };
        if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
          throw new HttpError(400, "Invalid version");
        const changed = await need(store, "The workspace").restore(
          thread,
          sha,
          await authorOf(thread.user_id),
        );
        return { changed };
      }),
    },
    "/api/projects/:id/publish": {
      GET: handle(async (request) => {
        const thread = await project(request);
        const [row] = await sql<
          { published_slug: string | null; published_at: Date | null }[]
        >`
          SELECT published_slug, published_at FROM public.threads WHERE id = ${thread.id}`;
        return {
          url: row?.published_slug
            ? `${config.sitesUrl}/${row.published_slug}/`
            : null,
          publishedAt: row?.published_at ?? null,
        };
      }),
      POST: handle(async (request) => {
        const thread = await project(request);
        return need(shipping, "Publishing").publish(thread);
      }),
      DELETE: handle(async (request) => {
        const thread = await project(request);
        await need(shipping, "Publishing").unpublish(thread);
        return { ok: true };
      }),
    },
    "/api/projects/:id/database": {
      GET: handle(async (request) => {
        const thread = await project(request);
        return {
          database: await need(shipping, "Databases").inspectDatabase(
            thread.id,
          ),
        };
      }),
      POST: handle(async (request) => {
        const thread = await project(request);
        return {
          schema: await need(shipping, "Databases").enableDatabase(thread),
        };
      }),
    },
    "/api/projects/:id/clone": {
      GET: handle(async (request) => {
        const thread = await project(request);
        return { url: await need(shipping, "Git").cloneUrl(thread.id) };
      }),
    },
    "/api/projects/:id/files": {
      PUT: handle(async (request) => {
        const thread = await project(request);
        const { path, contents } = (await request.json()) as {
          path?: unknown;
          contents?: unknown;
        };
        if (
          typeof path !== "string" ||
          (typeof contents !== "string" && contents !== null)
        )
          throw new HttpError(400, "path and contents are required");
        const changed = await need(store, "The workspace").commitFiles(
          thread,
          { [path]: contents },
          contents === null ? `Delete ${path}` : `Edit ${path}`,
          await authorOf(thread.user_id),
        );
        return { changed };
      }),
    },
  };

  /** A hand edit or a restore is the user's commit, under their name and email. */
  async function authorOf(userId: string) {
    const { data } = await supabase.auth.admin.getUserById(userId);
    const email = data.user?.email ?? "user@richelieu.ai";
    const [profile] = await sql<{ name: string }[]>`
      SELECT name FROM public.profiles WHERE id = ${userId}`;
    return { name: profile?.name ?? email.split("@")[0]!, email };
  }
}
