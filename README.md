# richelieu.ai

A Pi Durable agent on Supabase, with its own git forge. Supabase runs locally from `compose.yml`. Everything the app
keeps lives in that one Postgres: the agent's durable state (`pi` schema), the forge's repositories (`forge`
schema), and the app's threads and messages (`public`). The web app talks to Supabase only: Auth, PostgREST and
Realtime.

## Development

```sh
docker compose up -d                    # Supabase: API on :54321, Postgres on :54322, Studio on :54323
bun install
bun run forge:org richelieu --write-env # once: the forge organization the app signs its tokens as
bun dev                                 # app on http://localhost:3000, forge under /forge
bun test                                # needs Supabase running
```

`.env` needs `ANTHROPIC_API_KEY`. Every other setting has a local default (see `src/config.ts` and `compose.yml`).

How it fits together:

- The app signs users in with the Supabase UI auth forms and writes to `threads` and `messages`, guarded by RLS.
- The agent picks up new user messages. It answers each one with Pi Durable and streams the answer back into
  `messages`, and the app follows it there through Realtime.
- Each thread has a git repository on the forge, the agent's workspace. Every file the agent writes is a commit.
  `public.files` mirrors each repository's head, and the app shows it with [Pierre](https://pierre.computer)'s
  libraries: `@pierre/trees` for the tree and `@pierre/diffs` for files and their latest change. Code blocks in
  answers also render through `@pierre/diffs`, with `@pierre/theme` and `@pierre/icons` throughout.
- `src/pi/postgres-storage.ts` is Pi Durable's storage on Postgres. It passes the package's storage conformance
  suite. A crash mid-answer resumes on restart.
- Migrations live in `supabase/migrations` and are applied at startup.

## The forge

`src/forge` is a git forge whose API matches [code.storage](https://code.storage)'s, so the official
`@pierre/storage` SDK works against it unchanged:

```ts
import { GitStorage } from "@pierre/storage";

const store = new GitStorage({
  name: "richelieu",                              // the organization
  key: process.env.FORGE_PRIVATE_KEY!,            // from `bun run forge:org`
  apiBaseUrl: "https://your-app.vercel.app/forge",
  storageBaseUrl: "your-app.vercel.app/forge/git",
});

const repo = await store.createRepo({ id: "my-repo" });
await repo
  .createCommit({ targetBranch: "main", commitMessage: "Initial commit", author: { name: "Ada", email: "ada@example.com" } })
  .addFileFromString("README.md", "# Hello\n")
  .send();

const url = await repo.getRemoteURL(); // git clone it, push to it
```

What it stores, all in Supabase Postgres: organizations and their public keys, repositories, refs, and git
objects, zlib-compressed and shared across an organization's repositories (forks cost nothing).

What it serves, from one stateless `fetch` handler:

- `/forge/api/v1/*`: repositories (create, fork, find, list, delete), `createCommit`, `createCommitFromDiff`,
  `restoreCommit`, files and file metadata, raw files with ranges and ETags, archives, branches and ephemeral
  branches, tags, commits, blame, commit and branch diffs, merge previews and merges, grep, and notes.
- `/forge/git/<repo>.git`: git's smart HTTP protocol, so `git clone`, `fetch` and `push` work with the URLs from
  `getRemoteURL()` and `getEphemeralRemoteURL()`. A push based on a ref that moved since is refused, as
  git does.

Tokens are ES256 JWTs, the ones the SDK signs: the forge checks them against the organization's public keys
(several during a rotation) and enforces their `repo` and `scopes` claims.

Not supported yet: syncing with GitHub or other remotes (`pullUpstream`, git credentials), shallow and partial
clones, and the `refs` claim's per-ref policies. Merges combine changes line by line; overlapping changes
conflict.

## Deploying to Vercel and Supabase

1. Create a Supabase project. Migrations apply on the first request, so the database needs nothing else.
2. Create the forge organization against it, and keep the private key:
   `DATABASE_URL=<session pooler URL> bun run forge:org richelieu`.
3. Import the repository in Vercel. `vercel.json` builds the web app with Bun, serves `/forge` and `/api/agent`
   as functions on the Bun runtime, and runs the agent every minute with a cron.
4. Set the environment variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase's session pooler URL (port 5432). The transaction pooler drops the agent's session lock. |
   | `BUN_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` |
   | `BUN_PUBLIC_SUPABASE_ANON_KEY` | The project's anon (publishable) key |
   | `ANTHROPIC_API_KEY` | For the agent |
   | `FORGE_ORG` and `FORGE_PRIVATE_KEY` | From step 2 |
   | `PUBLIC_URL` | Optional; the app's URL, for git remote URLs. Defaults to the production domain. |

5. In Supabase Auth, set the site URL to the Vercel domain.

When deployed, the agent is a function. The app wakes it after each message, and the cron catches anything left
over. Pi Durable's writer lock keeps runs one at a time. An answer that outlives a run resumes in the next one.

Vercel caps request bodies at 4.5 MB, which limits the size of a single `git push` or `createCommit`. `bun run
build && bun run preview` serves the production build locally, routed like `vercel.json`.

## License

This project is licensed under the [MIT License](LICENSE).
