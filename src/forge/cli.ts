// Creates a forge organization: an ES256 key pair, the public key stored in Supabase, the private key printed
// (or written to .env with --write-env) for the SDK's `key` option.
//
//   bun run forge:org <name> [--write-env]

import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { migrate } from "../db/migrate.ts";
import { RepoStore } from "./store.ts";

export async function createOrganization(sql: Bun.SQL, name: string) {
  await migrate(sql);
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  await new RepoStore(sql).createOrg(name, await exportSPKI(publicKey));
  return exportPKCS8(privateKey);
}

/** `.env` lines for an organization: the private key on one line, newlines escaped. */
export const envLines = (name: string, key: string) =>
  `FORGE_ORG=${name}\nFORGE_PRIVATE_KEY="${key.trim().replace(/\n/g, "\\n")}"\n`;

if (import.meta.main) {
  const [name, ...flags] = Bun.argv.slice(2);
  if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    console.error(
      "Usage: bun run forge:org <name> [--write-env]   (name: lowercase letters, digits and dashes)",
    );
    process.exit(1);
  }
  const sql = new Bun.SQL(
    Bun.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:54322/postgres",
  );
  const key = await createOrganization(sql, name);
  await sql.close();
  if (flags.includes("--write-env")) {
    const file = Bun.file(".env");
    const current = (await file.exists()) ? await file.text() : "";
    const kept = current
      .split("\n")
      .filter((line) => !/^FORGE_(ORG|PRIVATE_KEY)=/.test(line))
      .join("\n");
    await Bun.write(
      file,
      `${kept.replace(/\n*$/, "\n")}${envLines(name, key)}`,
    );
    console.log(
      `Organization ${name} created; FORGE_ORG and FORGE_PRIVATE_KEY written to .env`,
    );
  } else {
    console.log(
      `Organization ${name} created. Keep this private key secret (FORGE_PRIVATE_KEY):\n\n${key}`,
    );
  }
}
