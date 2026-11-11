// Test helpers: a user in auth.users, and line-oriented SMTP and IMAP clients over the same Connection the
// servers use.

import { connect } from "node:net";
import type { SQL } from "bun";
import { Connection } from "../net/connection.ts";

export const DATABASE_URL =
  Bun.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:54322/postgres";

export async function createUser(sql: SQL, email: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email},
      ${JSON.stringify({ name: "Test User" })}::text::jsonb, now(), now())
    RETURNING id`;
  return user!.id;
}

export async function open(port: number): Promise<Connection> {
  const socket = await new Promise<import("node:net").Socket>(
    (resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port }, () => resolve(s));
      s.once("error", reject);
    },
  );
  return new Connection(socket, 30_000);
}

export class SmtpTestClient {
  constructor(readonly connection: Connection) {}

  static async connect(port: number) {
    const client = new SmtpTestClient(await open(port));
    await client.reply();
    return client;
  }

  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.connection.readLine();
      lines.push(line.slice(4));
      if (line[3] !== "-")
        return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
    }
  }

  async send(line: string) {
    this.connection.write(`${line}\r\n`);
    return this.reply();
  }

  async startTls() {
    const reply = await this.send("STARTTLS");
    if (reply.code !== 220)
      throw new Error(`STARTTLS: ${reply.code} ${reply.text}`);
    await this.connection.upgradeClient({
      servername: "localhost",
      rejectUnauthorized: false,
    });
  }

  async data(message: string) {
    const start = await this.send("DATA");
    if (start.code !== 354) return start;
    const body = message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    this.connection.write(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    return this.reply();
  }
}

export class ImapTestClient {
  private counter = 0;
  constructor(readonly connection: Connection) {}

  static async connect(port: number) {
    const client = new ImapTestClient(await open(port));
    await client.connection.readLine();
    return client;
  }

  /** Reads lines until the tagged response, reading literals whole. Returns everything as one text. */
  async readUntil(tag: string): Promise<{ status: string; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      let line = await this.connection.readLine();
      for (
        let match = line.match(/\{(\d+)\}$/);
        match;
        match = line.match(/\{(\d+)\}$/)
      ) {
        const bytes = await this.connection.readBytes(Number(match[1]));
        line = `${line}\n${new TextDecoder().decode(bytes)}${await this.connection.readLine()}`;
      }
      lines.push(line);
      if (line.startsWith(`${tag} `))
        return { status: line.slice(tag.length + 1), lines };
    }
  }

  async command(text: string) {
    const tag = `a${++this.counter}`;
    this.connection.write(`${tag} ${text}\r\n`);
    return this.readUntil(tag);
  }

  /** A command with a literal, using LITERAL+ so nothing waits for a continuation. */
  async commandWithLiteral(prefix: string, literal: string) {
    const tag = `a${++this.counter}`;
    const bytes = new TextEncoder().encode(literal);
    this.connection.write(`${tag} ${prefix} {${bytes.length}+}\r\n`);
    this.connection.write(bytes);
    this.connection.write("\r\n");
    return this.readUntil(tag);
  }
}
