// Server configuration. The defaults match compose.yml; override them in `.env` (Bun loads it).

export const config = {
  port: Number(Bun.env.PORT ?? 3000),
  /** Where the app is reachable, for the forge's git URLs. */
  publicUrl: (Bun.env.PUBLIC_URL ?? (Bun.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${Bun.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${Bun.env.PORT ?? 3000}`)).replace(/\/+$/, ""),
  databaseUrl: Bun.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54322/postgres",
  supabaseUrl: Bun.env.BUN_PUBLIC_SUPABASE_URL ?? "http://localhost:54321",
  serviceRoleKey:
    Bun.env.SUPABASE_SERVICE_ROLE_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpY2hlbGlldSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJpYXQiOjE3NjI4MTkyMDAsImV4cCI6NDEwMjQ0NDgwMH0.XC6fU0Bn6yXm28zVgFvQ__a8I8TkQIpidY-HfJQb-PY",
  model: { provider: "anthropic", modelId: Bun.env.MODEL ?? "claude-sonnet-5-5" },
  /** The forge organization the app signs its tokens as (`bun run forge:org <name> --write-env`). */
  forgeOrg: Bun.env.FORGE_ORG ?? "richelieu",
  forgePrivateKey: Bun.env.FORGE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
} as const;
