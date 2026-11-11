// The mail servers end to end, on the local Supabase database (`docker compose up -d`): a message arrives over
// SMTP, is read and changed over IMAP, and a reply leaves through submission and the queue to another server.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:net";
import { migrate } from "../../db/migrate.ts";
import { generateDkimKey, signMessage } from "../auth/dkim.ts";
import { staticResolver } from "../auth/dns.ts";
import { mailConfig, type MailConfig } from "../config.ts";
import { listenImap } from "../imap/server.ts";
import { buildMessage } from "../mime/build.ts";
import { OutboundQueue } from "../queue.ts";
import { MailService } from "../service.ts";
import { listenSmtp } from "../smtp/server.ts";
import { MailStore, type Account } from "../store.ts";
import { createSelfSigned } from "../tls/der.ts";
import { createSecureContext } from "node:tls";
import {
  createUser,
  DATABASE_URL,
  ImapTestClient,
  SmtpTestClient,
} from "./helpers.ts";

const sql = new Bun.SQL(DATABASE_URL);
const stamp = Date.now().toString(36);
const local = `local-${stamp}.test`;
const remote = `remote-${stamp}.test`;
const sender = `sender-${stamp}.test`;
const ports = { mx: 0, submission: 0, imap: 0, remoteMx: 0 };
const servers: Server[] = [];
const senderKey = generateDkimKey();
const self = createSelfSigned(["localhost"]);
const context = createSecureContext({
  cert: self.certificate,
  key: self.privateKey,
});

// Our "internet": the remote domain's MX and the sender's SPF and DKIM records all point at the loopback.
const resolver = staticResolver({
  [`TXT ${sender}`]: ["v=spf1 ip4:127.0.0.1 -all"],
  [`TXT mail._domainkey.${sender}`]: [senderKey.dnsValue],
  [`TXT _dmarc.${sender}`]: ["v=DMARC1; p=reject"],
  [`TXT spoofed-${stamp}.test`]: ["v=spf1 ip4:192.0.2.1 -all"],
  [`TXT _dmarc.spoofed-${stamp}.test`]: ["v=DMARC1; p=reject"],
  [`MX ${remote}`]: [{ exchange: "127.0.0.1", priority: 10 }],
});

const config: MailConfig = {
  ...mailConfig,
  hostname: "mx.test",
  maxSize: 1_000_000,
  relay: undefined,
  enforceDmarc: true,
};
let store: MailStore;
let service: MailService;
let remoteService: MailService;
let queue: OutboundQueue;
let account: Account;
let remoteAccount: Account;
let password: string;

const listen = async (server: Promise<Server>) => {
  const s = await server;
  servers.push(s);
  return (s.address() as { port: number }).port;
};

/** Our server's view of the shared database: the remote domain is someone else's, reached over SMTP. */
class OurStore extends MailStore {
  override async isLocalDomain(domain: string) {
    return domain !== remote && (await super.isLocalDomain(domain));
  }
  override async recipient(address: string) {
    return address.endsWith(`@${remote}`)
      ? undefined
      : super.recipient(address);
  }
}

beforeAll(async () => {
  await migrate(sql);
  store = new OurStore(sql);
  service = new MailService(sql, store, config, resolver);
  remoteService = new MailService(
    sql,
    new MailStore(sql),
    { ...config, hostname: "remote.test" },
    resolver,
  );
  const userId = await createUser(sql, `mail-${stamp}@example.com`);
  const remoteUserId = await createUser(sql, `remote-${stamp}@example.com`);
  await store.createDomain({ name: local, userId });
  await store.createDomain({ name: remote, userId: remoteUserId });
  account = await store.createAccount({
    userId,
    domain: local,
    localPart: "ada",
    displayName: "Ada Lovelace",
  });
  remoteAccount = await store.createAccount({
    userId: remoteUserId,
    domain: remote,
    localPart: "charles",
  });
  password = (await store.createAppPassword(userId, "Test client")).password;

  const tls = () => context;
  const smtp = {
    hostname: "mx.test",
    maxSize: config.maxSize,
    handler: service.smtpHandler(),
    tls,
  };
  ports.mx = await listen(
    listenSmtp({ mode: "mx", port: 0, host: "127.0.0.1" }, smtp),
  );
  ports.submission = await listen(
    listenSmtp({ mode: "submission", port: 0, host: "127.0.0.1" }, smtp),
  );
  ports.imap = await listen(
    listenImap(
      { port: 0, host: "127.0.0.1" },
      { hostname: "mx.test", service, maxSize: config.maxSize, tls },
    ),
  );
  ports.remoteMx = await listen(
    listenSmtp(
      { mode: "mx", port: 0, host: "127.0.0.1" },
      {
        ...smtp,
        hostname: "remote.test",
        handler: remoteService.smtpHandler(),
      },
    ),
  );
  queue = new OutboundQueue(service, ports.remoteMx);
});

