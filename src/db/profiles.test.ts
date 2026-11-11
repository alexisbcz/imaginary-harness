import { expect, test } from "bun:test";
import { migrate } from "./migrate.ts";

const DATABASE_URL =
  Bun.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:54322/postgres";
const SUPABASE_URL =
  Bun.env.BUN_PUBLIC_SUPABASE_URL ?? "http://localhost:54321";
const ANON_KEY =
  Bun.env.BUN_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpY2hlbGlldSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzYyODE5MjAwLCJleHAiOjQxMDI0NDQ4MDB9.A7UFTz_dhd_vLCC895znt_r5pOuYCjzOnRSvk-oR-VI";

const sql = new Bun.SQL(DATABASE_URL);

async function signUp(email: string, name?: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password-123",
      ...(name === undefined ? {} : { data: { name } }),
    }),
  });
  const body = (await response.json()) as {
    id?: string;
    user?: { id: string };
    msg?: string;
    error_description?: string;
  };
  if (!response.ok) {
    throw new Error(
      body.msg ?? body.error_description ?? response.statusText,
    );
  }
  return body.user?.id ?? body.id!;
}

/** Bun's expect() inspects a SQL error deeply enough to hang, so check the message by hand. */
async function queryFails(query: Promise<unknown>, message: string) {
  try {
    await query;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(
      message,
    );
    return;
  }
  throw new Error(`expected a query error containing ${message}`);
}

test("a name is stored when sign-up sends one, and only a real name can be saved", async () => {
  await migrate(sql);
  const stamp = crypto.randomUUID();
  const namedEmail = `named-${stamp}@example.com`;
  const bareEmail = `bare-${stamp}@example.com`;
  try {
    const namedId = await signUp(namedEmail, "  Ada   Lovelace ");
    const [named] = await sql<{ name: string }[]>`
      SELECT name FROM public.profiles WHERE id = ${namedId}`;
    expect(named?.name).toBe("Ada Lovelace");

    const bareId = await signUp(bareEmail);
    const bare = await sql<{ name: string }[]>`
      SELECT name FROM public.profiles WHERE id = ${bareId}`;
    expect(bare).toHaveLength(0);

    await queryFails(
      sql`INSERT INTO public.profiles (id, name) VALUES (${bareId}, '   ')`,
      "profiles_name_valid",
    );
    await queryFails(
      sql`INSERT INTO public.profiles (id, name) VALUES (${bareId}, ${"a".repeat(81)})`,
      "profiles_name_valid",
    );

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claim.sub', ${bareId}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`INSERT INTO public.profiles (name) VALUES ('Grace Hopper')`;
      const rows = await tx<{ id: string; name: string }[]>`
        SELECT id, name FROM public.profiles`;
      expect(rows.map((row) => ({ id: row.id, name: row.name }))).toEqual([
        { id: bareId, name: "Grace Hopper" },
      ]);
      // A failed statement aborts the transaction unless it is rolled back to a savepoint.
      await tx`SAVEPOINT other_person`;
      await queryFails(
        tx`INSERT INTO public.profiles (id, name) VALUES (${namedId}, 'Someone Else')`,
        "permission denied",
      );
      await tx`ROLLBACK TO SAVEPOINT other_person`;
    });

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claim.sub', ${namedId}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM public.profiles`;
      expect(rows.map((row) => row.id)).toEqual([namedId]);
    });
  } finally {
    await sql`DELETE FROM auth.users WHERE email IN (${namedEmail}, ${bareEmail})`;
    await sql.close();
  }
});
