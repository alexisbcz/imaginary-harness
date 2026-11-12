import { describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { parseWhen } from "../agent.ts";
import { countFor, problemsFor } from "../platforms.ts";
import { idsIn, normalizeHandle, platformOfUrl } from "../scrapecreators.ts";
import { SocialService, type Brand } from "../service.ts";
import type { PostInput, Zernio, ZernioAccount, ZernioPost } from "../zernio.ts";

const OURS = "aaaaaaaaaaaaaaaaaaaaaaaa";
const THEIRS = "bbbbbbbbbbbbbbbbbbbbbbbb";

const account = (id: string, profileId: string, platform = "linkedin"): ZernioAccount => ({
  _id: id,
  platform,
  profileId: { _id: profileId },
  username: `user-${id}`,
  isActive: true,
});

const post = (id: string, accounts: ZernioAccount[], status: ZernioPost["status"] = "draft"): ZernioPost => ({
  _id: id,
  content: `post ${id}`,
  status,
  mediaItems: [],
  platforms: accounts.map((a) => ({ platform: a.platform, accountId: a })),
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});

/** Zernio as the service sees it, with two profiles: ours and someone else's. */
function fakeZernio() {
  const ourLinkedin = account("100000000000000000000001", OURS);
  const ourX = account("100000000000000000000002", OURS, "twitter");
  const theirs = account("200000000000000000000001", THEIRS);
  const posts = new Map<string, ZernioPost>([
    ["300000000000000000000001", post("300000000000000000000001", [ourLinkedin])],
    ["300000000000000000000002", post("300000000000000000000002", [theirs])],
    ["300000000000000000000003", post("300000000000000000000003", [ourLinkedin], "published")],
  ]);
  const created: PostInput[] = [];
  const zernio = {
    configured: true,
    accounts: async (profileId: string) => [ourLinkedin, ourX, theirs].filter((a) => (a.profileId as { _id: string })._id === profileId || profileId === "*"),
    // Zernio's own filter is not trusted: it answers every post here.
    posts: async () => ({ posts: [...posts.values()], pagination: { total: posts.size, pages: 1 } }),
    post: async (id: string) => {
      const found = posts.get(id);
      if (!found) throw Object.assign(new Error("Post not found"), { status: 404 });
      return found;
    },
    createPost: async (input: PostInput) => {
      created.push(input);
      return { post: { ...post("300000000000000000000009", [ourLinkedin]), content: input.content ?? "" } };
    },
    updatePost: async (id: string, input: PostInput) => {
      created.push(input);
      return { post: posts.get(id)! };
    },
    deletePost: async (id: string) => void posts.delete(id),
  };
  return { zernio: zernio as unknown as Zernio, created, posts };
}

const brand: Brand = {
  id: "11111111-1111-1111-1111-111111111111",
  user_id: "22222222-2222-2222-2222-222222222222",
  name: "Acme",
  website: "",
  description: "",
  audience: "",
  voice: "",
  pillars: [],
  avoid: "",
  examples: "",
  timezone: "Europe/Paris",
  cadence: {},
  zernio_profile_id: OURS,
  zernio_profile_owned: true,
  thread_id: null,
  created_at: new Date(),
};

const service = () => {
  const fake = fakeZernio();
  return { ...fake, social: new SocialService((() => Promise.resolve([])) as unknown as SQL, { zernio: fake.zernio }) };
};

describe("a brand reaches only its own Zernio profile", () => {
  it("lists only the brand's accounts and posts", async () => {
    const { social } = service();
    expect((await social.accounts(brand)).map((a) => a.id)).toEqual([
      "100000000000000000000001",
      "100000000000000000000002",
    ]);
    const posts = await social.posts(brand);
    expect(posts.map((p) => p.id).sort()).toEqual(["300000000000000000000001", "300000000000000000000003"]);
  });

  it("does not read, change or delete another profile's post", async () => {
    const { social, posts } = service();
    await expect(social.post(brand, "300000000000000000000002")).rejects.toThrow("No such post");
    await expect(
      social.savePost(brand, { content: "x", channels: [], mode: "draft" }, { id: "300000000000000000000002" }),
    ).rejects.toThrow("No such post");
    await expect(social.deletePost(brand, "300000000000000000000002")).rejects.toThrow("No such post");
    expect(posts.has("300000000000000000000002")).toBe(true);
  });

  it("refuses to post on an account of another profile", async () => {
    const { social, created } = service();
    await expect(
      social.savePost(brand, { content: "x", channels: [{ account_id: "200000000000000000000001" }], mode: "draft" }),
    ).rejects.toThrow("not connected to Acme");
    expect(created).toHaveLength(0);
  });

  it("keeps published posts", async () => {
    const { social } = service();
    await expect(social.deletePost(brand, "300000000000000000000003")).rejects.toThrow("Published posts stay");
    await expect(
      social.savePost(brand, { content: "x", channels: [], mode: "draft" }, { id: "300000000000000000000003" }),
    ).rejects.toThrow("already published");
  });
});

describe("saving posts", () => {
  it("saves a draft as a draft, with its planned time", async () => {
    const { social, created } = service();
    await social.savePost(brand, {
      content: "Hello",
      channels: [{ account_id: "100000000000000000000001" }],
      scheduled_for: "2030-01-01T09:00:00.000Z",
      mode: "draft",
    });
    expect(created[0]).toMatchObject({ isDraft: true, scheduledFor: "2030-01-01T09:00:00.000Z", timezone: "Europe/Paris" });
    expect(created[0]!.publishNow).toBeUndefined();
  });

  it("checks each platform's rules before scheduling", async () => {
    const { social, created } = service();
    const long = "word ".repeat(80);
    await expect(
      social.savePost(brand, {
        content: long,
        channels: [{ account_id: "100000000000000000000002" }],
        scheduled_for: "2030-01-01T09:00:00Z",
        mode: "schedule",
      }),
    ).rejects.toThrow("X: 120 characters too long");
    // A version of its own for X fixes it.
    await social.savePost(brand, {
      content: long,
      channels: [
        { account_id: "100000000000000000000001" },
        { account_id: "100000000000000000000002", custom_content: "Short for X" },
      ],
      scheduled_for: "2030-01-01T09:00:00Z",
      mode: "schedule",
    });
    expect(created[0]).toMatchObject({ isDraft: false });
    expect(created[0]!.platforms![1]).toMatchObject({ platform: "twitter", customContent: "Short for X" });
  });

  it("schedules only in the future, and only with an account", async () => {
    const { social } = service();
    await expect(
      social.savePost(brand, {
        content: "x",
        channels: [{ account_id: "100000000000000000000001" }],
        scheduled_for: "2020-01-01T09:00:00Z",
        mode: "schedule",
      }),
    ).rejects.toThrow("in the future");
    await expect(social.savePost(brand, { content: "x", channels: [], mode: "publish" })).rejects.toThrow(
      "at least one account",
    );
  });
});

describe("platform rules", () => {
  it("counts links as 23 characters on X", () => {
    expect(countFor("twitter", `Look ${"https://example.com/" + "a".repeat(80)}`)).toBe(5 + 23);
    expect(countFor("linkedin", "héllo 👋")).toBe(7);
  });

  it("asks for the media a platform needs", () => {
    expect(problemsFor("instagram", "caption", [])).toEqual(["Instagram needs an image or a video"]);
    expect(problemsFor("tiktok", "caption", [{ type: "image" }])).toEqual(["TikTok needs a video"]);
    expect(problemsFor("linkedin", "caption", [])).toEqual([]);
  });
});

describe("the copilot's dates", () => {
  it("reads a wall-clock time in the brand's time zone, across daylight saving", () => {
    expect(parseWhen("2027-03-02T09:00", "Europe/Paris")).toBe("2027-03-02T08:00:00.000Z");
    expect(parseWhen("2027-07-02T09:00", "Europe/Paris")).toBe("2027-07-02T07:00:00.000Z");
    expect(parseWhen("2027-07-02 09:30", "America/New_York")).toBe("2027-07-02T13:30:00.000Z");
    expect(parseWhen("2027-07-02T09:30:00Z", "Asia/Tokyo")).toBe("2027-07-02T09:30:00.000Z");
    expect(parseWhen(undefined, "UTC")).toBeUndefined();
    expect(() => parseWhen("next tuesday", "UTC")).toThrow("YYYY-MM-DD");
  });
});

describe("handles", () => {
  it("reads handles and profile URLs", () => {
    expect(normalizeHandle("instagram", "@nike")).toBe("nike");
    expect(normalizeHandle("instagram", "https://www.instagram.com/nike/")).toBe("nike");
    expect(normalizeHandle("tiktok", "https://www.tiktok.com/@duolingo")).toBe("duolingo");
    expect(normalizeHandle("twitter", "https://x.com/vercel")).toBe("vercel");
    expect(normalizeHandle("youtube", "https://www.youtube.com/@mkbhd")).toBe("mkbhd");
    expect(normalizeHandle("linkedin", "vercel")).toBe("https://www.linkedin.com/company/vercel/");
    expect(normalizeHandle("linkedin", "https://www.linkedin.com/in/someone?trk=x")).toBe(
      "https://www.linkedin.com/in/someone/",
    );
  });
});

describe("imported posts", () => {
  it("knows a post's platform from its link, short links included", () => {
    expect(platformOfUrl("https://lnkd.in/p/esJBpUwz")).toBe("linkedin");
    expect(platformOfUrl("https://www.linkedin.com/feed/update/urn:li:activity:7526016016066207744/")).toBe("linkedin");
    expect(platformOfUrl("https://x.com/vercel/status/2117726156992753721")).toBe("twitter");
    expect(platformOfUrl("https://youtu.be/hdMszZ2ah5Q")).toBe("youtube");
    expect(platformOfUrl("https://example.com/post")).toBeNull();
  });

  it("recognises a post by its ids, whichever of its links was pasted", () => {
    const fromFeed = idsIn("https://www.linkedin.com/feed/update/urn:li:activity:7526016016066207744/");
    const fromShare = idsIn(
      "https://www.linkedin.com/posts/alexisbcz_mistral-activity-7526016016066207744-rtgE/",
      "urn:li:ugcPost:7526015948148023296",
    );
    expect(fromShare.some((id) => fromFeed.includes(id))).toBe(true);
  });
});
