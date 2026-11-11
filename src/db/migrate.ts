import type { SQL } from "bun";

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/**
 * Applies `supabase/migrations/*.sql` not applied yet, each in its own transaction, recorded in
 * `supabase_migrations.schema_migrations` as the Supabase CLI does, so `supabase db push` agrees with it.
 */
export async function migrate(sql: SQL): Promise<string[]> {
  const files = [...new Bun.Glob("*.sql").scanSync(MIGRATIONS.pathname)].sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('supabase_migrations'))`;
    await tx`CREATE SCHEMA IF NOT EXISTS supabase_migrations`;
    await tx`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text NOT NULL PRIMARY KEY, statements text[], name text
    )`;
    const done = new Set((await tx`SELECT version FROM supabase_migrations.schema_migrations`).map((r: { version: string }) => r.version));
    for (const file of files) {
      const [, version, name] = file.match(/^(\d+)_(.+)\.sql$/) ?? [];
      if (version === undefined || done.has(version)) continue;
      const text = await Bun.file(new URL(file, MIGRATIONS)).text();
      await tx.unsafe(text);
      await tx`INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${version}, ARRAY[${text}], ${name})`;
      applied.push(file);
    }
  });
  return applied;
}
