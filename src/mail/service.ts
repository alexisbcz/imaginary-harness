// What happens to mail: incoming messages are authenticated (SPF, DKIM, DMARC), stamped and filed in their
// recipients' Inbox or Junk; outgoing ones are signed with the sender domain's DKIM key, handed straight to local
// recipients, and queued for the others. The SMTP servers, the web API and the agent all send through here.

import { EventEmitter } from "node:events";
import type { SQL } from "bun";
import { checkDmarc, type DmarcResult } from "./auth/dmarc.ts";
import { signMessage, verifyDkim, type DkimResult } from "./auth/dkim.ts";
import type { Resolver } from "./auth/dns.ts";
import { checkSpf, type SpfOutcome } from "./auth/spf.ts";
import type { MailConfig } from "./config.ts";
import {
  canonicalAddress,
  domainOf,
  isAddress,
  parseAddressList,
  type Address,
} from "./mime/address.ts";
import {
  buildMessage,
  formatDate,
  newMessageId,
  replySubject,
  type OutgoingAttachment,
} from "./mime/build.ts";
import { binaryString, bytesOf } from "./mime/encoding.ts";
import { header, parseHeaders } from "./mime/parse.ts";
import type {
  Envelope,
  Reply,
  SmtpHandler,
  SmtpSession,
} from "./smtp/server.ts";
import { MailStore, type Account, type StoredMessage } from "./store.ts";

export type Authentication = {
  spf: SpfOutcome;
  dkim: DkimResult[];
  dmarc: DmarcResult | undefined;
  ip: string;
  helo: string;
  verdict: "inbox" | "junk";
};

export type Compose = {
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  text: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  /** The message this one answers (our row id): threads the reply. */
  replyTo?: string;
};

/** Messages of a folder changed: IMAP sessions in IDLE look again. */
export class MailEvents extends EventEmitter<{ folder: [folderId: string] }> {}

const RESERVED_HEADERS =
  /^(authentication-results|received-spf|arc-[a-z-]+|x-richelieu-[a-z-]+)$/i;

/** Splits a raw message into its header block and body, as text with one character per byte. */
function split(raw: Uint8Array) {
  const text = binaryString(raw);
  const match = /\r?\n\r?\n/.exec(text);
  return match
    ? { head: text.slice(0, match.index), body: text.slice(match.index) }
    : { head: text, body: "\r\n\r\n" };
}

export class MailService {
  readonly events = new MailEvents();
  /** Set by the queue, so a send can start a delivery round at once. */
  onQueued: () => void = () => {};
  private readonly failures = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(
    readonly sql: SQL,
    readonly store: MailStore,
    readonly config: MailConfig,
    readonly resolver: Resolver,
  ) {}

  // Receiving ---------------------------------------------------------------------------------------------

  async authenticate(
    raw: Uint8Array,
    ip: string,
    helo: string,
    mailFrom: string,
  ): Promise<Authentication> {
    const [spf, dkim] = await Promise.all([
      checkSpf({ resolver: this.resolver, ip, sender: mailFrom, helo }),
      verifyDkim(raw, this.resolver),
    ]);
    const from = parseAddressList(
      header(parseHeaders(split(raw).head), "from"),
    )[0];
    const dmarc = from
      ? await checkDmarc({
          resolver: this.resolver,
          fromDomain: domainOf(from.address),
          spf,
          dkim,
        })
      : undefined;
    const dkimPass = dkim.some((d) => d.result === "pass");
    const junk =
      (dmarc?.result === "fail" && dmarc.policy !== "none") ||
      (spf.result === "fail" && !dkimPass) ||
      (!from && spf.result !== "pass");
    return { spf, dkim, dmarc, ip, helo, verdict: junk ? "junk" : "inbox" };
  }

  /** The Authentication-Results header (RFC 8601) for what `authenticate` found. */
  authenticationResults(auth: Authentication, mailFrom: string): string {
    const parts = [
      `spf=${auth.spf.result} smtp.mailfrom=${mailFrom ? domainOf(mailFrom) : auth.helo}`,
    ];
    for (const d of auth.dkim)
      parts.push(
        d.result === "none"
          ? "dkim=none"
          : `dkim=${d.result} header.d=${d.domain} header.s=${d.selector}`,
      );
    if (auth.dmarc)
      parts.push(
        `dmarc=${auth.dmarc.result} (p=${auth.dmarc.policy}) header.from=${auth.dmarc.domain}`,
      );
    return `Authentication-Results: ${this.config.hostname};\r\n\t${parts.join(";\r\n\t")}`;
  }