afterAll(async () => {
  await queue?.stop();
  for (const server of servers) server.close();
  await sql`DELETE FROM public.mail_domains WHERE name IN (${local}, ${remote})`;
  await sql`DELETE FROM auth.users WHERE email IN (${`mail-${stamp}@example.com`}, ${`remote-${stamp}@example.com`})`;
  await sql.close();
});

function signedFromSender(subject: string, body: string) {
  const { raw } = buildMessage({
    from: { name: "Grace", address: `grace@${sender}` },
    to: [{ name: "Ada", address: `ada@${local}` }],
    subject,
    text: body,
  });
  return signMessage(raw, {
    domain: sender,
    selector: "mail",
    privateKey: senderKey.privateKey,
  });
}

describe("smtp in", () => {
  it("accepts authenticated mail for a local address, plus tags included", async () => {
    const client = await SmtpTestClient.connect(ports.mx);
    expect((await client.send("EHLO client.test")).text).toContain("STARTTLS");
    await client.startTls();
    expect((await client.send("EHLO client.test")).code).toBe(250);
    expect((await client.send(`MAIL FROM:<grace@${sender}>`)).code).toBe(250);
    expect((await client.send(`RCPT TO:<ada+notes@${local}>`)).code).toBe(250);
    expect((await client.send(`RCPT TO:<nobody@${local}>`)).code).toBe(550);
    expect((await client.send(`RCPT TO:<someone@elsewhere.test>`)).code).toBe(
      554,
    );
    const reply = await client.data(
      signedFromSender(
        "Analytical engine",
        "Hello Ada,\n.leading dot line\nGrace",
      ),
    );
    expect(reply.code).toBe(250);
    await client.send("QUIT");

    const inbox = await store.specialFolder(account.id, "inbox");
    const [message] = await store.index(inbox.id);
    const stored = (await store.message(message!.id))!;
    expect(stored.subject).toBe("Analytical engine");
    expect(stored.text_body).toContain(".leading dot line");
    const raw = new TextDecoder().decode(await store.raw(stored.id));
    expect(raw).toMatch(/^Return-Path: <grace@/);
    expect(raw).toContain(`spf=pass smtp.mailfrom=${sender}`);
    expect(raw).toContain(`dkim=pass header.d=${sender}`);
    expect(raw).toContain("dmarc=pass");
  });

  it("rejects mail that fails a reject DMARC policy", async () => {
    const client = await SmtpTestClient.connect(ports.mx);
    await client.send("EHLO forger.test");
    await client.send(`MAIL FROM:<ceo@spoofed-${stamp}.test>`);
    await client.send(`RCPT TO:<ada@${local}>`);
    const reply = await client.data(
      `From: ceo@spoofed-${stamp}.test\r\nTo: ada@${local}\r\nSubject: Wire money\r\n\r\nNow.\r\n`,
    );
    expect(reply.code).toBe(550);
    expect(reply.text).toContain("DMARC");
  });

  it("refuses AUTH on the MX port and before TLS on submission", async () => {
    const mx = await SmtpTestClient.connect(ports.mx);
    await mx.send("EHLO c");
    expect((await mx.send("AUTH PLAIN AGFkYQBw")).code).toBe(502);
    const submission = await SmtpTestClient.connect(ports.submission);
    expect((await submission.send("EHLO c")).text).not.toContain("AUTH");
    expect((await submission.send("MAIL FROM:<x@y.test>")).code).toBe(530);
  });
});

