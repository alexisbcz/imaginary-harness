// A Substack client. Substack has no public API: these are the private endpoints its own web app calls, the same
// ones the substack-mcp server (github.com/marcomoauro/substack-mcp) uses, authenticated with the session cookie of
// a signed-in writer. They can change without notice; every response is read defensively.
//
// Two hosts: the publication's (`https://<name>.substack.com/api/v1` or its custom domain) for drafts, posts,
// subscribers and stats, and `https://substack.com/api/v1` for the signed-in user and Notes.

import type { PMDoc } from "./document.ts";

export class SubstackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Audience = "everyone" | "only_paid" | "founding" | "only_free";
export const AUDIENCES: Audience[] = ["everyone", "only_paid", "founding", "only_free"];

/** A post as the post management lists show it: a draft, a scheduled post or a published one. */
export type SubstackPostSummary = {
  id: number;
  uuid?: string;
  type?: string;
  title?: string | null;
  draft_title?: string | null;
  subtitle?: string | null;
  draft_subtitle?: string | null;
  slug?: string | null;
  audience?: Audience;
  is_published?: boolean;
  post_date?: string | null;
  trigger_at?: string | null;
  draft_created_at?: string | null;
  draft_updated_at?: string | null;
  email_sent_at?: string | null;
  should_send_email?: boolean;
  section_id?: number | null;
  section_name?: string | null;
  cover_image?: string | null;
  reaction_count?: number;
  comment_count?: number;
  canonical_url?: string | null;
  word_count?: number | null;
  stats?: Record<string, unknown> | null;
};

/** A draft as `GET /drafts/:id` returns it; `draft_body` is a JSON string of the ProseMirror document. */
export type SubstackDraft = SubstackPostSummary & {
  draft_body?: string | null;
  body?: string | null;
  write_comment_permissions?: string;
  default_comment_sort?: string;
  description?: string | null;
  social_title?: string | null;
  search_engine_title?: string | null;
  search_engine_description?: string | null;
  postSchedules?: unknown[];
};

export type DraftPatch = {
  draft_title?: string;
  draft_subtitle?: string;
  draft_body?: PMDoc;
  audience?: Audience;
  write_comment_permissions?: "everyone" | "subscribers" | "only_paid" | "none";
  cover_image?: string | null;
  description?: string;
  social_title?: string;
  search_engine_title?: string;
  search_engine_description?: string;
  slug?: string;
  should_send_email?: boolean;
};

export type SubstackUser = {
  id: number;
  name: string;
  handle: string | null;
  photo_url: string | null;
  publications: { id: number; name: string; subdomain: string; custom_domain: string | null; role: string | null }[];
};

export type SubstackPublication = {
  id: number;
  name: string;
  subdomain: string;
  custom_domain: string | null;
  logo_url: string | null;
  hero_text: string | null;
  author_id: number | null;
  payments_enabled: boolean;
};

export type PostStatsRow = {
  post_id: number;
  title: string;
  post_date: string | null;
  audience: string | null;
  sent: number | null;
  delivered: number | null;
  opens: number | null;
  opened: number | null;
  open_rate: number | null;
  clicks: number | null;
  clicked: number | null;
  click_through_rate: number | null;
  views: number | null;
  signups: number | null;
  subscribes: number | null;
  unsubscribes: number | null;
  likes: number | null;
  shares: number | null;
  restacks: number | null;
  engagement_rate: number | null;
};

export type PublicationStats = {
  subscribers: number | null;
  subscribers_last_30_days: number | null;
  email_subscribers: number | null;
  paid_subscribers: number | null;
  arr: number | null;
  open_rate: number | null;
  views_30d: number | null;
  views_delta_30d: number | null;
};

export type SubstackComment = {
  id: number;
  name: string;
  handle: string | null;
  photo_url: string | null;
  body: string;
  date: string;
  reactions: number;
  children: SubstackComment[];
};

const num = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * A publication address as the user writes it ("name", "name.substack.com", "https://news.example.com/p/x") as its
 * origin. Public https hosts only: the server sends the user's session to it.
 */
export function publicationOrigin(input: string): string {
  let value = input.trim();
  if (!value) throw new SubstackError(400, "Give the publication's address");
  if (/^[a-z0-9-]+$/i.test(value)) value = `${value}.substack.com`;
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  const host = url.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host === "localhost" ||
    /\.(local|internal|localhost)$/.test(host) ||
    /^(\d+\.){3}\d+$/.test(host) ||
    host.startsWith("[")
  )
    throw new SubstackError(400, "That is not a public Substack address");
  if (host === "substack.com" || host === "www.substack.com")
    throw new SubstackError(400, "Give your publication's address, like name.substack.com");
  return `https://${host}`;
}