  /** The headers this server puts on top of a message it accepts. */
  private trace(
    session: SmtpSession,
    envelope: Envelope,
    extra: string[],
  ): string {
    const protocol = `${session.mode === "submission" ? "ESMTPSA" : "ESMTP"}${session.secure && session.mode !== "submission" ? "S" : ""}`;
    const tls = session.tlsProtocol
      ? `\r\n\t(using ${session.tlsProtocol} with cipher ${session.tlsCipher})`
      : "";
    const received = `Received: from ${session.helo || "unknown"} ([${session.remoteAddress}])\r\n\tby ${this.config.hostname} with ${protocol} id ${session.id}${tls};\r\n\t${formatDate(new Date())}`;
    return [`Return-Path: <${envelope.from}>`, ...extra, received].join("\r\n");
  }

  /** Drops headers a sender could forge to look authenticated by us. */
  private scrub(raw: Uint8Array): string {
    const { head, body } = split(raw);
    const kept = head.split(/\r?\n(?![ \t])/).filter((line) => {
      const name = line.slice(0, line.indexOf(":"));
      if (!RESERVED_HEADERS.test(name)) return true;
      // Keep other servers' results (they are labeled with their name), drop any claiming ours.
      return (
        /^authentication-results$/i.test(name) &&
        !line
          .slice(line.indexOf(":") + 1)
          .trim()
          .toLowerCase()
          .startsWith(this.config.hostname)
      );
    });
    return `${kept.join("\r\n")}${body}`;
  }

  /** Files a message for local accounts. Returns the stored copies. */
  async deliverLocal(
    accounts: Account[],
    raw: Uint8Array,
    options: { junk?: boolean; authentication?: Record<string, unknown> } = {},
  ) {
    const stored: StoredMessage[] = [];
    for (const account of accounts) {
      const folder = await this.store.specialFolder(
        account.id,
        options.junk ? "junk" : "inbox",
      );
      const message = await this.store.append({
        account,
        folder,
        raw,
        authentication: options.authentication,
      });
      this.events.emit("folder", folder.id);
      stored.push(message);
    }
    return stored;
  }

  private async inbound(
    session: SmtpSession,
    envelope: Envelope,
    data: Uint8Array,
  ): Promise<Reply> {
    const auth = await this.authenticate(
      data,
      session.remoteAddress,
      session.helo,
      envelope.from,
    );
    if (
      auth.dmarc?.result === "fail" &&
      auth.dmarc.policy === "reject" &&
      this.config.enforceDmarc
    )
      return {
        code: 550,
        message: `5.7.1 Rejected by the DMARC policy of ${auth.dmarc.domain}`,
      };
    if (auth.spf.result === "temperror" || auth.dmarc?.result === "temperror")
      return {
        code: 451,
        message:
          "4.4.3 Temporary DNS failure while checking the sender, try again later",
      };
    const accounts = new Map<string, Account>();
    for (const address of envelope.to) {
      const account = await this.store.recipient(address);
      if (account) accounts.set(account.id, account);
    }
    const stamped = bytesOf(
      `${this.trace(session, envelope, [this.authenticationResults(auth, envelope.from)])}\r\n${this.scrub(data)}`,
    );
    const record = {
      spf: auth.spf.result,
      dkim: auth.dkim.map((d) => ({ result: d.result, domain: d.domain })),
      dmarc: auth.dmarc
        ? {
            result: auth.dmarc.result,
            policy: auth.dmarc.policy,
            domain: auth.dmarc.domain,
          }
        : null,
      ip: auth.ip,
      helo: auth.helo,
      tls: session.tlsProtocol ?? null,
    };
    const stored = await this.deliverLocal([...accounts.values()], stamped, {
      junk: auth.verdict === "junk",
      authentication: record,
    });
    console.log(
      `[smtp ${session.id}] ${envelope.from || "<>"} → ${envelope.to.join(", ")} from ${session.remoteAddress}: spf=${auth.spf.result} dkim=${auth.dkim.map((d) => d.result).join(",")} dmarc=${auth.dmarc?.result ?? "none"} → ${auth.verdict}`,
    );
    return {
      code: 250,
      message: `2.0.0 Delivered as ${stored[0]?.id.slice(0, 8) ?? session.id}`,
    };
  }

  // Sending -----------------------------------------------------------------------------------------------

  /** Whether a user may send as an address: one of their accounts. */
  private async sender(
    userId: string,
    address: string,
  ): Promise<Account | undefined> {
    const account = await this.store.account(canonicalAddress(address));
    return account?.user_id === userId ? account : undefined;
  }

