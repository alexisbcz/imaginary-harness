// What the social API and the agent do: brands and their Zernio profiles, connected accounts, posts (drafts,
// scheduled, published), analytics, and the public accounts a brand watches. Every post or account a brand touches
// is checked to belong to the brand's Zernio profile: the API key is the server's, shared by every user.

import type { SQL } from "bun";
import { platformInfo, problemsFor } from "./platforms.ts";
import {
  engagementOf,
  idsIn,
  normalizeHandle,
  platformOfUrl,
  resolvePostUrl,
  ScrapeCreators,
  WATCH_PLATFORMS,
  type PublicPost,
  type PublicProfile,
  type WatchPlatform,
} from "./scrapecreators.ts";
import {
  Zernio,
  ZernioError,
  type ZernioAccount,
  type ZernioMedia,
  type ZernioPost,
  type ZernioFollowerStats,
  type ZernioPostAnalytics,
} from "./zernio.ts";

export class SocialError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Brand = {
  id: string;
  user_id: string;
  name: string;
  website: string;
  description: string;
  audience: string;
  voice: string;
  pillars: string[];
  avoid: string;
  examples: string;
  timezone: string;
  cadence: Record<string, number>;
  zernio_profile_id: string | null;
  zernio_profile_owned: boolean;
  thread_id: string | null;
  created_at: Date;
};

export const BRIEF_FIELDS = [
  "name",
  "website",
  "description",
  "audience",
  "voice",
  "pillars",
  "avoid",
  "examples",
  "timezone",
  "cadence",
] as const;
export type BrandPatch = Partial<Pick<Brand, (typeof BRIEF_FIELDS)[number]>>;

export type SocialAccount = {
  id: string;
  platform: string;
  username: string;
  name: string;
  avatar: string | null;
  url: string | null;
  active: boolean;
};

export type PostStatus = ZernioPost["status"];

export type SocialPost = {
  id: string;
  status: PostStatus;
  content: string;
  title: string;
  scheduled_for: string | null;
  published_at: string | null;
  timezone: string | null;
  media: ZernioMedia[];
  platforms: {
    account_id: string;
    platform: string;
    username: string;
    avatar: string | null;
    status: string | null;
    url: string | null;
    error: string | null;
    custom_content: string | null;
  }[];
  created_at: string;
  updated_at: string;
  /** zernio: written, scheduled or published through Zernio. imported: published elsewhere, imported by its URL. */
  source: "zernio" | "imported";
  /** What an imported post's platform shows publicly. */
  metrics?: { views: number | null; likes: number | null; comments: number | null; shares: number | null };
};

export type ImportedRow = {
  id: string;
  brand_id: string;
  platform: WatchPlatform;
  url: string;
  external_ids: string[];
  content: string;
  thumbnail: string | null;
  published_at: Date | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  checked_at: Date | null;
  error: string | null;
  created_at: Date;
};

export type PostInput = {
  content: string;
  title?: string;
  /** The accounts to post on, with an optional text of their own. */
  channels: { account_id: string; custom_content?: string | null }[];
  media?: ZernioMedia[];
  /** ISO 8601. A draft keeps it as its planned time on the calendar. */
  scheduled_for?: string | null;
  /** draft: saved, never published. schedule: published at `scheduled_for`. publish: now. */
  mode: "draft" | "schedule" | "publish";
};

export type PostMetrics = {
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  engagements: number;
  engagement_rate: number | null;
};

export type AnalyzedPost = PostMetrics & {
  id: string;
  content: string;
  published_at: string;
  platforms: string[];
  url: string | null;
  thumbnail: string | null;
  /** Published outside Zernio and imported by its URL: likes, comments and views only, no impressions. */
  imported?: boolean;
};

export type Analytics = {
  days: number;
  accounts: (SocialAccount & {
    followers: number | null;
    growth: number;
    growth_percentage: number;
    series: { date: string; followers: number }[];
  })[];
  totals: {
    followers: number;
    followers_growth: number;
    posts: number;
    impressions: number;
    engagements: number;
    engagement_rate: number | null;
  };
  previous: { posts: number; impressions: number; engagements: number };
  posts: AnalyzedPost[];
  /** Average engagements by weekday (0 = Monday) and hour, in the brand's time zone. */
  best_times: { weekday: number; hour: number; posts: number; engagements: number }[];
  by_platform: { platform: string; posts: number; impressions: number; engagements: number }[];
  synced_at: string | null;
};

export type WatchedAccount = {
  id: string;
  brand_id: string;
  platform: WatchPlatform;
  handle: string;
  relation: "competitor" | "inspiration" | "self";
  name: string;
  avatar_url: string | null;
  profile_url: string | null;
  followers: number | null;
  posts: PublicPost[];
  checked_at: Date | null;
  error: string | null;
};

