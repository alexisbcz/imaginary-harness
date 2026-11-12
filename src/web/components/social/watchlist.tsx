// The public accounts a brand keeps an eye on (competitors, inspiration, its own), read every day through
// ScrapeCreators: their growth, how often and how well they post, and their best posts, which the copilot can turn
// into ideas for the brand.

import { useMemo, useState } from "react";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "cn";
import { LightIconButton, SegmentedControl } from "twenty-ui/components/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Button, Input } from "twenty-ui/primitives/input";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBinocularsFilled,
  IconExternalLink,
  IconEye,
  IconHeart,
  IconMessageCircle,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";

import { IconTile } from "@/components/icon-tile";
import { PlatformGlyph } from "@/components/social/platform-icon";
import { SimpleSelect } from "@/components/simple-select";
import {
  compact,
  platformInfo,
  refreshWatched,
  unwatchAccount,
  useWatchlist,
  watchAccount,
  type BrandViewProps,
  type WatchedAccount,
  type WatchHistory,
} from "@/lib/social";

type PublicPost = WatchedAccount["posts"][number];
type Relation = WatchedAccount["relation"];

const PLATFORMS = ["instagram", "tiktok", "twitter", "linkedin", "youtube"] as const;
type Platform = (typeof PLATFORMS)[number];

const PLACEHOLDERS: Record<Platform, string> = {
  instagram: "@handle or instagram.com/handle",
  tiktok: "@handle or tiktok.com/@handle",
  twitter: "@handle or x.com/handle",
  linkedin: "linkedin.com/company/… or linkedin.com/in/…",
  youtube: "@channel or youtube.com/@channel",
};

const RELATIONS: { value: Relation; label: string; color: "red" | "violet" | "blue" }[] = [
  { value: "competitor", label: "Competitor", color: "red" },
  { value: "inspiration", label: "Inspiration", color: "violet" },
  { value: "self", label: "Our own", color: "blue" },
];
const relationOf = (value: Relation) => RELATIONS.find((r) => r.value === value) ?? RELATIONS[0]!;

const DAY = 86_400_000;

/** How the watchlist ranks posts: comments and shares say more than likes. */
const engagementOf = (post: PublicPost) => (post.likes ?? 0) + (post.comments ?? 0) * 2 + (post.shares ?? 0) * 3;

