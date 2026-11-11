// Server configuration. The defaults match compose.yml; override them in `.env` (Bun loads it).

export const config = {
  port: Number(Bun.env.PORT ?? 3000),
  databaseUrl: Bun.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54322/postgres",
  supabaseUrl: Bun.env.BUN_PUBLIC_SUPABASE_URL ?? "http://localhost:54321",
  serviceRoleKey:
    Bun.env.SUPABASE_SERVICE_ROLE_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpY2hlbGlldSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJpYXQiOjE3NjI4MTkyMDAsImV4cCI6NDEwMjQ0NDgwMH0.XC6fU0Bn6yXm28zVgFvQ__a8I8TkQIpidY-HfJQb-PY",
  model: { provider: "anthropic", modelId: Bun.env.MODEL ?? "claude-sonnet-5-5" },
} as const;
