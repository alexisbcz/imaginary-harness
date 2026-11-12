import { useCallback, useEffect, useState } from "react";
import { IconDatabaseFilled } from "@tabler/icons-react";
import { Trans, useTranslation } from "react-i18next";
import { SegmentedControl } from "twenty-ui/components/input";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import { LightIconButton } from "twenty-ui/components/input";
import {
  IconArrowLeft,
  IconColumns,
  IconDatabase,
  IconKey,
  IconLayoutList,
  IconLink,
  IconTable,
  IconTerminal2,
} from "twenty-ui/icon";

import { DataGrid, TypeTag, type GridColumn } from "@/components/data-grid";
import { IconTile } from "@/components/icon-tile";
import { SqlEditor } from "@/components/sql-editor";
import { TableBrowser, type Filter } from "@/components/table-browser";
import { api } from "@/lib/api";
import { intlLocale } from "@/lib/i18n";

type Column = GridColumn & {
  nullable: boolean;
  default: string | null;
};

type Table = {
  name: string;
  columns: Column[];
  rows: unknown[][];
  count: number;
};

type Database = { schema: string; tables: Table[] };

type View =
  | {
      kind: "table";
      name: string | null;
      tab: "data" | "structure";
      /** Filters to open the table with, such as the row a foreign key points to. */
      filters?: Filter[];
      key?: number;
    }
  | { kind: "sql"; initialText?: string; key: number };

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-4 pb-1 text-[11px] font-semibold text-t-text-light">
      {children}
    </div>
  );
}

