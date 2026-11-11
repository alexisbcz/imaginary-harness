# richelieu.ai

A Pi Durable agent on Supabase. Supabase runs locally from `compose.yml`. The agent keeps its durable state in the
`pi` schema of the same Postgres. The web app talks to Supabase only: Auth, PostgREST and Realtime.

## Development

```sh
docker compose up -d   # Supabase: API on :54321, Postgres on :54322, Studio on :54323
bun install
bun dev                # app on http://localhost:3000
```

`.env` needs `ANTHROPIC_API_KEY`. Every other setting has a local default (see `src/config.ts` and `compose.yml`).

How it fits together:

- The app signs users in with the Supabase UI auth forms and writes to `threads` and `messages`, guarded by RLS.
- The agent follows new user messages through Realtime. It answers each one with Pi Durable and streams the
  answer back into `messages`, and the app follows it there through Realtime.
- `src/pi/postgres-storage.ts` is Pi Durable's storage on Postgres. It passes the package's storage conformance
  suite (`bun test`, with Supabase running). A crash mid-answer resumes on restart.
- Migrations live in `supabase/migrations` and are applied at startup.

## License

This project is licensed under the [MIT License](LICENSE).
