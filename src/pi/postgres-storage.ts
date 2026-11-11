// Pi Durable's `Storage` on Postgres, through `Bun.sql`. A port of the package's portable SQLite backend
// (`@earendil-works/pi-durable/storage/sqlite`): the same tables, the same checks before writes, one transaction
// per `commit()` call with one seq per batch. Records are stored as JSON text, losslessly (lone surrogates and
// `\u0000` survive, which `jsonb` refuses); cast `record::jsonb` to query them.

import type { ReservedSQL, SQL } from "bun";
import type { Context } from "@earendil-works/chord/context";
import { apply } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  StorageRequestError,
  type CommitResult,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentContent,
  type DocumentCopySource,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type Page,
  type ScanOrder,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };
type Executor = Pick<SQL, "unsafe">;
type Row = Record<string, unknown>;
type Cell = string | number | null;
type RecordTable =
  "conversation" | "entry" | "task" | "submission" | "document";
type Scope = DocumentRecord["scope"];

export interface PostgresStorageOptions {
  /** The Postgres schema holding Durable's tables, created if missing. Default `pi`. */
  readonly schema?: string;
  /** How long `open` waits for another process to release the schema. Default 30 s. */
  readonly lockTimeoutMs?: number;
}

/**
 * Takes the schema's writer lock, a session advisory lock, on a connection of its own: Durable allows one writer
 * per storage, and two processes interleaving commits corrupt documents. Commits go through this connection, so
 * losing it (and the lock with it) fails them instead of letting them through unguarded.
 */
async function lockWriter(
  sql: SQL,
  schema: string,
  timeoutMs: number,
): Promise<ReservedSQL> {
  const writer = await sql.reserve();
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const [row] = await writer.unsafe(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [`pi-durable-writer:${schema}`],
      );
      if (row?.locked) return writer;
      if (Date.now() >= deadline)
        throw new Error(
          `Another process holds the Pi Durable storage in schema ${schema}`,
        );
      await Bun.sleep(250);
    }
  } catch (error) {
    writer.release();
    throw error;
  }
}

const idOf = <I>(value: unknown) => Number(value) as I;
const parseJson = <T>(value: unknown): T => JSON.parse(value as string) as T;
const encodeJson = (value: unknown) => JSON.stringify(value);
/** Indexed strings are JSON-encoded, as in the SQLite backend: lossless for any JavaScript string. */
const encodeIndexedString = (value: string) => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------------------------
// Schema

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

