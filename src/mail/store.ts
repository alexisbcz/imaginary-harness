// The mail store on Postgres: domains and their DKIM keys, accounts and app passwords, folders, and messages with
// their raw bytes. SMTP, IMAP, the web API, the CLI and the agent's tools all go through it.

import type { SQL } from "bun";
import { generateDkimKey } from "./auth/dkim.ts";
import { canonicalAddress, domainOf, type Address } from "./mime/address.ts";
import { parseMessage, summarize } from "./mime/parse.ts";

export type Domain = {
  id: string;
  user_id: string | null;
  name: string;
  open: boolean;
  dkim_selector: string;
  dkim_record: string;
  verified_at: Date | null;
  checks: Record<string, unknown>;
};

export type Account = {
  id: string;
  user_id: string;
  domain_id: string;
  local_part: string;
  address: string;
  display_name: string;
  assistant: "off" | "summarize" | "draft";
  catch_all: boolean;
};

export type SpecialUse =
  "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash";

export type Folder = {
  id: string;
  account_id: string;
  name: string;
  special_use: SpecialUse | null;
  uid_validity: number;
  uid_next: number;
  modseq: number;
  subscribed: boolean;
};

/** A message as an IMAP session indexes it. */
export type MessageIndex = {
  id: string;
  uid: number;
  flags: string[];
  modseq: number;
  size: number;
  internal_date: Date;
};

export type StoredMessage = MessageIndex & {
  account_id: string;
  folder_id: string;
  message_id: string | null;
  thread_key: string | null;
  subject: string;
  from_name: string;
  from_address: string;
  to_addresses: Address[];
  cc_addresses: Address[];
  sent_at: Date | null;
  snippet: string;
  text_body: string;
  html_body: string | null;
  attachments: unknown[];
  in_reply_to: string | null;
  references: string[];
  summary: string | null;
  category: string | null;
};

const MESSAGE_COLUMNS = `id, account_id, folder_id, uid::int as uid, flags, modseq::int as modseq, size, internal_date,
  message_id, thread_key, subject, from_name, from_address, to_addresses, cc_addresses, sent_at, snippet,
  text_body, html_body, attachments, in_reply_to, "references", summary, category`;

const FOLDER_COLUMNS = `id, account_id, name, special_use, uid_validity::int as uid_validity, uid_next::int as uid_next,
  modseq::int as modseq, subscribed`;

const json = (value: unknown) => JSON.stringify(value);

