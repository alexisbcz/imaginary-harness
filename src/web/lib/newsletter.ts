// The Newsletter pages' data: newsletters, ideas, releases and notes read through Supabase (RLS, Realtime), and
// everything that goes through Substack (posts, publishing, images, stats) or the model (assists) through the
// newsletter API.

import { useEffect } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/social";
import i18n, { intlLocale } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";
import type {
  Analytics,
  DraftInput,
  Idea as ServerIdea,
  Newsletter as ServerNewsletter,
  NewsletterPost,
  Note as ServerNote,
  PostDetail,
  PostState,
  SubstackComment,
} from "../../newsletter/service.ts";
import type { AssistInput, AssistResult } from "../../newsletter/writer.ts";

export { markdownToDoc, docText, wordCount, excerpt, BUTTON_URLS } from "../../newsletter/document.ts";
export type { PMDoc, PMNode } from "../../newsletter/document.ts";
export type { Analytics, DraftInput, NewsletterPost, PostDetail, PostState, SubstackComment, AssistInput, AssistResult };
export { useLoad };

type Dated<T, K extends keyof T> = Omit<T, K> & { [P in K]: string | null };
export type Newsletter = Dated<ServerNewsletter, "connected_at" | "created_at">;
export type Idea = Dated<ServerIdea, "created_at" | "updated_at">;
export type Note = Dated<ServerNote, "publish_at" | "published_at" | "created_at">;
export type Audience = Newsletter["default_audience"];
export type NewsletterStatus = { mcp: boolean };

// The labels are translated where they show: `t(\`audiences.${value}\`)` in the "newsletter" namespace.
export const AUDIENCES = [
  { value: "everyone" },
  { value: "only_free" },
  { value: "only_paid" },
  { value: "founding" },
] as const satisfies readonly { value: Audience }[];
export const audienceLabel = (value: string) => {
  const audience = AUDIENCES.find((a) => a.value === value);
  return audience ? i18n.t(`newsletter:audiences.${audience.value}`) : value;
};

const supabase = createClient();
const base = (id: string) => `/api/newsletters/${id}`;

