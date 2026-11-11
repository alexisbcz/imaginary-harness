import { expect, test } from "bun:test";
import { cleanName } from "./profile.ts";

test("cleanName keeps a display name", () => {
  expect(cleanName("  Ada   Lovelace \n")).toBe("Ada Lovelace");
  expect(cleanName("A")).toBe("A");
  expect(cleanName("a".repeat(80))).toBe("a".repeat(80));
});

test("cleanName rejects a blank, too long, or control-character name", () => {
  expect(cleanName("   ")).toBeNull();
  expect(cleanName("")).toBeNull();
  expect(cleanName("a".repeat(81))).toBeNull();
  expect(cleanName("Ada\u0007Lovelace")).toBeNull();
});