/** A DKIM selector naming the month it was made: `r202611`, so a rotation gets a new one. */
const selectorFor = (date = new Date()) =>
  `r${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;

/** The first lines of text a list shows, without quoted replies. */
export function snippetOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) => !line.startsWith(">") && !/^On .+ wrote:$/.test(line.trim()),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export class MailStore {
  constructor(readonly sql: SQL) {}

  // Domains -----------------------------------------------------------------------------------------------

  async createDomain(options: {
    name: string;
    userId?: string | null;
    open?: boolean;
  }): Promise<Domain> {
    const name = options.name.trim().toLowerCase().replace(/\.$/, "");
    const key = generateDkimKey();
    const selector = selectorFor();
    return await this.sql.begin(async (tx) => {
      const [domain] = await tx<Domain[]>`
        INSERT INTO public.mail_domains (name, user_id, open, dkim_selector, dkim_record)
        VALUES (${name}, ${options.userId ?? null}, ${options.open ?? options.userId == null}, ${selector}, ${key.dnsValue})
        RETURNING *`;
      await tx`INSERT INTO mail.dkim_keys (domain_id, selector, private_key, dns_record)
        VALUES (${domain!.id}, ${selector}, ${key.privateKey}, ${key.dnsValue})`;
      return domain!;
    });
  }

  /** A new DKIM key under a new selector. The old one keeps verifying mail in flight until removed from DNS. */
  async rotateDkim(domainId: string): Promise<Domain> {
    const key = generateDkimKey();
    let selector = selectorFor();
    return await this.sql.begin(async (tx) => {
      const used =
        await tx`SELECT 1 FROM mail.dkim_keys WHERE domain_id = ${domainId} AND selector = ${selector}`;
      if (used.length)
        selector = `${selector}${Date.now().toString(36).slice(-3)}`;
      await tx`UPDATE mail.dkim_keys SET active = false WHERE domain_id = ${domainId}`;
      await tx`INSERT INTO mail.dkim_keys (domain_id, selector, private_key, dns_record)
        VALUES (${domainId}, ${selector}, ${key.privateKey}, ${key.dnsValue})`;
      const [domain] = await tx<Domain[]>`
        UPDATE public.mail_domains SET dkim_selector = ${selector}, dkim_record = ${key.dnsValue}
        WHERE id = ${domainId} RETURNING *`;
      return domain!;
    });
  }

  async domain(nameOrId: string): Promise<Domain | undefined> {
    const value = nameOrId.toLowerCase();
    const [domain] = /^[0-9a-f-]{36}$/.test(value)
      ? await this.sql<
          Domain[]
        >`SELECT * FROM public.mail_domains WHERE id = ${value}`
      : await this.sql<
          Domain[]
        >`SELECT * FROM public.mail_domains WHERE name = ${value}`;
    return domain;
  }

  domains(userId?: string): Promise<Domain[]> {
    return userId
      ? this.sql<
          Domain[]
        >`SELECT * FROM public.mail_domains WHERE user_id = ${userId} OR open ORDER BY name`
      : this.sql<Domain[]>`SELECT * FROM public.mail_domains ORDER BY name`;
  }

  async deleteDomain(id: string) {
    await this.sql`DELETE FROM public.mail_domains WHERE id = ${id}`;
  }

  async saveChecks(
    domainId: string,
    checks: Record<string, unknown>,
    verified: boolean,
  ) {
    await this.sql`
      UPDATE public.mail_domains SET checks = ${json(checks)}::text::jsonb, checked_at = now(),
        verified_at = CASE WHEN ${verified} THEN COALESCE(verified_at, now()) ELSE NULL END
      WHERE id = ${domainId}`;
  }

  /** The key that signs the domain's mail. */
  async signingKey(
    domainName: string,
  ): Promise<{ selector: string; privateKey: string } | undefined> {
    const [key] = await this.sql<{ selector: string; private_key: string }[]>`
      SELECT k.selector, k.private_key FROM mail.dkim_keys k JOIN public.mail_domains d ON d.id = k.domain_id
      WHERE d.name = ${domainName.toLowerCase()} AND k.active ORDER BY k.created_at DESC LIMIT 1`;
    return key && { selector: key.selector, privateKey: key.private_key };
  }

  // Accounts ----------------------------------------------------------------------------------------------

  async createAccount(options: {
    userId: string;
    domain: string;
    localPart: string;
    displayName?: string;
  }): Promise<Account> {
    const domain = await this.domain(options.domain);
    if (!domain) throw new Error(`Unknown domain ${options.domain}`);
    if (
      domain.user_id !== null &&
      domain.user_id !== options.userId &&
      !domain.open
    )
      throw new Error(`${domain.name} belongs to someone else`);
    const localPart = options.localPart.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(localPart))
      throw new Error(
        "Use letters, digits, dots, dashes and underscores for the address",
      );
    if (
      ["postmaster", "abuse", "mailer-daemon"].includes(localPart) &&
      domain.user_id !== options.userId
    )
      throw new Error(`${localPart}@ is kept for the domain's owner`);
    const [account] = await this.sql<Account[]>`
      INSERT INTO public.mail_accounts (user_id, domain_id, local_part, address, display_name)
      VALUES (${options.userId}, ${domain.id}, ${localPart}, ${`${localPart}@${domain.name}`}, ${options.displayName ?? ""})
      ON CONFLICT (address) DO NOTHING
      RETURNING *`;
    if (!account) throw new Error(`${localPart}@${domain.name} is taken`);
    return account;
  }

  async account(idOrAddress: string): Promise<Account | undefined> {
    const value = idOrAddress.toLowerCase();
    const [account] = value.includes("@")
      ? await this.sql<
          Account[]
        >`SELECT * FROM public.mail_accounts WHERE address = ${value}`
      : await this.sql<
          Account[]
        >`SELECT * FROM public.mail_accounts WHERE id = ${value}`;
    return account;
  }

  accounts(userId?: string): Promise<Account[]> {
    return userId
      ? this.sql<
          Account[]
        >`SELECT * FROM public.mail_accounts WHERE user_id = ${userId} ORDER BY address`
      : this.sql<
          Account[]
        >`SELECT * FROM public.mail_accounts ORDER BY address`;
  }

  /**
   * The account that receives mail for an address: the address itself, without its `+tag`, then the domain's
   * catch-all. `postmaster@` goes to the domain owner's first account when it has none of its own (RFC 5321).
   */
  async recipient(address: string): Promise<Account | undefined> {
    const canonical = canonicalAddress(address);
    const direct = await this.account(canonical);
    if (direct) return direct;
    const domain = domainOf(canonical);
    const [catchAll] = await this.sql<Account[]>`
      SELECT a.* FROM public.mail_accounts a JOIN public.mail_domains d ON d.id = a.domain_id
      WHERE d.name = ${domain} AND a.catch_all ORDER BY a.created_at LIMIT 1`;
    if (catchAll) return catchAll;
    if (canonical.startsWith("postmaster@") || canonical.startsWith("abuse@")) {
      const [owner] = await this.sql<Account[]>`
        SELECT a.* FROM public.mail_accounts a JOIN public.mail_domains d ON d.id = a.domain_id
        WHERE d.name = ${domain} AND (a.user_id = d.user_id OR d.user_id IS NULL) ORDER BY a.created_at LIMIT 1`;
      return owner;
    }
    return undefined;
  }

  /** Whether the server receives mail for the domain at all. */
  async isLocalDomain(domain: string): Promise<boolean> {
    const rows = await this
      .sql`SELECT 1 FROM public.mail_domains WHERE name = ${domain.toLowerCase()}`;
    return rows.length > 0;
  }

  // App passwords -----------------------------------------------------------------------------------------

  /** A new password for a mail client, shown once: four groups of four letters, easy to type on a phone. */
  async createAppPassword(
    userId: string,
    name: string,
  ): Promise<{ id: string; password: string }> {
    const alphabet = "abcdefghjkmnpqrstuvwxyz";
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const letters = [...bytes]
      .map((b) => alphabet[b % alphabet.length])
      .join("");
    const password = letters.match(/.{4}/g)!.join("-");
    const hash = await Bun.password.hash(password);
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO public.mail_app_passwords (user_id, name, hash) VALUES (${userId}, ${name.trim().slice(0, 80) || "Mail client"}, ${hash})
      RETURNING id`;
    return { id: row!.id, password };
  }

  /** The account a mail client signs in to: its address and one of its owner's app passwords. */
  async authenticate(
    address: string,
    password: string,
  ): Promise<Account | undefined> {
    const account = await this.account(address.trim());
    if (!account) {
      // Spend the same time as a real check, so timing does not tell which addresses exist.
      await Bun.password
        .verify(
          password,
          "$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHRzYWx0$ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZQ",
        )
        .catch(() => false);
      return undefined;
    }
    const candidates = await this.sql<{ id: string; hash: string }[]>`
      SELECT id, hash FROM public.mail_app_passwords WHERE user_id = ${account.user_id}`;
    const normalized = password.trim().toLowerCase();
    for (const candidate of candidates) {
      if (await Bun.password.verify(normalized, candidate.hash)) {
        await this
          .sql`UPDATE public.mail_app_passwords SET last_used_at = now() WHERE id = ${candidate.id}`;
        return account;
      }
    }
    return undefined;
  }

  // Folders -----------------------------------------------------------------------------------------------

  folders(accountId: string): Promise<Folder[]> {
    return this.sql.unsafe(
      `SELECT ${FOLDER_COLUMNS} FROM public.mail_folders WHERE account_id = $1
       ORDER BY CASE special_use WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2 WHEN 'archive' THEN 3
         WHEN 'junk' THEN 4 WHEN 'trash' THEN 5 ELSE 6 END, name`,
      [accountId],
    ) as Promise<Folder[]>;
  }

  async folder(accountId: string, name: string): Promise<Folder | undefined> {
    // INBOX is case-insensitive in IMAP; other names are exact.
    const [folder] = (await this.sql.unsafe(
      `SELECT ${FOLDER_COLUMNS} FROM public.mail_folders
       WHERE account_id = $1 AND (name = $2 OR (upper($2) = 'INBOX' AND special_use = 'inbox'))`,
      [accountId, name],
    )) as Folder[];
    return folder;
  }

  async folderById(id: string): Promise<Folder | undefined> {
    const [folder] = (await this.sql.unsafe(
      `SELECT ${FOLDER_COLUMNS} FROM public.mail_folders WHERE id = $1`,
      [id],
    )) as Folder[];
    return folder;
  }

  async specialFolder(accountId: string, use: SpecialUse): Promise<Folder> {
    const [folder] = (await this.sql.unsafe(
      `SELECT ${FOLDER_COLUMNS} FROM public.mail_folders WHERE account_id = $1 AND special_use = $2`,
      [accountId, use],
    )) as Folder[];
    if (!folder) throw new Error(`The account has no ${use} folder`);
    return folder;
  }

  async createFolder(account: Account, name: string): Promise<Folder> {
    const [folder] = (await this.sql.unsafe(
      `INSERT INTO public.mail_folders (account_id, user_id, name) VALUES ($1, $2, $3) RETURNING ${FOLDER_COLUMNS}`,
      [account.id, account.user_id, name],
    )) as Folder[];
    return folder!;
  }

  /** Renames a folder and its children (`Projects` and `Projects/2026`). */
  async renameFolder(accountId: string, from: string, to: string) {
    await this.sql.begin(async (tx) => {
      await tx`UPDATE public.mail_folders SET name = ${to} || substr(name, ${from.length + 1})
        WHERE account_id = ${accountId} AND (name = ${from} OR name LIKE ${`${from.replace(/[\\%_]/g, "\\$&")}/%`})`;
    });
  }

  async deleteFolder(folderId: string) {
    await this
      .sql`DELETE FROM public.mail_folders WHERE id = ${folderId} AND special_use IS NULL`;
  }

  async subscribe(folderId: string, subscribed: boolean) {
    await this
      .sql`UPDATE public.mail_folders SET subscribed = ${subscribed} WHERE id = ${folderId}`;
  }

  async status(folderId: string) {
    const [row] = await this.sql<
      { messages: number; unseen: number; size: number }[]
    >`
      SELECT count(*)::int AS messages,
        count(*) FILTER (WHERE NOT ('\\Seen' = ANY(flags)))::int AS unseen,
        COALESCE(sum(size), 0)::bigint AS size
      FROM public.mail_messages WHERE folder_id = ${folderId}`;
    return {
      messages: row!.messages,
      unseen: row!.unseen,
      size: Number(row!.size),
    };
  }

  // Messages ----------------------------------------------------------------------------------------------

  /** Where a message belongs among the account's conversations. */
  private async threadKey(
    accountId: string,
    messageId: string | undefined,
    references: string[],
  ): Promise<string> {
    if (references.length) {
      const [found] = await this.sql<{ thread_key: string }[]>`
        SELECT thread_key FROM public.mail_messages
        WHERE account_id = ${accountId} AND message_id = ANY(${this.sql.array(references, "text")}) AND thread_key IS NOT NULL
        LIMIT 1`;
      if (found) return found.thread_key;
      return references[0]!;
    }
    return messageId ?? `<${crypto.randomUUID()}@local>`;
  }

  /**
   * Files a message: parses it, gives it the folder's next UID, and keeps its raw bytes. The agent reads new inbox
   * mail when the account asks it to.
   */
  async append(options: {
    account: Account;
    folder: Folder;
    raw: Uint8Array;
    flags?: string[];
    internalDate?: Date;
    authentication?: Record<string, unknown>;
    delivery?: unknown[];
  }): Promise<StoredMessage> {
    const { account, folder, raw } = options;
    const summary = summarize(parseMessage(raw));
    const references = [
      ...summary.references,
      ...(summary.inReplyTo && !summary.references.includes(summary.inReplyTo)
        ? [summary.inReplyTo]
        : []),
    ];
    const threadKey = await this.threadKey(
      account.id,
      summary.messageId,
      references,
    );
    const assistant =
      folder.special_use === "inbox" && account.assistant !== "off"
        ? "pending"
        : null;
    const flags = [...new Set(options.flags ?? [])].sort();
    return await this.sql.begin(async (tx) => {
      const [{ uid }] =
        (await tx`SELECT mail.allocate_uids(${folder.id}, 1)::int AS uid`) as [
          { uid: number },
        ];
      const [message] = (await tx.unsafe(
        `INSERT INTO public.mail_messages (account_id, user_id, folder_id, uid, flags, internal_date, size, message_id,
           in_reply_to, "references", thread_key, subject, from_name, from_address, to_addresses, cc_addresses, sent_at,
           snippet, text_body, html_body, attachments, authentication, delivery, assistant_status)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10::text[], $11, $12, $13, $14, $15::text::jsonb, $16::text::jsonb,
           $17, $18, $19, $20, $21::text::jsonb, $22::text::jsonb, $23::text::jsonb, $24)
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          account.id,
          account.user_id,
          folder.id,
          uid,
          `{${flags.map((f) => `"${f.replace(/["\\]/g, "\\$&")}"`).join(",")}}`,
          options.internalDate ?? new Date(),
          raw.length,
          summary.messageId ?? null,
          summary.inReplyTo ?? null,
          `{${references.map((r) => `"${r.replace(/["\\]/g, "\\$&")}"`).join(",")}}`,
          threadKey,
          summary.subject.slice(0, 2000),
          summary.from?.name ?? "",
          summary.from?.address.toLowerCase() ?? "",
          json(summary.to),
          json(summary.cc),
          summary.date ?? null,
          snippetOf(summary.text),
          summary.text.slice(0, 1_000_000),
          summary.html?.slice(0, 2_000_000) ?? null,
          json(summary.attachments),
          options.authentication ? json(options.authentication) : null,
          options.delivery ? json(options.delivery) : null,
          assistant,
        ],
      )) as StoredMessage[];
      await tx`INSERT INTO mail.blobs (message_id, raw) VALUES (${message!.id}, ${raw})`;
      return message!;
    });
  }

  /** The folder's messages in UID order: what an IMAP session numbers. */
  index(folderId: string): Promise<MessageIndex[]> {
    return this.sql<MessageIndex[]>`
      SELECT id, uid::int AS uid, flags, modseq::int AS modseq, size, internal_date
      FROM public.mail_messages WHERE folder_id = ${folderId} ORDER BY uid`;
  }

  async messages(ids: string[]): Promise<StoredMessage[]> {
    if (ids.length === 0) return [];
    return (await this.sql.unsafe(
      `SELECT ${MESSAGE_COLUMNS} FROM public.mail_messages WHERE id = ANY($1::uuid[])`,
      [`{${ids.join(",")}}`],
    )) as StoredMessage[];
  }

  async message(id: string): Promise<StoredMessage | undefined> {
    return (await this.messages([id]))[0];
  }

  async raw(id: string): Promise<Uint8Array | undefined> {
    const [row] = await this.sql<
      { raw: Uint8Array }[]
    >`SELECT raw FROM mail.blobs WHERE message_id = ${id}`;
    return row ? new Uint8Array(row.raw) : undefined;
  }

  async raws(ids: string[]): Promise<Map<string, Uint8Array>> {
    if (ids.length === 0) return new Map();
    const rows = await this.sql<{ message_id: string; raw: Uint8Array }[]>`
      SELECT message_id, raw FROM mail.blobs WHERE message_id = ANY(${this.sql.array(ids, "uuid")})`;
    return new Map(
      rows.map((row) => [row.message_id, new Uint8Array(row.raw)]),
    );
  }

  /** Changes flags; returns each message's new flags and modification sequence. */
  async setFlags(
    ids: string[],
    mode: "add" | "remove" | "replace",
    flags: string[],
  ): Promise<MessageIndex[]> {
    if (ids.length === 0) return [];
    const list = this.sql.array(flags, "text");
    const idList = this.sql.array(ids, "uuid");
    const rows =
      mode === "replace"
        ? await this.sql<
            MessageIndex[]
          >`UPDATE public.mail_messages SET flags = (SELECT COALESCE(array_agg(DISTINCT f ORDER BY f), '{}') FROM unnest(${list}::text[]) f)
            WHERE id = ANY(${idList}) RETURNING id, uid::int AS uid, flags, modseq::int AS modseq, size, internal_date`
        : mode === "add"
          ? await this.sql<
              MessageIndex[]
            >`UPDATE public.mail_messages SET flags = (SELECT array_agg(DISTINCT f ORDER BY f) FROM unnest(flags || ${list}::text[]) f)
            WHERE id = ANY(${idList}) AND NOT (flags @> ${list}::text[]) RETURNING id, uid::int AS uid, flags, modseq::int AS modseq, size, internal_date`
          : await this.sql<
              MessageIndex[]
            >`UPDATE public.mail_messages SET flags = (SELECT COALESCE(array_agg(f ORDER BY f), '{}') FROM unnest(flags) f WHERE f <> ALL(${list}::text[]))
            WHERE id = ANY(${idList}) AND flags && ${list}::text[] RETURNING id, uid::int AS uid, flags, modseq::int AS modseq, size, internal_date`;
    return rows;
  }

  /** Moves messages to another folder of the account; returns their new UIDs, in the order given. */
  async move(
    ids: string[],
    target: Folder,
  ): Promise<{ id: string; uid: number }[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql<{ id: string; uid: number }[]>`
      SELECT id, uid::int AS uid FROM mail.move_messages(${this.sql.array(ids, "uuid")}, ${target.id})`;
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  /** Copies messages into a folder, raw bytes and flags included; returns the copies' UIDs. */
  async copy(
    ids: string[],
    account: Account,
    target: Folder,
  ): Promise<{ id: string; uid: number }[]> {
    const raws = await this.raws(ids);
    const sources = new Map((await this.messages(ids)).map((m) => [m.id, m]));
    const copies: { id: string; uid: number }[] = [];
    for (const id of ids) {
      const raw = raws.get(id);
      const source = sources.get(id);
      if (!raw || !source) continue;
      const copy = await this.append({
        account,
        folder: target,
        raw,
        flags: source.flags,
        internalDate: source.internal_date,
      });
      copies.push({ id: copy.id, uid: copy.uid });
    }
    return copies;
  }

  async expunge(ids: string[]) {
    if (ids.length === 0) return;
    await this
      .sql`DELETE FROM public.mail_messages WHERE id = ANY(${this.sql.array(ids, "uuid")})`;
  }

  /** The messages of a folder whose text matches, for IMAP's TEXT and BODY search keys and the agent's search. */
  async searchText(folderId: string, query: string): Promise<Set<string>> {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM public.mail_messages WHERE folder_id = ${folderId}
        AND (subject ILIKE ${pattern} OR text_body ILIKE ${pattern} OR from_address ILIKE ${pattern} OR from_name ILIKE ${pattern})`;
    return new Set(rows.map((r) => r.id));
  }

  /** The thread of a message, oldest first, across the account's folders (Trash and Junk left out). */
  thread(accountId: string, threadKey: string): Promise<StoredMessage[]> {
    return this.sql.unsafe(
      `SELECT ${MESSAGE_COLUMNS} FROM public.mail_messages
       WHERE account_id = $1 AND thread_key = $2 AND folder_id NOT IN (
         SELECT id FROM public.mail_folders WHERE account_id = $1 AND special_use IN ('trash', 'junk'))
       ORDER BY COALESCE(sent_at, internal_date)`,
      [accountId, threadKey],
    ) as Promise<StoredMessage[]>;
  }

  /** Writes the agent's reading of a message. */
  async annotate(
    id: string,
    values: { summary?: string; category?: string; status?: string },
  ) {
    await this.sql`UPDATE public.mail_messages SET
      summary = COALESCE(${values.summary ?? null}, summary),
      category = COALESCE(${values.category ?? null}, category),
      assistant_status = COALESCE(${values.status ?? null}, assistant_status)
      WHERE id = ${id}`;
  }
}
