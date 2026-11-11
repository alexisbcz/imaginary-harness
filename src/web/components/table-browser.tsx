import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { LightIconButton, SearchInput } from "twenty-ui/components/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import {
  IconArrowUpRight,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCopy,
  IconFilter,
  IconFilterOff,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconX,
} from "twenty-ui/icon";

import {
  DataGrid,
  TypeTag,
  valueText,
  type GridCell,
  type GridColumn,
  type GridSort,
} from "@/components/data-grid";
import { SimpleSelect } from "@/components/simple-select";
import { typeKind } from "@/lib/sql-types";
import { api } from "@/lib/api";

export const OPERATORS = [
  { value: "=", label: "is" },
  { value: "!=", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not contains", label: "doesn't contain" },
  { value: "starts with", label: "starts with" },
  { value: "ends with", label: "ends with" },
  { value: ">", label: "greater than" },
  { value: ">=", label: "at least" },
  { value: "<", label: "less than" },
  { value: "<=", label: "at most" },
  { value: "in", label: "is one of" },
  { value: "is null", label: "is empty" },
  { value: "is not null", label: "is not empty" },
] as const;

type Operator = (typeof OPERATORS)[number]["value"];

export type Filter = {
  id: number;
  column: string;
  operator: Operator;
  value: string;
};

const takesNoValue = (operator: Operator) =>
  operator === "is null" || operator === "is not null";

type BrowseResult =
  | { ok: true; rows: unknown[][]; count: number; durationMs: number }
  | { ok: false; message: string };

const PAGE_SIZES = [
  { value: "50", label: "50 rows" },
  { value: "100", label: "100 rows" },
  { value: "200", label: "200 rows" },
  { value: "500", label: "500 rows" },
] as const;

let nextFilterId = 1;
export const newFilter = (
  column: string,
  operator: Operator = "=",
  value = "",
): Filter => ({ id: nextFilterId++, column, operator, value });

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** A SQL literal for a value typed in a filter: quotes doubled. */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const quoteName = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
const likeText = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The same rows as a query, to keep working on them in the SQL editor. */
export function browseSql(
  table: string,
  columns: GridColumn[],
  search: string,
  filters: Filter[],
  sort: GridSort,
  limit: number,
) {
  const where: string[] = [];
  if (search.trim()) {
    const pattern = literal(`%${likeText(search.trim())}%`);
    where.push(
      `(${columns.map((c) => `${quoteName(c.name)}::text ilike ${pattern}`).join("\n    or ")})`,
    );
  }
  for (const f of filters) {
    const c = quoteName(f.column);
    switch (f.operator) {
      case "is null":
        where.push(`${c} is null`);
        break;
      case "is not null":
        where.push(`${c} is not null`);
        break;
      case "contains":
        where.push(`${c}::text ilike ${literal(`%${likeText(f.value)}%`)}`);
        break;
      case "not contains":
        where.push(
          `(${c} is null or ${c}::text not ilike ${literal(`%${likeText(f.value)}%`)})`,
        );
        break;
      case "starts with":
        where.push(`${c}::text ilike ${literal(`${likeText(f.value)}%`)}`);
        break;
      case "ends with":
        where.push(`${c}::text ilike ${literal(`%${likeText(f.value)}`)}`);
        break;
      case "in":
        where.push(
          `${c} in (${f.value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .map(literal)
            .join(", ")})`,
        );
        break;
      case "!=":
        where.push(`${c} is distinct from ${literal(f.value)}`);
        break;
      default:
        where.push(`${c} ${f.operator} ${literal(f.value)}`);
    }
  }
  return [
    `select * from ${quoteName(table)}`,
    where.length ? `where ${where.join("\n  and ")}` : null,
    sort
      ? `order by ${quoteName(sort.column)} ${sort.direction}${sort.direction === "desc" ? " nulls last" : ""}`
      : null,
    `limit ${limit};`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One filter as a pill that reads as a phrase: `title · contains · pasta ×`. The column and the condition are
 * quiet menus, and the value field grows with what is typed, so filters wrap onto new lines instead of
 * overflowing a narrow panel.
 */
function FilterPill({
  filter,
  columns,
  onChange,
  onRemove,
}: {
  filter: Filter;
  columns: GridColumn[];
  onChange: (filter: Filter) => void;
  onRemove: () => void;
}) {
  const column = columns.find((c) => c.name === filter.column);
  const pending = !takesNoValue(filter.operator) && filter.value.trim() === "";
  return (
    <div
      className={cn(
        "inline-flex h-7 max-w-full items-stretch overflow-hidden rounded-md border bg-t-primary text-[12px] shadow-[0_1px_2px_rgb(0_0_0/0.05)]",
        // A filter still waiting for its value narrows nothing yet: its border says so.
        pending ? "border-dashed border-t-border-strong" : "border-t-border",
      )}
    >
      <SimpleSelect
        bare
        label="Column"
        value={filter.column}
        onValueChange={(name) => onChange({ ...filter, column: name })}
        options={columns.map((c) => ({ value: c.name, label: c.name }))}
        className="font-medium text-t-text"
      />
      <span aria-hidden className="w-px self-stretch bg-t-border-light" />
      <SimpleSelect<Operator>
        bare
        label="Condition"
        value={filter.operator}
        onValueChange={(operator) => onChange({ ...filter, operator })}
        options={OPERATORS}
        className="text-t-text-tertiary"
      />
      {!takesNoValue(filter.operator) && (
        <>
          <span aria-hidden className="w-px self-stretch bg-t-border-light" />
          <input
            aria-label="Value"
            placeholder={
              filter.operator === "in"
                ? "a, b, c"
                : column?.type.startsWith("bool")
                  ? "true or false"
                  : "value"
            }
            value={filter.value}
            onChange={(event) =>
              onChange({ ...filter, value: event.target.value })
            }
            autoFocus={filter.value === ""}
            className="min-w-14 max-w-56 bg-transparent px-2 text-t-text outline-none [field-sizing:content] placeholder:text-t-text-light focus:bg-t-hover"
          />
        </>
      )}
      <button
        type="button"
        aria-label="Remove this filter"
        title="Remove this filter"
        onClick={onRemove}
        className="flex w-6 shrink-0 items-center justify-center border-l border-t-border-light text-t-text-light outline-none hover:bg-t-hover hover:text-t-text focus-visible:bg-t-hover"
      >
        <IconX size={12} />
      </button>
    </div>
  );
}

/** Every field of one row, in full: long text wrapped, JSON laid out, each one ready to copy. */
function RowInspector({
  columns,
  row,
  number,
  onPrevious,
  onNext,
  onClose,
  onCopy,
  onFollow,
}: {
  columns: GridColumn[];
  row: unknown[];
  number: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onCopy: (text: string) => void;
  onFollow: (column: GridColumn, value: unknown) => void;
}) {
  return (
    <aside
      aria-label={`Row ${number}`}
      className="flex w-[340px] shrink-0 flex-col border-l border-t-border-light bg-t-primary"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-t-border-light pr-1.5 pl-3">
        <span className="flex-1 font-medium text-t-text">Row {number}</span>
        <LightIconButton
          aria-label="Previous row"
          tooltip="Previous row"
          size="sm"
          disabled={!onPrevious}
          onClick={onPrevious}
        >
          <IconChevronUp size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label="Next row"
          tooltip="Next row"
          size="sm"
          disabled={!onNext}
          onClick={onNext}
        >
          <IconChevronDown size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label="Close the row"
          tooltip="Close"
          size="sm"
          onClick={onClose}
        >
          <IconX size={16} />
        </LightIconButton>
      </div>
      <dl className="min-h-0 flex-1 overflow-y-auto">
        {columns.map((column, index) => {
          const value = row[index];
          const text =
            value !== null && typeof value === "object"
              ? JSON.stringify(value, null, 2)
              : valueText(value);
          return (
            <div
              key={column.name}
              className="group border-b border-t-border-light px-3 py-2.5"
            >
              <dt className="mb-1 flex items-center gap-1.5">
                <span className="text-[12px] font-medium text-t-text-secondary">
                  {column.name}
                </span>
                <TypeTag type={column.type} />
                <span className="flex-1" />
                {column.references &&
                  column.referencesColumn &&
                  value !== null && (
                    <LightIconButton
                      aria-label={`Open the ${column.references} row`}
                      tooltip={`Open in ${column.references}`}
                      size="xs"
                      onClick={() => onFollow(column, value)}
                    >
                      <IconArrowUpRight size={14} />
                    </LightIconButton>
                  )}
                <LightIconButton
                  aria-label={`Copy ${column.name}`}
                  tooltip="Copy"
                  size="xs"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onCopy(valueText(value))}
                >
                  <IconCopy size={14} />
                </LightIconButton>
              </dt>
              {Array.isArray(value) &&
              value.every(
                (item) => item === null || typeof item !== "object",
              ) ? (
                // A list of plain values reads best as chips; each one wraps whole.
                <dd className="flex flex-wrap gap-1">
                  {value.length === 0 && (
                    <span className="font-mono text-[12px] text-t-text-light">
                      []
                    </span>
                  )}
                  {value.map((item, i) => (
                    <Tag
                      key={i}
                      color="gray"
                      variant="soft"
                      className="h-auto min-h-5 py-0.5 whitespace-normal"
                    >
                      {valueText(item)}
                    </Tag>
                  ))}
                </dd>
              ) : (
                <dd
                  className={cn(
                    "text-[13px] break-words whitespace-pre-wrap text-t-text",
                    (value === null || value === undefined) &&
                      "font-mono text-[12px] text-t-text-light",
                    typeof value === "object" &&
                      value !== null &&
                      "max-h-64 overflow-auto rounded-sm bg-t-secondary p-2 font-mono text-[12px]",
                  )}
                >
                  {text}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </aside>
  );
}

/**
 * One table of the app's database, to find rows in: search every column at once, filter on any of them, sort by a
 * header, page through all of it, inspect a row, copy a value, and follow a foreign key to the row it points to.
 * Searching, filtering and sorting happen in Postgres, over the whole table.
 */
export function TableBrowser({
  threadId,
  table,
  columns,
  total,
  revision,
  initialFilters,
  onFollow,
  onQuery,
}: {
  threadId: string;
  table: string;
  columns: GridColumn[];
  /** Rows in the whole table, unfiltered. */
  total: number;
  /** Changes when the agent may have changed the data: the page reloads. */
  revision: string;
  initialFilters?: Filter[];
  onFollow: (table: string, filter: Filter) => void;
  onQuery: (sql: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filter[]>(initialFilters ?? []);
  const [sort, setSort] = useState<GridSort>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<GridCell | null>(null);
  const [inspected, setInspected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const debouncedSearch = useDebounced(search, 250);
  // A filter waiting for its value does not narrow anything yet.
  const applied = filters.filter(
    (f) => takesNoValue(f.operator) || f.value.trim() !== "",
  );
  const debouncedFilters = useDebounced(
    JSON.stringify(
      applied.map(({ column, operator, value }) => ({
        column,
        operator,
        value,
      })),
    ),
    250,
  );

  // A new search, filter or order starts from the first page.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, debouncedFilters, sort, pageSize]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    api<BrowseResult>(`/api/projects/${threadId}/database/browse`, {
      method: "POST",
      body: {
        table,
        search: debouncedSearch,
        filters: JSON.parse(debouncedFilters),
        sort,
        limit: pageSize,
        offset: page * pageSize,
      },
    })
      .then((next) => {
        if (id !== requestId.current) return;
        setResult(next);
        setSelected(null);
        setInspected(null);
      })
      .catch((error) => {
        if (id !== requestId.current) return;
        setResult({
          ok: false,
          message: error instanceof Error ? error.message : "Could not load",
        });
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [
    threadId,
    table,
    debouncedSearch,
    debouncedFilters,
    sort,
    page,
    pageSize,
    revision,
    reload,
  ]);

  // Notices clear themselves.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 1600);
    return () => clearTimeout(timer);
  }, [notice]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied");
    } catch {
      setNotice("The browser did not allow copying");
    }
  }

  function addFilter() {
    // A new filter starts on the first column worth searching: not the key, and text when there is some.
    const column =
      columns.find((c) => !c.primary && typeKind(c.type) === "text") ??
      columns.find((c) => !c.primary) ??
      columns[0]!;
    setFilters((current) => [...current, newFilter(column.name, "contains")]);
  }

  function toggleSort(column: string) {
    setSort((current) =>
      current?.column !== column
        ? { column, direction: "asc" }
        : current.direction === "asc"
          ? { column, direction: "desc" }
          : null,
    );
  }

  function follow(column: GridColumn, value: unknown) {
    if (!column.references || !column.referencesColumn) return;
    onFollow(
      column.references,
      newFilter(column.referencesColumn, "=", valueText(value)),
    );
  }

  const rows = result?.ok ? result.rows : [];
  const count = result?.ok ? result.count : 0;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const first = count === 0 ? 0 : page * pageSize + 1;
  const last = Math.min(count, (page + 1) * pageSize);
  const narrowed = debouncedSearch.trim() !== "" || applied.length > 0;
  const inspectedRow = inspected !== null ? rows[inspected] : undefined;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "f") {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-t-border-light px-3 py-2">
        {/* The search takes what room there is; the actions keep theirs, so the bar never wraps. */}
        <div className="max-w-72 min-w-0 flex-1">
          <SearchInput
            ref={searchRef}
            size="sm"
            aria-label={`Search ${table}`}
            placeholder={`Search ${table}…`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                setSearch("");
              }
            }}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          startIcon={<IconFilter size={14} />}
          onClick={addFilter}
          className="shrink-0"
        >
          Filter
          {applied.length > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-t-blue px-1 text-[10px] font-semibold text-white tabular-nums">
              {applied.length}
            </span>
          )}
        </Button>
        {narrowed && (
          <LightIconButton
            aria-label="Clear the search and filters"
            tooltip="Clear the search and filters"
            size="sm"
            onClick={() => {
              setSearch("");
              setFilters([]);
            }}
          >
            <IconFilterOff size={16} />
          </LightIconButton>
        )}
        <span className="flex-1" />
        {/* Room kept for the spinner, so the buttons do not jump while loading. */}
        <span className="flex w-5 shrink-0 justify-center">
          {loading && <Loader />}
        </span>
        <LightIconButton
          aria-label="Reload"
          tooltip="Reload"
          size="sm"
          onClick={() => setReload((n) => n + 1)}
        >
          <IconRefresh size={16} />
        </LightIconButton>
        <LightIconButton
          aria-label="Open these rows in the SQL editor"
          tooltip="Open in the SQL editor"
          size="sm"
          onClick={() =>
            onQuery(
              browseSql(
                table,
                columns,
                debouncedSearch,
                applied,
                sort,
                pageSize,
              ),
            )
          }
        >
          <IconTerminal2 size={16} />
        </LightIconButton>
      </div>

      {filters.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-t-border-light bg-t-secondary px-3 py-2">
          {filters.map((filter) => (
            <FilterPill
              key={filter.id}
              filter={filter}
              columns={columns}
              onChange={(next) =>
                setFilters((current) =>
                  current.map((f) => (f.id === filter.id ? next : f)),
                )
              }
              onRemove={() =>
                setFilters((current) =>
                  current.filter((f) => f.id !== filter.id),
                )
              }
            />
          ))}
          <button
            type="button"
            onClick={addFilter}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-t-text-tertiary outline-none hover:bg-t-hover hover:text-t-text-secondary focus-visible:bg-t-hover"
          >
            <IconPlus size={12} />
            Add filter
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-w-0 flex-1 overflow-auto transition-opacity",
            loading && result && "opacity-60",
          )}
        >
          {result?.ok === false ? (
            <div className="m-3 rounded-md border border-[var(--t-color-red6)] bg-[var(--t-color-red3)] p-3 text-[var(--t-color-red11)]">
              {result.message}
            </div>
          ) : result === null ? (
            <div className="flex h-full items-center justify-center">
              <Loader />
            </div>
          ) : (
            <DataGrid
              columns={columns}
              rows={rows}
              rowOffset={page * pageSize}
              sort={sort}
              onSort={toggleSort}
              selected={selected}
              onSelect={(cell) => {
                setSelected(cell);
                // An open inspector follows the selection, row by row.
                if (cell && inspected !== null) setInspected(cell.row);
              }}
              onOpenRow={setInspected}
              onCopy={(text) => void copy(text)}
              onFollow={follow}
              highlight={debouncedSearch}
              empty={
                narrowed ? (
                  <span>
                    No rows match. Try fewer filters or another search.
                  </span>
                ) : (
                  "This table has no rows yet"
                )
              }
            />
          )}
        </div>
        {inspectedRow && inspected !== null && (
          <RowInspector
            columns={columns}
            row={inspectedRow}
            number={page * pageSize + inspected + 1}
            onPrevious={
              inspected > 0 ? () => setInspected(inspected - 1) : undefined
            }
            onNext={
              inspected < rows.length - 1
                ? () => setInspected(inspected + 1)
                : undefined
            }
            onClose={() => setInspected(null)}
            onCopy={(text) => void copy(text)}
            onFollow={follow}
          />
        )}
      </div>

      <div className="flex h-10 shrink-0 items-center gap-3 border-t border-t-border-light px-3 text-[12px] text-t-text-tertiary">
        <span className="whitespace-nowrap tabular-nums">
          {count === 0
            ? narrowed
              ? "No matches"
              : "No rows"
            : `${first.toLocaleString()}–${last.toLocaleString()} of ${count.toLocaleString()}`}
          {narrowed && result?.ok && (
            <span className="text-t-text-light">
              {" "}
              matching, {total.toLocaleString()} in all
            </span>
          )}
        </span>
        {notice && (
          <span className="rounded-sm bg-t-tertiary px-1.5 py-0.5 text-t-text-secondary">
            {notice}
          </span>
        )}
        <span className="flex-1" />
        <SimpleSelect
          bare
          label="Rows per page"
          value={String(pageSize) as (typeof PAGE_SIZES)[number]["value"]}
          onValueChange={(size) => setPageSize(Number(size))}
          options={PAGE_SIZES}
          className="h-7 shrink-0 rounded-sm text-[12px] text-t-text-tertiary"
        />
        <LightIconButton
          aria-label="Previous page"
          tooltip="Previous page"
          size="sm"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          <IconChevronLeft size={16} />
        </LightIconButton>
        <span className="whitespace-nowrap tabular-nums">
          {page + 1} / {pages}
        </span>
        <LightIconButton
          aria-label="Next page"
          tooltip="Next page"
          size="sm"
          disabled={page >= pages - 1}
          onClick={() => setPage(page + 1)}
        >
          <IconChevronRight size={16} />
        </LightIconButton>
      </div>
    </div>
  );
}
