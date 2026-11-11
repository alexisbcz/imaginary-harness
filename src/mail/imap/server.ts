// The IMAP server (IMAP4rev1, RFC 3501, with LITERAL+, SASL-IR, ID, IDLE, NAMESPACE, UIDPLUS, MOVE, UNSELECT,
// SPECIAL-USE and CHILDREN): what Apple Mail, Thunderbird, Outlook and phones speak to read the mail Postgres
// keeps. Each session keeps its own numbering of the selected folder and catches up with changes made elsewhere
// (SMTP deliveries, the web app, other clients) at the moments IMAP allows.

import {
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import { createServer as createTlsServer, type SecureContext } from "node:tls";
import { parseMessage } from "../mime/parse.ts";
import {
  Connection,
  ConnectionClosed,
  LineTooLong,
} from "../net/connection.ts";
import type { MailService } from "../service.ts";
import type { Account, Folder, MessageIndex, SpecialUse } from "../store.ts";
import {
  bodyStructure,
  envelope,
  formatInternalDate,
  istring,
  list,
  parseFetchItems,
  parseImapDate,
  section,
  type FetchItem,
  type Piece,
} from "./fetch.ts";
import {
  decodeMailboxName,
  encodeMailboxName,
  formatSequenceSet,
  literalAtEnd,
  mailboxMatcher,
  ParseError,
  parseSequenceSet,
  text,
  tokenize,
  type Segment,
  type Token,
} from "./parser.ts";
import { search } from "./search.ts";

const SYSTEM_FLAGS = [
  "\\Answered",
  "\\Flagged",
  "\\Deleted",
  "\\Seen",
  "\\Draft",
];
const SPECIAL_ATTRIBUTES: Record<SpecialUse, string | undefined> = {
  inbox: undefined,
  sent: "\\Sent",
  drafts: "\\Drafts",
  archive: "\\Archive",
  junk: "\\Junk",
  trash: "\\Trash",
};
const DELIMITER = "/";
const FETCH_BATCH = 50;
const IDLE_POLL_MS = 10_000;

class No extends Error {}

type Selected = { folder: Folder; readOnly: boolean; messages: MessageIndex[] };

export type ImapOptions = {
  hostname: string;
  service: MailService;
  maxSize: number;
  tls: () => SecureContext | undefined;
};

const isLoopback = (ip: string) =>
  ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");

class ImapSession {
  private account: Account | undefined;
  private selected: Selected | undefined;
  private authFailures = 0;

  constructor(
    private readonly connection: Connection,
    private readonly options: ImapOptions,
  ) {}

  private get store() {
    return this.options.service.store;
  }

  // Output ------------------------------------------------------------------------------------------------

  private async send(pieces: Piece[]) {
    const chunks: (string | Uint8Array)[] = [];
    for (const piece of pieces) {
      if (typeof piece === "string") chunks.push(piece);
      else chunks.push(`{${piece.literal.length}}\r\n`, piece.literal);
    }
    chunks.push("\r\n");
    const buffer = Buffer.concat(
      chunks.map((c) =>
        typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c),
      ),
    );
    await this.connection.writeAsync(buffer);
  }

  private line(text: string) {
    this.connection.write(`${text}\r\n`);
  }

  private capabilities() {
    const tlsAvailable = this.options.tls() !== undefined;
    const caps = [
      "IMAP4rev1",
      "LITERAL+",
      "SASL-IR",
      "ID",
      "ENABLE",
      "IDLE",
      "NAMESPACE",
      "UIDPLUS",
      "MOVE",
      "UNSELECT",
      "SPECIAL-USE",
      "CHILDREN",
    ];
    if (!this.account) {
      if (!this.connection.secure && tlsAvailable) caps.push("STARTTLS");
      if (this.loginAllowed()) caps.push("AUTH=PLAIN");
      else caps.push("LOGINDISABLED");
    }
    return caps.join(" ");
  }

  /** Passwords travel encrypted only; plain connections from the machine itself are allowed for development. */
  private loginAllowed() {
    return (
      this.connection.secure ||
      isLoopback(this.connection.remoteAddress) ||
      this.options.tls() === undefined
    );
  }

  // Input -------------------------------------------------------------------------------------------------

  private async readCommand(): Promise<Segment[]> {
    const segments: Segment[] = [];
    let line = await this.connection.readLine(65_536);
    for (;;) {
      const literal = literalAtEnd(line);
      if (!literal) {
        segments.push(line);
        return segments;
      }
      segments.push(line.slice(0, line.lastIndexOf("{")));
      if (literal.size > this.options.maxSize) {
        if (literal.nonSync) await this.connection.readBytes(literal.size);
        throw new No(
          `[TOOBIG] Literals are limited to ${this.options.maxSize} bytes`,
        );
      }
      if (!literal.nonSync) this.line("+ Ready for literal data");
      segments.push(await this.connection.readBytes(literal.size));
      line = await this.connection.readLine(65_536);
    }
  }

  async run() {
    this.line(
      `* OK [CAPABILITY ${this.capabilities()}] ${this.options.hostname} IMAP4rev1 Richelieu ready`,
    );
    while (!this.connection.isClosed) {
      let tag = "*";
      try {
        const segments = await this.readCommand();
        const tokens = tokenize(segments);
        tag = tokens[0]?.type === "atom" ? tokens[0].value : "*";
        if (tag === "*" || tag === "+" || !tokens[1]) {
          this.line(`${tag === "+" ? "*" : tag} BAD Missing command`);
          continue;
        }
        let name = text(tokens[1]).toUpperCase();
        let args = tokens.slice(2);
        let uid = false;
        if (name === "UID") {
          uid = true;
          name = text(args[0]).toUpperCase();
          args = args.slice(1);
        }
        const ok = await this.command(tag, name, args, uid);
        if (ok !== undefined) this.line(`${tag} OK ${ok}`);
      } catch (error) {
        if (error instanceof ConnectionClosed) break;
        if (error instanceof LineTooLong) {
          this.line("* BYE Line too long");
          this.connection.close();
          break;
        }
        if (error instanceof No) this.line(`${tag} NO ${error.message}`);
        else if (error instanceof ParseError)
          this.line(`${tag} BAD ${error.message}`);
        else {
          console.error("[imap]", error);
          this.line(`${tag} NO [SERVERBUG] Something went wrong`);
        }
      }
    }
  }

  // Commands ----------------------------------------------------------------------------------------------

  /** Runs one command; returns the text of its tagged OK, or undefined when it answered itself. */
  private async command(
    tag: string,
    name: string,
    args: Token[],
    uid: boolean,
  ): Promise<string | undefined> {
    switch (name) {
      case "CAPABILITY":
        this.line(`* CAPABILITY ${this.capabilities()}`);
        return "CAPABILITY completed";
      case "NOOP":
      case "CHECK":
        if (this.selected) await this.sync(true);
        return `${name} completed`;
      case "LOGOUT":
        this.line("* BYE Logging out");
        this.line(`${tag} OK LOGOUT completed`);
        this.connection.close();
        return undefined;
      case "ID":
        this.line(
          '* ID ("name" "Richelieu" "vendor" "Richelieu" "support-url" "https://github.com/alexisbcz/richelieu.ai")',
        );
        return "ID completed";
      case "ENABLE":
        this.line("* ENABLED");
        return "ENABLE completed";
      case "STARTTLS":
        return this.startTls(tag);
      case "LOGIN":
        return this.login(text(args[0]), text(args[1]));
      case "AUTHENTICATE":
        return this.authenticate(args);
    }
    if (!this.account)
      throw new ParseError(`${name} needs you to sign in first`);
    switch (name) {
      case "NAMESPACE":
        this.line(`* NAMESPACE (("" "${DELIMITER}")) NIL NIL`);
        return "NAMESPACE completed";
      case "SELECT":
      case "EXAMINE":
        return this.select(
          decodeMailboxName(text(args[0])),
          name === "EXAMINE",
        );
      case "LIST":
      case "LSUB":
        return this.list(name, args);
      case "STATUS":
        return this.status(args);
      case "CREATE":
        return this.create(decodeMailboxName(text(args[0])));
      case "DELETE":
        return this.deleteFolder(decodeMailboxName(text(args[0])));
      case "RENAME":
        return this.rename(
          decodeMailboxName(text(args[0])),
          decodeMailboxName(text(args[1])),
        );
      case "SUBSCRIBE":
      case "UNSUBSCRIBE": {
        const folder = await this.folderOrFail(
          decodeMailboxName(text(args[0])),
        );
        await this.store.subscribe(folder.id, name === "SUBSCRIBE");
        return `${name} completed`;
      }
      case "APPEND":
        return this.append(args);
      case "IDLE":
        return this.idle(tag);
    }
    if (!this.selected) throw new ParseError(`${name} needs a selected folder`);
    switch (name) {
      case "CLOSE":
      case "UNSELECT": {
        if (name === "CLOSE" && !this.selected.readOnly) {
          const deleted = this.selected.messages.filter((m) =>
            m.flags.includes("\\Deleted"),
          );
          await this.store.expunge(deleted.map((m) => m.id));
          this.options.service.events.emit("folder", this.selected.folder.id);
        }
        this.selected = undefined;
        return `${name} completed`;
      }
      case "EXPUNGE":
        return this.expunge(uid ? text(args[0]) : undefined);
      case "SEARCH":
        return this.search(args, uid);
      case "FETCH":
        return this.fetch(args, uid);
      case "STORE":
        return this.storeFlags(args, uid);
      case "COPY":
      case "MOVE":
        return this.copy(args, uid, name === "MOVE");
    }
    throw new ParseError(`Unknown command ${name}`);
  }

  private async startTls(tag: string) {
    const context = this.options.tls();
    if (this.connection.secure || !context)
      throw new No("TLS is not available");
    if (this.connection.hasBuffered) {
      this.line("* BYE Commands sent after STARTTLS");
      this.connection.close();
      return undefined;
    }
    this.line(`${tag} OK Begin TLS negotiation now`);
    await this.connection.upgradeServer(context);
    return undefined;
  }

  private async signIn(username: string, password: string) {
    const { service } = this.options;
    const ip = this.connection.remoteAddress;
    if (!this.loginAllowed())
      throw new No("[PRIVACYREQUIRED] Use STARTTLS or port 993 first");
    if (service.blocked(ip))
      throw new No("[UNAVAILABLE] Too many failed sign-ins, try again later");
    const account = await service.store.authenticate(username, password);
    if (!account) {
      service.noteFailure(ip);
      this.authFailures++;
      await Bun.sleep(Math.min(5000, 500 * 2 ** this.authFailures));
      if (this.authFailures >= 3) {
        this.line("* BYE Too many failed attempts");
        this.connection.close();
      }
      throw new No("[AUTHENTICATIONFAILED] Wrong address or app password");
    }
    this.account = account;
    this.connection.setIdle(30 * 60_000);
    return `[CAPABILITY ${this.capabilities()}] Signed in as ${account.address}`;
  }

  private login(username: string, password: string) {
    if (this.account) throw new ParseError("Already signed in");
    return this.signIn(username, password);
  }

  private async authenticate(args: Token[]) {
    if (this.account) throw new ParseError("Already signed in");
    const mechanism = text(args[0]).toUpperCase();
    if (mechanism !== "PLAIN") throw new No("Use AUTHENTICATE PLAIN");
    let response = args[1] ? text(args[1]) : undefined;
    if (response === undefined) {
      this.line("+ ");
      response = await this.connection.readLine();
    }
    if (response === "*") throw new ParseError("Authentication cancelled");
    const [, user = "", pass = ""] = Buffer.from(response, "base64")
      .toString("utf8")
      .split("\0");
    return this.signIn(user, pass);
  }

  // Folders -----------------------------------------------------------------------------------------------

  private async folderOrFail(name: string, tryCreate = false): Promise<Folder> {
    const folder = await this.store.folder(this.account!.id, name);
    if (!folder)
      throw new No(
        `${tryCreate ? "[TRYCREATE] " : "[NONEXISTENT] "}No folder named ${name}`,
      );
    return folder;
  }

  private async select(name: string, readOnly: boolean) {
    this.selected = undefined;
    const folder = await this.folderOrFail(name);
    const messages = await this.store.index(folder.id);
    this.selected = { folder, readOnly, messages };
    this.line(`* FLAGS (${SYSTEM_FLAGS.join(" ")})`);
    this.line(
      `* OK [PERMANENTFLAGS (${readOnly ? "" : `${SYSTEM_FLAGS.join(" ")} \\*`})] Flags permitted`,
    );
    this.line(`* ${messages.length} EXISTS`);
    this.line("* 0 RECENT");
    const firstUnseen = messages.findIndex((m) => !m.flags.includes("\\Seen"));
    if (firstUnseen >= 0)
      this.line(`* OK [UNSEEN ${firstUnseen + 1}] First unseen`);
    this.line(`* OK [UIDVALIDITY ${folder.uid_validity}] UIDs valid`);
    this.line(`* OK [UIDNEXT ${folder.uid_next}] Predicted next UID`);
    return `[${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${readOnly ? "EXAMINE" : "SELECT"} completed`;
  }

  private attributes(folder: Folder, all: Folder[]) {
    const attrs: string[] = [];
    const hasChildren = all.some((f) =>
      f.name.startsWith(`${folder.name}${DELIMITER}`),
    );
    attrs.push(hasChildren ? "\\HasChildren" : "\\HasNoChildren");
    const special = folder.special_use
      ? SPECIAL_ATTRIBUTES[folder.special_use]
      : undefined;
    if (special) attrs.push(special);
    if (folder.subscribed) attrs.push("\\Subscribed");
    return attrs;
  }

  private async list(command: "LIST" | "LSUB", args: Token[]) {
    // LIST-EXTENDED selection options (`LIST (SUBSCRIBED) "" "*"`) and RETURN options are read and mostly ignored.
    let rest = args;
    let subscribedOnly = command === "LSUB";
    if (rest[0]?.type === "list") {
      subscribedOnly ||= rest[0].items.some(
        (t) => t.type === "atom" && t.value.toUpperCase() === "SUBSCRIBED",
      );
      rest = rest.slice(1);
    }
    const reference = decodeMailboxName(text(rest[0]));
    const patterns =
      rest[1]?.type === "list"
        ? rest[1].items.map((t) => decodeMailboxName(text(t)))
        : [decodeMailboxName(text(rest[1]))];
    if (patterns.length === 1 && patterns[0] === "") {
      this.line(`* ${command} (\\Noselect) "${DELIMITER}" ""`);
      return `${command} completed`;
    }
    const folders = await this.store.folders(this.account!.id);
    const matchers = patterns.map((p) =>
      mailboxMatcher(`${reference}${p}`, DELIMITER),
    );
    for (const folder of folders) {
      if (subscribedOnly && !folder.subscribed) continue;
      if (!matchers.some((match) => match(folder.name))) continue;
      const attrs = this.attributes(folder, folders).filter(
        (a) => command === "LIST" || a !== "\\Subscribed",
      );
      await this.send([
        `* ${command} (${attrs.join(" ")}) "${DELIMITER}" `,
        istring(encodeMailboxName(folder.name)),
      ]);
    }
    return `${command} completed`;
  }

  private async status(args: Token[]) {
    const name = decodeMailboxName(text(args[0]));
    const folder = await this.folderOrFail(name);
    const fresh = (await this.store.folderById(folder.id))!;
    const counts = await this.store.status(folder.id);
    const items =
      args[1]?.type === "list"
        ? args[1].items.map((t) => text(t).toUpperCase())
        : [];
    const values: string[] = [];
    for (const item of items) {
      if (item === "MESSAGES") values.push(`MESSAGES ${counts.messages}`);
      else if (item === "RECENT") values.push("RECENT 0");
      else if (item === "UIDNEXT") values.push(`UIDNEXT ${fresh.uid_next}`);
      else if (item === "UIDVALIDITY")
        values.push(`UIDVALIDITY ${fresh.uid_validity}`);
      else if (item === "UNSEEN") values.push(`UNSEEN ${counts.unseen}`);
      else if (item === "SIZE") values.push(`SIZE ${counts.size}`);
      else if (item === "HIGHESTMODSEQ")
        values.push(`HIGHESTMODSEQ ${fresh.modseq}`);
      else throw new ParseError(`Unknown status item ${item}`);
    }
    await this.send([
      "* STATUS ",
      istring(encodeMailboxName(fresh.name)),
      ` (${values.join(" ")})`,
    ]);
    return "STATUS completed";
  }

  private async create(rawName: string) {
    const name = rawName.replace(new RegExp(`${DELIMITER}+$`), "");
    if (!name || name.toUpperCase() === "INBOX")
      throw new No("[CANNOT] That name is taken");
    if (await this.store.folder(this.account!.id, name))
      throw new No("[ALREADYEXISTS] The folder exists");
    // Parents first, so the hierarchy holds.
    const parts = name.split(DELIMITER);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join(DELIMITER);
      if (!(await this.store.folder(this.account!.id, path)))
        await this.store.createFolder(this.account!, path);
    }
    return "CREATE completed";
  }

  private async deleteFolder(name: string) {
    const folder = await this.folderOrFail(name);
    if (folder.special_use)
      throw new No("[CANNOT] Standard folders cannot be deleted");
    if (this.selected?.folder.id === folder.id) this.selected = undefined;
    await this.store.deleteFolder(folder.id);
    return "DELETE completed";
  }

  private async rename(from: string, to: string) {
    const folder = await this.folderOrFail(from);
    if (folder.special_use === "inbox")
      throw new No("[CANNOT] INBOX cannot be renamed");
    if (await this.store.folder(this.account!.id, to))
      throw new No("[ALREADYEXISTS] The target exists");
    await this.store.renameFolder(this.account!.id, folder.name, to);
    return "RENAME completed";
  }

  private async append(args: Token[]) {
    const folder = await this.folderOrFail(
      decodeMailboxName(text(args[0])),
      true,
    );
    let flags: string[] = [];
    let date: Date | undefined;
    let message: Uint8Array | undefined;
    for (const token of args.slice(1)) {
      if (token.type === "list") flags = token.items.map((t) => text(t));
      else if (token.type === "string" && token.bytes) message = token.bytes;
      else if (token.type === "string") date = parseImapDate(token.value);
    }
    if (!message) throw new ParseError("APPEND needs the message as a literal");
    const stored = await this.store.append({
      account: this.account!,
      folder,
      raw: message,
      flags: flags.filter((f) => f.toLowerCase() !== "\\recent"),
      internalDate: date,
    });
    this.options.service.events.emit("folder", folder.id);
    if (this.selected?.folder.id === folder.id) await this.sync(false);
    return `[APPENDUID ${folder.uid_validity} ${stored.uid}] APPEND completed`;
  }

  // The selected folder -----------------------------------------------------------------------------------

  /**
   * Catches up with the folder: reports messages that left (EXPUNGE, only when allowed), new ones (EXISTS) and
   * changed flags (FETCH).
   */
  private async sync(expunges: boolean) {
    const selected = this.selected;
    if (!selected) return;
    const fresh = await this.store.index(selected.folder.id);
    if (this.selected !== selected) return;
    const byUid = new Map(fresh.map((m) => [m.uid, m]));
    if (expunges) {
      for (let i = selected.messages.length - 1; i >= 0; i--) {
        if (!byUid.has(selected.messages[i]!.uid)) {
          selected.messages.splice(i, 1);
          this.line(`* ${i + 1} EXPUNGE`);
        }
      }
    }
    selected.messages.forEach((message, i) => {
      const current = byUid.get(message.uid);
      if (current && current.modseq !== message.modseq) {
        const changed = current.flags.join(" ") !== message.flags.join(" ");
        selected.messages[i] = current;
        if (changed)
          this.line(
            `* ${i + 1} FETCH (UID ${current.uid} FLAGS (${current.flags.join(" ")}))`,
          );
      }
    });
    const last = selected.messages.at(-1)?.uid ?? 0;
    const added = fresh.filter((m) => m.uid > last);
    if (added.length) {
      selected.messages.push(...added);
      this.line(`* ${selected.messages.length} EXISTS`);
      this.line("* 0 RECENT");
    }
  }

  /** The messages a sequence set (or UID set) names, with their sequence numbers. */
  private resolve(
    set: string,
    uid: boolean,
  ): { message: MessageIndex; seq: number }[] {
    const messages = this.selected!.messages;
    if (uid) {
      // `*` is the largest UID, so `n:*` includes the last message even when n is past it (RFC 3501).
      const test = parseSequenceSet(set, messages.at(-1)?.uid ?? 0);
      return messages.flatMap((message, i) =>
        test(message.uid) ? [{ message, seq: i + 1 }] : [],
      );
    }
    if (messages.length === 0) {
      if (set === "*" || /^1(:\*)?$/.test(set)) return [];
      throw new ParseError("No messages in the folder");
    }
    const test = parseSequenceSet(set, messages.length);
    return messages.flatMap((message, i) =>
      test(i + 1) ? [{ message, seq: i + 1 }] : [],
    );
  }

  private async expunge(uidSet?: string) {
    const selected = this.selected!;
    if (selected.readOnly) throw new No("[READ-ONLY] The folder is read-only");
    const targets = uidSet
      ? new Set(this.resolve(uidSet, true).map((r) => r.message.uid))
      : undefined;
    const deleted = selected.messages.filter(
      (m) => m.flags.includes("\\Deleted") && (!targets || targets.has(m.uid)),
    );
    await this.store.expunge(deleted.map((m) => m.id));
    if (deleted.length)
      this.options.service.events.emit("folder", selected.folder.id);
    await this.sync(true);
    return "EXPUNGE completed";
  }

  private async search(args: Token[], uid: boolean) {
    const selected = this.selected!;
    // ESEARCH-style `RETURN (...)` is not offered, so its absence keeps the plain response.
    const found = await search(
      args,
      this.store,
      selected.folder.id,
      selected.messages,
    );
    const seq = new Map(selected.messages.map((m, i) => [m.uid, i + 1]));
    const numbers = found.map((m) => (uid ? m.uid : seq.get(m.uid)!));
    this.line(`* SEARCH${numbers.length ? ` ${numbers.join(" ")}` : ""}`);
    if (uid) await this.sync(true);
    return `${uid ? "UID " : ""}SEARCH completed`;
  }

  private async fetch(args: Token[], uid: boolean) {
    if (!args[0] || !args[1])
      throw new ParseError("FETCH needs a sequence set and items");
    const selected = this.selected!;
    if (!uid) await this.sync(false);
    const items = parseFetchItems(args[1] as never);
    if (uid && !items.some((i) => i.kind === "UID"))
      items.unshift({ kind: "UID" });
    const targets = this.resolve(text(args[0]), uid);
    const needsBody = items.some((i) =>
      [
        "ENVELOPE",
        "BODYSTRUCTURE",
        "BODY",
        "SECTION",
        "RFC822",
        "RFC822.HEADER",
        "RFC822.TEXT",
      ].includes(i.kind),
    );
    const marksSeen =
      !selected.readOnly &&
      items.some(
        (i) =>
          (i.kind === "SECTION" && !i.peek) ||
          i.kind === "RFC822" ||
          i.kind === "RFC822.TEXT",
      );

    if (marksSeen) {
      const unseen = targets.filter((t) => !t.message.flags.includes("\\Seen"));
      const updated = await this.store.setFlags(
        unseen.map((t) => t.message.id),
        "add",
        ["\\Seen"],
      );
      for (const row of updated) {
        const target = targets.find((t) => t.message.id === row.id);
        if (target)
          Object.assign(target.message, {
            flags: row.flags,
            modseq: row.modseq,
          });
      }
      if (updated.length) {
        this.options.service.events.emit("folder", selected.folder.id);
        if (!items.some((i) => i.kind === "FLAGS"))
          items.push({ kind: "FLAGS" });
      }
    }

    for (let start = 0; start < targets.length; start += FETCH_BATCH) {
      const batch = targets.slice(start, start + FETCH_BATCH);
      const raws = needsBody
        ? await this.store.raws(batch.map((t) => t.message.id))
        : new Map<string, Uint8Array>();
      for (const { message, seq } of batch) {
        const raw = raws.get(message.id);
        if (needsBody && !raw) continue;
        const parsed = raw ? parseMessage(raw) : undefined;
        const parts: Piece[][] = items.map((item) =>
          this.fetchItem(item, message, parsed),
        );
        const pieces: Piece[] = [`* ${seq} FETCH (`];
        parts.forEach((part, i) => {
          if (i) pieces.push(" ");
          pieces.push(...part);
        });
        pieces.push(")");
        await this.send(pieces);
      }
    }
    if (uid) await this.sync(true);
    return `${uid ? "UID " : ""}FETCH completed`;
  }

  private fetchItem(
    item: FetchItem,
    message: MessageIndex,
    parsed: ReturnType<typeof parseMessage> | undefined,
  ): Piece[] {
    switch (item.kind) {
      case "UID":
        return [`UID ${message.uid}`];
      case "FLAGS":
        return [`FLAGS (${message.flags.join(" ")})`];
      case "INTERNALDATE":
        return [`INTERNALDATE "${formatInternalDate(message.internal_date)}"`];
      case "RFC822.SIZE":
        return [`RFC822.SIZE ${message.size}`];
      case "MODSEQ":
        return [`MODSEQ (${message.modseq})`];
      case "ENVELOPE":
        return ["ENVELOPE ", ...envelope(parsed!.headers)];
      case "BODYSTRUCTURE":
        return [
          "BODYSTRUCTURE ",
          ...bodyStructure(parsed!, parsed!.root, true),
        ];
      case "BODY":
        return ["BODY ", ...bodyStructure(parsed!, parsed!.root, false)];
      case "RFC822":
        return ["RFC822 ", { literal: parsed!.raw }];
      case "RFC822.HEADER":
        return ["RFC822.HEADER ", { literal: section(parsed!, "HEADER") }];
      case "RFC822.TEXT":
        return ["RFC822.TEXT ", { literal: section(parsed!, "TEXT") }];
      case "SECTION": {
        let bytes = section(parsed!, item.section);
        if (item.partial)
          bytes = bytes.subarray(
            item.partial[0],
            item.partial[0] + item.partial[1],
          );
        return [`${item.label} `, { literal: bytes }];
      }
    }
  }

  private async storeFlags(args: Token[], uid: boolean) {
    const selected = this.selected!;
    if (selected.readOnly) throw new No("[READ-ONLY] The folder is read-only");
    if (!uid) await this.sync(false);
    const action = text(args[1]).toUpperCase();
    const match = action.match(/^([+-]?)FLAGS(\.SILENT)?$/);
    if (!match) throw new ParseError(`Bad STORE action ${action}`);
    const flagTokens = args
      .slice(2)
      .flatMap((t) => (t.type === "list" ? t.items : [t]));
    const flags = flagTokens
      .map((t) => text(t))
      .filter((f) => f.toLowerCase() !== "\\recent");
    const mode =
      match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "replace";
    const targets = this.resolve(text(args[0]), uid);
    const updated = await this.store.setFlags(
      targets.map((t) => t.message.id),
      mode,
      flags,
    );
    const byId = new Map(updated.map((row) => [row.id, row]));
    for (const target of targets) {
      const row = byId.get(target.message.id);
      if (row)
        Object.assign(target.message, { flags: row.flags, modseq: row.modseq });
      if (!match[2])
        this.line(
          `* ${target.seq} FETCH (FLAGS (${target.message.flags.join(" ")})${uid ? ` UID ${target.message.uid}` : ""})`,
        );
    }
    if (updated.length)
      this.options.service.events.emit("folder", selected.folder.id);
    if (uid) await this.sync(true);
    return `${uid ? "UID " : ""}STORE completed`;
  }

  private async copy(args: Token[], uid: boolean, move: boolean) {
    const selected = this.selected!;
    if (move && selected.readOnly)
      throw new No("[READ-ONLY] The folder is read-only");
    const target = await this.folderOrFail(
      decodeMailboxName(text(args[1])),
      true,
    );
    const sources = this.resolve(text(args[0]), uid);
    if (sources.length === 0)
      return `${move ? "MOVE" : "COPY"} completed (nothing to do)`;
    const ids = sources.map((s) => s.message.id);
    if (target.id === selected.folder.id && move)
      return "MOVE completed (already there)";
    const results = move
      ? await this.store.move(ids, target)
      : await this.store.copy(ids, this.account!, target);
    const newUids = new Map(results.map((r) => [r.id, r.uid]));
    const pairs = sources.filter((s) => newUids.has(s.message.id) || !move);
    const copyUid = `COPYUID ${target.uid_validity} ${formatSequenceSet(sources.map((s) => s.message.uid))} ${formatSequenceSet(
      move
        ? pairs.map((s) => newUids.get(s.message.id)!)
        : results.map((r) => r.uid),
    )}`;
    this.options.service.events.emit("folder", target.id);
    if (!move) return `[${copyUid}] COPY completed`;
    this.line(`* OK [${copyUid}] Moved`);
    // The moved messages leave this folder: highest sequence number first, so the others keep theirs.
    const movedUids = new Set(sources.map((s) => s.message.uid));
    for (let i = selected.messages.length - 1; i >= 0; i--) {
      if (movedUids.has(selected.messages[i]!.uid)) {
        selected.messages.splice(i, 1);
        this.line(`* ${i + 1} EXPUNGE`);
      }
    }
    this.options.service.events.emit("folder", selected.folder.id);
    return "MOVE completed";
  }

  /** Waits for DONE, telling the client about changes as they happen (RFC 2177). */
  private async idle(tag: string) {
    this.line("+ idling");
    const { events } = this.options.service;
    let wake: (() => void) | undefined;
    const onChange = (folderId: string) => {
      if (this.selected?.folder.id === folderId) wake?.();
    };
    events.on("folder", onChange);
    const done = this.connection.readLine();
    let finished = false;
    void done.then(
      () => ((finished = true), wake?.()),
      () => ((finished = true), wake?.()),
    );
    try {
      while (!finished) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, IDLE_POLL_MS);
        });
        wake = undefined;
        if (!finished && this.selected) await this.sync(true);
      }
      const line = await done;
      if (line.toUpperCase() !== "DONE") throw new ParseError("Expected DONE");
    } finally {
      events.off("folder", onChange);
    }
    return "IDLE terminated";
  }
}

export type ImapListener = {
  port: number;
  host: string;
  implicitTls?: boolean;
};

export function listenImap(
  listener: ImapListener,
  options: ImapOptions,
): Promise<Server> {
  const handle = (socket: Socket) => {
    socket.setNoDelay(true);
    void new ImapSession(new Connection(socket, 30 * 60_000), options).run();
  };
  const server = listener.implicitTls
    ? createTlsServer(
        { SNICallback: (_name, callback) => callback(null, options.tls()) },
        handle,
      )
    : createTcpServer(handle);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listener.port, listener.host, () => resolve(server));
  });
}
