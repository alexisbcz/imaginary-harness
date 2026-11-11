import type { ThemeColor } from "twenty-ui/theme";

/** The families of Postgres types the Database tab tells apart by color and by how it shows their values. */
export type TypeKind =
  "number" | "text" | "bool" | "time" | "json" | "uuid" | "bytes" | "other";

const kinds: Record<string, TypeKind> = {
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  money: "number",
  oid: "number",
  // What guessType calls a number it cannot tell the size of.
  number: "number",
  text: "text",
  varchar: "text",
  bpchar: "text",
  char: "text",
  name: "text",
  citext: "text",
  bool: "bool",
  date: "time",
  time: "time",
  timetz: "time",
  timestamp: "time",
  timestamptz: "time",
  interval: "time",
  json: "json",
  jsonb: "json",
  uuid: "uuid",
  bytea: "bytes",
};

export const kindColor: Record<TypeKind, ThemeColor> = {
  number: "blue",
  text: "green",
  bool: "orange",
  time: "purple",
  json: "pink",
  uuid: "turquoise",
  bytes: "brown",
  other: "gray",
};

export function isArrayType(type: string) {
  return type.endsWith("[]");
}

export function typeKind(type: string): TypeKind {
  return kinds[type.replace(/\[\]$/, "")] ?? "other";
}

/**
 * A type for a column the server did not describe, read from its values: the first one that is not null decides.
 * Good enough to color it; the label says it is a guess by naming the family, not a Postgres type.
 */
export function guessType(values: unknown[]): string {
  const value = values.find((v) => v !== null && v !== undefined);
  if (value === undefined) return "unknown";
  if (Array.isArray(value)) return `${guessType(value)}[]`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "object") return "json";
  if (typeof value === "string") {
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      return "uuid";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "timestamptz";
    return "text";
  }
  return "unknown";
}