const DAY = 86_400_000;
const sum = (values: (number | undefined | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);

/** A tiny time-based cache, for the Zernio reads every page view repeats. */
class Cache {
  private readonly entries = new Map<string, { until: number; value: Promise<unknown> }>();
  get<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { until: Date.now() + ms, value });
    value.catch(() => this.entries.delete(key));
    return value;
  }
  drop(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

// A post's account is null once the account was disconnected.
const accountIdOf = (value: string | ZernioAccount | null) =>
  typeof value === "string" ? value : (value?._id ?? "");
const profileIdOf = (value: ZernioAccount["profileId"]) => (typeof value === "string" ? value : value?._id);

function toAccount(account: ZernioAccount): SocialAccount {
  return {
    id: account._id,
    platform: account.platform,
    username: account.username,
    name: account.displayName || account.username,
    avatar: account.profilePicture ?? null,
    url: account.profileUrl ?? null,
    active: account.isActive,
  };
}

function metricsOf(analytics: ZernioPostAnalytics["analytics"] | undefined): PostMetrics {
  const a = analytics ?? {};
  const engagements = sum([a.likes, a.comments, a.shares, a.saves, a.reposts, a.clicks]);
  const base = a.impressions || a.views || a.reach || 0;
  return {
    impressions: a.impressions ?? 0,
    reach: a.reach ?? 0,
    views: a.views ?? 0,
    likes: a.likes ?? 0,
    comments: a.comments ?? 0,
    shares: sum([a.shares, a.reposts]),
    saves: a.saves ?? 0,
    clicks: a.clicks ?? 0,
    engagements,
    engagement_rate: base > 0 ? engagements / base : null,
  };
}

/** The weekday (0 = Monday) and hour of a moment in a time zone. */
function zonedSlot(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    parts.find((p) => p.type === "weekday")!.value,
  );
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  return { weekday, hour };
}

