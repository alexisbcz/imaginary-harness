// Server configuration. The defaults match compose.yml; override them in `.env` (Bun loads it).

export const config = {
  port: Number(Bun.env.PORT ?? 3000),
  /** Where the app is reachable, for the forge's git URLs. */
  publicUrl: (
    Bun.env.PUBLIC_URL ??
    (Bun.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${Bun.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : `http://localhost:${Bun.env.PORT ?? 3000}`)
  ).replace(/\/+$/, ""),
  databaseUrl:
    Bun.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:54322/postgres",
  /** Where the server reaches Supabase: its own address for it when the browser goes through a proxy. */
  supabaseUrl:
    Bun.env.SUPABASE_INTERNAL_URL ??
    Bun.env.BUN_PUBLIC_SUPABASE_URL ??
    "http://localhost:54321",
  /**
   * Forward /auth/v1, /rest/v1, /realtime/v1 and /storage/v1 to SUPABASE_INTERNAL_URL, so the browser reaches
   * Supabase on the app's origin (BUN_PUBLIC_SUPABASE_URL = PUBLIC_URL): the one-box VPS setup.
   */
  supabaseProxy: Bun.env.SUPABASE_PROXY === "true",
  serviceRoleKey:
    Bun.env.SUPABASE_SERVICE_ROLE_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpY2hlbGlldSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJpYXQiOjE3NjI4MTkyMDAsImV4cCI6NDEwMjQ0NDgwMH0.XC6fU0Bn6yXm28zVgFvQ__a8I8TkQIpidY-HfJQb-PY",
  /** The public (anon) key, which generated apps use to reach their database. */
  anonKey:
    Bun.env.BUN_PUBLIC_SUPABASE_ANON_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpY2hlbGlldSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzYyODE5MjAwLCJleHAiOjQxMDI0NDQ4MDB9.A7UFTz_dhd_vLCC895znt_r5pOuYCjzOnRSvk-oR-VI",
  /**
   * Where published apps are served: their own origin, so a published app's scripts can never read the builder's
   * session. Locally a second port of the same server.
   */
  sitesPort: Number(Bun.env.SITES_PORT ?? 3001),
  sitesUrl: (
    Bun.env.SITES_URL ?? `http://localhost:${Bun.env.SITES_PORT ?? 3001}`
  ).replace(/\/+$/, ""),
  /**
   * Serve the web app over HTTPS itself, on HTTPS_PORT (443), with the mail server's certificate, and answer ACME
   * challenges and redirect to HTTPS on HTTP_PORT (80): the one-box VPS setup, without a reverse proxy.
   */
  https: Bun.env.WEB_HTTPS === "true",
  httpsPort: Number(Bun.env.HTTPS_PORT ?? 443),
  httpPort: Number(Bun.env.HTTP_PORT ?? 80),
  model: {
    provider: "anthropic",
    modelId: Bun.env.MODEL ?? "claude-sonnet-5-5",
  },
  /** The forge organization the app signs its tokens as (`bun run forge:org <name> --write-env`). */
  forgeOrg: Bun.env.FORGE_ORG ?? "richelieu",
  forgePrivateKey: Bun.env.FORGE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
} as const;
