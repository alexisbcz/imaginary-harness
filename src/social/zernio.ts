// Zernio (zernio.com): one API to connect social accounts, keep drafts, schedule and publish posts, and read their
// analytics. Each brand is a Zernio profile; its connected accounts and posts belong to that profile.

const BASE = "https://zernio.com/api/v1";

export class ZernioError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type ZernioProfile = {
  _id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  externalId?: string | null;
  accountUsernames?: string[];
  accountCount?: number;
};

export type ZernioAccount = {
  _id: string;
  platform: string;
  profileId: string | { _id: string };
  username: string;
  displayName?: string;
  profilePicture?: string;
  profileUrl?: string;
  isActive: boolean;
};

export type ZernioMedia = {
  url: string;
  type: "image" | "video" | "gif" | "document";
};

export type ZernioPostPlatform = {
  platform: string;
  accountId: string | ZernioAccount | null;
  customContent?: string;
  status?: string;
  publishedAt?: string;
  platformPostUrl?: string;
  errorMessage?: string;
};

export type ZernioPost = {
  _id: string;
  title?: string;
  content: string;
  status:
    | "draft"
    | "pending_approval"
    | "scheduled"
    | "publishing"
    | "published"
    | "partial"
    | "failed"
    | "cancelled";
  scheduledFor?: string;
  timezone?: string;
  mediaItems: ZernioMedia[];
  platforms: ZernioPostPlatform[];
  profileId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ZernioMetrics = {
  impressions?: number;
  reach?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  reposts?: number;
  engagementRate?: number;
};

export type ZernioPostAnalytics = {
  _id: string;
  latePostId?: string;
  content: string;
  publishedAt: string;
  status: string;
  analytics: ZernioMetrics;
  platform?: string;
  platformPostUrl?: string;
  thumbnailUrl?: string;
  mediaItems?: ZernioMedia[];
  platformAnalytics?: {
    platform: string;
    accountId: string;
    accountUsername?: string;
    platformPostUrl?: string;
    analytics: ZernioMetrics;
  }[];
};

export type ZernioFollowerStats = {
  accounts: {
    _id: string;
    profileId: string;
    platform: string;
    username: string;
    displayName?: string;
    profilePicture?: string;
    currentFollowers: number;
    growth: number;
    growthPercentage: number;
  }[];
  stats: Record<string, { date: string; followers: number }[]>;
};

export type PostInput = {
  content?: string;
  title?: string;
  scheduledFor?: string;
  timezone?: string;
  isDraft?: boolean;
  publishNow?: boolean;
  mediaItems?: ZernioMedia[];
  platforms?: { platform: string; accountId: string; customContent?: string }[];
  profileId?: string;
  tags?: string[];
};

type Query = Record<string, string | number | undefined>;

export class Zernio {
  constructor(private readonly key: string | undefined = Bun.env.ZERNIO_API_KEY) {}

  get configured() {
    return Boolean(this.key);
  }

  private async call<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    if (!this.key)
      throw new ZernioError(503, "Social publishing is off: set ZERNIO_API_KEY in .env");
    const url = new URL(BASE + path);
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (!response.ok)
      throw new ZernioError(
        response.status,
        String(json.error ?? json.message ?? `Zernio answered ${response.status}`),
        json.code as string | undefined,
      );
    return json as T;
  }

  // Profiles ------------------------------------------------------------------------------------------------

  async profiles() {
    return (await this.call<{ profiles: ZernioProfile[] }>("GET", "/profiles")).profiles;
  }

  async createProfile(input: { name: string; description?: string; externalId?: string }) {
    const result = await this.call<{ profile?: ZernioProfile } & Partial<ZernioProfile>>(
      "POST",
      "/profiles",
      { body: input },
    );
    const profile = result.profile ?? (result as ZernioProfile);
    if (!profile?._id) throw new ZernioError(502, "Zernio did not return the new profile");
    return profile;
  }

  async updateProfile(id: string, input: { name?: string; description?: string }) {
    await this.call("PUT", `/profiles/${id}`, { body: input });
  }

  async deleteProfile(id: string) {
    await this.call("DELETE", `/profiles/${id}`);
  }

  // Accounts ------------------------------------------------------------------------------------------------

  async accounts(profileId: string) {
    return (await this.call<{ accounts: ZernioAccount[] }>("GET", "/accounts", { query: { profileId } }))
      .accounts;
  }

  async disconnect(accountId: string) {
    await this.call("DELETE", `/accounts/${accountId}`);
  }

  /** Where to send the user to connect an account of `platform`; they come back to `redirectUrl`. */
  async connectUrl(platform: string, profileId: string, redirectUrl: string) {
    const result = await this.call<{ authUrl: string }>("GET", `/connect/${platform}`, {
      query: { profileId, redirect_url: redirectUrl },
    });
    return result.authUrl;
  }

  async followerStats(profileId: string, fromDate?: string) {
    return this.call<ZernioFollowerStats>("GET", "/accounts/follower-stats", {
      query: { profileId, fromDate },
    });
  }

  // Posts ---------------------------------------------------------------------------------------------------

  async posts(query: {
    profileId: string;
    status?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    page?: number;
    search?: string;
  }) {
    return this.call<{ posts: ZernioPost[]; pagination: { total: number; pages: number } }>(
      "GET",
      "/posts",
      { query: { limit: 100, ...query } },
    );
  }

  async post(id: string) {
    const result = await this.call<{ post?: ZernioPost } & Partial<ZernioPost>>("GET", `/posts/${id}`);
    return (result.post ?? result) as ZernioPost;
  }

  async createPost(input: PostInput, idempotencyKey?: string) {
    return this.call<{ post: ZernioPost; message?: string; warnings?: string[] }>("POST", "/posts", {
      body: input,
      idempotencyKey,
    });
  }

  async updatePost(id: string, input: PostInput) {
    return this.call<{ post: ZernioPost }>("PUT", `/posts/${id}`, { body: input });
  }

  async deletePost(id: string) {
    await this.call("DELETE", `/posts/${id}`);
  }

  async retryPost(id: string) {
    return this.call<{ post?: ZernioPost }>("POST", `/posts/${id}/retry`);
  }

  // Media ---------------------------------------------------------------------------------------------------

  /** Uploads a file to Zernio's storage; returns the public URL to put in a post's media. */
  async upload(filename: string, contentType: string, data: Blob) {
    const presigned = await this.call<{ uploadUrl: string; publicUrl: string }>("POST", "/media/presign", {
      body: { filename, contentType },
    });
    const put = await fetch(presigned.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: data,
    });
    if (!put.ok) throw new ZernioError(502, `The upload failed (${put.status})`);
    return presigned.publicUrl;
  }

  // Analytics -----------------------------------------------------------------------------------------------

  async analytics(query: { profileId: string; fromDate?: string; toDate?: string; limit?: number; page?: number }) {
    return this.call<{
      overview?: { totalPosts: number; publishedPosts: number; lastSync?: string };
      posts: ZernioPostAnalytics[];
      pagination?: { total: number; pages: number };
      hasAnalyticsAccess?: boolean;
    }>("GET", "/analytics", { query: { limit: 100, ...query } });
  }
}