export const validTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export class SocialService {
  readonly zernio: Zernio;
  readonly scraper: ScrapeCreators;
  private readonly cache = new Cache();

  constructor(
    private readonly sql: SQL,
    options: { zernio?: Zernio; scraper?: ScrapeCreators } = {},
  ) {
    this.zernio = options.zernio ?? new Zernio();
    this.scraper = options.scraper ?? new ScrapeCreators();
  }

  status() {
    return {
      publishing: this.zernio.configured,
      research: this.scraper.configured,
      link_existing: Bun.env.ZERNIO_LINK_EXISTING === "true",
    };
  }

  // Brands --------------------------------------------------------------------------------------------------

  async brands(userId: string) {
    return this.sql<Brand[]>`SELECT * FROM public.social_brands WHERE user_id = ${userId} ORDER BY created_at`;
  }

  async brand(userId: string, id: string): Promise<Brand> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SocialError(404, "No such brand");
    const [brand] = await this.sql<Brand[]>`
      SELECT * FROM public.social_brands WHERE id = ${id} AND user_id = ${userId}`;
    if (!brand) throw new SocialError(404, "No such brand");
    return brand;
  }

  /** The brand a copilot conversation works for. */
  async brandOfConversation(conversationId: number): Promise<Brand | undefined> {
    const [brand] = await this.sql<Brand[]>`
      SELECT b.* FROM public.social_brands b JOIN public.threads t ON t.id = b.thread_id
      WHERE t.conversation_id = ${conversationId}`;
    return brand;
  }

  /** Zernio profiles no brand uses yet, which a brand may take over (only with ZERNIO_LINK_EXISTING). */
  async linkableProfiles() {
    if (!this.status().link_existing) return [];
    const [profiles, taken] = await Promise.all([
      this.zernio.profiles(),
      this.sql<{ id: string }[]>`SELECT zernio_profile_id AS id FROM public.social_brands WHERE zernio_profile_id IS NOT NULL`,
    ]);
    const used = new Set(taken.map((row) => row.id));
    return profiles
      .filter((profile) => !used.has(profile._id))
      .map((profile) => ({
        id: profile._id,
        name: profile.name,
        accounts: profile.accountUsernames ?? [],
      }));
  }

  async createBrand(
    userId: string,
    input: BrandPatch & { name: string; link_profile_id?: string },
  ): Promise<Brand> {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new SocialError(400, "Name the brand");
    const id = crypto.randomUUID();
    let profileId: string;
    let owned = true;
    if (input.link_profile_id) {
      const linkable = await this.linkableProfiles();
      if (!linkable.some((profile) => profile.id === input.link_profile_id))
        throw new SocialError(400, "That Zernio profile cannot be linked");
      profileId = input.link_profile_id;
      owned = false;
    } else {
      const profile = await this.zernio.createProfile({
        name: `${name} (Richelieu)`,
        description: `Richelieu brand ${id}`,
        externalId: id,
      });
      profileId = profile._id;
    }
    const timezone = input.timezone && validTimezone(input.timezone) ? input.timezone : "UTC";
    return this.sql.begin(async (tx) => {
      const [thread] = await tx<{ id: string }[]>`
        INSERT INTO public.threads (user_id, title, kind) VALUES (${userId}, ${`${name} · Social`}, 'social') RETURNING id`;
      const [brand] = await tx<Brand[]>`
        INSERT INTO public.social_brands (id, user_id, name, website, description, audience, voice, timezone,
          zernio_profile_id, zernio_profile_owned, thread_id)
        VALUES (${id}, ${userId}, ${name}, ${input.website ?? ""}, ${input.description ?? ""}, ${input.audience ?? ""},
          ${input.voice ?? ""}, ${timezone}, ${profileId}, ${owned}, ${thread!.id})
        RETURNING *`;
      return brand!;
    });
  }

  async updateBrand(brand: Brand, patch: BrandPatch): Promise<Brand> {
    const next: Brand = { ...brand };
    for (const field of BRIEF_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (field === "pillars") {
        if (!Array.isArray(value)) throw new SocialError(400, "pillars is a list");
        next.pillars = (value as string[]).map((p) => String(p).trim()).filter(Boolean).slice(0, 12);
      } else if (field === "cadence") {
        const cadence: Record<string, number> = {};
        for (const [platform, count] of Object.entries((value as Record<string, number>) ?? {}))
          if (Number.isFinite(Number(count)) && Number(count) > 0) cadence[platform] = Math.min(50, Math.round(Number(count)));
        next.cadence = cadence;
      } else if (field === "timezone") {
        if (!validTimezone(String(value))) throw new SocialError(400, `Unknown time zone ${value}`);
        next.timezone = String(value);
      } else if (field === "name") {
        const name = String(value).trim().slice(0, 80);
        if (!name) throw new SocialError(400, "Name the brand");
        next.name = name;
      } else {
        (next as Record<string, unknown>)[field] = String(value).slice(0, 4000);
      }
    }
    const [updated] = await this.sql<Brand[]>`
      UPDATE public.social_brands SET name = ${next.name}, website = ${next.website}, description = ${next.description},
        audience = ${next.audience}, voice = ${next.voice}, pillars = ${this.sql.array(next.pillars, "text")},
        avoid = ${next.avoid}, examples = ${next.examples}, timezone = ${next.timezone},
        cadence = ${JSON.stringify(next.cadence)}::text::jsonb, updated_at = now()
      WHERE id = ${brand.id} RETURNING *`;
    if (next.name !== brand.name && brand.thread_id)
      await this.sql`UPDATE public.threads SET title = ${`${next.name} · Social`} WHERE id = ${brand.thread_id}`;
    return updated!;
  }

  async deleteBrand(brand: Brand) {
    if (brand.zernio_profile_id && brand.zernio_profile_owned) {
      // Zernio refuses to delete a profile with accounts: disconnect them first.
      try {
        for (const account of await this.zernio.accounts(brand.zernio_profile_id))
          await this.zernio.disconnect(account._id);
        await this.zernio.deleteProfile(brand.zernio_profile_id);
      } catch (error) {
        console.warn(`[social] could not delete Zernio profile ${brand.zernio_profile_id}:`, error);
      }
    }
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM public.social_brands WHERE id = ${brand.id}`;
      if (brand.thread_id) await tx`DELETE FROM public.threads WHERE id = ${brand.thread_id}`;
    });
    this.cache.drop(brand.id);
  }

  private profileOf(brand: Brand) {
    if (!brand.zernio_profile_id) throw new SocialError(409, "The brand has no Zernio profile");
    return brand.zernio_profile_id;
  }

  // Accounts ------------------------------------------------------------------------------------------------

  async accounts(brand: Brand): Promise<SocialAccount[]> {
    const profileId = this.profileOf(brand);
    return this.cache.get(`${brand.id}:accounts`, 60_000, async () =>
      (await this.zernio.accounts(profileId))
        .filter((account) => profileIdOf(account.profileId) === profileId)
        .map(toAccount),
    );
  }

  async connectUrl(brand: Brand, platform: string, redirectUrl: string) {
    if (!platformInfo(platform).connectable) throw new SocialError(400, `${platform} cannot be connected here`);
    this.cache.drop(`${brand.id}:accounts`);
    return this.zernio.connectUrl(platform, this.profileOf(brand), redirectUrl);
  }

  async disconnect(brand: Brand, accountId: string) {
    const accounts = await this.accounts(brand);
    if (!accounts.some((a) => a.id === accountId)) throw new SocialError(404, "No such account");
    await this.zernio.disconnect(accountId);
    this.cache.drop(`${brand.id}:accounts`);
  }

  // Posts ---------------------------------------------------------------------------------------------------

  private belongs(brand: Brand, post: ZernioPost) {
    const profileId = this.profileOf(brand);
    if (post.profileId === profileId) return true;
    return (
      post.platforms.length > 0 &&
      post.platforms.some((p) => p.accountId && typeof p.accountId === "object" && profileIdOf(p.accountId.profileId) === profileId) &&
      post.platforms.every((p) => !p.accountId || (typeof p.accountId === "object" && profileIdOf(p.accountId.profileId) === profileId))
    );
  }

  private toPost(post: ZernioPost, accounts: SocialAccount[]): SocialPost {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return {
      id: post._id,
      status: post.status,
      content: post.content ?? "",
      title: post.title ?? "",
      scheduled_for: post.scheduledFor ?? null,
      published_at:
        post.platforms.map((p) => p.publishedAt).filter(Boolean).sort()[0] ??
        (post.status === "published" ? (post.scheduledFor ?? null) : null),
      timezone: post.timezone ?? null,
      media: (post.mediaItems ?? []).map((m) => ({ url: m.url, type: m.type })),
      platforms: post.platforms.map((p) => {
        const accountId = accountIdOf(p.accountId);
        const account = p.accountId && typeof p.accountId === "object" ? toAccount(p.accountId) : byId.get(accountId);
        return {
          account_id: accountId,
          platform: p.platform,
          username: account?.username ?? "",
          avatar: account?.avatar ?? null,
          status: p.status ?? null,
          url: p.platformPostUrl ?? null,
          error: p.errorMessage ?? null,
          custom_content: p.customContent ?? null,
        };
      }),
      created_at: post.createdAt,
      updated_at: post.updatedAt,
      source: "zernio",
    };
  }

  /** An imported post, shown under the brand's connected account of its platform when there is one. */
  private importedToPost(row: ImportedRow, accounts: SocialAccount[] = []): SocialPost {
    const account = accounts.find((a) => a.platform === row.platform);
    const at = row.published_at ? new Date(row.published_at).toISOString() : new Date(row.created_at).toISOString();
    return {
      id: row.id,
      status: "published",
      content: row.content,
      title: "",
      scheduled_for: null,
      published_at: at,
      timezone: null,
      media: row.thumbnail ? [{ url: row.thumbnail, type: "image" }] : [],
      platforms: [
        {
          account_id: account?.id ?? "",
          platform: row.platform,
          username: account?.name ?? "",
          avatar: account?.avatar ?? null,
          status: "published",
          url: row.url,
          error: row.error,
          custom_content: null,
        },
      ],
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.checked_at ?? row.created_at).toISOString(),
      source: "imported",
      metrics: { views: row.views, likes: row.likes, comments: row.comments, shares: row.shares },
    };
  }

  /** Posts planned, scheduled or published between two dates, and drafts without a date (`undated`). */
  async posts(
    brand: Brand,
    range: { from?: string; to?: string; status?: string; search?: string } = {},
  ): Promise<SocialPost[]> {
    const profileId = this.profileOf(brand);
    const [accounts, first] = await Promise.all([
      this.accounts(brand),
      this.zernio.posts({ profileId, status: range.status, search: range.search, limit: 100 }),
    ]);
    let all = first.posts;
    // A brand with many posts: read further pages, up to 500 posts.
    for (let page = 2; page <= Math.min(first.pagination?.pages ?? 1, 5); page++)
      all = all.concat(
        (await this.zernio.posts({ profileId, status: range.status, search: range.search, limit: 100, page })).posts,
      );
    const from = range.from ? Date.parse(range.from) : -Infinity;
    const to = range.to ? Date.parse(range.to) : Infinity;
    const imported =
      !range.status || range.status === "published"
        ? (await this.importedPosts(brand)).filter((row) => !range.search || row.content.toLowerCase().includes(range.search.toLowerCase()))
        : [];
    return all
      .filter((post) => this.belongs(brand, post))
      .map((post) => this.toPost(post, accounts))
      .concat(imported.map((row) => this.importedToPost(row, accounts)))
      .filter((post) => {
        const at = post.scheduled_for ?? post.published_at;
        if (!at) return true;
        const time = Date.parse(at);
        return time >= from && time <= to;
      });
  }

  async post(brand: Brand, id: string): Promise<SocialPost> {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new SocialError(404, "No such post");
    let post: ZernioPost;
    try {
      post = await this.zernio.post(id);
    } catch (error) {
      if (error instanceof ZernioError && error.status === 404) throw new SocialError(404, "No such post");
      throw error;
    }
    if (!this.belongs(brand, post)) throw new SocialError(404, "No such post");
    return this.toPost(post, await this.accounts(brand));
  }

  /** Creates or changes a post. Scheduling and publishing check each platform's rules first. */
  async savePost(
    brand: Brand,
    input: PostInput,
    options: { id?: string; idempotencyKey?: string } = {},
  ): Promise<{ post: SocialPost; warnings: string[] }> {
    const accounts = await this.accounts(brand);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const channels = input.channels.map((channel) => {
      const account = byId.get(channel.account_id);
      if (!account) throw new SocialError(400, `Account ${channel.account_id} is not connected to ${brand.name}`);
      return { account, custom: channel.custom_content?.trim() ? channel.custom_content : null };
    });
    const media = (input.media ?? []).filter((m) => /^https:\/\//.test(m.url));
    const content = input.content ?? "";

    if (input.mode !== "draft") {
      if (channels.length === 0) throw new SocialError(400, "Pick at least one account to post on");
      const problems = channels.flatMap((c) => problemsFor(c.account.platform, c.custom ?? content, media));
      if (problems.length) throw new SocialError(400, problems.join(". "));
      if (input.mode === "schedule") {
        const at = input.scheduled_for ? Date.parse(input.scheduled_for) : NaN;
        if (!Number.isFinite(at)) throw new SocialError(400, "Pick a date and time to schedule the post");
        if (at < Date.now() + 60_000) throw new SocialError(400, "Pick a time in the future (or publish now)");
      }
    }
    if (options.id) {
      const existing = await this.post(brand, options.id);
      if (existing.status === "published" || existing.status === "publishing")
        throw new SocialError(409, "This post is already published");
    }

    const body = {
      content,
      title: input.title || undefined,
      mediaItems: media,
      platforms: channels.map((c) => ({
        platform: c.account.platform,
        accountId: c.account.id,
        ...(c.custom ? { customContent: c.custom } : {}),
      })),
      timezone: brand.timezone,
      scheduledFor: input.scheduled_for ?? undefined,
      isDraft: input.mode === "draft",
      ...(input.mode === "publish" ? { publishNow: true } : {}),
      // A draft for no account yet is filed under the brand's profile by Zernio itself.
      ...(channels.length === 0 ? { profileId: this.profileOf(brand) } : {}),
    };
    const result = options.id
      ? await this.zernio.updatePost(options.id, body)
      : await this.zernio.createPost(body, options.idempotencyKey);
    return {
      post: this.toPost(result.post, accounts),
      warnings: ("warnings" in result && Array.isArray(result.warnings) ? result.warnings : []).filter(
        (w: string) => !/root-level "profileId"/.test(w),
      ),
    };
  }

  /** Moves a draft or a scheduled post to another time, keeping its status. */
  async reschedule(brand: Brand, id: string, at: string) {
    const post = await this.post(brand, id);
    if (!["draft", "scheduled", "failed"].includes(post.status))
      throw new SocialError(409, "Only drafts and scheduled posts can move");
    if (post.status === "scheduled" && Date.parse(at) < Date.now() + 60_000)
      throw new SocialError(400, "A scheduled post can only move to the future");
    const result = await this.zernio.updatePost(id, {
      scheduledFor: at,
      timezone: brand.timezone,
      ...(post.status === "draft" ? { isDraft: true } : {}),
    });
    return this.toPost(result.post, await this.accounts(brand));
  }

  async deletePost(brand: Brand, id: string) {
    const post = await this.post(brand, id);
    if (post.status === "published" || post.status === "publishing")
      throw new SocialError(409, "Published posts stay: delete them on the platform");
    await this.zernio.deletePost(id);
  }

  async retryPost(brand: Brand, id: string) {
    await this.post(brand, id);
    await this.zernio.retryPost(id);
    return this.post(brand, id);
  }

  async upload(brand: Brand, file: File) {
    this.profileOf(brand);
    if (file.size > 200 * 1024 * 1024) throw new SocialError(413, "Files up to 200 MB");
    const type = file.type || "application/octet-stream";
    const kind = type.startsWith("video/") ? "video" : type === "image/gif" ? "gif" : type.startsWith("image/") ? "image" : null;
    if (!kind) throw new SocialError(400, "Images and videos only");
    const url = await this.zernio.upload(file.name || "upload", type, file);
    return { url, type: kind } satisfies ZernioMedia;
  }

  // Analytics -----------------------------------------------------------------------------------------------

  async analytics(brand: Brand, days = 30): Promise<Analytics> {
    days = Math.max(7, Math.min(365, Math.round(days)));
    const profileId = this.profileOf(brand);
    return this.cache.get(`${brand.id}:analytics:${days}`, 5 * 60_000, async () => {
      const since = new Date(Date.now() - 2 * days * DAY);
      const sinceDay = since.toISOString().slice(0, 10);
      const [accounts, followers, first] = await Promise.all([
        this.accounts(brand),
        this.zernio.followerStats(profileId, sinceDay).catch(() => ({ accounts: [], stats: {} }) as ZernioFollowerStats),
        this.zernio.analytics({ profileId, fromDate: sinceDay, limit: 100 }),
      ]);
      let rows = first.posts ?? [];
      for (let page = 2; page <= Math.min(first.pagination?.pages ?? 1, 5); page++)
        rows = rows.concat((await this.zernio.analytics({ profileId, fromDate: sinceDay, limit: 100, page })).posts ?? []);

      const accountIds = new Set(accounts.map((a) => a.id));
      const cutoff = Date.now() - days * DAY;
      const posts: AnalyzedPost[] = rows
        .filter((row) => row.publishedAt)
        // Only the brand's own accounts' posts.
        .filter((row) => !row.platformAnalytics?.length || row.platformAnalytics.some((p) => accountIds.has(p.accountId)))
        .map((row) => ({
          id: row.latePostId ?? row._id,
          content: row.content ?? "",
          published_at: row.publishedAt,
          platforms: [...new Set((row.platformAnalytics ?? []).map((p) => p.platform).concat(row.platform ? [row.platform] : []))],
          url: row.platformPostUrl ?? row.platformAnalytics?.find((p) => p.platformPostUrl)?.platformPostUrl ?? null,
          thumbnail: row.thumbnailUrl ?? row.mediaItems?.find((m) => m.type === "image")?.url ?? null,
          ...metricsOf(row.analytics),
        }));
      for (const row of await this.importedPosts(brand)) {
        if (!row.published_at || new Date(row.published_at).getTime() < since.getTime()) continue;
        const engagements = (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0);
        posts.push({
          id: row.id,
          content: row.content,
          published_at: new Date(row.published_at).toISOString(),
          platforms: [row.platform],
          url: row.url,
          thumbnail: row.thumbnail,
          impressions: 0,
          reach: 0,
          views: row.views ?? 0,
          likes: row.likes ?? 0,
          comments: row.comments ?? 0,
          shares: row.shares ?? 0,
          saves: 0,
          clicks: 0,
          engagements,
          engagement_rate: row.views ? engagements / row.views : null,
          imported: true,
        });
      }
      const current = posts.filter((p) => Date.parse(p.published_at) >= cutoff);
      const previous = posts.filter((p) => Date.parse(p.published_at) < cutoff);

      const statsById = new Map(followers.accounts.map((a) => [a._id, a]));
      const sinceCurrent = new Date(cutoff).toISOString().slice(0, 10);
      const accountRows = accounts.map((account) => {
        const series = (followers.stats[account.id] ?? []).filter((point) => point.date >= sinceCurrent);
        const stat = statsById.get(account.id);
        const latest = stat?.currentFollowers ?? series.at(-1)?.followers ?? null;
        const start = series[0]?.followers ?? latest ?? 0;
        const growth = latest === null ? 0 : latest - start;
        return {
          ...account,
          followers: latest,
          growth,
          growth_percentage: start > 0 ? (growth / start) * 100 : 0,
          series,
        };
      });

      const slots = new Map<string, { weekday: number; hour: number; posts: number; engagements: number }>();
      for (const post of posts) {
        const { weekday, hour } = zonedSlot(new Date(post.published_at), brand.timezone);
        const key = `${weekday}:${hour}`;
        const slot = slots.get(key) ?? { weekday, hour, posts: 0, engagements: 0 };
        slot.posts++;
        slot.engagements += post.engagements;
        slots.set(key, slot);
      }

      const platforms = new Map<string, { platform: string; posts: number; impressions: number; engagements: number }>();
      for (const post of current)
        for (const platform of post.platforms.length ? post.platforms : ["other"]) {
          const row = platforms.get(platform) ?? { platform, posts: 0, impressions: 0, engagements: 0 };
          row.posts++;
          row.impressions += post.impressions;
          row.engagements += post.engagements;
          platforms.set(platform, row);
        }

      const impressions = sum(current.map((p) => p.impressions || p.views));
      const engagements = sum(current.map((p) => p.engagements));
      return {
        days,
        accounts: accountRows,
        totals: {
          followers: sum(accountRows.map((a) => a.followers)),
          followers_growth: sum(accountRows.map((a) => a.growth)),
          posts: current.length,
          impressions,
          engagements,
          engagement_rate: impressions > 0 ? engagements / impressions : null,
        },
        previous: {
          posts: previous.length,
          impressions: sum(previous.map((p) => p.impressions || p.views)),
          engagements: sum(previous.map((p) => p.engagements)),
        },
        posts: current.sort((a, b) => b.published_at.localeCompare(a.published_at)),
        best_times: [...slots.values()],
        by_platform: [...platforms.values()],
        synced_at: first.overview?.lastSync ?? null,
      };
    });
  }

  // Watchlist -----------------------------------------------------------------------------------------------

  async watchlist(brand: Brand) {
    return this.sql<WatchedAccount[]>`
      SELECT * FROM public.social_watch WHERE brand_id = ${brand.id} ORDER BY relation, followers DESC NULLS LAST`;
  }

  async research(platform: string, handle: string, fresh = false): Promise<PublicProfile> {
    if (!(WATCH_PLATFORMS as readonly string[]).includes(platform))
      throw new SocialError(400, `Research works on ${WATCH_PLATFORMS.join(", ")}`);
    return this.scraper.profile(platform as WatchPlatform, handle, fresh ? "" : "1d");
  }

  async watch(brand: Brand, input: { platform: string; handle: string; relation?: string }) {
    if (!(WATCH_PLATFORMS as readonly string[]).includes(input.platform))
      throw new SocialError(400, `Watch accounts on ${WATCH_PLATFORMS.join(", ")}`);
    const platform = input.platform as WatchPlatform;
    const handle = normalizeHandle(platform, input.handle);
    if (!handle) throw new SocialError(400, "Give the account's handle or URL");
    const relation = ["competitor", "inspiration", "self"].includes(input.relation ?? "") ? input.relation! : "competitor";
    const profile = await this.research(platform, handle);
    const [row] = await this.sql<WatchedAccount[]>`
      INSERT INTO public.social_watch (brand_id, user_id, platform, handle, relation)
      VALUES (${brand.id}, ${brand.user_id}, ${platform}, ${handle}, ${relation})
      ON CONFLICT (brand_id, platform, handle) DO UPDATE SET relation = EXCLUDED.relation
      RETURNING *`;
    return this.store(row!, profile);
  }

  private async store(row: WatchedAccount, profile: PublicProfile) {
    const posts = profile.posts.slice(0, 30);
    const engaged = posts.filter((p) => p.likes !== null);
    const avg = engaged.length ? sum(engaged.map(engagementOf)) / engaged.length : null;
    const [updated] = await this.sql<WatchedAccount[]>`
      UPDATE public.social_watch SET name = ${profile.name}, avatar_url = ${profile.avatar_url},
        profile_url = ${profile.profile_url}, followers = ${profile.followers},
        posts = ${JSON.stringify(posts)}::text::jsonb, checked_at = now(), error = NULL
      WHERE id = ${row.id} RETURNING *`;
    await this.sql`
      INSERT INTO public.social_watch_history (watch_id, day, followers, avg_engagement)
      VALUES (${row.id}, current_date, ${profile.followers}, ${avg})
      ON CONFLICT (watch_id, day) DO UPDATE SET followers = EXCLUDED.followers, avg_engagement = EXCLUDED.avg_engagement`;
    return updated!;
  }

  async watched(brand: Brand, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SocialError(404, "No such account in the watchlist");
    const [row] = await this.sql<WatchedAccount[]>`
      SELECT * FROM public.social_watch WHERE id = ${id} AND brand_id = ${brand.id}`;
    if (!row) throw new SocialError(404, "No such account in the watchlist");
    return row;
  }

  async refreshWatched(row: WatchedAccount) {
    try {
      return await this.store(row, await this.scraper.profile(row.platform, row.handle, ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sql`UPDATE public.social_watch SET error = ${message}, checked_at = now() WHERE id = ${row.id}`;
      throw error;
    }
  }

  async unwatch(brand: Brand, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    await this.sql`DELETE FROM public.social_watch WHERE id = ${id} AND brand_id = ${brand.id}`;
  }

  async watchHistory(brand: Brand) {
    return this.sql<{ watch_id: string; day: string; followers: number | null }[]>`
      SELECT h.watch_id, h.day::text AS day, h.followers FROM public.social_watch_history h
      JOIN public.social_watch w ON w.id = h.watch_id
      WHERE w.brand_id = ${brand.id} AND h.day > current_date - 90 ORDER BY h.day`;
  }

  // Imported posts ----------------------------------------------------------------------------------------

  async importedPosts(brand: Brand) {
    return this.sql<ImportedRow[]>`
      SELECT * FROM public.social_imported_posts WHERE brand_id = ${brand.id} ORDER BY published_at DESC NULLS LAST`;
  }

  /**
   * Imports a post the brand published outside Zernio, from its URL (short links too). The same post imported again,
   * by any of its URLs, is read again instead of added twice; a post Zernio already has is refused.
   */
  async importPost(brand: Brand, input: string): Promise<SocialPost> {
    let url: string;
    try {
      url = await resolvePostUrl(input);
    } catch {
      throw new SocialError(400, "That is not a post's URL");
    }
    if (!platformOfUrl(url)) throw new SocialError(400, "Paste a post's URL from LinkedIn, X, Instagram, TikTok or YouTube");
    const post = await this.scraper.post(url);
    const ids = post.ids.length ? post.ids : idsIn(url);

    // Published through Zernio already: it is on the calendar with its full analytics.
    if (brand.zernio_profile_id && ids.length) {
      const zernio = await this.posts(brand, { status: "published" }).catch(() => []);
      const known = zernio.find(
        (p) => p.source === "zernio" && p.platforms.some((x) => x.url && idsIn(x.url).some((id) => ids.includes(id))),
      );
      if (known) throw new SocialError(409, "This post was published through Richelieu: it is already on the calendar");
    }

    const [existing] = await this.sql<ImportedRow[]>`
      SELECT * FROM public.social_imported_posts
      WHERE brand_id = ${brand.id} AND (url = ${post.url} OR external_ids && ${this.sql.array(ids, "text")})
      LIMIT 1`;
    const [row] = existing
      ? await this.sql<ImportedRow[]>`
          UPDATE public.social_imported_posts SET content = ${post.text}, thumbnail = ${post.thumbnail},
            published_at = ${post.published_at}, views = ${post.views}, likes = ${post.likes}, comments = ${post.comments},
            shares = ${post.shares}, external_ids = ${this.sql.array([...new Set([...existing.external_ids, ...ids])], "text")},
            checked_at = now(), error = NULL
          WHERE id = ${existing.id} RETURNING *`
      : await this.sql<ImportedRow[]>`
          INSERT INTO public.social_imported_posts (brand_id, user_id, platform, url, external_ids, content, thumbnail,
            published_at, views, likes, comments, shares, checked_at)
          VALUES (${brand.id}, ${brand.user_id}, ${post.platform}, ${post.url}, ${this.sql.array(ids, "text")}, ${post.text},
            ${post.thumbnail}, ${post.published_at}, ${post.views}, ${post.likes}, ${post.comments}, ${post.shares}, now())
          RETURNING *`;
    this.cache.drop(`${brand.id}:analytics`);
    return this.importedToPost(row!, await this.accounts(brand).catch(() => []));
  }

  async deleteImported(brand: Brand, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SocialError(404, "No such post");
    const rows = await this.sql`DELETE FROM public.social_imported_posts WHERE id = ${id} AND brand_id = ${brand.id} RETURNING id`;
    if (rows.length === 0) throw new SocialError(404, "No such post");
    this.cache.drop(`${brand.id}:analytics`);
  }

  /** Reads an imported post's numbers again. */
  async refreshImported(row: ImportedRow) {
    try {
      const post = await this.scraper.post(row.url);
      await this.sql`
        UPDATE public.social_imported_posts SET content = ${post.text}, thumbnail = ${post.thumbnail ?? row.thumbnail},
          views = ${post.views}, likes = ${post.likes}, comments = ${post.comments}, shares = ${post.shares},
          checked_at = now(), error = NULL
        WHERE id = ${row.id}`;
      this.cache.drop(`${row.brand_id}:analytics`);
    } catch (error) {
      await this.sql`UPDATE public.social_imported_posts SET checked_at = now(), error = ${error instanceof Error ? error.message : String(error)} WHERE id = ${row.id}`;
      throw error;
    }
  }

  /** Refreshes watched accounts not checked for a day, and imported posts of the last 30 days; runs every hour. */
  async refreshStale(limit = 20) {
    if (!this.scraper.configured) return 0;
    const imported = await this.sql<ImportedRow[]>`
      SELECT * FROM public.social_imported_posts
      WHERE published_at > now() - interval '30 days' AND (checked_at IS NULL OR checked_at < now() - interval '20 hours')
      ORDER BY checked_at NULLS FIRST LIMIT ${limit}`;
    for (const row of imported)
      await this.refreshImported(row).catch((error) =>
        console.warn(`[social] imported post ${row.url}:`, error instanceof Error ? error.message : error),
      );
    const rows = await this.sql<WatchedAccount[]>`
      SELECT * FROM public.social_watch WHERE checked_at IS NULL OR checked_at < now() - interval '20 hours'
      ORDER BY checked_at NULLS FIRST LIMIT ${limit}`;
    let done = 0;
    for (const row of rows) {
      await this.refreshWatched(row).then(
        () => done++,
        (error) => console.warn(`[social] watch ${row.platform}/${row.handle}:`, error.message),
      );
    }
    return done;
  }
}
