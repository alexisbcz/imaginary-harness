// IMAP SEARCH (RFC 3501 section 6.4.4): every search key, evaluated against a folder's messages. Flags, sizes and
// dates come from the index; addresses and subjects from the stored summaries; HEADER from the raw bytes, loaded
// only for the messages it is asked about.

import { header, parseHeaders } from "../mime/parse.ts";
import { binaryString, decodeWords } from "../mime/encoding.ts";
import type { MailStore, MessageIndex, StoredMessage } from "../store.ts";
import { parseImapDate } from "./fetch.ts";
import { ParseError, parseSequenceSet, text, type Token } from "./parser.ts";

type Context = {
  store: MailStore;
  folderId: string;
  messages: MessageIndex[];
  /** Sequence numbers by message id. */
  seq: Map<string, number>;
  details: () => Promise<Map<string, StoredMessage>>;
  raws: () => Promise<Map<string, Uint8Array>>;
  textMatches: (query: string) => Promise<Set<string>>;
};

type Test = (message: MessageIndex) => Promise<boolean> | boolean;

const day = (date: Date) =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

function dateArg(token: Token | undefined): number {
  const date = parseImapDate(text(token));
  if (!date) throw new ParseError("Bad date");
  return day(date);
}

const includes = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

const addressText = (list: { name: string; address: string }[]) =>
  list.map((a) => `${a.name} <${a.address}>`).join(", ");

/** Reads one search key (and its arguments) from `tokens`, starting at `at.i`. */
function key(tokens: Token[], at: { i: number }, ctx: Context): Test {
  const token = tokens[at.i++];
  if (!token) throw new ParseError("Missing search key");
  if (token.type === "list") {
    const inner = { i: 0 };
    const tests: Test[] = [];
    while (inner.i < token.items.length)
      tests.push(key(token.items, inner, ctx));
    return async (m) => {
      for (const test of tests) if (!(await test(m))) return false;
      return true;
    };
  }
  const name = text(token).toUpperCase();
  const flag =
    (f: string, present: boolean): Test =>
    (m) =>
      m.flags.includes(f) === present;
  const detail =
    (pick: (d: StoredMessage) => string): ((needle: string) => Test) =>
    (needle) =>
    async (m) => {
      const d = (await ctx.details()).get(m.id);
      return d ? includes(pick(d), needle) : false;
    };

  if (/^[\d*:,]+$/.test(name)) {
    const inSet = parseSequenceSet(name, ctx.messages.length);
    return (m) => inSet(ctx.seq.get(m.id)!);
  }
  switch (name) {
    case "ALL":
      return () => true;
    case "ANSWERED":
      return flag("\\Answered", true);
    case "UNANSWERED":
      return flag("\\Answered", false);
    case "DELETED":
      return flag("\\Deleted", true);
    case "UNDELETED":
      return flag("\\Deleted", false);
    case "DRAFT":
      return flag("\\Draft", true);
    case "UNDRAFT":
      return flag("\\Draft", false);
    case "FLAGGED":
      return flag("\\Flagged", true);
    case "UNFLAGGED":
      return flag("\\Flagged", false);
    case "SEEN":
    case "OLD":
      return flag("\\Seen", true);
    case "UNSEEN":
    case "NEW":
      return flag("\\Seen", false);
    case "RECENT":
      return () => false;
    case "KEYWORD":
      return flag(text(tokens[at.i++]), true);
    case "UNKEYWORD":
      return flag(text(tokens[at.i++]), false);
    case "LARGER": {
      const n = Number(text(tokens[at.i++]));
      return (m) => m.size > n;
    }
    case "SMALLER": {
      const n = Number(text(tokens[at.i++]));
      return (m) => m.size < n;
    }
    case "BEFORE": {
      const d = dateArg(tokens[at.i++]);
      return (m) => day(m.internal_date) < d;
    }
    case "ON": {
      const d = dateArg(tokens[at.i++]);
      return (m) => day(m.internal_date) === d;
    }
    case "SINCE": {
      const d = dateArg(tokens[at.i++]);
      return (m) => day(m.internal_date) >= d;
    }
    case "SENTBEFORE":
    case "SENTON":
    case "SENTSINCE": {
      const d = dateArg(tokens[at.i++]);
      return async (m) => {
        const sent =
          (await ctx.details()).get(m.id)?.sent_at ?? m.internal_date;
        const s = day(sent);
        return name === "SENTBEFORE"
          ? s < d
          : name === "SENTON"
            ? s === d
            : s >= d;
      };
    }
    case "FROM":
      return detail((d) => `${d.from_name} <${d.from_address}>`)(
        text(tokens[at.i++]),
      );
    case "TO":
      return detail((d) => addressText(d.to_addresses))(text(tokens[at.i++]));
    case "CC":
      return detail((d) => addressText(d.cc_addresses))(text(tokens[at.i++]));
    case "SUBJECT":
      return detail((d) => d.subject)(text(tokens[at.i++]));
    case "BCC":
    case "HEADER": {
      const field = name === "BCC" ? "bcc" : text(tokens[at.i++]);
      const needle = text(tokens[at.i++]);
      return async (m) => {
        const raw = (await ctx.raws()).get(m.id);
        if (!raw) return false;
        const head = binaryString(raw).split(/\r?\n\r?\n/)[0]!;
        const value = header(parseHeaders(head), field);
        return (
          value !== undefined &&
          (needle === "" || includes(decodeWords(value), needle))
        );
      };
    }
    case "BODY":
    case "TEXT": {
      const needle = text(tokens[at.i++]);
      let matches: Promise<Set<string>> | undefined;
      return async (m) => {
        matches ??= ctx.textMatches(needle);
        return (await matches).has(m.id);
      };
    }
    case "UID": {
      const max = ctx.messages.at(-1)?.uid ?? 0;
      const inSet = parseSequenceSet(text(tokens[at.i++]), max);
      return (m) => inSet(m.uid);
    }
    case "NOT": {
      const inner = key(tokens, at, ctx);
      return async (m) => !(await inner(m));
    }
    case "OR": {
      const a = key(tokens, at, ctx);
      const b = key(tokens, at, ctx);
      return async (m) => (await a(m)) || (await b(m));
    }
    case "MODSEQ": {
      const n = Number(text(tokens[at.i++]));
      return (m) => m.modseq >= n;
    }
    default:
      throw new ParseError(`Unknown search key ${name}`);
  }
}