describe("imap", () => {
  it("lists, selects and fetches", async () => {
    const client = await ImapTestClient.connect(ports.imap);
    expect(
      (await client.command(`LOGIN ada@${local} wrong-password`)).status,
    ).toMatch(/^NO \[AUTHENTICATIONFAILED\]/);
    expect(
      (await client.command(`LOGIN ada@${local} ${password}`)).status,
    ).toMatch(/^OK/);
    const list = await client.command('LIST "" "*"');
    expect(list.lines).toContain(
      '* LIST (\\HasNoChildren \\Sent \\Subscribed) "/" "Sent"',
    );
    const select = await client.command("SELECT INBOX");
    expect(select.lines).toContain("* 1 EXISTS");
    expect(select.status).toContain("[READ-WRITE]");

    const fetch = await client.command(
      "FETCH 1 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (SUBJECT)])",
    );
    const text = fetch.lines.join("\n");
    expect(text).toContain('"Analytical engine"');
    expect(text).toContain('("Grace" NIL "grace" ');
    expect(text).toContain(
      '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE"',
    );
    expect(text).toContain("Subject: Analytical engine");
    expect(text).toContain("FLAGS ()");

    // Reading the body marks it seen.
    const body = await client.command("FETCH 1 BODY[TEXT]");
    expect(body.lines.join("\n")).toContain("FLAGS (\\Seen)");
    expect(body.lines.join("\n")).toContain("Hello Ada,");
    expect((await client.command("SEARCH UNSEEN")).lines).toContain("* SEARCH");
    expect(
      (await client.command('SEARCH FROM "grace" SUBJECT engine')).lines,
    ).toContain("* SEARCH 1");
    expect(
      (await client.command('UID SEARCH TEXT "leading dot"')).lines[0],
    ).toMatch(/^\* SEARCH \d+$/);
    await client.command("LOGOUT");
  });

  it("stores flags, appends, copies, moves and expunges, with UIDPLUS codes", async () => {
    const client = await ImapTestClient.connect(ports.imap);
    await client.command(`LOGIN ada@${local} ${password}`);
    await client.command("SELECT INBOX");
    const store1 = await client.command(
      "STORE 1 +FLAGS (\\Flagged $Important)",
    );
    expect(store1.lines[0]).toMatch(/^\* 1 FETCH \(FLAGS \(.+\)\)$/);
    for (const flag of ["$Important", "\\Flagged", "\\Seen"])
      expect(store1.lines[0]).toContain(flag);

    const append = await client.commandWithLiteral(
      'APPEND INBOX (\\Seen) "11-Nov-2026 10:00:00 +0100"',
      "From: a@b.test\r\nSubject: Appended\r\n\r\nHi\r\n",
    );
    expect(append.status).toMatch(/^OK \[APPENDUID \d+ \d+\]/);
    // Appending to the selected folder announces the new message right away.
    expect(append.lines).toContain("* 2 EXISTS");

    const copy = await client.command("COPY 2 Archive");
    expect(copy.status).toMatch(/^OK \[COPYUID \d+ \d+ 1\]/);
    expect((await client.command("COPY 2 Nowhere")).status).toMatch(
      /^NO \[TRYCREATE\]/,
    );

    const move = await client.command("MOVE 2 Trash");
    expect(move.lines).toContain("* 2 EXPUNGE");
    expect(move.lines.some((l) => l.startsWith("* OK [COPYUID"))).toBe(true);

    await client.command("SELECT Archive");
    await client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
    const expunge = await client.command("EXPUNGE");
    expect(expunge.lines).toContain("* 1 EXPUNGE");
    const status = await client.command(
      "STATUS Trash (MESSAGES UNSEEN UIDNEXT)",
    );
    expect(status.lines[0]).toBe(
      '* STATUS "Trash" (MESSAGES 1 UNSEEN 0 UIDNEXT 2)',
    );

    expect((await client.command("CREATE Projects/2026")).status).toMatch(
      /^OK/,
    );
    const list = await client.command('LIST "" "Projects*"');
    expect(list.lines).toContain(
      '* LIST (\\HasChildren \\Subscribed) "/" "Projects"',
    );
    expect((await client.command("RENAME Projects Work")).status).toMatch(
      /^OK/,
    );
    expect((await client.command('LIST "" "Work/%"')).lines).toContain(
      '* LIST (\\HasNoChildren \\Subscribed) "/" "Work/2026"',
    );
    expect((await client.command("DELETE Trash")).status).toMatch(/^NO/);
  });

  it("tells an idling client about new mail at once", async () => {
    const client = await ImapTestClient.connect(ports.imap);
    await client.command(`LOGIN ada@${local} ${password}`);
    const select = await client.command("SELECT INBOX");
    const exists = Number(
      select.lines.find((l) => l.endsWith(" EXISTS"))!.split(" ")[1],
    );
    client.connection.write("i1 IDLE\r\n");
    expect(await client.connection.readLine()).toBe("+ idling");
    const started = Date.now();
    const smtp = await SmtpTestClient.connect(ports.mx);
    await smtp.send("EHLO client.test");
    await smtp.send(`MAIL FROM:<grace@${sender}>`);
    await smtp.send(`RCPT TO:<ada@${local}>`);
    expect(
      (await smtp.data(signedFromSender("While you idle", "Ping"))).code,
    ).toBe(250);
    expect(await client.connection.readLine()).toBe(`* ${exists + 1} EXISTS`);
    expect(Date.now() - started).toBeLessThan(5000);
    client.connection.write("DONE\r\n");
    expect((await client.readUntil("i1")).status).toBe("OK IDLE terminated");
  });
});

