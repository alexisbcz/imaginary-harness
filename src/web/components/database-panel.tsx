import { useCallback, useEffect, useState } from "react";
import { cn } from "cn";

import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { IconDatabase, IconTable } from "twenty-ui/icon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

type Database = {
  schema: string;
  tables: {
    name: string;
    columns: { name: string; type: string }[];
    rows: Record<string, unknown>[];
    count: number;
  }[];
};

function cell(value: unknown) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">null</span>;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The app's database: its tables, their columns and first rows. The agent creates and changes them. */
export function DatabasePanel({
  threadId,
  revision,
}: {
  threadId: string;
  revision: string;
}) {
  const [database, setDatabase] = useState<Database | null | undefined>(
    undefined,
  );
  const [selected, setSelected] = useState<string | null>(null);
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
          : "Could not create the database",
      );
    } finally {
      setEnabling(false);
    }
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
        <span className="flex size-10 items-center justify-center rounded-md border border-t-border bg-t-primary text-t-text-tertiary shadow-[0_2px_4px_rgb(0_0_0/0.04)]">
          <IconDatabase size={20} />
        </span>
        <div className="flex max-w-sm flex-col gap-1">
          <p className="font-semibold text-t-text">No database yet</p>
          <p className="leading-[1.45] text-t-text-tertiary">
            Give the app a database to keep data and sign users in. Richelieu
            adds one by itself when you ask for something that needs it.
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
          Add a database
        </Button>
        {error && <p className="text-t-text-danger">{error}</p>}
      </div>
    );

  const table =
    database.tables.find((t) => t.name === selected) ?? database.tables[0];
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col gap-px overflow-y-auto border-r border-t-border-light p-2">
        <p className="px-2 pt-1 pb-1.5 font-mono text-[11px] text-t-text-light">
          {database.schema.slice(0, 12)}…
        </p>
        {database.tables.length === 0 && (
          <p className="px-2 py-1 text-t-text-tertiary">
            No tables yet. Ask Richelieu to create some.
          </p>
        )}
        {database.tables.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => setSelected(t.name)}
            className={cn(
              "flex h-7 items-center gap-2 rounded-sm px-2 text-left text-t-text-secondary outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring",
              t.name === table?.name && "bg-t-press text-t-text",
            )}
          >
            <IconTable size={14} className="shrink-0 text-t-text-tertiary" />
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            <span className="text-[12px] text-t-text-light tabular-nums">
              {t.count}
            </span>
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {table && (
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                {table.columns.map((column) => (
                  <TableHead key={column.name} className="whitespace-nowrap">
                    {column.name}{" "}
                    <span className="font-normal text-muted-foreground">
                      {column.type}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row, index) => (
                <TableRow key={index}>
                  {table.columns.map((column) => (
                    <TableCell
                      key={column.name}
                      className="max-w-64 truncate font-mono"
                    >
                      {cell(row[column.name])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
