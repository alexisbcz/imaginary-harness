// The builder's HTTP API, beside the web app on the local server: previews, history, restore, hand edits,
// publishing, the app's database and git clone URLs. Each
// request carries the user's Supabase access token, and reaches only the user's own projects.

import type { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import type { Previews } from "../builder/previews.ts";
import type { BrowseRequest, Shipping } from "../builder/shipping.ts";
import type { WorkspaceStore } from "../agent/workspace.ts";
import { config } from "../config.ts";
import {
  createUserAuth,
  handle,
  HttpError,
  type ApiRequest as Request,
} from "./http.ts";

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
  const userOf = createUserAuth();

  /** The project, when the request's user owns it. */
  async function project(request: Request) {
    const userId = await userOf(request);
    const [found] = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM public.projects WHERE id = ${request.params.id} AND user_id = ${userId}`;
    if (!found) throw new HttpError(404, "No such project");
    return found;
  }

  function need<T>(value: T | undefined, what: string): T {
    if (value === undefined)
      throw new HttpError(503, `${what} is off on this server`);
    return value;
  }

  return {
    "/api/projects/:id/preview": {
      GET: handle(async (request) => {
        const app = await project(request);
        return await need(previews, "Previews").status(app.id);
      }),
      POST: handle(async (request) => {
        const app = await project(request);
        const url = await need(previews, "Previews").ensure(app.id);
        return { state: "running", url };
      }),
    },
    "/api/projects/:id/preview/restart": {
      POST: handle(async (request) => {
        const app = await project(request);
        const url = await need(previews, "Previews").restart(app.id);
        return { state: "running", url };
      }),
    },
    "/api/projects/:id/preview/errors": {
      POST: handle(async (request) => {
        const app = await project(request);
        const body = (await request.json()) as {
          message?: unknown;
          stack?: unknown;
        };
        if (typeof body.message !== "string")
          throw new HttpError(400, "message is required");
        need(previews, "Previews").reportError(app.id, {
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
        const app = await project(request);
        return {
          versions: await need(store, "The workspace").history(app.id),
        };
      }),
    },
    "/api/projects/:id/history/:sha": {
      GET: handle(async (request) => {
        const app = await project(request);
        if (!/^[0-9a-f]{40}$/.test(request.params.sha!))
          throw new HttpError(400, "Invalid version");
        return {
          files: await need(store, "The workspace").diff(
            app.id,
            request.params.sha!,
          ),
        };
      }),
    },
    "/api/projects/:id/restore": {
      POST: handle(async (request) => {
        const app = await project(request);
        const { sha } = (await request.json()) as { sha?: unknown };
        if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
          throw new HttpError(400, "Invalid version");
        const changed = await need(store, "The workspace").restore(
          app,
          sha,
          await authorOf(app.user_id),
        );
        return { changed };
      }),
    },
    "/api/projects/:id/publish": {
      GET: handle(async (request) => {
        const app = await project(request);
        const [row] = await sql<
          { published_slug: string | null; published_at: Date | null }[]
        >`
          SELECT published_slug, published_at FROM public.projects WHERE id = ${app.id}`;
        return {
          url: row?.published_slug
            ? `${config.sitesUrl}/${row.published_slug}/`
            : null,
          publishedAt: row?.published_at ?? null,
        };
      }),
      POST: handle(async (request) => {
        const app = await project(request);
        return need(shipping, "Publishing").publish(app);
      }),
      DELETE: handle(async (request) => {
        const app = await project(request);
        await need(shipping, "Publishing").unpublish(app);
        return { ok: true };
      }),
    },
    "/api/projects/:id/database": {
      GET: handle(async (request) => {
        const app = await project(request);
        return {
          database: await need(shipping, "Databases").inspectDatabase(
            app.id,
          ),
        };
      }),
      POST: handle(async (request) => {
        const app = await project(request);
        return {
          schema: await need(shipping, "Databases").enableDatabase(app),
        };
      }),
    },
    "/api/projects/:id/database/browse": {
      POST: handle(async (request) => {
        const app = await project(request);
        const body = (await request.json()) as BrowseRequest;
        if (typeof body?.table !== "string")
          throw new HttpError(400, "Name the table to browse");
        return need(shipping, "Databases").browseTable(app.id, body);
      }),
    },
    "/api/projects/:id/database/query": {
      POST: handle(async (request) => {
        const app = await project(request);
        const { sql: text } = (await request.json()) as { sql?: unknown };
        if (typeof text !== "string")
          throw new HttpError(400, "Send the query as `sql`");
        return need(shipping, "Databases").querySql(app.id, text);
      }),
    },
    "/api/projects/:id/clone": {
      GET: handle(async (request) => {
        const app = await project(request);
        return { url: await need(shipping, "Git").cloneUrl(app.id) };
      }),
    },
    "/api/projects/:id/files": {
      PUT: handle(async (request) => {
        const app = await project(request);
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
          app,
          { [path]: contents },
          contents === null ? `Delete ${path}` : `Edit ${path}`,
          await authorOf(app.user_id),
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
