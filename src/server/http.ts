// What the server's JSON APIs share: errors with a status, a handler wrapper that turns them into responses, and
// the user behind a request's Supabase access token.

import { createClient } from "@supabase/supabase-js";
import { config } from "../config.ts";

export type ApiRequest = Bun.BunRequest<string> & {
  params: Record<string, string>;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Runs a handler: its value as JSON (or its Response), an HttpError as its status, anything else as a 500. */
export const handle =
  (handler: (request: ApiRequest) => Promise<unknown>) =>
  async (request: ApiRequest) => {
    try {
      const result = await handler(request);
      return result instanceof Response
        ? result
        : Response.json(result ?? { ok: true });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 500) console.error("[api]", error);
      return Response.json({ error: message }, { status });
    }
  };

const TOKEN_CACHE_MS = 60_000;

/** The id of the user whose access token a request carries (`Authorization: Bearer`), checked with Supabase Auth. */
export function createUserAuth() {
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tokens = new Map<string, { userId: string; until: number }>();
  return async function userOf(request: Request): Promise<string> {
    const token = request.headers
      .get("authorization")
      ?.replace(/^Bearer /i, "");
    if (!token) throw new HttpError(401, "Sign in first");
    const cached = tokens.get(token);
    if (cached && cached.until > Date.now()) return cached.userId;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, "Sign in again");
    tokens.set(token, {
      userId: data.user.id,
      until: Date.now() + TOKEN_CACHE_MS,
    });
    return data.user.id;
  };
}