/** Reloads `reload` when a table's rows for this newsletter change. */
function useRealtime(table: string, newsletterId: string | null, reload: () => unknown) {
  useEffect(() => {
    if (!newsletterId && table !== "newsletters") return;
    const channel = supabase
      .channel(`${table}:${newsletterId ?? "all"}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          ...(table === "newsletters" ? {} : { filter: `newsletter_id=eq.${newsletterId}` }),
        },
        () => void reload(),
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [table, newsletterId, reload]);
}

export function useNewsletters() {
  const state = useLoad("newsletters", () =>
    api<{ newsletters: Newsletter[]; status: NewsletterStatus }>("/api/newsletters"),
  );
  useRealtime("newsletters", null, state.reload);
  return state;
}

export const createNewsletter = (input: { name?: string; publication?: string; cookie?: string; timezone?: string }) =>
  api<{ newsletter: Newsletter }>("/api/newsletters", { body: input }).then((r) => r.newsletter);

export const updateNewsletter = (id: string, patch: Partial<Newsletter>) =>
  api<{ newsletter: Newsletter }>(base(id), { method: "PATCH", body: patch }).then((r) => r.newsletter);

export const deleteNewsletter = (id: string) => api(base(id), { method: "DELETE" });

export const connectNewsletter = (id: string, input: { publication?: string; cookie: string }) =>
  api<{ newsletter: Newsletter }>(`${base(id)}/connection`, { method: "PUT", body: input }).then((r) => r.newsletter);

export const disconnectNewsletter = (id: string) => api(`${base(id)}/connection`, { method: "DELETE" });

// Posts -------------------------------------------------------------------------------------------------------

export function usePosts(newsletter: Newsletter, revision: string) {
  const state = useLoad(newsletter.connected_at ? `posts:${newsletter.id}:${revision}` : null, () =>
    api<{ posts: NewsletterPost[] }>(`${base(newsletter.id)}/posts`).then((r) => r.posts),
  );
  // Richelieu's releases change a post's state (scheduled, published by the scheduler).
  useRealtime("newsletter_releases", newsletter.id, state.reload);
  return state;
}

export const getPost = (id: string, postId: number | string) =>
  api<{ post: PostDetail }>(`${base(id)}/posts/${postId}`).then((r) => r.post);

export const createDraft = (id: string, input: DraftInput) =>
  api<{ post: PostDetail }>(`${base(id)}/posts`, { body: input }).then((r) => r.post);

export const saveDraft = (id: string, postId: number, input: DraftInput & { revision?: string | null }) =>
  api<{ post: PostDetail }>(`${base(id)}/posts/${postId}`, { method: "PUT", body: input }).then((r) => r.post);

export const deleteDraft = (id: string, postId: number) => api(`${base(id)}/posts/${postId}`, { method: "DELETE" });

export const checkPost = (id: string, postId: number) =>
  api<{ problems: string[] }>(`${base(id)}/posts/${postId}/check`).then((r) => r.problems);

export const publishPost = (id: string, postId: number, send: boolean) =>
  api<{ url: string | null; emailed: boolean }>(`${base(id)}/posts/${postId}/publish`, { body: { send } });

export const schedulePost = (id: string, postId: number, at: Date, send: boolean) =>
  api<{ warnings: string[] }>(`${base(id)}/posts/${postId}/schedule`, { body: { at: at.toISOString(), send } });

export const unschedulePost = (id: string, postId: number) =>
  api(`${base(id)}/posts/${postId}/schedule`, { method: "DELETE" });

export const getComments = (id: string, postId: number) =>
  api<{ comments: SubstackComment[] }>(`${base(id)}/posts/${postId}/comments`).then((r) => r.comments);

/** Uploads an image to Substack's CDN; returns its address. */
export async function uploadImage(id: string, file: File, postId?: number) {
  const { data } = await supabase.auth.getSession();
  const form = new FormData();
  form.set("file", file);
  if (postId) form.set("post_id", String(postId));
  const response = await fetch(`${base(id)}/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` },
    body: form,
  });
  const result = (await response.json().catch(() => ({}))) as { image?: { url: string }; error?: string };
  if (!response.ok || !result.image) throw new Error(result.error ?? i18n.t("newsletter:errors.uploadFailed", { status: response.status }));
  return result.image.url;
}

export const assist = (id: string, input: AssistInput) =>
  api<{ result: AssistResult }>(`${base(id)}/assist`, { body: input }).then((r) => r.result);

// Labels: `t(\`assist.actions.${value}\`)`.
export const ASSIST_ACTIONS = [
  { value: "improve" },
  { value: "punchier" },
  { value: "shorter" },
  { value: "longer" },
  { value: "simplify" },
  { value: "fix" },
] as const;

// Analytics ---------------------------------------------------------------------------------------------------

export const useAnalytics = (newsletter: Newsletter, fresh: number) =>
  useLoad(newsletter.connected_at ? `analytics:${newsletter.id}:${fresh}` : null, () =>
    api<{ analytics: Analytics }>(`${base(newsletter.id)}/analytics${fresh ? "?fresh" : ""}`).then((r) => r.analytics),
  );

// Ideas -------------------------------------------------------------------------------------------------------

export function useIdeas(newsletterId: string) {
  const state = useLoad(`ideas:${newsletterId}`, () =>
    api<{ ideas: Idea[] }>(`${base(newsletterId)}/ideas`).then((r) => r.ideas),
  );
  useRealtime("newsletter_ideas", newsletterId, state.reload);
  return state;
}

export const createIdea = (id: string, input: { title: string; notes?: string; status?: Idea["status"]; planned_for?: string | null }) =>
  api<{ idea: Idea }>(`${base(id)}/ideas`, { body: input }).then((r) => r.idea);

export const updateIdea = (id: string, ideaId: string, patch: Partial<Pick<Idea, "title" | "notes" | "status" | "planned_for">>) =>
  api<{ idea: Idea }>(`${base(id)}/ideas/${ideaId}`, { method: "PATCH", body: patch }).then((r) => r.idea);

export const deleteIdea = (id: string, ideaId: string) => api(`${base(id)}/ideas/${ideaId}`, { method: "DELETE" });

export const draftFromIdea = (id: string, ideaId: string) =>
  api<{ post: PostDetail }>(`${base(id)}/ideas/${ideaId}/draft`, { body: {} }).then((r) => r.post);

// Labels: `t(\`ideas.statuses.${value}\`)`.
export const IDEA_STATUSES = [
  { value: "idea" },
  { value: "planned" },
  { value: "drafting" },
  { value: "done" },
  { value: "dropped" },
] as const satisfies readonly { value: Idea["status"] }[];

// Notes -------------------------------------------------------------------------------------------------------

export function useNotes(newsletterId: string) {
  const state = useLoad(`notes:${newsletterId}`, () =>
    api<{ notes: Note[] }>(`${base(newsletterId)}/notes`).then((r) => r.notes),
  );
  useRealtime("newsletter_notes", newsletterId, state.reload);
  return state;
}

export const saveNote = (id: string, body: string, noteId?: string) =>
  api<{ note: Note }>(noteId ? `${base(id)}/notes/${noteId}` : `${base(id)}/notes`, {
    method: noteId ? "PUT" : "POST",
    body: { body },
  }).then((r) => r.note);

export const deleteNote = (id: string, noteId: string) => api(`${base(id)}/notes/${noteId}`, { method: "DELETE" });

export const scheduleNote = (id: string, noteId: string, at: Date | null) =>
  api<{ note: Note }>(`${base(id)}/notes/${noteId}/schedule`, { body: { at: at?.toISOString() ?? null } }).then((r) => r.note);

export const publishNote = (id: string, noteId: string) =>
  api<{ note: Note }>(`${base(id)}/notes/${noteId}/publish`, { body: {} }).then((r) => r.note);

// Formatting --------------------------------------------------------------------------------------------------

export function formatMoment(value: string | Date | null, timeZone: string, withTime = true) {
  if (!value) return "";
  return new Intl.DateTimeFormat(intlLocale(), {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(new Date(value).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}

/** "2026-11-20T09:00" in a zone, for a datetime-local input; and back. */
export function toLocalInput(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function fromLocalInput(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const shown = toLocalInput(new Date(result), timeZone);
    const [sy, smo, sd, sh, smi] = shown.split(/[-T:]/).map(Number) as number[];
    result += guess - Date.UTC(sy!, smo! - 1, sd!, sh!, smi!);
  }
  return new Date(result);
}

export function compact(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Substack's rates come as 0–1 or 0–100, depending on the endpoint. */
export const rate = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat(intlLocale(), { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
        value <= 1 ? value : value / 100,
      );
