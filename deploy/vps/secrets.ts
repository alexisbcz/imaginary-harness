// Prints fresh Supabase secrets as .env lines: the database password, the JWT secret and the anon and service role
// keys signed with it, and the keys Realtime and postgres-meta need. compose.yml reads them from .env.
//
//   bun deploy/vps/secrets.ts >> .env

import { SignJWT } from "jose";

const random = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );

const jwtSecret = random(48);
const key = new TextEncoder().encode(jwtSecret);
const sign = (role: string) =>
  new SignJWT({ role, iss: "supabase", ref: "richelieu" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10y")
    .sign(key);

const anon = await sign("anon");
const service = await sign("service_role");
console.log(
  [
    `POSTGRES_PASSWORD=${random(24)}`,
    `SUPABASE_JWT_SECRET=${jwtSecret}`,
    `SUPABASE_ANON_KEY=${anon}`,
    `SUPABASE_SERVICE_ROLE_KEY=${service}`,
    `BUN_PUBLIC_SUPABASE_ANON_KEY=${anon}`,
    `SECRET_KEY_BASE=${random(48)}`,
    `PG_META_CRYPTO_KEY=${random(32)}`,
  ].join("\n"),
);