function migrations(s: string): readonly (readonly string[])[] {
  return [
    [
      `CREATE TABLE ${s}.metadata (
        singleton integer PRIMARY KEY CHECK (singleton = 1),
        next_id bigint NOT NULL,
        next_seq bigint NOT NULL
      )`,
      `INSERT INTO ${s}.metadata (singleton, next_id, next_seq) VALUES (1, 2, 1)`,
      `CREATE TABLE ${s}.record_ids (
        id bigint PRIMARY KEY,
        record_type text NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
      )`,
      `CREATE TABLE ${s}.conversations (
        id bigint PRIMARY KEY,
        owner_conversation_id bigint,
        owner_task_id bigint,
        record text NOT NULL
      )`,
      `CREATE INDEX conversations_by_owner_conversation ON ${s}.conversations (owner_conversation_id, id)`,
      `CREATE INDEX conversations_by_owner_task ON ${s}.conversations (owner_task_id, id)`,
      `CREATE TABLE ${s}.entries (
        id bigint PRIMARY KEY,
        conversation_id bigint NOT NULL,
        head bigint,
        commit_seq bigint NOT NULL,
        record text NOT NULL
      )`,
      `CREATE INDEX entries_by_conversation ON ${s}.entries (conversation_id, id DESC)`,
      `CREATE INDEX entry_heads_by_conversation ON ${s}.entries (conversation_id, id DESC) WHERE head IS NOT NULL`,
      `CREATE TABLE ${s}.tasks (
        id bigint PRIMARY KEY,
        conversation_id bigint NOT NULL,
        kind text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
        abort_requested boolean NOT NULL,
        background boolean NOT NULL,
        record text NOT NULL
      )`,
      `CREATE INDEX tasks_by_status ON ${s}.tasks (status, id)`,
      `CREATE INDEX tasks_by_conversation ON ${s}.tasks (conversation_id, id)`,
      `CREATE INDEX tasks_by_kind ON ${s}.tasks (kind, id)`,
      `CREATE INDEX tasks_by_abort_requested ON ${s}.tasks (abort_requested, id)`,
      `CREATE INDEX tasks_by_background ON ${s}.tasks (background, id)`,
      `CREATE TABLE ${s}.submissions (
        id bigint PRIMARY KEY,
        conversation_id bigint NOT NULL,
        request_id text,
        status text NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
        record text NOT NULL
      )`,
      `CREATE INDEX submissions_by_request ON ${s}.submissions (conversation_id, request_id)`,
      `CREATE INDEX submissions_by_conversation ON ${s}.submissions (conversation_id, id)`,
      `CREATE INDEX submissions_by_status ON ${s}.submissions (status, id)`,
      `CREATE TABLE ${s}.documents (
        id bigint PRIMARY KEY,
        kind text NOT NULL,
        family boolean NOT NULL,
        key_value text NOT NULL,
        scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
        owner_id bigint NOT NULL,
        created_at bigint NOT NULL,
        retired_at bigint,
        record text NOT NULL
      )`,
      `CREATE INDEX documents_by_address
        ON ${s}.documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
      `CREATE INDEX documents_by_scope ON ${s}.documents (scope_kind, owner_id, id)`,
      `CREATE INDEX documents_by_scope_kind ON ${s}.documents (scope_kind, owner_id, kind, id)`,
      `CREATE TABLE ${s}.document_revisions (
        document_id bigint NOT NULL,
        seq bigint NOT NULL,
        kind text NOT NULL CHECK (kind IN ('base', 'delta')),
        version bigint NOT NULL,
        content text NOT NULL,
        PRIMARY KEY (document_id, seq)
      )`,
      `CREATE INDEX document_revisions_by_kind ON ${s}.document_revisions (document_id, kind, seq DESC)`,
    ],
  ];
}

/** Creates the schema and applies pending migrations, one transaction under an advisory lock. */
async function migrate(sql: SQL, schema: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `pi-durable:${schema}`,
    ]);
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${schema}.schema_version (version integer NOT NULL)`,
    );
    const [row] = await tx.unsafe(
      `SELECT max(version) AS version FROM ${schema}.schema_version`,
    );
    const current = Number(row?.version ?? 0);
    const all = migrations(schema);
    for (let version = current + 1; version <= all.length; version++) {
      for (const statement of all[version - 1]!) await tx.unsafe(statement);
      await tx.unsafe(
        `INSERT INTO ${schema}.schema_version (version) VALUES ($1)`,
        [version],
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

const scopeColumns = (scope: Scope) => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return {
        scopeKind: "conversation",
        ownerId: scope.conversationId as number,
      };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId as number };
  }
};

const addressParts = (address: DocumentAddress) => ({
  kind: encodeIndexedString(address.kind),
  ...scopeColumns(address.scope),
  family: address.key !== undefined,
  keyValue: encodeIndexedString(address.key ?? ""),
});

type AddressParts = ReturnType<typeof addressParts>;

const addressColumnsKey = (
  kind: string,
  scopeKind: string,
  ownerId: number,
  family: boolean,
  keyValue: string,
) => JSON.stringify([kind, scopeKind, ownerId, family, keyValue]);

const addressKey = (address: DocumentAddress) => {
  const p = addressParts(address);
  return addressColumnsKey(
    p.kind,
    p.scopeKind,
    p.ownerId,
    p.family,
    p.keyValue,
  );
};

const isCurrentOnly = (record: DocumentRecord) =>
  record.scope.kind !== "conversation" || record.history === "latest";

function documentRow(record: DocumentRecord): (Cell | boolean)[] {
  const p = addressParts(record);
  return [
    record.id as number,
    p.kind,
    p.family,
    p.keyValue,
    p.scopeKind,
    p.ownerId,
    record.createdAt as number,
    (record.retiredAt as number | undefined) ?? null,
    encodeJson(record),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Statements: few round trips whatever the number of rows.

const MAX_PARAMETERS = 30_000;

function placeholders(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => `$${offset + i + 1}`).join(
    ", ",
  );
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size)
    out.push(values.slice(start, start + size));
  return out;
}

/** Rows of `select` (`... IN (<ids>)`, `<ids>` replaced by placeholders) for every value of `ids`, chunked. */
async function readIn(
  executor: Executor,
  select: (list: string) => string,
  ids: readonly number[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const chunk of chunks(ids, MAX_PARAMETERS)) {
    rows.push(
      ...(await executor.unsafe(select(placeholders(chunk.length)), chunk)),
    );
  }
  return rows;
}

async function insertRows(
  executor: Executor,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (Cell | boolean)[])[],
  conflict = "",
): Promise<void> {
  if (rows.length === 0) return;
  const width = columns.length;
  for (const chunk of chunks(rows, Math.floor(MAX_PARAMETERS / width))) {
    const values = chunk
      .map((_, row) => `(${placeholders(width, row * width)})`)
      .join(", ");
    await executor.unsafe(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ${conflict}`,
      chunk.flat(),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One commit call: the state its checks read, checked in memory, then the writes per table.

type DocumentCreateRecord = Extract<
  StorageWrite,
  { type: "document.create" }
>["record"];

interface DocumentAction {
  create?: DocumentCreateRecord;
  content?: DocumentContent;
  copy?: DocumentCopySource;
  retire: boolean;
}

const claimOf = (
  write: StorageWrite,
): { id: number; table: RecordTable } | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return { id: write.value.id as number, table: write.type };
    case "document.create":
    case "document.copy":
      return { id: write.record.id as number, table: "document" };
    default:
      return undefined;
  }
};

/** One batch's writes per document; throws when a document gets two content commands or two retirements. */
function prepareDocumentActions(
  writes: readonly StorageWrite[],
): Map<number, DocumentAction> {
  const actions = new Map<number, DocumentAction>();
  for (const write of writes) {
    if (
      write.type !== "document.create" &&
      write.type !== "document.copy" &&
      write.type !== "document.change" &&
      write.type !== "document.retire"
    ) {
      continue;
    }
    const id = (
      write.type === "document.create" || write.type === "document.copy"
        ? write.record.id
        : write.id
    ) as number;
    let action = actions.get(id);
    if (action === undefined) {
      action = { retire: false };
      actions.set(id, action);
    }
    switch (write.type) {
      case "document.create":
        if (
          action.create !== undefined ||
          action.content !== undefined ||
          action.copy !== undefined
        ) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.create = write.record;
        action.content = write.content;
        break;
      case "document.copy":
        if (
          action.create !== undefined ||
          action.content !== undefined ||
          action.copy !== undefined
        ) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.create = write.record;
        action.copy = write.source;
        break;
      case "document.change":
        if (action.content !== undefined || action.copy !== undefined) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.content = write.content;
        break;
      case "document.retire":
        if (action.retire)
          throw new Error(`Document ${id} is retired more than once`);
        action.retire = true;
        break;
    }
  }
  return actions;
}

class CommitState {
  constructor(
    private readonly recordIds: Map<number, RecordTable>,
    private readonly documents: Map<number, DocumentRecord>,
    private readonly versions: Map<number, number>,
    private readonly current: Map<string, number | undefined>,
  ) {}

  static async read(
    executor: Executor,
    s: string,
    batches: readonly (readonly StorageWrite[])[],
  ) {
    const ids = new Set<number>();
    const documentIds = new Set<number>();
    const deltaIds = new Set<number>();
    const addresses = new Map<string, AddressParts>();
    for (const writes of batches) {
      for (const write of writes) {
        const claim = claimOf(write);
        if (claim !== undefined) ids.add(claim.id);
        switch (write.type) {
          case "document.create":
          case "document.copy":
            documentIds.add(write.record.id as number);
            addresses.set(addressKey(write.record), addressParts(write.record));
            break;
          case "document.change":
            documentIds.add(write.id as number);
            if (write.content.kind === "delta")
              deltaIds.add(write.id as number);
            break;
          case "document.retire":
            documentIds.add(write.id as number);
            break;
          default:
            break;
        }
      }
    }
    const recordIds = new Map<number, RecordTable>();
    for (const row of await readIn(
      executor,
      (l) => `SELECT id, record_type FROM ${s}.record_ids WHERE id IN (${l})`,
      [...ids],
    )) {
      recordIds.set(Number(row.id), row.record_type as RecordTable);
    }
    const documents = new Map<number, DocumentRecord>();
    for (const row of await readIn(
      executor,
      (l) => `SELECT record FROM ${s}.documents WHERE id IN (${l})`,
      [...documentIds],
    )) {
      const record = parseJson<DocumentRecord>(row.record);
      documents.set(record.id as number, record);
    }
    const versions = new Map<number, number>();
    for (const row of await readIn(
      executor,
      (
        l,
      ) => `SELECT DISTINCT ON (document_id) document_id, version FROM ${s}.document_revisions
        WHERE document_id IN (${l}) ORDER BY document_id, seq DESC`,
      [...deltaIds],
    )) {
      versions.set(Number(row.document_id), Number(row.version));
    }
    const current = new Map<string, number | undefined>();
    for (const key of addresses.keys()) current.set(key, undefined);
    for (const chunk of chunks(
      [...addresses.values()],
      Math.floor(MAX_PARAMETERS / 5),
    )) {
      const tuples = chunk
        .map((_, i) => `(${placeholders(5, i * 5)})`)
        .join(", ");
      const params = chunk.flatMap((p) => [
        p.kind,
        p.scopeKind,
        p.ownerId,
        p.family,
        p.keyValue,
      ]);
      const rows = await executor.unsafe(
        `SELECT id, kind, scope_kind, owner_id, family, key_value FROM ${s}.documents
          WHERE retired_at IS NULL AND (kind, scope_kind, owner_id, family, key_value) IN (${tuples})`,
        params,
      );
      for (const row of rows) {
        current.set(
          addressColumnsKey(
            row.kind,
            row.scope_kind,
            Number(row.owner_id),
            Boolean(row.family),
            row.key_value,
          ),
          Number(row.id),
        );
      }
    }
    return new CommitState(recordIds, documents, versions, current);
  }

  check(writes: readonly StorageWrite[], actions: Map<number, DocumentAction>) {
    this.checkIds(writes);
    this.checkDocuments(actions);
  }

  apply(
    writes: readonly StorageWrite[],
    actions: Map<number, DocumentAction>,
    seq: Seq,
  ) {
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim !== undefined) this.recordIds.set(claim.id, claim.table);
    }
    for (const [id, action] of actions) {
      if (action.create !== undefined) {
        const record = {
          ...action.create,
          createdAt: seq,
          ...(action.retire ? { retiredAt: seq } : {}),
        } as DocumentRecord;
        this.documents.set(id, record);
        if (!action.retire) this.current.set(addressKey(record), id);
      } else if (action.retire) {
        const record = {
          ...this.documents.get(id)!,
          retiredAt: seq,
        } as DocumentRecord;
        this.documents.set(id, record);
        const key = addressKey(record);
        if (this.current.get(key) === id) this.current.set(key, undefined);
      }
      if (action.content !== undefined)
        this.versions.set(id, action.content.version);
    }
  }

  document(id: number) {
    return this.documents.get(id);
  }

  private checkIds(writes: readonly StorageWrite[]) {
    const claimed = new Map<number, RecordTable>();
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim === undefined) continue;
      const { id, table } = claim;
      const existing = this.recordIds.get(id);
      const earlier = claimed.get(id);
      if (
        table === "conversation" ||
        table === "entry" ||
        table === "document"
      ) {
        if (existing !== undefined)
          throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined)
          throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table)
          throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table)
          throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  private checkDocuments(actions: Map<number, DocumentAction>) {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id as number)) {
        throw new Error(
          `Document copy ${id} source is changed in the copy batch`,
        );
      }
      const existing = this.documents.get(id);
      if (action.create === undefined && existing === undefined)
        throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined)
        throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined)
        throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = this.versions.get(id);
        if (previous === undefined)
          throw new Error(`Document ${id} delta has no base`);
        if (previous !== action.content.version)
          throw new Error(`Document ${id} version transition requires a base`);
      }
      if (action.create === undefined && !action.retire) continue;
      const key = addressKey((action.create ?? existing)!);
      let live = liveCounts.get(key);
      if (live === undefined)
        live = this.current.get(key) === undefined ? 0 : 1;
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1)
        throw new Error("Document address already has a current incarnation");
    }
  }
}

/** The net writes of the accepted batches not yet written, per table. */
class PendingWrites {
  private recordIds = new Map<number, RecordTable>();
  private conversations: Cell[][] = [];
  private entries: Cell[][] = [];
  private tasks = new Map<number, (Cell | boolean)[]>();
  private submissions = new Map<number, Cell[]>();
  private documents = new Map<number, DocumentRecord>();
  private cleared = new Set<number>();
  private revisions = new Map<number, Cell[][]>();

  add(
    writes: readonly StorageWrite[],
    actions: Map<number, DocumentAction>,
    seq: Seq,
    state: CommitState,
  ) {
    for (const write of writes) this.addWrite(write, seq);
    for (const [id, action] of actions)
      this.addDocument(id, action, seq, state.document(id)!);
  }

  private addWrite(write: StorageWrite, seq: Seq) {
    const claim = claimOf(write);
    if (claim !== undefined) this.recordIds.set(claim.id, claim.table);
    switch (write.type) {
      case "conversation":
        this.conversations.push([
          write.value.id as number,
          (write.value.owner?.conversationId as number | undefined) ?? null,
          (write.value.owner?.taskId as number | undefined) ?? null,
          encodeJson(write.value),
        ]);
        break;
      case "entry":
        this.entries.push([
          write.value.id as number,
          write.value.conversationId as number,
          (write.value.head as number | undefined) ?? null,
          seq as number,
          encodeJson(write.value),
        ]);
        break;
      case "task":
        this.tasks.set(write.value.id as number, [
          write.value.id as number,
          write.value.conversationId as number,
          encodeIndexedString(write.value.kind),
          write.value.state.status,
          Boolean(write.value.abortRequested),
          Boolean(write.value.background),
          encodeJson(write.value),
        ]);
        break;
      case "submission":
        this.submissions.set(write.value.id as number, [
          write.value.id as number,
          write.value.conversationId as number,
          write.value.requestId === undefined
            ? null
            : encodeIndexedString(write.value.requestId),
          write.value.status,
          encodeJson(write.value),
        ]);
        break;
      default:
        break;
    }
  }

  private addDocument(
    id: number,
    action: DocumentAction,
    seq: Seq,
    record: DocumentRecord,
  ) {
    if (action.create !== undefined || action.retire)
      this.documents.set(id, record);
    const content = action.content;
    if (content !== undefined) {
      if (content.kind === "base" && isCurrentOnly(record)) this.clear(id);
      const encoded =
        content.kind === "base"
          ? encodeJson(content.value)
          : encodeJson(content.ops);
      let revisions = this.revisions.get(id);
      if (revisions === undefined) {
        revisions = [];
        this.revisions.set(id, revisions);
      }
      revisions.push([
        id,
        seq as number,
        content.kind,
        content.version,
        encoded,
      ]);
    }
    if (action.retire && isCurrentOnly(record)) this.clear(id);
  }

  private clear(id: number) {
    this.cleared.add(id);
    this.revisions.delete(id);
  }

  async flush(executor: Executor, s: string) {
    await insertRows(
      executor,
      `${s}.record_ids`,
      ["id", "record_type"],
      [...this.recordIds],
      "ON CONFLICT (id) DO NOTHING",
    );
    await insertRows(
      executor,
      `${s}.conversations`,
      ["id", "owner_conversation_id", "owner_task_id", "record"],
      this.conversations,
    );
    await insertRows(
      executor,
      `${s}.entries`,
      ["id", "conversation_id", "head", "commit_seq", "record"],
      this.entries,
    );
    await insertRows(
      executor,
      `${s}.tasks`,
      [
        "id",
        "conversation_id",
        "kind",
        "status",
        "abort_requested",
        "background",
        "record",
      ],
      [...this.tasks.values()],
      `ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
        status = excluded.status, abort_requested = excluded.abort_requested,
        background = excluded.background, record = excluded.record`,
    );
    await insertRows(
      executor,
      `${s}.submissions`,
      ["id", "conversation_id", "request_id", "status", "record"],
      [...this.submissions.values()],
      `ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id,
        request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
    );
    await insertRows(
      executor,
      `${s}.documents`,
      [
        "id",
        "kind",
        "family",
        "key_value",
        "scope_kind",
        "owner_id",
        "created_at",
        "retired_at",
        "record",
      ],
      [...this.documents.values()].map(documentRow),
      "ON CONFLICT (id) DO UPDATE SET retired_at = excluded.retired_at, record = excluded.record",
    );
    if (this.cleared.size > 0) {
      await readIn(
        executor,
        (l) =>
          `DELETE FROM ${s}.document_revisions WHERE document_id IN (${l})`,
        [...this.cleared],
      );
    }
    await insertRows(
      executor,
      `${s}.document_revisions`,
      ["document_id", "seq", "kind", "version", "content"],
      [...this.revisions.values()].flat(),
    );
    this.recordIds.clear();
    this.conversations.length = 0;
    this.entries.length = 0;
    this.tasks.clear();
    this.submissions.clear();
    this.documents.clear();
    this.cleared.clear();
    this.revisions.clear();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scans

function scanStart(
  requested: ScanOrder | undefined,
  cursor: Cursor | undefined,
  fallback: ScanOrder,
) {
  if (
    requested !== undefined &&
    requested !== "ascending" &&
    requested !== "descending"
  ) {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  if (cursor === undefined)
    return { order: requested ?? fallback, after: undefined };
  const { after, order: stored } = cursor as {
    after?: unknown;
    order?: unknown;
  };
  if (typeof after !== "number" || !Number.isSafeInteger(after))
    throw new StorageRequestError("Invalid storage cursor");
  if (
    stored !== undefined &&
    stored !== "ascending" &&
    stored !== "descending"
  ) {
    throw new StorageRequestError("Invalid storage cursor");
  }
  const order = (stored as ScanOrder | undefined) ?? fallback;
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(
      `The cursor continues a ${order} scan; the query asks for ${requested}`,
    );
  }
  return { order, after };
}

function page<T>(
  values: T[],
  limit: number,
  order: ScanOrder = "ascending",
): Page<T, Cursor> {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return {
    items,
    next: { after: (items.at(-1) as { id: number }).id, order } as Cursor,
  };
}

/** The ID condition (`$1`), its parameter, and the `ORDER BY` direction of a table scan. */
const scanSql = (start: { order: ScanOrder; after: number | undefined }) =>
  start.order === "ascending"
    ? { clause: "id > $1", param: start.after ?? -1, direction: "ASC" }
    : {
        clause: "id < $1",
        param: start.after ?? Number.MAX_SAFE_INTEGER,
        direction: "DESC",
      };

/** `clauses` with their parameters numbered from `$2` after the scan's `$1`, then `LIMIT`. */
class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];
  constructor(first?: { clause: string; param: unknown }) {
    if (first !== undefined) this.add(first.clause, first.param);
  }
  add(clause: string, ...params: unknown[]) {
    let index = this.params.length;
    this.clauses.push(clause.replace(/\$\d+|\?/g, () => `$${++index}`));
    this.params.push(...params);
    return this;
  }
  sql() {
    return this.clauses.join(" AND ");
  }
  limit(value: number) {
    this.params.push(value);
    return `LIMIT $${this.params.length}`;
  }
}

