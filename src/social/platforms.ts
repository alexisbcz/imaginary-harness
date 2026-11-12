// What each platform allows, shared by the server, the agent and the web app: its name, the longest text a post
// may have, and whether it needs media.

export type PlatformInfo = {
  id: string;
  label: string;
  /** The longest text a post may have. */
  limit: number;
  /** Posts need an image or a video. */
  needsMedia?: "image" | "video";
  /** Can be connected through Zernio from the brand page. */
  connectable: boolean;
};

export const PLATFORMS: PlatformInfo[] = [
  { id: "linkedin", label: "LinkedIn", limit: 3000, connectable: true },
  { id: "twitter", label: "X", limit: 280, connectable: true },
  { id: "instagram", label: "Instagram", limit: 2200, needsMedia: "image", connectable: true },
  { id: "threads", label: "Threads", limit: 500, connectable: true },
  { id: "facebook", label: "Facebook", limit: 63206, connectable: true },
  { id: "tiktok", label: "TikTok", limit: 2200, needsMedia: "video", connectable: true },
  { id: "youtube", label: "YouTube", limit: 5000, needsMedia: "video", connectable: true },
  { id: "bluesky", label: "Bluesky", limit: 300, connectable: false },
  { id: "pinterest", label: "Pinterest", limit: 500, needsMedia: "image", connectable: true },
];

const byId = new Map(PLATFORMS.map((p) => [p.id, p]));

export const platformInfo = (id: string): PlatformInfo =>
  byId.get(id) ?? { id, label: id[0]?.toUpperCase() + id.slice(1), limit: 5000, connectable: false };

/** Characters as the platforms count them: X counts each URL as 23. */
export function countFor(platform: string, text: string) {
  if (platform !== "twitter") return [...text].length;
  return [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
}

/** What stops a post from going out on a platform, or nothing. */
export function problemsFor(
  platform: string,
  text: string,
  media: { type: string }[],
): string[] {
  const info = platformInfo(platform);
  const problems: string[] = [];
  const count = countFor(platform, text);
  if (count > info.limit) problems.push(`${info.label}: ${count - info.limit} characters too long (${info.limit} at most)`);
  if (info.needsMedia === "image" && !media.some((m) => m.type === "image" || m.type === "video"))
    problems.push(`${info.label} needs an image or a video`);
  if (info.needsMedia === "video" && !media.some((m) => m.type === "video"))
    problems.push(`${info.label} needs a video`);
  if (!text.trim() && media.length === 0) problems.push("The post is empty");
  return problems;
}
