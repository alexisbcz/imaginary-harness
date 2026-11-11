import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safe-next-path";

export const NAME_MAX_LENGTH = 80;

const CONTROL = /[\u0000-\u001F\u007F]/;

/** The name stored on a profile: trimmed, one space between words, 1–80 characters. */
export function cleanName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > NAME_MAX_LENGTH) return null;
  if (CONTROL.test(name)) return null;
  return name;
}

/** The signed-in user's name, or null when they have not set one. */
export async function loadProfileName(): Promise<string | null> {
  const { data, error } = await createClient()
    .from("profiles")
    .select("name")
    .maybeSingle();
  if (error) throw error;
  return data?.name ?? null;
}

/** Where to go after the name is saved. A next of /name would send them back to the form. */
export function pathAfterName(next: string | null) {
  const path = safeNextPath(next, "/");
  return new URL(path, window.location.origin).pathname === "/name" ? "/" : path;
}
