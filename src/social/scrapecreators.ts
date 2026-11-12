// ScrapeCreators (scrapecreators.com): public profiles and posts of any account, for the accounts a brand watches
// (competitors, inspiration) and for the agent's research. Each platform answers in its own shape; this file reads
// them into one. A call costs a credit; `cache_max_age` reuses ScrapeCreators' cache for free when fresh enough.

const BASE = "https://api.scrapecreators.com";

export const WATCH_PLATFORMS = ["instagram", "tiktok", "twitter", "linkedin", "youtube"] as const;
export type WatchPlatform = (typeof WATCH_PLATFORMS)[number];

export type PublicPost = {
  id: string;
  url: string;
  text: string;
  thumbnail: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type PublicProfile = {
  platform: WatchPlatform;
  handle: string;
  name: string;
  avatar_url: string | null;
  profile_url: string;
  followers: number | null;
  bio: string;
  posts: PublicPost[];
};

export class ScrapeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, any>;

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const iso = (value: unknown): string | null => {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
};

/** A handle as typed by a person: `@nike`, `nike`, or a profile URL, down to what the platform's endpoint takes. */
export function normalizeHandle(platform: WatchPlatform, input: string): string {
  const value = input.trim();
  if (platform === "linkedin") {
    if (/^https?:\/\//i.test(value)) return value.replace(/[?#].*$/, "").replace(/\/?$/, "/");
    return `https://www.linkedin.com/company/${value.replace(/^@/, "")}/`;
  }
  const fromUrl = value.match(
    /(?:instagram\.com|tiktok\.com\/@?|x\.com|twitter\.com|youtube\.com\/@?)\/?@?([\w.\-]+)/i,
  )?.[1];
  return (fromUrl ?? value).replace(/^@/, "").replace(/\/$/, "");
}

/** The platform a post's URL belongs to, or nothing. */
export function platformOfUrl(url: string): WatchPlatform | null {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (/(^|\.)linkedin\.com$|^lnkd\.in$/.test(host)) return "linkedin";
  if (/^(x|twitter|mobile\.twitter)\.com$|^t\.co$/.test(host)) return "twitter";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return "youtube";
  return null;
}

/** Short links the platforms hand out, followed to the post's own URL before reading it. */
const SHORTENERS = /^(lnkd\.in|t\.co|vm\.tiktok\.com|vt\.tiktok\.com)$/;

export async function resolvePostUrl(input: string): Promise<string> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  for (let hop = 0; hop < 4; hop++) {
    const host = new URL(url).hostname.toLowerCase();
    if (!SHORTENERS.test(host)) break;
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RichelieuBot/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    const next = response.headers.get("location");
    if (!next) break;
    url = new URL(next, url).toString();
  }
  // Tracking parameters are not part of the post.
  const parsed = new URL(url);
  for (const name of [...parsed.searchParams.keys()])
    if (/^(utm_|rcm$|trk|si$|igsh|s$|t$|feature$)/.test(name)) parsed.searchParams.delete(name);
  parsed.hash = "";
  return parsed.toString();
}

/** The long numbers in a post's URL or URNs: what identifies it across its many URLs. */
export const idsIn = (...values: (string | null | undefined)[]) =>
  [...new Set(values.flatMap((v) => (v ?? "").match(/\d{12,}/g) ?? []))];

export type ImportedPost = PublicPost & { platform: WatchPlatform; ids: string[] };

export class ScrapeCreators {
  constructor(private readonly key: string | undefined = Bun.env.SCRAPECREATORS_API_KEY) {}

  get configured() {
    return Boolean(this.key);
  }

  private async get(path: string, query: Record<string, string>): Promise<Json> {
    if (!this.key) throw new ScrapeError(503, "Account research is off: set SCRAPECREATORS_API_KEY in .env");
    const url = new URL(BASE + path);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await fetch(url, {
      headers: { "x-api-key": this.key },
      signal: AbortSignal.timeout(45_000),
    });
    const json = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok)
      throw new ScrapeError(
        response.status,
        response.status === 402
          ? "ScrapeCreators is out of credits"
          : String(json.message ?? json.error ?? `ScrapeCreators answered ${response.status}`),
      );
    if (json.error === "not_found" || json.success === false)
      throw new ScrapeError(404, String(json.message ?? "Account not found"));
    return json;
  }

  /** A public account and its latest posts. Two credits, none when ScrapeCreators' cache is fresh enough. */
  async profile(platform: WatchPlatform, handleInput: string, cacheMaxAge = "1d"): Promise<PublicProfile> {
    const handle = normalizeHandle(platform, handleInput);
    const cache: Record<string, string> = cacheMaxAge ? { cache_max_age: cacheMaxAge } : {};
    switch (platform) {
      case "instagram": {
        const [profile, posts] = await Promise.all([
          this.get("/v1/instagram/profile", { handle, ...cache }),
          this.get("/v2/instagram/user/posts", { handle, ...cache }).catch(() => ({ items: [] })),
        ]);
        const user = profile.data?.user;
        if (!user) throw new ScrapeError(404, `No Instagram account @${handle}`);
        return {
          platform,
          handle,
          name: user.full_name || user.username || handle,
          avatar_url: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
          profile_url: `https://www.instagram.com/${handle}/`,
          followers: num(user.edge_followed_by?.count),
          bio: user.biography ?? "",
          posts: (posts.items ?? []).map(
            (item: Json): PublicPost => ({
              id: String(item.code ?? item.id),
              url: item.url ?? `https://www.instagram.com/p/${item.code}/`,
              text: item.caption?.text ?? "",
              thumbnail: item.display_uri ?? item.image_versions2?.candidates?.[0]?.url ?? null,
              published_at: iso(item.taken_at),
              views: num(item.play_count ?? item.ig_play_count),
              likes: num(item.like_count),
              comments: num(item.comment_count),
              shares: num(item.reshare_count),
            }),
          ),
        };
      }
      case "tiktok": {
        const [profile, videos] = await Promise.all([
          this.get("/v1/tiktok/profile", { handle, ...cache }),
          this.get("/v3/tiktok/profile/videos", { handle, ...cache }).catch(() => ({ aweme_list: [] })),
        ]);
        if (!profile.user) throw new ScrapeError(404, `No TikTok account @${handle}`);
        return {
          platform,
          handle,
          name: profile.user.nickname || handle,
          avatar_url: profile.user.avatarMedium ?? profile.user.avatarLarger ?? null,
          profile_url: `https://www.tiktok.com/@${handle}`,
          followers: num(profile.stats?.followerCount),
          bio: profile.user.signature ?? "",
          posts: (videos.aweme_list ?? []).map(
            (item: Json): PublicPost => ({
              id: String(item.aweme_id),
              url: item.url ?? `https://www.tiktok.com/@${handle}/video/${item.aweme_id}`,
              text: item.desc ?? "",
              thumbnail: item.video?.cover?.url_list?.[0] ?? null,
              published_at: iso(item.create_time),
              views: num(item.statistics?.play_count),
              likes: num(item.statistics?.digg_count),
              comments: num(item.statistics?.comment_count),
              shares: num(item.statistics?.share_count),
            }),
          ),
        };
      }
      case "twitter": {
        const [profile, tweets] = await Promise.all([
          this.get("/v1/twitter/profile", { handle, ...cache }),
          this.get("/v1/twitter/user-tweets", { handle, ...cache }).catch(() => ({ tweets: [] })),
        ]);
        const legacy = profile.legacy ?? {};
        const name = profile.core?.name ?? legacy.name ?? handle;
        return {
          platform,
          handle,
          name,
          avatar_url: profile.avatar?.image_url ?? legacy.profile_image_url_https ?? null,
          profile_url: `https://x.com/${handle}`,
          followers: num(legacy.followers_count),
          bio: legacy.description ?? "",
          posts: (tweets.tweets ?? []).map(
            (tweet: Json): PublicPost => ({
              id: String(tweet.rest_id),
              url: tweet.url ?? `https://x.com/${handle}/status/${tweet.rest_id}`,
              text: tweet.legacy?.full_text ?? "",
              thumbnail: tweet.legacy?.entities?.media?.[0]?.media_url_https ?? null,
              published_at: iso(tweet.legacy?.created_at),
              views: num(tweet.views?.count),
              likes: num(tweet.legacy?.favorite_count),
              comments: num(tweet.legacy?.reply_count),
              shares: num(tweet.legacy?.retweet_count),
            }),
          ),
        };
      }
      case "linkedin": {
        const isPerson = /linkedin\.com\/in\//i.test(handle);
        if (isPerson) {
          const profile = await this.get("/v1/linkedin/profile", { url: handle, ...cache });
          return {
            platform,
            handle,
            name: profile.name ?? handle,
            avatar_url: profile.image ?? null,
            profile_url: handle,
            followers: num(profile.followers),
            bio: profile.about ?? "",
            posts: (profile.recentPosts ?? []).map(
              (post: Json, index: number): PublicPost => ({
                id: String(post.link ?? index),
                url: post.link ?? handle,
                text: post.title ?? "",
                thumbnail: post.image ?? null,
                published_at: null,
                views: null,
                likes: null,
                comments: null,
                shares: null,
              }),
            ),
          };
        }
        const [company, posts] = await Promise.all([
          this.get("/v1/linkedin/company", { url: handle, ...cache }),
          this.get("/v1/linkedin/company/posts", { url: handle, ...cache }).catch(() => ({ posts: [] })),
        ]);
        return {
          platform,
          handle,
          name: company.name ?? handle,
          avatar_url: company.logo ?? null,
          profile_url: handle,
          followers: num(company.followers),
          bio: company.slogan || company.description || "",
          posts: (posts.posts ?? []).map(
            (post: Json): PublicPost => ({
              id: String(post.id),
              url: post.url,
              text: post.text ?? "",
              thumbnail: null,
              published_at: iso(post.datePublished),
              views: null,
              likes: null,
              comments: null,
              shares: null,
            }),
          ),
        };
      }
      case "youtube": {
        const [channel, videos] = await Promise.all([
          this.get("/v1/youtube/channel", { handle, ...cache }),
          this.get("/v1/youtube/channel-videos", { handle, ...cache }).catch(() => ({ videos: [] })),
        ]);
        return {
          platform,
          handle,
          name: channel.name ?? handle,
          avatar_url: channel.avatar?.image?.sources?.at(-1)?.url ?? null,
          profile_url: channel.channel ?? `https://www.youtube.com/@${handle}`,
          followers: num(channel.subscriberCount),
          bio: channel.description ?? "",
          posts: (videos.videos ?? []).map(
            (video: Json): PublicPost => ({
              id: String(video.id),
              url: video.url,
              text: video.title ?? "",
              thumbnail: video.thumbnail ?? null,
              published_at: iso(video.publishedTime ?? video.publishDate),
              views: num(video.viewCountInt),
              likes: num(video.likeCountInt),
              comments: num(video.commentCountInt),
              shares: null,
            }),
          ),
        };
      }
    }
  }

  /** One post, from its URL. A credit, none when ScrapeCreators' cache is fresh enough. */
  async post(url: string, cacheMaxAge = ""): Promise<ImportedPost> {
    const platform = platformOfUrl(url);
    if (!platform) throw new ScrapeError(400, "Paste a post's URL from LinkedIn, X, Instagram, TikTok or YouTube");
    const query: Record<string, string> = { url, ...(cacheMaxAge ? { cache_max_age: cacheMaxAge } : {}) };
    switch (platform) {
      case "linkedin": {
        const post = await this.get("/v1/linkedin/post", query);
        if (!post.datePublished && !post.description) throw new ScrapeError(404, "LinkedIn did not show this post");
        return {
          platform,
          id: String(post.activityUrn ?? post.contentUrn ?? url),
          ids: idsIn(url, post.activityUrn, post.contentUrn, post.url),
          url: String(post.url ?? url).replace(/^https:\/\/[a-z]{2}\.linkedin\.com/, "https://www.linkedin.com"),
          text: post.description ?? "",
          thumbnail: post.image ?? post.images?.[0] ?? null,
          published_at: iso(post.datePublished),
          views: null,
          likes: num(post.likeCount),
          comments: num(post.commentCount),
          shares: null,
        };
      }
      case "twitter": {
        const tweet = await this.get("/v1/twitter/tweet", query);
        if (!tweet.legacy) throw new ScrapeError(404, "X did not show this post");
        return {
          platform,
          id: String(tweet.rest_id),
          ids: idsIn(url, tweet.rest_id),
          url,
          text: tweet.legacy.full_text ?? "",
          thumbnail: tweet.legacy.entities?.media?.[0]?.media_url_https ?? null,
          published_at: iso(tweet.legacy.created_at),
          views: num(tweet.views?.count),
          likes: num(tweet.legacy.favorite_count),
          comments: num(tweet.legacy.reply_count),
          shares: num(tweet.legacy.retweet_count),
        };
      }
      case "instagram": {
        const media = (await this.get("/v1/instagram/post", query)).data?.xdt_shortcode_media;
        if (!media) throw new ScrapeError(404, "Instagram did not show this post");
        return {
          platform,
          id: String(media.shortcode ?? media.id),
          ids: idsIn(url, media.id),
          url: `https://www.instagram.com/p/${media.shortcode}/`,
          text: media.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
          thumbnail: media.display_url ?? null,
          published_at: iso(media.taken_at_timestamp),
          views: num(media.video_play_count ?? media.video_view_count),
          likes: num(media.edge_media_preview_like?.count ?? media.edge_liked_by?.count),
          comments: num(media.edge_media_to_parent_comment?.count ?? media.edge_media_to_comment?.count),
          shares: null,
        };
      }
      case "tiktok": {
        const video = (await this.get("/v2/tiktok/video", query)).aweme_detail;
        if (!video) throw new ScrapeError(404, "TikTok did not show this video");
        return {
          platform,
          id: String(video.aweme_id),
          ids: idsIn(url, video.aweme_id),
          url,
          text: video.desc ?? "",
          thumbnail: video.video?.cover?.url_list?.[0] ?? null,
          published_at: iso(video.create_time),
          views: num(video.statistics?.play_count),
          likes: num(video.statistics?.digg_count),
          comments: num(video.statistics?.comment_count),
          shares: num(video.statistics?.share_count),
        };
      }
      case "youtube": {
        const video = await this.get("/v1/youtube/video", query);
        if (!video.id && !video.title) throw new ScrapeError(404, "YouTube did not show this video");
        return {
          platform,
          id: String(video.id),
          ids: [String(video.id)],
          url: `https://www.youtube.com/watch?v=${video.id}`,
          text: video.title ?? "",
          thumbnail: video.thumbnail ?? null,
          published_at: iso(video.publishDate),
          views: num(video.viewCountInt),
          likes: num(video.likeCountInt),
          comments: num(video.commentCountInt),
          shares: null,
        };
      }
    }
  }
}

/** Likes, comments and shares of a post: what the watchlist ranks posts by. */
export const engagementOf = (post: PublicPost) =>
  (post.likes ?? 0) + (post.comments ?? 0) * 2 + (post.shares ?? 0) * 3;
