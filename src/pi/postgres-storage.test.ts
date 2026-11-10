import { afterAll, describe, expect, it } from "bun:test";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PostgresStorage } from "./postgres-storage.ts";

const url = Bun.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54322/postgres";
const sql = new Bun.SQL(url);
let counter = 0;

afterAll(async () => {
  const schemas = await sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'pi_test_%'`;
  for (const { nspname } of schemas) await sql.unsafe(`DROP SCHEMA ${nspname} CASCADE`);
  await sql.close();
});

// Each case gets a fresh schema of the local Supabase database (`docker compose up -d`).
registerStorageConformance({ describe, expect, it } as never, "PostgresStorage", async (use) => {
  const schema = `pi_test_${process.pid}_${++counter}`;
  const storage = await PostgresStorage.open(sql, { schema });
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});
