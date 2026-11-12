import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror, {
  keymap,
  Prec,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { Tag } from "twenty-ui/primitives/data-display";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconTerminal2,
} from "twenty-ui/icon";

import { DataGrid } from "@/components/data-grid";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { api } from "@/lib/api";
import { intlLocale } from "@/lib/i18n";
import { guessType } from "@/lib/sql-types";

type QueryResult =
  | {
      ok: true;
      command: string | null;
      count: number;
      statements: number;
      columns: { name: string; type: string | null }[];
      rows: unknown[][];
      truncated: boolean;
      durationMs: number;
    }
  | {
      ok: false;
      message: string;
      detail: string | null;
      hint: string | null;
      position: number | null;
      durationMs: number;
    };

const draftKey = (threadId: string) => `richelieu.sql.${threadId}`;

function readDraft(threadId: string) {
  try {
    return localStorage.getItem(draftKey(threadId));
  } catch {
    return null;
  }
}

function saveDraft(threadId: string, text: string) {
  try {
    localStorage.setItem(draftKey(threadId), text);
  } catch {
    // The draft only lives as long as the tab then.
  }
}

/** Line and column, from 1, of a character position Postgres reports from 1. */
function lineAndColumn(text: string, position: number) {
  const before = text.slice(0, position - 1).split("\n");
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

function Summary({ result }: { result: Extract<QueryResult, { ok: true }> }) {
  const { t } = useTranslation("builder");
  const rows = { count: result.count, formatted: result.count.toLocaleString(intlLocale()) };
  const reads = result.command === "SELECT" || result.columns.length > 0;
  return (
    <>
      {result.command && (
        <Tag
          color={reads ? "blue" : "green"}
          variant="soft"
          className="font-mono text-[11px]"
        >
          {result.command}
        </Tag>
      )}
      <span className="text-t-text-secondary">
        {reads ? t("sql.rows", rows) : t("sql.rowsChanged", rows)}
        {result.truncated &&
          t("sql.firstShown", { shown: result.rows.length.toLocaleString(intlLocale()) })}
      </span>
      {result.statements > 1 && (
        <span className="text-t-text-tertiary">
          · {t("sql.lastOf", { count: result.statements })}
        </span>
      )}
    </>
  );
}

/**
 * The SQL editor: write a query against the app's database, run it as the app's own role with ⌘↵, and read the
 * rows or Postgres's error below. Completes the app's table and column names.
 */
export function SqlEditor({
  threadId,
  tables,
  initialText,
  onChanged,
}: {
  threadId: string;
  tables: { name: string; columns: { name: string }[] }[];
  /** Text to start from instead of the saved draft, such as a query on the table the user came from. */
  initialText?: string;
  /** Called after a statement that may have changed the tables or their rows. */
  onChanged: () => void;
}) {
  const { t } = useTranslation("builder");
  const scheme = useColorScheme();
  const [text, setText] = useState(
    () =>
      initialText ??
      readDraft(threadId) ??
      (tables[0]
        ? `select * from ${tables[0].name} limit 100;`
        : "select now();"),
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Where an error is in the editor's text, worked out when the query ran (it may have been a selection).
  const [errorAt, setErrorAt] = useState<string | null>(null);
  const editor = useRef<ReactCodeMirrorRef>(null);
  const latest = useRef({ text, running });
  latest.current = { text, running };

  async function run() {
    const { text, running } = latest.current;
    if (running || !text.trim()) return;
    // A selection runs just the selected statement.
    const view = editor.current?.view;
    const selection = view?.state.selection.main;
    const partial = view && selection && !selection.empty;
    const query = partial
      ? view.state.sliceDoc(selection.from, selection.to)
      : text;
    const offset = partial ? selection.from : 0;
    setRunning(true);
    setFailure(null);
    try {
      const next = await api<QueryResult>(
        `/api/projects/${threadId}/database/query`,
        { method: "POST", body: { sql: query } },
      );
      setResult(next);
      if (!next.ok && next.position !== null) {
        const at = lineAndColumn(text, offset + next.position);
        setErrorAt(t("sql.errorAt", { line: at.line, column: at.column }));
      } else setErrorAt(null);
      if (next.ok && next.command !== "SELECT") onChanged();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("sql.runFailed"),
      );
    } finally {
      setRunning(false);
    }
  }

  const extensions = useMemo(
    () => [
      sql({
        dialect: PostgreSQL,
        schema: Object.fromEntries(
          tables.map((table) => [table.name, table.columns.map((c) => c.name)]),
        ),
      }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              void run();
              return true;
            },
          },
        ]),
      ),
    ],
    // run reads the latest text and state through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tables],
  );

  const columns =
    result?.ok === true
      ? result.columns.map((column, index) => ({
          name: column.name,
          type: column.type ?? guessType(result.rows.map((row) => row[index])),
        }))
      : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-t-border-light px-3">
        <IconTerminal2 size={16} className="shrink-0 text-t-text-tertiary" />
        <span className="shrink-0 font-medium whitespace-nowrap text-t-text">
          {t("sql.title")}
        </span>
        <span className="hidden min-w-0 truncate text-t-text-tertiary md:inline">
          {t("sql.runsAs")}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="solid"
          color="accent"
          loading={running}
          loadingPosition="start"
          startIcon={<IconPlayerPlay size={14} />}
          shortcut={["Mod", "Enter"]}
          onClick={() => void run()}
        >
          {t("sql.run")}
        </Button>
      </div>
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="38" minSize={80}>
          <CodeMirror
            ref={editor}
            value={text}
            onChange={(value) => {
              setText(value);
              saveDraft(threadId, value);
            }}
            extensions={extensions}
            height="100%"
            className="h-full overflow-auto text-[13px]"
            basicSetup={{ foldGutter: false }}
            theme={scheme}
            autoFocus
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={80} className="flex flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-t-border-light bg-t-secondary px-3 text-[12px]">
            <span className="font-medium text-t-text-secondary">{t("sql.results")}</span>
            {result?.ok === true && <Summary result={result} />}
            {result?.ok === false && (
              <Tag color="red" variant="soft" className="text-[11px]">
                {t("sql.error")}
              </Tag>
            )}
            {result && (
              <span className="ml-auto text-t-text-light tabular-nums">
                {result.durationMs} ms
              </span>
            )}
          </div>
          <div className="relative min-h-0 flex-1 overflow-auto">
            {running && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-t-primary/60">
                <Loader />
              </div>
            )}
            {failure && <p className="p-4 text-t-text-danger">{failure}</p>}
            {!failure && result === null && (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-t-text-tertiary">
                <p>{t("sql.emptyTitle")}</p>
                <p className="text-[12px] text-t-text-light">
                  {t("sql.emptyHint")}
                </p>
              </div>
            )}
            {!failure && result?.ok === false && (
              <div className="m-3 flex gap-2.5 rounded-md border border-[var(--t-color-red6)] bg-[var(--t-color-red3)] p-3">
                <IconAlertTriangle
                  size={16}
                  className="mt-px shrink-0 text-[var(--t-color-red10)]"
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-medium text-[var(--t-color-red11)]">
                    {result.message}
                  </p>
                  {errorAt && (
                    <p className="text-[12px] text-t-text-secondary">
                      {errorAt}
                    </p>
                  )}
                  {result.detail && (
                    <p className="text-t-text-secondary">{result.detail}</p>
                  )}
                  {result.hint && (
                    <p className="text-t-text-secondary">{t("sql.hint", { hint: result.hint })}</p>
                  )}
                </div>
              </div>
            )}
            {!failure && result?.ok === true && (
              <DataGrid
                columns={columns}
                rows={result.rows}
                empty={
                  result.command === "SELECT"
                    ? t("sql.noRows")
                    : t("sql.noRowsStatement")
                }
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
