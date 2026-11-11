import { useEffect, useRef, type ReactNode } from "react";
import { format } from "date-fns";
import { cn } from "cn";
import { Tag } from "twenty-ui/primitives/data-display";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowUpRight,
  IconKey,
  IconLink,
} from "twenty-ui/icon";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  isArrayType,
  kindColor,
  typeKind,
  type TypeKind,
} from "@/lib/sql-types";

export type GridColumn = {
  name: string;
  type: string;
  primary?: boolean;
  references?: string | null;
  referencesColumn?: string | null;
};

export type GridSort = { column: string; direction: "asc" | "desc" } | null;
export type GridCell = { row: number; column: number };

/** A Postgres type as a small colored tag: blue numbers, green text, purple times… */
export function TypeTag({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  return (
    <Tag
      color={kindColor[typeKind(type)]}
      variant="soft"
      className={cn("font-mono text-[11px]", className)}
    >
      {type}
    </Tag>
  );
}

/** A value as text to copy: what you would type back into SQL or a filter. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The parts of `text` that match `query`, ignoring case, marked. */
export function Highlight({ text, query }: { text: string; query?: string }) {
  const needle = query?.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, from)
  ) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark
        key={at}
        className="rounded-[2px] bg-[var(--t-color-yellow5)] text-inherit"
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function Null() {
  return (
    <span className="rounded-[3px] bg-t-tertiary px-1 font-mono text-[11px] text-t-text-light">
      NULL
    </span>
  );
}

const MAX_LIST_ITEMS = 3;

/** A value the way its type reads best: dots for booleans, chips for lists, dates split from times… */
export function Value({
  value,
  kind,
  highlight,
}: {
  value: unknown;
  kind: TypeKind;
  highlight?: string;
}): ReactNode {
  if (value === null || value === undefined) return <Null />;
  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="font-mono text-t-text-light">[]</span>;
    return (
      <span className="flex items-center gap-1">
        {value.slice(0, MAX_LIST_ITEMS).map((item, index) => (
          <Tag
            key={index}
            color="gray"
            variant="soft"
            className="max-w-40"
            truncate
          >
            <Highlight text={valueText(item)} query={highlight} />
          </Tag>
        ))}
        {value.length > MAX_LIST_ITEMS && (
          <span className="text-[11px] text-t-text-light">
            +{value.length - MAX_LIST_ITEMS}
          </span>
        )}
      </span>
    );
  }
  if (kind === "bool" || typeof value === "boolean")
    return (
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 rounded-full",
            value ? "bg-[var(--t-color-green9)]" : "bg-t-text-light",
          )}
        />
        <span className={value ? "text-t-text" : "text-t-text-tertiary"}>
          {String(value)}
        </span>
      </span>
    );
  if (kind === "json" || typeof value === "object")
    return (
      <span className="font-mono text-[12px] text-[var(--t-color-pink11)]">
        <Highlight text={JSON.stringify(value)} query={highlight} />
      </span>
    );
  if (
    kind === "time" &&
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
  ) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()))
      return (
        <span className="tabular-nums" title={value}>
          {format(date, "yyyy-MM-dd")}{" "}
          <span className="text-t-text-tertiary">
            {format(date, "HH:mm:ss")}
          </span>
        </span>
      );
  }
  const text = String(value);
  if (kind === "uuid" || kind === "bytes")
    return (
      <span className="font-mono text-[12px] text-t-text-tertiary">
        <Highlight text={text} query={highlight} />
      </span>
    );
  if (kind === "number" || typeof value === "number")
    return (
      <span className="font-mono text-[12px] tabular-nums">
        <Highlight text={text} query={highlight} />
      </span>
    );
  return (
    <span title={text.length > 40 ? text : undefined}>
      <Highlight text={text} query={highlight} />
    </span>
  );
}

function ColumnHeader({
  column,
  sort,
}: {
  column: GridColumn;
  sort: GridSort;
}) {
  const direction = sort?.column === column.name ? sort.direction : null;
  return (
    <div className="flex items-center gap-1.5">
      {column.primary && (
        <Tooltip>
          <TooltipTrigger
            render={<span className="flex text-[var(--t-color-amber10)]" />}
          >
            <IconKey size={13} />
          </TooltipTrigger>
          <TooltipContent>Primary key</TooltipContent>
        </Tooltip>
      )}
      {column.references && (
        <Tooltip>
          <TooltipTrigger
            render={<span className="flex text-[var(--t-color-sky10)]" />}
          >
            <IconLink size={13} />
          </TooltipTrigger>
          <TooltipContent>Points to {column.references}</TooltipContent>
        </Tooltip>
      )}
      <span className="font-medium text-t-text">{column.name}</span>
      {direction === "asc" && (
        <IconArrowUp size={13} className="text-t-blue" aria-label="Ascending" />
      )}
      {direction === "desc" && (
        <IconArrowDown
          size={13}
          className="text-t-blue"
          aria-label="Descending"
        />
      )}
      <TypeTag type={column.type} className="ml-auto" />
    </div>
  );
}

/**
 * Rows as a spreadsheet: a sticky header naming each column with its type, numbered rows, and each value shown
 * the way its type reads best. With the optional handlers it also sorts by a header click, selects a cell (arrows
 * move it, Enter opens its row, ⌘C copies it) and follows a foreign key to the row it points to.
 */