describe("smtp out", () => {
  it("sends through submission and the queue, signed, to another server", async () => {
    const client = await SmtpTestClient.connect(ports.submission);
    await client.send("EHLO laptop");
    await client.startTls();
    expect((await client.send("EHLO laptop")).text).toContain(
      "AUTH PLAIN LOGIN",
    );
    const token = Buffer.from(`\0ada@${local}\0${password}`).toString("base64");
    expect((await client.send(`AUTH PLAIN ${token}`)).code).toBe(235);
    expect((await client.send(`MAIL FROM:<ada@${local}>`)).code).toBe(250);
    expect((await client.send(`RCPT TO:<charles@${remote}>`)).code).toBe(250);
    // Signed in or not, the MX port relays nothing; submission sends anywhere.
    const forged = await client.data(
      `From: someone@else.test\r\nTo: charles@${remote}\r\nSubject: x\r\n\r\nx\r\n`,
    );
    expect(forged.code).toBe(550);
    await client.send(`MAIL FROM:<ada@${local}>`);
    await client.send(`RCPT TO:<charles@${remote}>`);
    const reply = await client.data(
      `From: Ada <ada@${local}>\r\nTo: charles@${remote}\r\nBcc: secret@${remote}\r\nSubject: Note G\r\n\r\nThe first program.\r\n`,
    );
    expect(reply.code).toBe(250);

    await queue.drain();
    const inbox = await store.specialFolder(remoteAccount.id, "inbox");
    const [arrived] = await store.messages(
      (await store.index(inbox.id)).map((m) => m.id),
    );
    expect(arrived!.subject).toBe("Note G");
    const raw = new TextDecoder().decode(await store.raw(arrived!.id));
    expect(raw).toContain(
      `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${local};`,
    );
    expect(raw).not.toContain("Bcc:");
    expect(raw).toMatch(/Message-ID: <[^>]+@/);
  });

  it("composes replies that thread, delivering local recipients directly", async () => {
    const inbox = await store.specialFolder(account.id, "inbox");
    const [first] = await store.messages([
      (await store.index(inbox.id))[0]!.id,
    ]);
    const result = await service.compose(account, {
      to: [{ name: "", address: `ada@${local}` }],
      subject: "",
      text: "Replying to myself",
      replyTo: first!.id,
    });
    expect(result.local).toEqual([`ada@${local}`]);
    expect(result.sent!.subject).toBe("Re: Analytical engine");
    expect(result.sent!.thread_key).toBe(first!.thread_key);
    const thread = await store.thread(account.id, first!.thread_key!);
    expect(thread.length).toBeGreaterThanOrEqual(3);
    expect((await store.message(first!.id))!.flags).toContain("\\Answered");
  });

  it("queues a message once per idempotency key", async () => {
    const input = {
      to: [{ name: "", address: `charles@${remote}` }],
      subject: "Once",
      text: "Only once",
    };
    const first = await service.compose(account, input, {
      idempotencyKey: `test-${stamp}`,
    });
    const second = await service.compose(account, input, {
      idempotencyKey: `test-${stamp}`,
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.sent?.id).toBe(first.sent!.id);
    await queue.drain();
    const sent = (await store.message(first.sent!.id))!;
    const [row] = await sql<
      { delivery: { address: string; status: string }[] }[]
    >`SELECT delivery FROM public.mail_messages WHERE id = ${sent.id}`;
    expect(row!.delivery).toEqual([
      expect.objectContaining({ address: `charles@${remote}`, status: "sent" }),
    ]);
  });
});
