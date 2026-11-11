// A forge on the local Supabase database (`docker compose up -d`), a fresh organization per test file, and the
// official `@pierre/storage` SDK pointed at it.

import { GitStorage } from "@pierre/storage";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { migrate } from "../../db/migrate.ts";
import { createForge } from "../index.ts";

export const DATABASE_URL =
  Bun.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:54322/postgres";

export async function setupForge() {
  const sql = new Bun.SQL(DATABASE_URL);
  await migrate(sql);
  const forge = createForge({ sql, basePath: "/forge" });
  const org = `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  await forge.repos.createOrg(org, await exportSPKI(publicKey));
  const key = await exportPKCS8(privateKey);

  // HTTP for git, which the SDK's https:// remote URLs cannot reach locally.
  const server = Bun.serve({ port: 0, fetch: forge.fetch });
  const origin = `http://localhost:${server.port}`;
  const storage = new GitStorage({
    name: org,
    key,
    apiBaseUrl: `${origin}/forge`,
    storageBaseUrl: `localhost:${server.port}/forge/git`,
  });
  const remote = async (repo: { getRemoteURL(): Promise<string> }) =>
    (await repo.getRemoteURL()).replace(/^https:/, "http:");

  return {
    sql,
    forge,
    org,
    key,
    storage,
    origin,
    remote,
    async teardown() {
      server.stop(true);
      await sql`DELETE FROM forge.orgs WHERE name = ${org}`;
      await sql.close();
    },
  };
}

/** Runs git in `cwd` without any user configuration, failing loudly. */
export async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Tester",
      "-c",
      "user.email=tester@example.com",
      "-c",
      "init.defaultBranch=main",
      // Apple's git ships a built-in config with the osxkeychain helper that
      // GIT_CONFIG_NOSYSTEM does not skip: an empty value clears the helpers.
      "-c",
      "credential.helper=",
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // An editor's askpass (VS Code sets GIT_ASKPASS) would prompt on a 401.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/ASKPASS/.test(key)),
        ),
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: cwd,
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`git ${args.join(" ")} failed (${code}):\n${stderr}`);
  return stdout.trim();
}