const isAliveAt = (record: DocumentRecord, at: DocumentPoint) => {
  if (at === "current") return record.retiredAt === undefined;
  return (
    record.createdAt <= at &&
    (record.retiredAt === undefined || at < record.retiredAt)
  );
};

// ---------------------------------------------------------------------------------------------------------------

/** Pi Durable storage in one Postgres schema. One process writes it at a time; any number may read. */
export class PostgresStorage implements Storage {
  private closed = false;
  private closing: Promise<void> | undefined;
  private admittedReads = 0;
  private readsDrained: (() => void) | undefined;
  /** Commits run one at a time: each reads the state the previous one left. */
  private commits: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly sql: SQL,
    private readonly writer: ReservedSQL,
    private readonly s: string,
    private nextId: number,
    private readonly ownsConnection: boolean,
  ) {}

  /** Opens (and migrates) Durable's tables in `options.schema` of the database `sql` connects to. */
  static async open(
    sql: SQL | string,
    options: PostgresStorageOptions = {},
  ): Promise<PostgresStorage> {
    const schema = options.schema ?? "pi";
    if (!SCHEMA_NAME.test(schema))
      throw new Error(`Invalid Postgres schema name: ${schema}`);
    const owns = typeof sql === "string";
    const db = typeof sql === "string" ? new Bun.SQL(sql) : sql;
    let writer: ReservedSQL | undefined;
    try {
      writer = await lockWriter(db, schema, options.lockTimeoutMs ?? 30_000);
      await migrate(db, schema);
      const [metadata] = await db.unsafe(
        `SELECT next_id FROM ${schema}.metadata WHERE singleton = 1`,
      );
      if (metadata === undefined)
        throw new Error("Durable Postgres metadata is missing");
      return new PostgresStorage(
        db,
        writer,
        schema,
        Number(metadata.next_id),
        owns,
      );
    } catch (error) {
      if (writer !== undefined) await PostgresStorage.unlock(writer, schema);
      if (owns) await db.close().catch(() => {});
      throw error;
    }
  }

  private static async unlock(writer: ReservedSQL, schema: string) {
    await writer
      .unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [
        `pi-durable-writer:${schema}`,
      ])
      .catch(() => {});
    writer.release();
  }

  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    _context: Context,
  ): Promise<CommitResult> {
    this.assertOpen();
    const run = this.commits.then(() => this.commitNow(batches, receive));
    this.commits = run.catch(() => {});
    return run;
  }

  private async commitNow(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
  ): Promise<CommitResult> {
    const seqs: Seq[] = [];
    let refused: { error: unknown } | undefined;
    let candidateNextId = this.nextId;
    await this.writer.begin(async (tx) => {
      const [metadata] = await tx.unsafe(
        `SELECT next_id, next_seq FROM ${this.s}.metadata WHERE singleton = 1 FOR UPDATE`,
      );
      if (metadata === undefined)
        throw new Error("Durable Postgres metadata is missing");
      let next = Number(metadata.next_seq);
      const state = await CommitState.read(tx, this.s, batches);
      const pending = new PendingWrites();
      for (const writes of batches) {
        const checked = await this.checkBatch(tx, state, pending, writes);
        if ("refused" in checked) {
          refused = { error: checked.refused };
          break;
        }
        const seq = next++ as Seq;
        state.apply(writes, checked.actions, seq);
        pending.add(writes, checked.actions, seq, state);
        seqs.push(seq);
        candidateNextId = Math.max(
          candidateNextId,
          this.candidateNextId(writes),
        );
      }
      await pending.flush(tx, this.s);
      if (seqs.length > 0) {
        await tx.unsafe(
          `UPDATE ${this.s}.metadata SET next_id = $1, next_seq = $2 WHERE singleton = 1`,
          [Math.max(Number(metadata.next_id), candidateNextId), next],
        );
      }
    });
    this.nextId = Math.max(this.nextId, candidateNextId);
    for (const [index, seq] of seqs.entries()) receive(index, seq);
    return refused === undefined
      ? { stored: seqs.length }
      : { stored: seqs.length, refused: refused.error };
  }

  private async checkBatch(
    tx: Executor,
    state: CommitState,
    pending: PendingWrites,
    writes: readonly StorageWrite[],
  ): Promise<{ actions: Map<number, DocumentAction> } | { refused: unknown }> {
    let actions: Map<number, DocumentAction>;
    try {
      actions = prepareDocumentActions(writes);
      state.check(writes, actions);
    } catch (error) {
      return { refused: error };
    }
    if (![...actions.values()].some((action) => action.copy !== undefined))
      return { actions };
    await pending.flush(tx, this.s);
    const calls = { failed: false };
    const watched: Executor = {
      unsafe: ((text: string, params?: unknown[]) => {
        const query = tx.unsafe(text, params);
        query.catch(() => {
          calls.failed = true;
        });
        return query;
      }) as Executor["unsafe"],
    };
    try {
      await this.resolveCopies(watched, actions);
    } catch (error) {
      if (calls.failed) throw error;
      return { refused: error };
    }
    return { actions };
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.assertOpen();
    if (!Number.isSafeInteger(this.nextId))
      throw new Error("ID space is exhausted");
    return this.nextId++ as unknown as I;
  }

  async conversation(
    id: ConversationId,
    _context: Context,
  ): Promise<ConversationRecord | undefined> {
    this.assertOpen();
    return this.readConversation(id);
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    this.assertOpen();
    const start = scanStart(query.order, cursor, "ascending");
    const scan = scanSql(start);
    const where = new Where(scan);
    if (query.ownerConversationId !== undefined)
      where.add("owner_conversation_id = ?", query.ownerConversationId);
    if (query.ownerTaskId !== undefined)
      where.add("owner_task_id = ?", query.ownerTaskId);
    const rows = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.conversations WHERE ${where.sql()} ORDER BY id ${scan.direction} ${where.limit(limit + 1)}`,
      where.params,
    );
    return page(
      rows.map((row: Row) => parseJson<ConversationRecord>(row.record)),
      limit,
      start.order,
    );
  }

  entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<StoredEntry | undefined>;
  entry(
    idOrConversationId: number,
    idOrContext: unknown,
    context?: Context,
  ): Promise<StoredEntry | undefined> {
    return this.admitRead(() =>
      this.readEntry(idOrConversationId, idOrContext, context),
    );
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.admitRead(() =>
      this.readLatestHeadMarker(conversationId, atOrBeforeEntryId),
    );
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.admitRead(() => this.readEntries(query, limit, cursor));
  }

  private async readEntry(
    idOrConversationId: number,
    idOrContext: unknown,
    context: Context | undefined,
  ) {
    const id =
      context === undefined
        ? idOrConversationId
        : typeof idOrContext === "number"
          ? idOrContext
          : undefined;
    if (id === undefined)
      throw new StorageRequestError("Storage.entry() requires an entry ID");
    let conversation: ConversationRecord | undefined;
    if (context !== undefined) {
      conversation = await this.readConversation(
        idOrConversationId as ConversationId,
      );
      if (conversation === undefined)
        throw new StorageRequestError(
          `Unknown conversation: ${idOrConversationId}`,
        );
    }
    const [row] = await this.sql.unsafe(
      `SELECT record, commit_seq FROM ${this.s}.entries WHERE id = $1`,
      [id],
    );
    if (row === undefined) return undefined;
    const entry = parseJson<EntryRecord>(row.record);
    if (conversation !== undefined) {
      let upperEntryId = Number.POSITIVE_INFINITY;
      while (conversation.id !== entry.conversationId) {
        if (conversation.parent === undefined) return undefined;
        upperEntryId = Math.min(upperEntryId, conversation.parent.at as number);
        conversation = (await this.readConversation(
          conversation.parent.conversationId,
        ))!;
      }
      if ((entry.id as number) > upperEntryId) return undefined;
    }
    return { entry, commitSeq: Number(row.commit_seq) as Seq };
  }

  private async readLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
  ) {
    let conversation = await this.readConversation(conversationId);
    if (conversation === undefined)
      throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    let upper = atOrBeforeEntryId as number | undefined;
    while (true) {
      const [row] =
        upper === undefined
          ? await this.sql.unsafe(
              `SELECT record FROM ${this.s}.entries WHERE conversation_id = $1 AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
              [conversation.id],
            )
          : await this.sql.unsafe(
              `SELECT record FROM ${this.s}.entries
                WHERE conversation_id = $1 AND head IS NOT NULL AND id <= $2 ORDER BY id DESC LIMIT 1`,
              [conversation.id, upper],
            );
      if (row !== undefined)
        return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
      if (conversation.parent === undefined) return undefined;
      const at = conversation.parent.at as number;
      upper = upper === undefined ? at : Math.min(upper, at);
      conversation = (await this.readConversation(
        conversation.parent.conversationId,
      ))!;
    }
  }

  private async readEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<Page<EntryRecord, Cursor>> {
    const { order, after } = scanStart(query.order, cursor, "descending");
    if (order === "ascending")
      return this.readEntriesAscending(query, limit, after);
    let conversation = await this.readConversation(query.conversationId);
    if (conversation === undefined)
      throw new StorageRequestError(
        `Unknown conversation: ${query.conversationId}`,
      );
    const minEntryId = query.minEntryId as number | undefined;
    let upper = query.maxEntryId as number | undefined;
    if (after !== undefined)
      upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
    const values: EntryRecord[] = [];
    while (true) {
      const where = new Where().add("conversation_id = ?", conversation.id);
      if (minEntryId !== undefined) where.add("id >= ?", minEntryId);
      if (upper !== undefined) where.add("id <= ?", upper);
      const rows = await this.sql.unsafe(
        `SELECT record FROM ${this.s}.entries WHERE ${where.sql()} ORDER BY id DESC ${where.limit(limit + 1 - values.length)}`,
        where.params,
      );
      values.push(
        ...rows.map((row: Row) => parseJson<EntryRecord>(row.record)),
      );
      if (values.length > limit || conversation.parent === undefined) break;
      const at = conversation.parent.at as number;
      upper = upper === undefined ? at : Math.min(upper, at);
      if (minEntryId !== undefined && upper < minEntryId) break;
      conversation = (await this.readConversation(
        conversation.parent.conversationId,
      ))!;
    }
    return page(values, limit, "descending");
  }

  /** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
  private async readEntriesAscending(
    query: EntryQuery,
    limit: number,
    after: number | undefined,
  ) {
    const segments: {
      conversationId: ConversationId;
      upper: number | undefined;
    }[] = [];
    let conversation = await this.readConversation(query.conversationId);
    if (conversation === undefined)
      throw new StorageRequestError(
        `Unknown conversation: ${query.conversationId}`,
      );
    const minEntryId = query.minEntryId as number | undefined;
    let upper = query.maxEntryId as number | undefined;
    while (true) {
      segments.push({ conversationId: conversation.id, upper });
      if (conversation.parent === undefined) break;
      const at = conversation.parent.at as number;
      upper = upper === undefined ? at : Math.min(upper, at);
      if (minEntryId !== undefined && upper < minEntryId) break;
      conversation = (await this.readConversation(
        conversation.parent.conversationId,
      ))!;
    }
    let lower = minEntryId;
    if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
    const values: EntryRecord[] = [];
    for (const segment of segments.reverse()) {
      const where = new Where().add(
        "conversation_id = ?",
        segment.conversationId,
      );
      if (lower !== undefined) where.add("id >= ?", lower);
      if (segment.upper !== undefined) where.add("id <= ?", segment.upper);
      const rows = await this.sql.unsafe(
        `SELECT record FROM ${this.s}.entries WHERE ${where.sql()} ORDER BY id ASC ${where.limit(limit + 1 - values.length)}`,
        where.params,
      );
      values.push(
        ...rows.map((row: Row) => parseJson<EntryRecord>(row.record)),
      );
      if (values.length > limit) break;
    }
    return page(values, limit, "ascending");
  }

  async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    this.assertOpen();
    const [row] = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.tasks WHERE id = $1`,
      [id],
    );
    return row === undefined ? undefined : parseJson<StoredTask>(row.record);
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<StoredTask, Cursor>> {
    this.assertOpen();
    const start = scanStart(query.order, cursor, "ascending");
    const scan = scanSql(start);
    const where = new Where(scan);
    if (query.conversationId !== undefined)
      where.add("conversation_id = ?", query.conversationId);
    if (query.kind !== undefined)
      where.add("kind = ?", encodeIndexedString(query.kind));
    if (query.status !== undefined) where.add("status = ?", query.status);
    if (query.abortRequested !== undefined)
      where.add("abort_requested = ?", query.abortRequested);
    if (query.background !== undefined)
      where.add("background = ?", query.background);
    const rows = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.tasks WHERE ${where.sql()} ORDER BY id ${scan.direction} ${where.limit(limit + 1)}`,
      where.params,
    );
    return page(
      rows.map((row: Row) => parseJson<StoredTask>(row.record)),
      limit,
      start.order,
    );
  }

  async submission(
    id: SubmissionId,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    this.assertOpen();
    const [row] = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.submissions WHERE id = $1`,
      [id],
    );
    return row === undefined
      ? undefined
      : parseJson<SubmissionRecord>(row.record);
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    this.assertOpen();
    const start = scanStart(query.order, cursor, "ascending");
    const scan = scanSql(start);
    const where = new Where(scan);
    if (query.conversationId !== undefined)
      where.add("conversation_id = ?", query.conversationId);
    if (query.status !== undefined) where.add("status = ?", query.status);
    const rows = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.submissions WHERE ${where.sql()} ORDER BY id ${scan.direction} ${where.limit(limit + 1)}`,
      where.params,
    );
    return page(
      rows.map((row: Row) => parseJson<SubmissionRecord>(row.record)),
      limit,
      start.order,
    );
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ) {
    this.assertOpen();
    const [row] = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.submissions WHERE conversation_id = $1 AND request_id = $2`,
      [conversationId, encodeIndexedString(requestId)],
    );
    return row === undefined
      ? undefined
      : parseJson<SubmissionRecord>(row.record);
  }

  async findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    this.assertOpen();
    const p = addressParts(address);
    const where = new Where()
      .add("kind = ?", p.kind)
      .add("scope_kind = ?", p.scopeKind)
      .add("owner_id = ?", p.ownerId)
      .add("family = ?", p.family)
      .add("key_value = ?", p.keyValue);
    if (at === "current") where.add("retired_at IS NULL");
    else
      where.add(
        "created_at <= ? AND (retired_at IS NULL OR retired_at > ?)",
        at,
        at,
      );
    const [row] = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.documents WHERE ${where.sql()} ORDER BY created_at DESC LIMIT 1`,
      where.params,
    );
    return row === undefined
      ? undefined
      : parseJson<DocumentRecord>(row.record);
  }

  async document(
    id: DocumentId,
    at: DocumentPoint,
    _context: Context,
  ): Promise<StoredDocument | undefined> {
    this.assertOpen();
    // The record and its revisions must come from one snapshot: a commit between them can replace the base.
    return this.sql.begin("isolation level repeatable read read only", (tx) =>
      this.materializeDocument(tx, id as number, at),
    );
  }

  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    this.assertOpen();
    const scope = scopeColumns(query.scope);
    const after = (cursor as { after?: unknown } | undefined)?.after;
    if (
      cursor !== undefined &&
      (typeof after !== "number" || !Number.isSafeInteger(after))
    ) {
      throw new StorageRequestError("Invalid storage cursor");
    }
    const where = new Where()
      .add("scope_kind = ?", scope.scopeKind)
      .add("owner_id = ?", scope.ownerId)
      .add("id > ?", (after as number | undefined) ?? -1);
    if (query.kind !== undefined)
      where.add("kind = ?", encodeIndexedString(query.kind));
    if (query.at === "current") where.add("retired_at IS NULL");
    else
      where.add(
        "created_at <= ? AND (retired_at IS NULL OR retired_at > ?)",
        query.at,
        query.at,
      );
    const rows = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.documents WHERE ${where.sql()} ORDER BY id ${where.limit(limit + 1)}`,
      where.params,
    );
    return page(
      rows.map((row: Row) => parseJson<DocumentRecord>(row.record)),
      limit,
    );
  }

  close(_context: Context): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      this.closing = this.closeConnection();
    }
    return this.closing;
  }

  private async closeConnection() {
    await this.commits;
    if (this.admittedReads > 0) {
      await new Promise<void>((resolve) => {
        this.readsDrained = resolve;
      });
    }
    await PostgresStorage.unlock(this.writer, this.s);
    if (this.ownsConnection) await this.sql.close();
  }

  /** A read of several queries: close waits for it, so its later queries never reach a closed connection. */
  private async admitRead<T>(read: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.admittedReads++;
    try {
      return await read();
    } finally {
      if (--this.admittedReads === 0) this.readsDrained?.();
    }
  }

  private async readConversation(
    id: ConversationId,
  ): Promise<ConversationRecord | undefined> {
    const [row] = await this.sql.unsafe(
      `SELECT record FROM ${this.s}.conversations WHERE id = $1`,
      [id],
    );
    return row === undefined
      ? undefined
      : parseJson<ConversationRecord>(row.record);
  }

  private async materializeDocument(
    executor: Executor,
    id: number,
    at: DocumentPoint,
  ): Promise<StoredDocument | undefined> {
    const [row] = await executor.unsafe(
      `SELECT record FROM ${this.s}.documents WHERE id = $1`,
      [id],
    );
    if (row === undefined) return undefined;
    const record = parseJson<DocumentRecord>(row.record);
    if (at !== "current" && isCurrentOnly(record)) {
      throw new StorageRequestError(
        `Document ${id} does not retain historical content`,
      );
    }
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    const [base] = await executor.unsafe(
      `SELECT seq, kind, version, content FROM ${this.s}.document_revisions
        WHERE document_id = $1 AND kind = 'base' AND seq <= $2 ORDER BY seq DESC LIMIT 1`,
      [id, upper],
    );
    if (base === undefined)
      throw new Error(`Document ${id} is missing a required base`);
    const version = Number(base.version);
    let value = parseJson<JsonValue>(base.content);
    const tail = await executor.unsafe(
      `SELECT seq, kind, version, content FROM ${this.s}.document_revisions
        WHERE document_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`,
      [id, base.seq, upper],
    );
    for (const revision of tail) {
      if (revision.kind !== "delta" || Number(revision.version) !== version) {
        throw new Error(
          `Document ${id} crosses a stored version boundary without a base`,
        );
      }
      value = apply(value, parseJson(revision.content));
    }
    return {
      record,
      version,
      value,
      deltasSinceBase: tail.length,
    } as StoredDocument;
  }

  private candidateNextId(writes: readonly StorageWrite[]) {
    let nextId = this.nextId;
    for (const write of writes) {
      const id = claimOf(write)?.id;
      if (id !== undefined) nextId = Math.max(nextId, id + 1);
    }
    return nextId;
  }

  /** Resolves each copy to a base of its source's state before this batch, which may not change the source. */
  private async resolveCopies(
    executor: Executor,
    actions: Map<number, DocumentAction>,
  ) {
    for (const [id, action] of actions) {
      if (action.copy === undefined) continue;
      try {
        const stored = await this.materializeDocument(
          executor,
          action.copy.id as number,
          action.copy.at as DocumentPoint,
        );
        if (stored === undefined)
          throw new Error(
            `Fork source document ${action.copy.id} cannot be read`,
          );
        const create = action.create!;
        if (
          stored.record.scope.kind !== "conversation" ||
          create.scope.kind !== "conversation" ||
          stored.record.kind !== create.kind ||
          stored.record.key !== create.key ||
          stored.record.history !== create.history ||
          stored.record.fork !== create.fork
        ) {
          throw new Error(
            `Fork source document ${action.copy.id} does not match the copied record`,
          );
        }
        action.content = {
          kind: "base",
          version: stored.version,
          value: stored.value,
        } as DocumentContent;
      } catch (error) {
        throw new Error(`Document copy ${id} was rejected`, { cause: error });
      }
    }
  }

  private assertOpen() {
    if (this.closed) throw new Error("PostgresStorage is closed");
  }
}