/** The messages matching every key, in folder order. */
export async function search(
  tokens: Token[],
  store: MailStore,
  folderId: string,
  messages: MessageIndex[],
): Promise<MessageIndex[]> {
  let rest = tokens;
  // CHARSET is accepted for UTF-8 and ASCII; strings are compared as Unicode anyway.
  if (rest[0] && text(rest[0]).toUpperCase() === "CHARSET") {
    const charset = text(rest[1]).toUpperCase();
    if (charset !== "UTF-8" && charset !== "US-ASCII")
      throw new ParseError(
        `[BADCHARSET (UTF-8 US-ASCII)] ${charset} is not supported`,
      );
    rest = rest.slice(2);
  }
  let details: Promise<Map<string, StoredMessage>> | undefined;
  let raws: Promise<Map<string, Uint8Array>> | undefined;
  const ctx: Context = {
    store,
    folderId,
    messages,
    seq: new Map(messages.map((m, i) => [m.id, i + 1])),
    details: () =>
      (details ??= store
        .messages(messages.map((m) => m.id))
        .then((rows) => new Map(rows.map((r) => [r.id, r])))),
    raws: () => (raws ??= store.raws(messages.map((m) => m.id))),
    textMatches: (query) => store.searchText(folderId, query),
  };
  const at = { i: 0 };
  const tests: Test[] = [];
  while (at.i < rest.length) tests.push(key(rest, at, ctx));
  if (tests.length === 0) throw new ParseError("Missing search key");
  const matched: MessageIndex[] = [];
  for (const message of messages) {
    let ok = true;
    for (const test of tests) {
      if (!(await test(message))) {
        ok = false;
        break;
      }
    }
    if (ok) matched.push(message);
  }
  return matched;
}
