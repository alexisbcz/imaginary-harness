// Shipping a project: publishing its production build on the sites origin, giving it a database of its own, and
// handing out a git URL to clone it.

import type { SQL } from "bun";
import type { GitStorage } from "@pierre/storage";
import { config } from "../config.ts";
import type { Previews } from "./previews.ts";
import { untar } from "./tar.ts";
import type { Thread, WorkspaceStore } from "../agent/workspace.ts";

const BUILD_DIR = "/tmp/richelieu-build";
const CLONE_TTL_SECONDS = 60 * 60;
const MAX_ROWS = 50;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
  map: "application/json",
};
const contentTypeOf = (path: string) =>
  CONTENT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ??
  "application/octet-stream";

/** A URL-friendly name from the project's title, with a short suffix of its id so names stay unique. */
function slugFor(title: string, threadId: string) {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // A few words: cut at the last dash before 28 characters.
      .slice(0, 28)
      .replace(/-[^-]*$/, "")
      .replace(/-+$/, "") || "app";
  return `${base}-${threadId.replace(/-/g, "").slice(0, 6)}`;
}

export function createShipping({
  sql,
  store,
  storage,
  previews,
}: {
  sql: SQL;
  store: WorkspaceStore;
  storage: GitStorage;
  previews: Previews | undefined;
}) {
  // Publishing ------------------------------------------------------------------------------------------------------

  /** Builds the project for production and serves it at `<sites>/<slug>/`, replacing a previous build. */
  async function publish(thread: Thread) {
    if (!previews)
      throw new Error("Publishing needs Docker, which this server lacks");
    const [row] = await sql<{ title: string; published_slug: string | null }[]>`
      SELECT title, published_slug FROM public.threads WHERE id = ${thread.id}`;
    const slug = row?.published_slug ?? slugFor(row?.title ?? "app", thread.id);

    const build = await previews.exec(
      thread.id,
      [
        "node",
        "node_modules/vite/bin/vite.js",
        "build",
        "--base",
        `/${slug}/`,
        "--outDir",
        BUILD_DIR,
        "--emptyOutDir",
        "--logLevel",
        "error",
      ],
      300_000,
    );
    if (build.exitCode !== 0)
      throw new Error(
        `The build failed:\n${(build.stdout + build.stderr).trim().slice(-3000)}`,
      );
    const archive = await previews.copyOut(thread.id, BUILD_DIR);
    const files = Object.entries(untar(archive))
      .map(
        ([path, content]) =>
          [path.replace(/^(\.\/)?[^/]+\//, ""), content] as const,
      )
      .filter(([path]) => path.length > 0);
    if (!files.some(([path]) => path === "index.html"))
      throw new Error("The build has no index.html");

    await sql.begin(async (tx) => {
      await tx`DELETE FROM public.published_files WHERE slug = ${slug}`;
      for (const [path, content] of files)
        await tx`
          INSERT INTO public.published_files (slug, path, content, content_type)
          VALUES (${slug}, ${path}, ${content}, ${contentTypeOf(path)})`;
      await tx`UPDATE public.threads SET published_slug = ${slug}, published_at = now() WHERE id = ${thread.id}`;
    });
    return { url: `${config.sitesUrl}/${slug}/`, files: files.length };
  }

  async function unpublish(thread: Thread) {
    await sql.begin(async (tx) => {
      const [row] = await tx<{ published_slug: string | null }[]>`
        SELECT published_slug FROM public.threads WHERE id = ${thread.id} FOR UPDATE`;
      if (row?.published_slug)
        await tx`DELETE FROM public.published_files WHERE slug = ${row.published_slug}`;
      await tx`UPDATE public.threads SET published_slug = NULL, published_at = NULL WHERE id = ${thread.id}`;
    });
  }

  /** Serves the published apps: `/<slug>/<path>`, with index.html for the app's own routes. */
  async function serveSite(request: Request) {
    const { pathname } = new URL(request.url);
    const [, slug, ...rest] = pathname.split("/");
    if (!slug) return new Response("Not found", { status: 404 });
    if (rest.length === 0)
      return Response.redirect(`${config.sitesUrl}/${slug}/`, 301);
    const path = decodeURIComponent(rest.join("/")) || "index.html";
    const [file] = await sql<{ content: Uint8Array; content_type: string }[]>`
      SELECT content, content_type FROM public.published_files
      WHERE slug = ${slug} AND path IN (${path}, 'index.html')
      ORDER BY path = ${path} DESC LIMIT 1`;
    if (!file) return new Response("Not found", { status: 404 });
    // A missing asset is a 404, not the app's page.
    const fallback =
      file.content_type.startsWith("text/html") && path !== "index.html";
    if (fallback && /\.[a-z0-9]+$/i.test(path))
      return new Response("Not found", { status: 404 });
    return new Response(file.content as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": file.content_type,
        "Cache-Control": path.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Database ------------------------------------------------------------------------------------------------------

  type AppDatabase = {
    schema_name: string;
    role_name: string;
    password: string;
  };

  async function databaseOf(threadId: string) {
    const [row] = await sql<AppDatabase[]>`
      SELECT schema_name, role_name, password FROM public.app_databases WHERE thread_id = ${threadId}`;
    return row;
  }

  /** Exposes every app schema through the API (PostgREST reads this from the database) and reloads it. */
  async function exposeSchemas() {
    const rows = await sql<
      { schema_name: string }[]
    >`SELECT schema_name FROM public.app_databases ORDER BY created_at`;
    const schemas = [
      "public",
      "graphql_public",
      ...rows.map((r) => r.schema_name),
    ].join(",");
    await sql.unsafe(
      `ALTER ROLE authenticator SET pgrst.db_schemas = '${schemas}'`,
    );
    await sql`NOTIFY pgrst, 'reload config'`;
    await sql`NOTIFY pgrst, 'reload schema'`;
  }

  /** A connection as the app's own role: whatever the SQL says, it reaches only the app's schema. */
  function connect(database: AppDatabase) {
    const url = new URL(config.databaseUrl);
    url.username = database.role_name;
    url.password = database.password;
    return new Bun.SQL(url.toString(), { max: 1 });
  }

  /**
   * Gives the project a database: its schema and role, exposed through the API, and the app wired to it
   * (supabase-js installed, `src/lib/supabase.ts` and `.env` committed). Does nothing the second time.
   */
  async function enableDatabase(thread: Thread) {
    let database = await databaseOf(thread.id);
    if (!database) {
      const schema = `app_${thread.id.replace(/-/g, "")}`;
      const role = `${schema}_owner`;
      const password =
        crypto.randomUUID().replace(/-/g, "") +
        crypto.randomUUID().replace(/-/g, "");
      await sql.begin(async (tx) => {
        // Names come from a UUID and the password from random hex: nothing here comes from the user.
        await tx.unsafe(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5`,
        );
        // Supabase's postgres is no superuser: it must be granted the role to create a schema owned by it. (Keep this
        // plain: `GRANT ... TO current_user WITH SET TRUE, INHERIT FALSE` crashes the backend under supautils.)
        await tx.unsafe(
          `GRANT ${role} TO ${new URL(config.databaseUrl).username}`,
        );
        await tx.unsafe(`ALTER ROLE ${role} SET statement_timeout = '10s'`);
        await tx.unsafe(`ALTER ROLE ${role} SET search_path = ${schema}`);
        await tx.unsafe(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
        await tx.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role`,
        );
        await tx`
          INSERT INTO public.app_databases (thread_id, schema_name, role_name, password)
          VALUES (${thread.id}, ${schema}, ${role}, ${password})`;
        await tx`UPDATE public.threads SET database_schema = ${schema} WHERE id = ${thread.id}`;
      });
      database = (await databaseOf(thread.id))!;
      // The signed-in user's id, as row level security policies need it. `auth` is out of the role's reach, so the
      // schema has its own `uid()`, reading the request's JWT as auth.uid() does.
      const connection = connect(database);
      try {
        await connection.unsafe(`
          CREATE FUNCTION ${schema}.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(coalesce(
              current_setting('request.jwt.claim.sub', true),
              current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
            ), '')::uuid
          $$`);
      } finally {
        await connection.close();
      }
      await exposeSchemas();
    }

    // Wire the app: the client, its settings, and the package.
    await store.commitFiles(
      thread,
      {
        ".env": [
          "# This app's database: Supabase, in its own schema. The anon key is public; row level security protects the data.",
          `VITE_SUPABASE_URL=${config.supabaseUrl}`,
          `VITE_SUPABASE_ANON_KEY=${config.anonKey}`,
          `VITE_SUPABASE_SCHEMA=${database.schema_name}`,
          "",
        ].join("\n"),
        "src/lib/supabase.ts": [
          'import { createClient } from "@supabase/supabase-js"',
          "",
          "/** The app's database and auth. Its tables live in the app's own schema. */",
          "export const supabase = createClient(",
          "  import.meta.env.VITE_SUPABASE_URL,",
          "  import.meta.env.VITE_SUPABASE_ANON_KEY,",
          "  { db: { schema: import.meta.env.VITE_SUPABASE_SCHEMA } },",
          ")",
          "",
        ].join("\n"),
      },
      "Connect the database",
    );
    if (previews) {
      const manifest = JSON.parse(
        (await store.files(thread.id))["package.json"] ?? "{}",
      ) as {
        dependencies?: Record<string, string>;
      };
      if (!manifest.dependencies?.["@supabase/supabase-js"]) {
        const install = await previews.exec(
          thread.id,
          [
            "npm",
            "install",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
            "@supabase/supabase-js",
          ],
          300_000,
        );
        if (install.exitCode !== 0)
          throw new Error(
            `Could not install @supabase/supabase-js: ${install.stderr.slice(-2000)}`,
          );
        const packageJson = await previews.exec(thread.id, [
          "cat",
          "package.json",
        ]);
        await store.commitFiles(
          thread,
          { "package.json": packageJson.stdout },
          "Add @supabase/supabase-js",
        );
      }
      // The dev server reads .env at start.
      await previews.restart(thread.id);
    }
    return database.schema_name;
  }

  /** Runs SQL as the app's role, in its schema, in one transaction; returns the last statement's rows. */
  async function runSql(threadId: string, text: string) {
    const database = await databaseOf(threadId);
    if (!database)
      throw new Error("This project has no database yet: enable it first");
    const connection = connect(database);
    try {
      const rows = await connection.begin((tx) => tx.unsafe(text));
      await sql`NOTIFY pgrst, 'reload schema'`;
      // Several statements give one result each: the last one is the answer.
      const results = rows as unknown[];
      const last = Array.isArray(results[0]) ? results.at(-1) : results;
      return Array.isArray(last)
        ? [...(last as Record<string, unknown>[])].slice(0, MAX_ROWS)
        : [];
    } finally {
      await connection.close();
    }
  }

  /** The app's tables, their columns and first rows, for the Database tab. */
  async function inspectDatabase(threadId: string) {
    const database = await databaseOf(threadId);
    if (!database) return null;
    const connection = connect(database);
    try {
      const columns = await connection<
        { table_name: string; column_name: string; data_type: string }[]
      >`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = ${database.schema_name} ORDER BY table_name, ordinal_position`;
      const tables = new Map<string, { name: string; type: string }[]>();
      for (const c of columns) {
        if (!tables.has(c.table_name)) tables.set(c.table_name, []);
        tables
          .get(c.table_name)!
          .push({ name: c.column_name, type: c.data_type });
      }
      const result = [];
      for (const [name, cols] of tables) {
        const rows = await connection.unsafe(
          `SELECT * FROM "${database.schema_name}"."${name.replace(/"/g, '""')}" LIMIT ${MAX_ROWS}`,
        );
        const [{ count }] = await connection.unsafe(
          `SELECT count(*)::int AS count FROM "${database.schema_name}"."${name.replace(/"/g, '""')}"`,
        );
        result.push({ name, columns: cols, rows: [...rows], count });
      }
      return { schema: database.schema_name, tables: result };
    } finally {
      await connection.close();
    }
  }

  // Git -----------------------------------------------------------------------------------------------------------

  /** A read-only clone URL with a token that expires within the hour. Pushes would bypass the app's mirror. */
  async function cloneUrl(threadId: string) {
    const repo = await storage.findOne({ id: threadId });
    if (!repo) throw new Error("This project has no files yet");
    const url = new URL(
      await repo.getRemoteURL({
        permissions: ["git:read"],
        ttl: CLONE_TTL_SECONDS,
      }),
    );
    // The SDK always says https; locally the forge speaks plain http.
    url.protocol = new URL(config.publicUrl).protocol;
    return url.toString();
  }

  return {
    publish,
    unpublish,
    serveSite,
    enableDatabase,
    runSql,
    inspectDatabase,
    cloneUrl,
  };
}

export type Shipping = ReturnType<typeof createShipping>;
