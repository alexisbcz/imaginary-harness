// The Social pages' data: brands and their watched accounts read through Supabase (RLS, Realtime), and everything
// that goes through Zernio or ScrapeCreators (accounts, posts, analytics, uploads, rewrites) through the social API.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import i18n, { intlLocale } from "@/lib/i18n";
import type {
  Analytics,
  AnalyzedPost,
  Brand as ServerBrand,
  PostInput,
  PostStatus,
  SocialAccount,
  SocialPost,
  WatchedAccount as ServerWatched,
} from "../../social/service.ts";

export { PLATFORMS, platformInfo, countFor, problemsFor } from "../../social/platforms.ts";
export type { Analytics, AnalyzedPost, PostInput, PostStatus, SocialAccount, SocialPost };

export type Brand = Omit<ServerBrand, "created_at"> & { created_at: string };
export type WatchedAccount = Omit<ServerWatched, "checked_at"> & { checked_at: string | null };
export type Media = { url: string; type: "image" | "video" | "gif" | "document" };

export type SocialStatus = { publishing: boolean; research: boolean; link_existing: boolean };
export type LinkableProfile = { id: string; name: string; accounts: string[] };

const supabase = createClient();
const base = (brandId: string) => `/api/social/brands/${brandId}`;

/** Loads `load` when its key changes; `reload` loads again. Keeps the last value while reloading. */
export function useLoad<T>(key: string | null, load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loader = useRef(load);
  loader.current = load;
  const current = useRef(0);
  const reload = useCallback(async () => {
    if (key === null) return;
    const run = ++current.current;
    setLoading(true);
    try {
      const value = await loader.current();
      if (run === current.current) {
        setData(value);
        setError(null);
      }
    } catch (e) {
      if (run === current.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === current.current) setLoading(false);
    }
  }, [key]);
  useEffect(() => {
    setData(null);
    setError(null);
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** The user's brands, the server's social settings, and the Zernio profiles a new brand may take over. */
export function useBrands() {
  const state = useLoad("brands", () =>
    api<{ brands: Brand[]; status: SocialStatus; linkable: LinkableProfile[] }>("/api/social/brands"),
  );
  const { reload } = state;
  useEffect(() => {
    const channel = supabase
      .channel("social_brands")
      .on("postgres_changes", { event: "*", schema: "public", table: "social_brands" }, () => void reload())
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [reload]);
  return state;
}

export const createBrand = (input: { name: string; website?: string; timezone?: string; link_profile_id?: string }) =>
  api<{ brand: Brand }>("/api/social/brands", { body: input }).then((r) => r.brand);

export const updateBrand = (brandId: string, patch: Partial<Brand>) =>
  api<{ brand: Brand }>(base(brandId), { method: "PATCH", body: patch }).then((r) => r.brand);

export const deleteBrand = (brandId: string) => api(base(brandId), { method: "DELETE" });

// Accounts ----------------------------------------------------------------------------------------------------

export const useAccounts = (brandId: string) =>
  useLoad(brandId ? `accounts:${brandId}` : null, () =>
    api<{ accounts?: SocialAccount[] }>(`${base(brandId)}/accounts`).then((r) => r.accounts ?? []),
  );

/** Sends the browser to the platform's sign-in; it comes back to the brand page. */
export async function connectAccount(brandId: string, platform: string) {
  const { url } = await api<{ url: string }>(`${base(brandId)}/connect`, { body: { platform } });
  window.location.href = url;
}

export const disconnectAccount = (brandId: string, accountId: string) =>
  api(`${base(brandId)}/accounts/${accountId}`, { method: "DELETE" });

// Posts -------------------------------------------------------------------------------------------------------

export function usePosts(brandId: string, from: Date, to: Date) {
  const key = `posts:${brandId}:${from.toISOString()}:${to.toISOString()}`;
  return useLoad(key, () =>
    api<{ posts: SocialPost[] }>(
      `${base(brandId)}/posts?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    ).then((r) => r.posts),
  );
}

export const savePost = (brandId: string, input: PostInput & { idempotency_key?: string }, id?: string) =>
  api<{ post: SocialPost; warnings: string[] }>(id ? `${base(brandId)}/posts/${id}` : `${base(brandId)}/posts`, {
    method: id ? "PUT" : "POST",
    body: input,
  });

export const reschedulePost = (brandId: string, id: string, at: Date) =>
  api<{ post: SocialPost }>(`${base(brandId)}/posts/${id}/reschedule`, { body: { at: at.toISOString() } }).then(
    (r) => r.post,
  );

export const deletePost = (brandId: string, id: string) =>
  api(`${base(brandId)}/posts/${id}`, { method: "DELETE" });

export const retryPost = (brandId: string, id: string) =>
  api<{ post: SocialPost }>(`${base(brandId)}/posts/${id}/retry`, { body: {} }).then((r) => r.post);

/** Adds a post published outside Richelieu, from its URL: it shows on the calendar and in the analytics. */
export const importPost = (brandId: string, url: string) =>
  api<{ post: SocialPost }>(`${base(brandId)}/imports`, { body: { url } }).then((r) => r.post);

export const deleteImportedPost = (brandId: string, id: string) =>
  api(`${base(brandId)}/imports/${id}`, { method: "DELETE" });

/** Uploads an image or a video for a post; returns it as post media. */
export async function uploadMedia(brandId: string, file: File): Promise<Media> {
  const { data } = await supabase.auth.getSession();
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${base(brandId)}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` },
    body: form,
  });
  const result = (await response.json().catch(() => ({}))) as { media?: Media; error?: string };
  if (!response.ok || !result.media) throw new Error(result.error ?? i18n.t("social:errors.uploadFailed", { status: response.status }));
  return result.media;
}

/** The rewrites the editor offers; their labels are `social:rewrites.<value>`. */
export const REWRITES = [
  { value: "improve" },
  { value: "hook" },
  { value: "shorter" },
  { value: "longer" },
  { value: "casual" },
  { value: "professional" },
  { value: "emoji" },
  { value: "hashtags" },
  { value: "fix" },
] as const;

export const rewriteText = (brandId: string, input: { text: string; instruction: string; platform?: string }) =>
  api<{ text: string }>(`${base(brandId)}/rewrite`, { body: input }).then((r) => r.text);

// Analytics ---------------------------------------------------------------------------------------------------

export const useAnalytics = (brandId: string, days: number) =>
  useLoad(`analytics:${brandId}:${days}`, () =>
    api<{ analytics: Analytics }>(`${base(brandId)}/analytics?days=${days}`).then((r) => r.analytics),
  );

// Watchlist ---------------------------------------------------------------------------------------------------

export type WatchHistory = { watch_id: string; day: string; followers: number | null }[];

export function useWatchlist(brandId: string) {
  const state = useLoad(`watch:${brandId}`, () =>
    api<{ accounts: WatchedAccount[]; history: WatchHistory }>(`${base(brandId)}/watch`),
  );
  const { reload } = state;
  useEffect(() => {
    const channel = supabase
      .channel(`social_watch:${brandId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "social_watch", filter: `brand_id=eq.${brandId}` },
        () => void reload(),
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [brandId, reload]);
  return state;
}

export const watchAccount = (brandId: string, input: { platform: string; handle: string; relation: string }) =>
  api<{ account: WatchedAccount }>(`${base(brandId)}/watch`, { body: input }).then((r) => r.account);

export const unwatchAccount = (brandId: string, id: string) =>
  api(`${base(brandId)}/watch/${id}`, { method: "DELETE" });

export const refreshWatched = (brandId: string, id: string) =>
  api<{ account: WatchedAccount }>(`${base(brandId)}/watch/${id}/refresh`, { body: {} }).then((r) => r.account);

// Formatting --------------------------------------------------------------------------------------------------

/** 1234 → 1.2K, 2500000 → 2.5M. */
export function compact(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export const percent = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat(intlLocale(), {
        style: "percent",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);

/** A post status as people read it, in the current language. */
export const statusLabel = (status: PostStatus) => i18n.t(`social:status.${status}`);

// The views' contract ------------------------------------------------------------------------------------------

/** What opens the post editor: an existing post, or a new one on a day, prefilled with text. */
export type EditorRequest = { post?: SocialPost; date?: Date; content?: string };

/** What every view of a brand receives from the Social page. */
export type BrandViewProps = {
  brand: Brand;
  /** The brand's connected accounts; null while loading. */
  accounts: SocialAccount[] | null;
  /** Changes whenever posts may have changed (an editor save, a copilot answer): reload on change. */
  revision: string;
  /** Opens the post editor. */
  onCompose: (request: EditorRequest) => void;
  /** Sends a message to the brand's copilot, and shows its panel. */
  onAsk: (message: string) => void;
};
