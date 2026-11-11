import { useCallback, useEffect, useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
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
        <Spinner className="text-muted-foreground" />
      </div>
    );

  if (database === null)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No database yet</EmptyTitle>
          <EmptyDescription>
            Give the app a database to keep data and sign users in. Richelieu
            adds one by itself when you ask for something that needs it.
          </EmptyDescription>
        </EmptyHeader>
        <Button disabled={enabling} onClick={() => void enable()}>
          {enabling && <Spinner />}
          Add a database
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Empty>
    );

  const table =
    database.tables.find((t) => t.name === selected) ?? database.tables[0];
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        <p className="px-3 py-1 font-mono text-xs text-muted-foreground">
          {database.schema.slice(0, 12)}…
        </p>
        {database.tables.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No tables yet. Ask Richelieu to create some.
          </p>
        )}
        {database.tables.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => setSelected(t.name)}
            className={cn(
              "flex items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-muted",
              t.name === table?.name && "bg-muted",
            )}
          >
            <span className="truncate">{t.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
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