function stats(account: WatchedAccount) {
  const engaged = account.posts.filter((p) => p.likes !== null);
  const avg = engaged.length ? engaged.reduce((n, p) => n + engagementOf(p), 0) / engaged.length : null;
  const dates = account.posts
    .map((p) => (p.published_at ? Date.parse(p.published_at) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let perWeek: number | null = null;
  if (dates.length >= 2) {
    const span = Math.max(DAY, Date.now() - dates[0]!);
    perWeek = (dates.length / span) * 7 * DAY;
  }
  return { avg, perWeek };
}

function Avatar({ src, name, size = 36 }: { src: string | null; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  return src && !broken ? (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="shrink-0 rounded-full border border-t-border-light object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-t-tertiary font-semibold text-t-text-secondary"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const w = 64;
  const h = 20;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = max === min ? h / 2 : h - ((v - min) / (max - min)) * (h - 2) - 1;
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points.at(-1)! >= points[0]!;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <path
        d={d}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke={up ? "var(--t-color-green9)" : "var(--t-color-red9)"}
      />
    </svg>
  );
}

function Metric({ icon: Icon, value, label }: { icon: typeof IconHeart; value: number | null; label: string }) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${value.toLocaleString()} ${label}`}>
      <Icon size={12} className="text-t-text-light" />
      {compact(value)}
    </span>
  );
}

function AddForm({ brandId, onAdded }: { brandId: string; onAdded: () => void }) {
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [handle, setHandle] = useState("");
  const [relation, setRelation] = useState<Relation>("competitor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!handle.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await watchAccount(brandId, { platform, handle: handle.trim(), relation });
      setHandle("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-t-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect<Platform>
          label="Platform"
          value={platform}
          onValueChange={setPlatform}
          options={PLATFORMS.map((p) => ({
            value: p,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <PlatformGlyph platform={p} size={13} />
                {platformInfo(p).label}
              </span>
            ),
          }))}
        />
        <Input
          aria-label="Handle or URL"
          placeholder={PLACEHOLDERS[platform]}
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          className="min-w-[180px] flex-1"
          size="sm"
        />
        <SimpleSelect<Relation>
          label="Relation"
          value={relation}
          onValueChange={setRelation}
          options={RELATIONS.map((r) => ({ value: r.value, label: r.label }))}
        />
        <Button
          type="submit"
          size="sm"
          variant="solid"
          color="accent"
          startIcon={<IconPlus size={14} />}
          loading={busy}
          disabled={!handle.trim() || busy}
        >
          {busy ? "Reading the account…" : "Watch"}
        </Button>
      </div>
      {error && <p className="text-[12px] text-t-text-danger">{error}</p>}
    </form>
  );
}

function AccountRow({
  account,
  history,
  brandId,
  selected,
  onSelect,
  onChanged,
}: {
  account: WatchedAccount;
  history: number[];
  brandId: string;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const { avg, perWeek } = stats(account);
  const growth = history.length >= 2 ? history.at(-1)! - history[0]! : null;
  const relation = relationOf(account.relation);
  const error = rowError ?? account.error;

  async function refresh() {
    setRefreshing(true);
    setRowError(null);
    try {
      await refreshWatched(brandId, account.id);
      onChanged();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function remove() {
    try {
      await unwatchAccount(brandId, account.id);
      onChanged();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-2 rounded-lg border px-3 py-2.5 outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-[var(--t-color-iris8)] bg-t-secondary" : "border-t-border",
      )}
    >
      <div className="flex items-center gap-3">
        <Avatar src={account.avatar_url} name={account.name || account.handle} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <PlatformGlyph platform={account.platform} size={13} className="text-t-text-tertiary" />
            <span className="truncate font-medium text-t-text">{account.name || account.handle}</span>
            <Tag color={relation.color} variant="soft" className="shrink-0 text-[11px]">
              {relation.label}
            </Tag>
          </span>
          <span className="truncate text-[12px] text-t-text-tertiary">
            {account.platform === "linkedin" ? account.handle.replace(/^https?:\/\/(www\.)?/, "") : `@${account.handle}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
          {confirming ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button size="sm" variant="soft" color="danger" onClick={() => void remove()}>
                Remove
              </Button>
            </>
          ) : (
            <>
              <LightIconButton
                aria-label={`Refresh ${account.name}`}
                tooltip="Read again"
                size="sm"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <IconRefresh size={14} className={cn(refreshing && "animate-spin")} />
              </LightIconButton>
              <LightIconButton
                aria-label={`Stop watching ${account.name}`}
                tooltip="Stop watching"
                size="sm"
                onClick={() => setConfirming(true)}
              >
                <IconTrash size={14} />
              </LightIconButton>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-t-text-secondary">
        <span className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-t-text tabular-nums">{compact(account.followers)}</span>
          <span className="text-t-text-tertiary">followers</span>
          {growth !== null && growth !== 0 && (
            <span
              className={cn(
                "tabular-nums",
                growth > 0 ? "text-[var(--t-color-green10)]" : "text-[var(--t-color-red10)]",
              )}
            >
              {growth > 0 ? "+" : ""}
              {compact(growth)}
            </span>
          )}
          <Sparkline points={history} />
        </span>
        {avg !== null && (
          <span className="tabular-nums">
            <span className="text-t-text">{compact(Math.round(avg))}</span>
            <span className="text-t-text-tertiary"> eng./post</span>
          </span>
        )}
        {perWeek !== null && (
          <span className="tabular-nums">
            <span className="text-t-text">{perWeek >= 10 ? Math.round(perWeek) : perWeek.toFixed(1)}</span>
            <span className="text-t-text-tertiary"> posts/week</span>
          </span>
        )}
        <span className="ml-auto text-t-text-light">
          {account.checked_at ? `Read ${formatDistanceToNow(new Date(account.checked_at), { addSuffix: true })}` : "Not read yet"}
        </span>
      </div>
      {error && (
        <p className="flex items-center gap-1.5 text-[12px] text-t-text-danger">
          <IconAlertTriangle size={13} className="shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

function inspirationPrompt(post: PublicPost, author: WatchedAccount) {
  const metrics = [
    post.views !== null && `${compact(post.views)} views`,
    post.likes !== null && `${compact(post.likes)} likes`,
    post.comments !== null && `${compact(post.comments)} comments`,
    post.shares !== null && `${compact(post.shares)} shares`,
  ]
    .filter(Boolean)
    .join(", ");
  return `This ${platformInfo(author.platform).label} post by ${author.name || author.handle} (${relationOf(author.relation).label.toLowerCase()}) did well${metrics ? ` (${metrics})` : ""}: ${post.url}

"""
${post.text.slice(0, 2000)}
"""

Work out why it works (hook, format, angle), then write one post for our brand inspired by it: our voice, our subject, never a copy. Put it on the calendar as a draft at a good time.`;
}

function PostCard({
  post,
  author,
  onAsk,
  showAuthor = false,
}: {
  post: PublicPost;
  author: WatchedAccount;
  onAsk: (message: string) => void;
  showAuthor?: boolean;
}) {
  const [thumbBroken, setThumbBroken] = useState(false);
  return (
    <article className="flex gap-3 rounded-lg border border-t-border p-3">
      {post.thumbnail && !thumbBroken && (
        <img
          src={post.thumbnail}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setThumbBroken(true)}
          className="size-16 shrink-0 rounded-md border border-t-border-light object-cover"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {showAuthor && (
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-t-text-secondary">
            <Avatar src={author.avatar_url} name={author.name || author.handle} size={16} />
            <span className="truncate font-medium">{author.name || author.handle}</span>
            <PlatformGlyph platform={author.platform} size={12} className="text-t-text-tertiary" />
          </span>
        )}
        <p className="line-clamp-3 leading-[1.45] whitespace-pre-line text-t-text">{post.text || "(no text)"}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-t-text-secondary">
          <Metric icon={IconEye} value={post.views} label="views" />
          <Metric icon={IconHeart} value={post.likes} label="likes" />
          <Metric icon={IconMessageCircle} value={post.comments} label="comments" />
          <Metric icon={IconRepeat} value={post.shares} label="shares" />
          {post.published_at && (
            <span className="text-t-text-light">{format(new Date(post.published_at), "d MMM yyyy")}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-[var(--t-color-iris11)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onAsk(inspirationPrompt(post, author))}
          >
            <IconSparkles size={13} /> Write a post inspired by this
          </button>
          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-t-text-tertiary hover:text-t-text"
            >
              <IconExternalLink size={12} /> Open
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the watchlist">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-t-border px-3 py-3">
          <Skeleton width={36} height={36} borderRadius={18} />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton width={`${40 + i * 12}%`} height={12} />
            <Skeleton width="30%" height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Watchlist tab of a brand. */
export function SocialWatchlist({ brand, onAsk }: BrandViewProps) {
  const { data, error, reload } = useWatchlist(brand.id);
  const [filter, setFilter] = useState<"all" | Relation>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const historyById = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const row of (data?.history ?? []) as WatchHistory)
      if (row.followers !== null) map.set(row.watch_id, [...(map.get(row.watch_id) ?? []), Number(row.followers)]);
    return map;
  }, [data?.history]);

  const accounts = (data?.accounts ?? []).map((a) => ({ ...a, followers: a.followers === null ? null : Number(a.followers) }));
  const shown = filter === "all" ? accounts : accounts.filter((a) => a.relation === filter);
  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  const topPosts = useMemo(() => {
    const since = Date.now() - 30 * DAY;
    return shown
      .flatMap((author) => author.posts.map((post) => ({ post, author })))
      .filter(({ post }) => !post.published_at || Date.parse(post.published_at) >= since)
      .sort((a, b) => engagementOf(b.post) - engagementOf(a.post))
      .slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter]);

  const counts = Object.fromEntries(RELATIONS.map((r) => [r.value, accounts.filter((a) => a.relation === r.value).length]));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 p-4">
        <AddForm brandId={brand.id} onAdded={() => void reload()} />

        {error && !data && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--t-border-color-danger)] bg-[var(--t-background-danger)] px-3 py-2 text-t-text-danger">
            <span>The watchlist could not load: {error}</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}

        {!data ? (
          !error && <Loading />
        ) : accounts.length === 0 ? (
          <div className="mx-auto flex max-w-[460px] flex-col items-center gap-3 py-12 text-center">
            <IconTile size="lg" color="orange">
              <IconBinocularsFilled />
            </IconTile>
            <h2 className="text-[16px] font-semibold text-t-text">Keep an eye on who matters</h2>
            <p className="leading-[1.55] text-t-text-secondary">
              Add competitors and accounts you admire. Richelieu reads them every day: how fast they grow, how often
              they post, and which posts work, so the copilot can turn the best ideas into posts of your own.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {[
                {
                  label: "Find our competitors",
                  message:
                    "Who are our main competitors on social media? Look at our brief and website, suggest 3 to 5 accounts, check each with research_social_account, and add the relevant ones to the watchlist.",
                },
                {
                  label: "Suggest accounts to learn from",
                  message:
                    "Suggest 3 accounts in our space (not competitors) whose social media is excellent, check them with research_social_account, and add them to the watchlist as inspiration.",
                },
                {
                  label: "Watch our own accounts",
                  message:
                    "Add our own public accounts to the watchlist (relation: self), so we can compare ourselves with the others.",
                },
              ].map((chip) => (
                <Button
                  key={chip.label}
                  size="sm"
                  variant="outline"
                  startIcon={<IconSparkles size={14} />}
                  onClick={() => onAsk(chip.message)}
                >
                  {chip.label}
                </Button>
              ))}
            </div>
          </div>
        ) : selected ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <LightIconButton aria-label="Back to the watchlist" size="sm" onClick={() => setSelectedId(null)}>
                <IconArrowLeft size={16} />
              </LightIconButton>
              <Avatar src={selected.avatar_url} name={selected.name || selected.handle} size={28} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold text-t-text">{selected.name || selected.handle}</span>
                <span className="text-[12px] text-t-text-tertiary">
                  {platformInfo(selected.platform).label} · {compact(selected.followers)} followers ·{" "}
                  {selected.posts.length} recent posts, best first
                </span>
              </div>
              {selected.profile_url && (
                <Button
                  size="sm"
                  variant="ghost"
                  startIcon={<IconExternalLink size={14} />}
                  render={<a href={selected.profile_url} target="_blank" rel="noreferrer" />}
                >
                  Profile
                </Button>
              )}
            </div>
            {selected.posts.length === 0 ? (
              <p className="py-10 text-center text-t-text-tertiary">No recent posts could be read for this account.</p>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {[...selected.posts]
                  .sort((a, b) => engagementOf(b) - engagementOf(a))
                  .map((post) => (
                    <PostCard key={post.id} post={post} author={selected} onAsk={onAsk} />
                  ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl<"all" | Relation>
                aria-label="Show"
                size="sm"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "all", label: `All ${accounts.length}` },
                  ...RELATIONS.filter((r) => counts[r.value]).map((r) => ({
                    value: r.value,
                    label: `${r.label} ${counts[r.value]}`,
                  })),
                ]}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-t-text-tertiary">Accounts</h2>
                {shown.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    history={historyById.get(account.id) ?? []}
                    brandId={brand.id}
                    selected={false}
                    onSelect={() => setSelectedId(account.id)}
                    onChanged={() => void reload()}
                  />
                ))}
              </section>
              <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-t-text-tertiary">Top posts of the last 30 days</h2>
                {topPosts.length === 0 ? (
                  <p className="rounded-lg border border-t-border px-3 py-8 text-center text-t-text-tertiary">
                    No posts from the last 30 days yet.
                  </p>
                ) : (
                  topPosts.map(({ post, author }) => (
                    <PostCard key={`${author.id}:${post.id}`} post={post} author={author} onAsk={onAsk} showAuthor />
                  ))
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