/** Each column with its type, whether it may be empty, its default and its keys. */
function Structure({ table }: { table: Table }) {
  const { t } = useTranslation("builder");
  return (
    <table className="w-full border-separate border-spacing-0 text-[13px]">
      <thead>
        <tr className="text-left text-[12px] text-t-text-tertiary">
          {(["column", "type", "empty", "default", "keys"] as const).map((label) => (
            <th
              key={label}
              className="sticky top-0 h-9 border-b border-t-border-light bg-t-secondary px-3 font-medium"
            >
              {t(`database.structure.${label}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.columns.map((column) => (
          <tr key={column.name} className="hover:bg-t-hover">
            <td className="h-10 border-b border-t-border-light px-3 font-medium text-t-text">
              {column.name}
            </td>
            <td className="border-b border-t-border-light px-3">
              <TypeTag type={column.type} />
            </td>
            <td className="border-b border-t-border-light px-3 text-t-text-secondary">
              {column.nullable ? (
                t("database.structure.allowed")
              ) : (
                <span className="text-t-text-tertiary">{t("database.structure.required")}</span>
              )}
            </td>
            <td className="max-w-72 truncate border-b border-t-border-light px-3 font-mono text-[12px] text-t-text-tertiary">
              {column.default ?? <span className="text-t-text-light">—</span>}
            </td>
            <td className="border-b border-t-border-light px-3">
              <span className="flex items-center gap-1.5">
                {column.primary && (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--t-color-amber3)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-color-amber11)]">
                    <IconKey size={12} /> {t("database.structure.primary")}
                  </span>
                )}
                {column.references && (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--t-color-sky3)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-color-sky11)]">
                    <IconLink size={12} /> {column.references}
                  </span>
                )}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The app's database: its tables with their first rows and their structure, and a SQL editor to query it. The agent
 * creates and changes the tables; the user can too, from the editor.
 */
export function DatabasePanel({
  threadId,
  revision,
}: {
  threadId: string;
  revision: string;
}) {
  const { t } = useTranslation("builder");
  const { t: tc } = useTranslation("common");
  const [database, setDatabase] = useState<Database | null | undefined>(
    undefined,
  );
  const [view, setView] = useState<View>({
    kind: "table",
    name: null,
    tab: "data",
  });
  // Where following foreign keys came from, to go back.
  const [trail, setTrail] = useState<View[]>([]);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ database: Database | null }>(`/api/projects/${threadId}/database`)
      .then((result) => setDatabase(result.database))
      .catch((error) => {
        setError(error.message);
        setDatabase(null);
      });
  }, [threadId]);
  useEffect(load, [load, revision]);

  async function enable() {
    setEnabling(true);
    setError(null);
    try {
      await api(`/api/projects/${threadId}/database`, { method: "POST" });
      load();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("database.createFailed"),
      );
    } finally {
      setEnabling(false);
    }
  }

  function query(text?: string) {
    setTrail([]);
    setView({ kind: "sql", initialText: text, key: Date.now() });
  }

  function open(next: View) {
    setTrail([]);
    setView(next);
  }

  function follow(table: string, filter: Filter) {
    setTrail((current) => [...current, view]);
    setView({
      kind: "table",
      name: table,
      tab: "data",
      filters: [filter],
      key: Date.now(),
    });
  }

  function back() {
    const previous = trail.at(-1);
    if (!previous) return;
    setTrail(trail.slice(0, -1));
    setView(previous);
  }

  if (database === undefined)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader />
      </div>
    );

  if (database === null)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <IconTile size="lg" color="green">
          <IconDatabaseFilled />
        </IconTile>
        <div className="flex max-w-sm flex-col gap-1">
          <p className="font-semibold text-t-text">{t("database.emptyTitle")}</p>
          <p className="leading-[1.45] text-t-text-tertiary">
            {t("database.emptyBody")}
          </p>
        </div>
        <Button
          size="sm"
          variant="solid"
          color="accent"
          loading={enabling}
          loadingPosition="start"
          startIcon={<IconDatabase size={14} />}
          onClick={() => void enable()}
        >
          {t("database.add")}
        </Button>
        {error && <p className="text-t-text-danger">{error}</p>}
      </div>
    );

  const previous = trail.at(-1);
  const previousName = previous?.kind === "table" ? previous.name : null;
  const table =
    view.kind === "table"
      ? (database.tables.find((t) => t.name === view.name) ??
        database.tables[0])
      : undefined;

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label={t("database.nav")}
        className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-t-border-light p-2"
      >
        <ListItem
          render={<button type="button" />}
          startIcon={
            <IconTile color="purple">
              <IconTerminal2 />
            </IconTile>
          }
          selected={view.kind === "sql"}
          onClick={() => view.kind !== "sql" && query()}
        >
          {t("database.sqlEditor")}
        </ListItem>
        <SectionLabel>{t("database.tables")}</SectionLabel>
        <div className="flex flex-col gap-px">
          {database.tables.length === 0 && (
            <p className="px-1 py-1 leading-[1.45] text-t-text-tertiary">
              <Trans
                t={t}
                i18nKey="database.noTables"
                components={{ code: <code className="font-mono text-[12px]" /> }}
              />
            </p>
          )}
          {database.tables.map((item) => (
            <ListItem
              key={item.name}
              render={<button type="button" />}
              startIcon={
                <IconTile color="green">
                  <IconTable />
                </IconTile>
              }
              selected={view.kind === "table" && item.name === table?.name}
              description={item.count.toLocaleString(intlLocale())}
              descriptionPlacement="end"
              onClick={() =>
                open({
                  kind: "table",
                  name: item.name,
                  tab: view.kind === "table" ? view.tab : "data",
                  key: Date.now(),
                })
              }
            >
              {item.name}
            </ListItem>
          ))}
        </div>
        <p
          className="mt-auto truncate px-1 pt-3 font-mono text-[11px] text-t-text-light"
          title={database.schema}
        >
          {database.schema}
        </p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {view.kind === "sql" ? (
          <SqlEditor
            key={view.key}
            threadId={threadId}
            tables={database.tables}
            initialText={view.initialText}
            onChanged={load}
          />
        ) : table ? (
          <>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-t-border-light px-3">
              {trail.length > 0 ? (
                <LightIconButton
                  aria-label={tc("back")}
                  tooltip={
                    previousName
                      ? t("database.backTo", { table: previousName })
                      : t("database.backToPrevious")
                  }
                  size="sm"
                  onClick={back}
                >
                  <IconArrowLeft size={16} />
                </LightIconButton>
              ) : (
                <IconTable
                  size={16}
                  className="shrink-0 text-t-text-tertiary"
                />
              )}
              <span className="truncate font-medium text-t-text">
                {table.name}
              </span>
              <span className="shrink-0 text-t-text-tertiary">
                {t("database.rows", {
                  count: table.count,
                  formatted: table.count.toLocaleString(intlLocale()),
                })}{" "}
                · {t("database.columns", { count: table.columns.length })}
              </span>
              <span className="flex-1" />
              <SegmentedControl<"data" | "structure">
                aria-label={t("database.view")}
                size="sm"
                value={view.tab}
                onValueChange={(tab) => setView({ ...view, tab })}
                options={[
                  {
                    value: "data",
                    startIcon: <IconLayoutList size={14} />,
                    label: t("database.data"),
                  },
                  {
                    value: "structure",
                    startIcon: <IconColumns size={14} />,
                    label: t("database.structure.title"),
                  },
                ]}
              />
            </div>
            {/* Kept mounted under Structure, so its search, filters and page are there on coming back. */}
            <div className={view.tab === "data" ? "min-h-0 flex-1" : "hidden"}>
              <TableBrowser
                key={`${table.name}:${view.key ?? 0}`}
                threadId={threadId}
                table={table.name}
                columns={table.columns}
                total={table.count}
                revision={revision}
                initialFilters={view.filters}
                onFollow={follow}
                onQuery={query}
              />
            </div>
            {view.tab === "structure" && (
              <div className="min-h-0 flex-1 overflow-auto">
                <Structure table={table} />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-t-text-tertiary">
            <p>{t("database.noTablesYet")}</p>
            <Button
              size="sm"
              variant="outline"
              startIcon={<IconTerminal2 size={14} />}
              onClick={() => query()}
            >
              {t("database.openSql")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
