// The outbound queue: claims due recipients from Postgres (several workers can share it, `FOR UPDATE SKIP
// LOCKED`), delivers them domain by domain, retries with backoff for five days, and bounces what never goes
// through back to the sender. Each recipient's progress shows on the Sent copy of the message.

import { hostname as osHostname } from "node:os";
import { domainOf } from "./mime/address.ts";
import { buildMessage, formatDate } from "./mime/build.ts";
import { bytesOf, decodeWords } from "./mime/encoding.ts";
import {
  deliverToDomain,
  parseRelay,
  type RecipientOutcome,
} from "./smtp/client.ts";
import type { MailService } from "./service.ts";

/** Minutes before each retry: quickly at first, then every few hours. */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480, 720];
const TICK_MS = 30_000;
const BATCH = 50;

type Claimed = {
  outbound_id: string;
  address: string;
  domain: string;
  attempts: number;
};

export class OutboundQueue {
  private timer: Timer | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private readonly relay;

  constructor(
    private readonly service: MailService,
    /** For tests: deliver to this port instead of 25. */
    private readonly port?: number,
  ) {
    this.relay = service.config.relay
      ? parseRelay(service.config.relay)
      : undefined;
    service.onQueued = () => this.wake();
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), TICK_MS);
    this.wake();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  /** Runs a round now, or right after the current one. */
  wake() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.round()
      .catch((error) => console.error("[queue]", error))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  /** Delivers everything due, batch after batch. Resolves when nothing is due. */
  async drain() {
    this.wake();
    while (this.running) await this.running;
  }

  private async claim(): Promise<Claimed[]> {
    return this.service.sql<Claimed[]>`
      UPDATE mail.outbound_recipients r SET locked_until = now() + interval '10 minutes', attempts = r.attempts + 1
      FROM (
        SELECT outbound_id, address FROM mail.outbound_recipients
        WHERE status = 'queued' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
      ) due
      WHERE r.outbound_id = due.outbound_id AND r.address = due.address
      RETURNING r.outbound_id, r.address, r.domain, r.attempts`;
  }

  private async round() {
    for (;;) {
      const claimed = await this.claim();
      if (claimed.length === 0) return;
      const groups = new Map<string, Claimed[]>();
      for (const row of claimed) {
        const key = `${row.outbound_id} ${row.domain}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      // Domains in parallel, a few at a time.
      const entries = [...groups.values()];
      for (let i = 0; i < entries.length; i += 8)
        await Promise.all(
          entries.slice(i, i + 8).map((group) => this.deliver(group)),
        );
      if (this.stopped) return;
    }
  }

  private async deliver(group: Claimed[]) {
    const { sql, resolver, config } = this.service;
    const first = group[0]!;
    const [outbound] = await sql<
      {
        mail_from: string;
        raw: Uint8Array;
        expires_at: Date;
        sent_message_id: string | null;
        account_id: string | null;
      }[]
    >`
      SELECT mail_from, raw, expires_at, sent_message_id, account_id FROM mail.outbound WHERE id = ${first.outbound_id}`;
    if (!outbound) return;
    let outcomes: RecipientOutcome[];
    try {
      outcomes = await deliverToDomain({
        resolver,
        domain: first.domain,
        helo: config.hostname === "localhost" ? osHostname() : config.hostname,
        from: outbound.mail_from,
        recipients: group.map((r) => r.address),
        data: new Uint8Array(outbound.raw),
        relay: this.relay,
        port: this.port,
      });
    } catch (error) {
      outcomes = group.map((r) => ({
        address: r.address,
        status: "deferred",
        detail: String(error),
      }));
    }
    const bounced: RecipientOutcome[] = [];
    for (const outcome of outcomes) {
      const row = group.find((r) => r.address === outcome.address)!;
      const expired = outbound.expires_at.getTime() < Date.now();
      if (outcome.status === "sent") {
        await sql`UPDATE mail.outbound_recipients SET status = 'sent', sent_at = now(), last_error = ${outcome.detail}, locked_until = NULL
          WHERE outbound_id = ${row.outbound_id} AND address = ${row.address}`;
      } else if (outcome.status === "failed" || expired) {
        await sql`UPDATE mail.outbound_recipients SET status = 'failed', last_error = ${outcome.detail}, locked_until = NULL
          WHERE outbound_id = ${row.outbound_id} AND address = ${row.address}`;
        bounced.push(outcome);
      } else {
        const minutes =
          BACKOFF_MINUTES[
            Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)
          ]!;
        await sql`UPDATE mail.outbound_recipients SET last_error = ${outcome.detail}, locked_until = NULL,
          next_attempt_at = now() + make_interval(mins => ${minutes})
          WHERE outbound_id = ${row.outbound_id} AND address = ${row.address}`;
      }
      console.log(
        `[queue] ${outbound.mail_from} → ${outcome.address}: ${outcome.status} (${outcome.detail.slice(0, 160)})`,
      );
    }
    await this.showDelivery(first.outbound_id, outbound.sent_message_id);
    if (bounced.length && outbound.account_id)
      await this.bounce(
        outbound.account_id,
        outbound.mail_from,
        new Uint8Array(outbound.raw),
        bounced,
      );
  }

  /** Copies each recipient's state onto the Sent message, which the web app shows. */
  private async showDelivery(outboundId: string, sentMessageId: string | null) {
    if (!sentMessageId) return;
    const { sql } = this.service;
    const rows = await sql<
      {
        address: string;
        status: string;
        last_error: string | null;
        sent_at: Date | null;
        next_attempt_at: Date;
      }[]
    >`
      SELECT address, status, last_error, sent_at, next_attempt_at FROM mail.outbound_recipients WHERE outbound_id = ${outboundId}`;
    const remote = rows.map((r) => ({
      address: r.address,
      status:
        r.status === "queued"
          ? r.last_error
            ? "retrying"
            : "queued"
          : r.status,
      detail: r.last_error ?? "Waiting to be sent",
      at: (r.sent_at ?? new Date()).toISOString(),
      next: r.status === "queued" ? r.next_attempt_at.toISOString() : undefined,
    }));
    const addresses = new Set(remote.map((r) => r.address));
    await sql`UPDATE public.mail_messages SET delivery = (
        SELECT COALESCE(jsonb_agg(d), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(delivery, '[]'::jsonb)) d
        WHERE NOT (d->>'address' = ANY(${sql.array([...addresses], "text")}))
      ) || ${JSON.stringify(remote)}::text::jsonb
      WHERE id = ${sentMessageId}`;
  }

  /** A delivery status notification (RFC 3464) in the sender's inbox, listing what failed and why. */
  private async bounce(
    accountId: string,
    sender: string,
    original: Uint8Array,
    failed: RecipientOutcome[],
  ) {
    const { store, config } = this.service;
    const account = await store.account(accountId);
    if (!account) return;
    const head =
      Buffer.from(original)
        .toString("latin1")
        .split(/\r?\n\r?\n/)[0] ?? "";
    // The subject as the sender wrote it: unfolded, encoded words decoded.
    const subject = decodeWords(
      head
        .match(/^Subject:[ \t]*((?:.*)(?:\r?\n[ \t].*)*)/im)?.[1]
        ?.replace(/\r?\n[ \t]/g, " ") ?? "(no subject)",
    );
    const text = [
      `Your message "${subject}" could not be delivered to ${failed.length === 1 ? "this recipient" : "these recipients"}:`,
      "",
      ...failed.map((f) => `  ${f.address}\n    ${f.detail}`),
      "",
      "No more attempts will be made.",
    ].join("\n");
    const report = [
      `Reporting-MTA: dns; ${config.hostname}`,
      `Arrival-Date: ${formatDate(new Date())}`,
      "",
      ...failed.flatMap((f) => [
        `Final-Recipient: rfc822; ${f.address}`,
        "Action: failed",
        `Status: ${f.detail.match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0] ?? "5.0.0"}`,
        `Diagnostic-Code: smtp; ${f.detail.replace(/\r?\n/g, " ")}`,
        "",
      ]),
    ].join("\r\n");
    const { raw } = buildMessage({
      from: {
        name: "Mail Delivery System",
        address: `mailer-daemon@${config.hostname}`,
      },
      to: [{ name: "", address: sender }],
      subject: `Undelivered: ${subject}`,
      text,
      attachments: [
        {
          filename: "status.txt",
          contentType: "message/delivery-status",
          content: bytesOf(report),
        },
        {
          filename: "headers.txt",
          contentType: "text/rfc822-headers",
          content: bytesOf(head),
        },
      ],
      headers: { "Auto-Submitted": "auto-replied" },
    });
    await this.service.deliverLocal([account], bytesOf(raw), {
      authentication: { internal: true, bounce: true },
    });
    console.log(
      `[queue] bounced ${failed.map((f) => f.address).join(", ")} back to ${sender} (${domainOf(sender)})`,
    );
  }
}