  /**
   * Signs and sends a raw message: local recipients get it now, others are queued. With `saveToSent`, a copy lands
   * in the sender's Sent folder, showing each recipient's delivery. `idempotencyKey` makes a retry a no-op.
   */
  async sendRaw(
    account: Account,
    rawMessage: string,
    recipients: string[],
    options: { saveToSent?: boolean; idempotencyKey?: string } = {},
  ): Promise<{
    sent?: StoredMessage;
    queued: string[];
    local: string[];
    duplicate: boolean;
  }> {
    if (options.idempotencyKey) {
      const [existing] = await this.sql<{ sent_message_id: string | null }[]>`
        SELECT sent_message_id FROM mail.outbound WHERE idempotency_key = ${options.idempotencyKey}`;
      if (existing) {
        const sent = existing.sent_message_id
          ? await this.store.message(existing.sent_message_id)
          : undefined;
        return { sent, queued: [], local: [], duplicate: true };
      }
    }
    const domain = await this.store.domain(domainOf(account.address));
    if (
      !domain?.verified_at &&
      !this.config.hostname.startsWith("localhost") &&
      process.env.NODE_ENV === "production"
    )
      throw new Error(
        `${domainOf(account.address)} is not verified yet: publish its DNS records first`,
      );
    const key = await this.store.signingKey(domainOf(account.address));
    const signed = key
      ? signMessage(rawMessage, {
          domain: domainOf(account.address),
          selector: key.selector,
          privateKey: key.privateKey,
        })
      : rawMessage.replace(/\r?\n/g, "\r\n");
    const raw = bytesOf(signed);
    const unique = [
      ...new Set(recipients.map((r) => r.trim()).filter(isAddress)),
    ];
    const local: string[] = [];
    const localAccounts: Account[] = [];
    const remote: string[] = [];
    for (const address of unique) {
      if (await this.store.isLocalDomain(domainOf(address))) {
        const target = await this.store.recipient(address);
        if (target) {
          localAccounts.push(target);
          local.push(address);
          continue;
        }
      }
      remote.push(address);
    }
    const now = new Date().toISOString();
    const delivery = [
      ...local.map((address) => ({
        address,
        status: "sent",
        detail: "Delivered on this server",
        at: now,
      })),
      ...remote.map((address) => ({
        address,
        status: "queued",
        detail: "Waiting to be sent",
        at: now,
      })),
    ];
    let sent: StoredMessage | undefined;
    if (options.saveToSent) {
      const folder = await this.store.specialFolder(account.id, "sent");
      sent = await this.store.append({
        account,
        folder,
        raw,
        flags: ["\\Seen"],
        delivery,
      });
      this.events.emit("folder", folder.id);
    }
    if (remote.length) {
      const inserted = await this.sql.begin(async (tx) => {
        const [outbound] = await tx<{ id: string }[]>`
          INSERT INTO mail.outbound (account_id, sent_message_id, mail_from, raw, idempotency_key)
          VALUES (${account.id}, ${sent?.id ?? null}, ${account.address}, ${raw}, ${options.idempotencyKey ?? null})
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
        if (!outbound) return false;
        for (const address of remote)
          await tx`INSERT INTO mail.outbound_recipients (outbound_id, address, domain) VALUES (${outbound.id}, ${address}, ${domainOf(address)})`;
        return true;
      });
      if (!inserted) return { sent, queued: [], local: [], duplicate: true };
      this.onQueued();
    } else if (options.idempotencyKey) {
      // Remember the key even when nothing leaves the server.
      await this
        .sql`INSERT INTO mail.outbound (account_id, sent_message_id, mail_from, raw, idempotency_key)
        VALUES (${account.id}, ${sent?.id ?? null}, ${account.address}, ${new Uint8Array()}, ${options.idempotencyKey})
        ON CONFLICT (idempotency_key) DO NOTHING`;
    }
    if (localAccounts.length)
      await this.deliverLocal(localAccounts, raw, {
        authentication: {
          spf: "pass",
          dkim: [{ result: "pass", domain: domainOf(account.address) }],
          dmarc: { result: "pass" },
          internal: true,
        },
      });
    return { sent, queued: remote, local, duplicate: false };
  }

  /** Writes a message (a reply when `replyTo` is set: subject, quotes and threading headers) and sends it. */
  async compose(
    account: Account,
    input: Compose,
    options: { idempotencyKey?: string } = {},
  ) {
    const message = await this.prepare(account, input);
    const recipients = [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ].map((a) => a.address);
    if (recipients.length === 0) throw new Error("Add at least one recipient");
    const result = await this.sendRaw(account, message.raw, recipients, {
      saveToSent: true,
      idempotencyKey: options.idempotencyKey,
    });
    if (input.replyTo) {
      const original = await this.store.message(input.replyTo);
      if (original) {
        const updated = await this.store.setFlags([original.id], "add", [
          "\\Answered",
        ]);
        if (updated.length) this.events.emit("folder", original.folder_id);
      }
    }
    return result;
  }

  /** Files a message in Drafts without sending it, replacing the draft `replaces` when given. */
  async saveDraft(
    account: Account,
    input: Compose,
    replaces?: string,
  ): Promise<StoredMessage> {
    const message = await this.prepare(account, input);
    const folder = await this.store.specialFolder(account.id, "drafts");
    const stored = await this.store.append({
      account,
      folder,
      raw: bytesOf(message.raw),
      flags: ["\\Draft", "\\Seen"],
    });
    if (replaces) {
      const old = await this.store.message(replaces);
      if (old && old.account_id === account.id && old.folder_id === folder.id)
        await this.store.expunge([old.id]);
    }
    this.events.emit("folder", folder.id);
    return stored;
  }

  private async prepare(account: Account, input: Compose) {
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let subject = input.subject;
    if (input.replyTo) {
      const original = await this.store.message(input.replyTo);
      if (!original || original.account_id !== account.id)
        throw new Error("The message to reply to is not in this account");
      inReplyTo = original.message_id ?? undefined;
      references = [
        ...original.references,
        ...(original.message_id ? [original.message_id] : []),
      ].slice(-20);
      subject ||= replySubject(original.subject);
    }
    return buildMessage({
      from: { name: account.display_name, address: account.address },
      to: input.to,
      cc: input.cc,
      subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      inReplyTo,
      references,
      messageId: newMessageId(domainOf(account.address)),
    });
  }

  // The SMTP handler --------------------------------------------------------------------------------------

  /** A short-lived block on addresses that keep failing to sign in (SMTP and IMAP share it). */
  blocked(ip: string) {
    const entry = this.failures.get(ip);
    return entry !== undefined && entry.count >= 10 && entry.until > Date.now();
  }

  noteFailure(ip: string) {
    const entry = this.failures.get(ip);
    const fresh = !entry || entry.until < Date.now();
    this.failures.set(ip, {
      count: fresh ? 1 : entry.count + 1,
      until: Date.now() + 15 * 60_000,
    });
  }

  smtpHandler(): SmtpHandler {
    return {
      connect: (ip, mode) =>
        mode === "submission" && this.blocked(ip)
          ? { code: 421, message: "4.7.0 Too many failed sign-ins, try later" }
          : undefined,
      recipient: async (session, address) => {
        if (session.mode === "submission") return undefined;
        if (!(await this.store.isLocalDomain(domainOf(address))))
          return { code: 554, message: "5.7.1 Relaying denied" };
        if (!(await this.store.recipient(address)))
          return { code: 550, message: "5.1.1 No such mailbox here" };
        return undefined;
      },
      message: async (session, envelope, data) => {
        if (session.mode === "mx") return this.inbound(session, envelope, data);
        return this.submitted(session, envelope, data);
      },
      login: async (username, password, session) => {
        const account = await this.store.authenticate(username, password);
        if (!account) {
          this.noteFailure(session.remoteAddress);
          return undefined;
        }
        return { address: account.address, accountId: account.id };
      },
    };
  }

  /** A message a signed-in client sent: checked, completed and sent. Clients file their own copy in Sent. */
  private async submitted(
    session: SmtpSession,
    envelope: Envelope,
    data: Uint8Array,
  ): Promise<Reply> {
    const account = await this.store.account(session.login!.accountId);
    if (!account) return { code: 451, message: "4.3.0 Account not found" };
    const { head, body } = split(data);
    const headers = parseHeaders(head);
    const from = parseAddressList(header(headers, "from"))[0];
    // Send as yourself: the From address must be one of the user's accounts.
    if (!from)
      return { code: 550, message: "5.6.0 The message has no From header" };
    const sender = await this.sender(account.user_id, from.address);
    if (!sender)
      return {
        code: 550,
        message: `5.7.1 You may not send as ${from.address}`,
      };
    // Bcc never travels; Message-ID and Date are added when missing.
    const lines = head
      .split(/\r?\n(?![ \t])/)
      .filter((line) => !/^bcc:/i.test(line));
    if (!header(headers, "message-id"))
      lines.push(`Message-ID: ${newMessageId(domainOf(sender.address))}`);
    if (!header(headers, "date")) lines.push(`Date: ${formatDate(new Date())}`);
    const raw = `${this.trace(session, envelope, []).replace(/^Return-Path:[^\r\n]*\r\n/, "")}\r\n${lines.join("\r\n")}${body}`;
    const result = await this.sendRaw(sender, raw, envelope.to);
    console.log(
      `[smtp ${session.id}] ${sender.address} sent to ${envelope.to.length} recipient(s): ${result.local.length} local, ${result.queued.length} queued`,
    );
    return {
      code: 250,
      message: `2.0.0 Queued for ${envelope.to.length} recipient(s)`,
    };
  }
}
