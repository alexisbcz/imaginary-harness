// What the server and the Vercel functions share: the database, the forge, and the `@pierre/storage` SDK bound to
// the forge in process (no network hop) for the app's own git work.

import { GitStorage } from "@pierre/storage";
import { config } from "../config.ts";
import { createForge } from "../forge/index.ts";

export const FORGE_PATH = "/forge";

let shared: ReturnType<typeof createServices> | undefined;
let migrated: Promise<unknown> | undefined;

/**
 * One set of services per function instance, migrated once: a cold start applies pending migrations, so a deploy
 * needs no separate migration step.
 */
export async function sharedServices() {
  shared ??= createServices();
  migrated ??= import("../db/migrate.ts").then(({ migrate }) => migrate(shared!.sql));
  await migrated;
  return shared;
}

export function createServices(sql: Bun.SQL = new Bun.SQL(config.databaseUrl)) {
  const forge = createForge({ sql, basePath: FORGE_PATH, publicOrigin: config.publicUrl });
  const host = new URL(config.publicUrl).host;
  const storage = config.forgePrivateKey
    ? new GitStorage({
        name: config.forgeOrg,
        key: config.forgePrivateKey,
        apiBaseUrl: `${config.publicUrl}${FORGE_PATH}`,
        storageBaseUrl: `${host}${FORGE_PATH}/git`,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => forge.fetch(new Request(input, init))) as typeof fetch,
      })
    : undefined;
  return { sql, forge, storage };
}
