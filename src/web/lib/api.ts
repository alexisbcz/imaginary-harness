import i18n from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";

/** Calls the builder's API with the user's session; rejects with the server's error message. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { data } = await createClient().auth.getSession();
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ""}`,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const result = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(result.error ?? i18n.t("builder:api.requestFailed", { status: response.status }));
  return result;
}