/** The session cookie as the user pastes it: the bare value, `substack.sid=…`, or a whole Cookie header. */
export function sessionToken(input: string): string {
  const value = input.trim();
  const named = /(?:^|;\s*)(?:substack\.sid|connect\.sid)=([^;]+)/.exec(value);
  const token = decodeURIComponent((named?.[1] ?? value).trim());
  if (!token || /\s/.test(token) || token.length < 20)
    throw new SubstackError(400, "Paste the value of the substack.sid cookie");
  return token;
}

export class Substack {
  private readonly cookie: string;

  constructor(
    /** The publication's origin, `https://name.substack.com`. */
    readonly origin: string,
    token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    // Substack reads either name, depending on the host.
    this.cookie = `substack.sid=${token}; connect.sid=${token}`;
  }

  private async request<T>(
    url: string,
    init: { method?: string; body?: unknown; referer?: string; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(init.query ?? {}))
      if (value !== undefined) target.searchParams.set(key, String(value));
    const response = await this.fetcher(target, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        Cookie: this.cookie,
        Accept: "application/json",
        Referer: `${this.origin}${init.referer ?? "/publish/home"}`,
        "User-Agent": "Mozilla/5.0 (compatible; Richelieu/1.0)",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400)
      throw new SubstackError(401, "Substack sent the request to its sign-in page: sign in again and paste a fresh cookie");
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: string; errors?: { msg?: string }[]; message?: string };
        message = parsed.error ?? parsed.errors?.map((e) => e.msg).join(", ") ?? parsed.message ?? message;
      } catch {}
      if (response.status === 401 || response.status === 403)
        throw new SubstackError(401, `Substack refused the session (${response.status}): ${message || "sign in again"}`);
      throw new SubstackError(response.status, `Substack: ${message || response.statusText} (${response.status})`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SubstackError(502, "Substack answered with something other than JSON");
    }
  }

  private pub<T>(path: string, init?: Parameters<Substack["request"]>[1]) {
    return this.request<T>(`${this.origin}/api/v1${path}`, init);
  }

  private global<T>(path: string, init?: Parameters<Substack["request"]>[1]) {
    return this.request<T>(`https://substack.com/api/v1${path}`, init);
  }

  // Who and what ---------------------------------------------------------------------------------------------

  async me(): Promise<SubstackUser> {
    const raw = await this.global<Record<string, unknown>>("/user/profile/self", { referer: "/" });
    const id = num(raw.id);
    if (id === null) throw new SubstackError(401, "Substack did not recognise the session");
    const memberships = [
      ...((raw.publicationUsers as Record<string, unknown>[] | undefined) ?? []),
      ...((raw.adminOfPublications as Record<string, unknown>[] | undefined) ?? []),
    ];
    const publications = memberships
      .map((m) => {
        const p = ((m.publication as Record<string, unknown> | undefined) ?? m) as Record<string, unknown>;
        return {
          id: num(p.id) ?? 0,
          name: str(p.name) ?? "",
          subdomain: str(p.subdomain) ?? "",
          custom_domain: str(p.custom_domain),
          role: str(m.role),
        };
      })
      .filter((p) => p.subdomain)
      .filter((p, index, all) => all.findIndex((q) => q.id === p.id) === index);
    const primary = raw.primaryPublication as Record<string, unknown> | undefined;
    if (primary && str(primary.subdomain) && !publications.some((p) => p.id === num(primary.id)))
      publications.unshift({
        id: num(primary.id) ?? 0,
        name: str(primary.name) ?? "",
        subdomain: str(primary.subdomain)!,
        custom_domain: str(primary.custom_domain),
        role: "admin",
      });
    return {
      id,
      name: str(raw.name) ?? "",
      handle: str(raw.handle),
      photo_url: str(raw.photo_url),
      publications,
    };
  }

  async publication(): Promise<SubstackPublication> {
    const raw = await this.pub<Record<string, unknown>>("/publication", { referer: "/publish/settings" });
    return {
      id: num(raw.id) ?? 0,
      name: str(raw.name) ?? "",
      subdomain: str(raw.subdomain) ?? "",
      custom_domain: str(raw.custom_domain),
      logo_url: str(raw.logo_url),
      hero_text: str(raw.hero_text),
      author_id: num(raw.author_id),
      payments_enabled: raw.payments_state === "enabled" || raw.paymentsEnabled === true,
    };
  }

  // Posts ----------------------------------------------------------------------------------------------------

  /** Drafts, scheduled or published posts, newest first (scheduled: soonest first). */
  async posts(
    status: "drafts" | "scheduled" | "published",
    options: { limit?: number; offset?: number; search?: string } = {},
  ): Promise<{ total: number; posts: SubstackPostSummary[] }> {
    const order = { drafts: "draft_updated_at", scheduled: "trigger_at", published: "post_date" }[status];
    const raw = await this.pub<{ total?: number; posts?: SubstackPostSummary[] }>(`/post_management/${status}`, {
      referer: "/publish/posts",
      query: {
        offset: options.offset ?? 0,
        limit: Math.min(100, options.limit ?? 50),
        order_by: order,
        order_direction: status === "scheduled" ? "asc" : "desc",
        query: options.search || undefined,
      },
    });
    return { total: num(raw?.total) ?? raw?.posts?.length ?? 0, posts: raw?.posts ?? [] };
  }

  draft(id: number) {
    return this.pub<SubstackDraft>(`/drafts/${id}`, { referer: `/publish/post/${id}` });
  }

  /** A new draft by the signed-in user. */
  createDraft(userId: number, patch: DraftPatch) {
    return this.pub<SubstackDraft>("/drafts", {
      method: "POST",
      referer: "/publish/post",
      body: {
        draft_title: patch.draft_title ?? "",
        draft_subtitle: patch.draft_subtitle ?? "",
        draft_body: JSON.stringify(patch.draft_body ?? { type: "doc", content: [] }),
        draft_bylines: [{ id: userId, is_guest: false }],
        audience: patch.audience ?? "everyone",
        write_comment_permissions: patch.write_comment_permissions ?? "everyone",
        draft_section_id: null,
        section_chosen: true,
        type: "newsletter",
      },
    });
  }

  /** Changes only the fields given. */
  updateDraft(id: number, patch: DraftPatch) {
    const body: Record<string, unknown> = { ...patch };
    if (patch.draft_body) body.draft_body = JSON.stringify(patch.draft_body);
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    return this.pub<SubstackDraft>(`/drafts/${id}`, { method: "PUT", referer: `/publish/post/${id}`, body });
  }

  deleteDraft(id: number) {
    return this.pub<unknown>(`/drafts/${id}`, { method: "DELETE", referer: "/publish/posts" });
  }

  /** What Substack would refuse to publish: an empty title, an image still uploading… */
  async prepublish(id: number): Promise<string[]> {
    const raw = await this.pub<{ errors?: unknown[] } | undefined>(`/drafts/${id}/prepublish`, {
      referer: `/publish/post/${id}`,
    }).catch((error) => {
      // An old endpoint some publications lack: no check rather than no publishing.
      if (error instanceof SubstackError && error.status === 404) return undefined;
      throw error;
    });
    return (raw?.errors ?? []).map((e) =>
      typeof e === "string" ? e : str((e as { msg?: string; message?: string }).msg ?? (e as { message?: string }).message) ?? JSON.stringify(e),
    );
  }

  /** Publishes now; `send` also emails it to the subscribers. */
  async publish(id: number, send: boolean): Promise<SubstackPostSummary> {
    // should_send_email defaults to true on a draft: set it first so `send: false` cannot still email.
    await this.updateDraft(id, { should_send_email: send });
    return this.pub<SubstackPostSummary>(`/drafts/${id}/publish`, {
      method: "POST",
      referer: `/publish/post/${id}`,
      body: { send, share_automatically: false },
    });
  }

  /** Uploads an image (a data URI); Substack hosts it on its CDN. */
  async uploadImage(dataUri: string, postId?: number): Promise<{ url: string; width: number | null; height: number | null }> {
    const raw = await this.pub<Record<string, unknown>>("/image", {
      method: "POST",
      referer: "/publish/post",
      body: postId ? { image: dataUri, postId } : { image: dataUri },
    });
    const url = str(raw.url);
    if (!url) throw new SubstackError(502, "Substack did not return the image's address");
    return { url, width: num(raw.imageWidth), height: num(raw.imageHeight) };
  }

  async comments(postId: number, limit = 50): Promise<SubstackComment[]> {
    const raw = await this.pub<{ comments?: Record<string, unknown>[] }>(`/post/${postId}/comments`, {
      referer: `/publish/post/${postId}`,
      query: { limit: Math.min(100, limit), all_comments: "true", sort: "most_recent_first" },
    });
    const map = (c: Record<string, unknown>): SubstackComment => ({
      id: num(c.id) ?? 0,
      name: str(c.name) ?? "Someone",
      handle: str(c.handle),
      photo_url: str(c.photo_url),
      body: str(c.body) ?? "",
      date: str(c.date) ?? "",
      reactions: Object.values((c.reactions as Record<string, number> | undefined) ?? {}).reduce((a, b) => a + (num(b) ?? 0), 0),
      children: ((c.children as Record<string, unknown>[] | undefined) ?? []).map(map),
    });
    return (raw?.comments ?? []).map(map);
  }

  // Stats ----------------------------------------------------------------------------------------------------

  async stats(): Promise<PublicationStats> {
    const settle = <T>(promise: Promise<T>) => promise.catch(() => undefined);
    const [summary, open, views] = await Promise.all([
      settle(this.pub<Record<string, unknown>>("/publish-dashboard/summary", { referer: "/publish/home" })),
      settle(this.pub<Record<string, unknown>>("/publication/stats/email_stats/30d_open_rate", { referer: "/publish/stats" })),
      settle(this.pub<Record<string, unknown>>("/publication/stats/publication_traffic/30d_views", { referer: "/publish/stats" })),
    ]);
    if (!summary && !open && !views) throw new SubstackError(502, "Substack's stats are not available");
    return {
      subscribers: num(summary?.subscribers),
      subscribers_last_30_days: num(summary?.subscribersLast30Days),
      email_subscribers: num(summary?.totalEmail),
      paid_subscribers: num(summary?.paidSubscribers ?? summary?.paid_subscribers),
      arr: num(summary?.arr),
      open_rate: num(open?.openRate),
      views_30d: num(views?.views30d ?? summary?.views),
      views_delta_30d: num(views?.viewsDelta30d ?? summary?.viewsDelta),
    };
  }

  /** Each sent post's email and web numbers, newest first. */
  async postStats(limit = 50, offset = 0): Promise<{ total: number; rows: PostStatsRow[] }> {
    const raw = await this.pub<{ total?: number; rows?: Record<string, unknown>[] }>("/publication/stats/email_stats", {
      referer: "/publish/stats/emails",
      query: { offset, limit: Math.min(100, limit), order_by: "post_date", order_direction: "desc" },
    });
    const rows = (raw?.rows ?? []).map((r) => ({
      post_id: num(r.post_id) ?? 0,
      title: str(r.title) ?? "",
      post_date: str(r.post_date),
      audience: str(r.audience),
      sent: num(r.sent),
      delivered: num(r.delivered),
      opens: num(r.opens),
      opened: num(r.opened),
      open_rate: num(r.open_rate),
      clicks: num(r.clicks),
      clicked: num(r.clicked),
      click_through_rate: num(r.click_through_rate),
      views: num(r.views),
      signups: num(r.signups),
      subscribes: num(r.subscribes),
      unsubscribes: num(r.unsubscribes),
      likes: num(r.likes),
      shares: num(r.shares),
      restacks: num(r.restacks),
      engagement_rate: num(r.engagement_rate),
    }));
    return { total: num(raw?.total) ?? rows.length, rows };
  }

  // Notes ----------------------------------------------------------------------------------------------------

  /** Publishes a Note (Substack's short posts) as the signed-in user. */
  async publishNote(doc: PMDoc): Promise<{ id: number | null; url: string | null }> {
    const raw = await this.global<Record<string, unknown>>("/comment/feed", {
      method: "POST",
      referer: "/notes",
      body: { bodyJson: doc, tabId: "for-you", surface: "feed", replyMinimumRole: "everyone" },
    });
    const id = num(raw?.id);
    const handle = str((raw?.user as Record<string, unknown> | undefined)?.handle);
    return { id, url: id && handle ? `https://substack.com/@${handle}/note/c-${id}` : null };
  }
}

/** A post's public address. */
export function postUrl(origin: string, post: SubstackPostSummary) {
  return post.canonical_url ?? (post.slug ? `${origin}/p/${post.slug}` : null);
}