export function DataGrid({
  columns,
  rows,
  empty = "No rows",
  rowOffset = 0,
  sort = null,
  onSort,
  selected = null,
  onSelect,
  onOpenRow,
  onCopy,
  onFollow,
  highlight,
}: {
  columns: GridColumn[];
  rows: unknown[][];
  empty?: ReactNode;
  /** The number of the first row, less one: rows on later pages count on. */
  rowOffset?: number;
  sort?: GridSort;
  onSort?: (column: string) => void;
  selected?: GridCell | null;
  onSelect?: (cell: GridCell | null) => void;
  onOpenRow?: (row: number) => void;
  onCopy?: (text: string) => void;
  onFollow?: (column: GridColumn, value: unknown) => void;
  /** Text to mark in the values: the current search. */
  highlight?: string;
}) {
  const kinds = columns.map((column) => typeKind(column.type));
  const gridRef = useRef<HTMLDivElement>(null);
  const interactive = Boolean(onSelect);

  // Keep the selected cell in view as the arrows move it.
  useEffect(() => {
    if (!selected) return;
    gridRef.current
      ?.querySelector<HTMLElement>(
        `[data-cell="${selected.row}:${selected.column}"]`,
      )
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!onSelect || rows.length === 0) return;
    const cell = selected ?? { row: 0, column: 0 };
    const move = (row: number, column: number) => {
      event.preventDefault();
      onSelect({
        row: Math.max(0, Math.min(rows.length - 1, row)),
        column: Math.max(0, Math.min(columns.length - 1, column)),
      });
    };
    switch (event.key) {
      case "ArrowDown":
        return move(selected ? cell.row + 1 : 0, cell.column);
      case "ArrowUp":
        return move(cell.row - 1, cell.column);
      case "ArrowRight":
        return move(cell.row, selected ? cell.column + 1 : 0);
      case "ArrowLeft":
        return move(cell.row, cell.column - 1);
      case "Home":
        return move(cell.row, 0);
      case "End":
        return move(cell.row, columns.length - 1);
      case "Enter":
        if (selected && onOpenRow) {
          event.preventDefault();
          onOpenRow(selected.row);
        }
        return;
      case "Escape":
        if (selected) {
          event.preventDefault();
          onSelect(null);
        }
        return;
      case "c":
        if ((event.metaKey || event.ctrlKey) && selected && onCopy) {
          // Text selected on the page copies as usual.
          if (window.getSelection()?.toString()) return;
          event.preventDefault();
          onCopy(valueText(rows[selected.row]?.[selected.column]));
        }
        return;
    }
  }

  return (
    <div
      ref={gridRef}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={onKeyDown}
      role={interactive ? "grid" : undefined}
      aria-rowcount={interactive ? rows.length : undefined}
      className="flex min-h-full flex-col outline-none"
    >
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 w-10 border-r border-b border-t-border-light bg-t-secondary" />
            {columns.map((column) => (
              <th
                key={column.name}
                aria-sort={
                  sort?.column === column.name
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className="sticky top-0 z-10 h-9 min-w-36 border-r border-b border-t-border-light bg-t-secondary p-0 text-left font-normal whitespace-nowrap"
              >
                {onSort ? (
                  <button
                    type="button"
                    title="Sort by this column"
                    onClick={() => onSort(column.name)}
                    className="flex h-9 w-full items-center px-2.5 outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <span className="min-w-0 flex-1">
                      <ColumnHeader column={column} sort={sort} />
                    </span>
                  </button>
                ) : (
                  <div className="px-2.5">
                    <ColumnHeader column={column} sort={sort} />
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowSelected = selected?.row === index;
            return (
              <tr key={index} className="group">
                <td
                  onClick={() => onOpenRow?.(index)}
                  className={cn(
                    "sticky left-0 z-10 h-8 border-r border-b border-t-border-light bg-t-primary px-2 text-right font-mono text-[11px] text-t-text-light tabular-nums group-hover:bg-t-secondary",
                    onOpenRow && "cursor-pointer hover:text-t-text",
                    rowSelected && "bg-t-secondary text-t-text-secondary",
                  )}
                >
                  {rowOffset + index + 1}
                </td>
                {columns.map((column, i) => {
                  const value = row[i];
                  const cellSelected = rowSelected && selected?.column === i;
                  const followable =
                    onFollow &&
                    column.references &&
                    column.referencesColumn &&
                    value !== null &&
                    value !== undefined;
                  return (
                    <td
                      key={column.name}
                      data-cell={`${index}:${i}`}
                      aria-selected={interactive ? cellSelected : undefined}
                      onClick={() => onSelect?.({ row: index, column: i })}
                      onDoubleClick={() => onOpenRow?.(index)}
                      className={cn(
                        "relative h-8 max-w-80 truncate border-r border-b border-t-border-light px-2.5 text-t-text-secondary group-hover:bg-t-hover",
                        !isArrayType(column.type) &&
                          kinds[i] === "number" &&
                          "text-right",
                        rowSelected && "bg-t-hover",
                        cellSelected &&
                          "bg-[var(--t-color-blue3)] outline-2 -outline-offset-2 outline-[var(--t-color-blue9)] group-hover:bg-[var(--t-color-blue3)]",
                        followable && "pr-8",
                      )}
                    >
                      <Value
                        value={value}
                        kind={kinds[i]!}
                        highlight={highlight}
                      />
                      {followable && (
                        <button
                          type="button"
                          aria-label={`Open the ${column.references} row`}
                          title={`Open the ${column.references} row`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onFollow(column, value);
                          }}
                          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--t-color-sky10)] opacity-0 outline-none group-hover:opacity-100 hover:bg-t-press focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <IconArrowUpRight size={14} />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="flex flex-1 items-center justify-center py-10 text-t-text-tertiary">
          {empty}
        </div>
      )}
    </div>
  );
}
