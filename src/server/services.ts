// What the server and the Vercel functions share: the database, the forge, and the `@pierre/storage` SDK bound to
// the forge in process (no network hop) for the app's own git work.

import { GitStorage } from "@pierre/storage";
import { config } from "../config.ts";
import { createForge } from "../forge/index.ts";

export const FORGE_PATH = "/forge";

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
