// The public accounts a brand keeps an eye on (competitors, inspiration, its own), read every day through
// ScrapeCreators: their growth, how often and how well they post, and their best posts, which the copilot can turn
// into ideas for the brand.

import { useMemo, useState } from "react";
import { formatDistanceToNow, format } from "date-fns";
import { useTranslation } from "react-i18next";
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
import i18n, { dateLocale, intlLocale } from "@/lib/i18n";

type PublicPost = WatchedAccount["posts"][number];
type Relation = WatchedAccount["relation"];

const PLATFORMS = ["instagram", "tiktok", "twitter", "linkedin", "youtube"] as const;
type Platform = (typeof PLATFORMS)[number];

/** The relations; their labels are `watchlist.relations.<value>`. */
const RELATIONS: { value: Relation; color: "red" | "violet" | "blue" }[] = [
  { value: "competitor", color: "red" },
  { value: "inspiration", color: "violet" },
  { value: "self", color: "blue" },
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

function Metric({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof IconHeart;
  value: number | null;
  label: "views" | "likes" | "comments" | "shares";
}) {
  const { t } = useTranslation("social");
  if (value === null) return null;
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      title={t(`watchlist.metrics.${label}`, { count: value, value: value.toLocaleString(intlLocale()) })}
    >
      <Icon size={12} className="text-t-text-light" />
      {compact(value)}
    </span>
  );
}

function AddForm({ brandId, onAdded }: { brandId: string; onAdded: () => void }) {
  const { t } = useTranslation("social");
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
          label={t("watchlist.add.platform")}
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
          aria-label={t("watchlist.add.handle")}
          placeholder={t(`watchlist.add.placeholders.${platform}`)}
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          className="min-w-[180px] flex-1"
          size="sm"
        />
        <SimpleSelect<Relation>
          label={t("watchlist.add.relation")}
          value={relation}
          onValueChange={setRelation}
          options={RELATIONS.map((r) => ({ value: r.value, label: t(`watchlist.relations.${r.value}`) }))}
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
          {busy ? t("watchlist.add.reading") : t("watchlist.add.submit")}
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
  const { t } = useTranslation("social");
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
              {t(`watchlist.relations.${relation.value}`)}
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
                {t("watchlist.row.keep")}
              </Button>
              <Button size="sm" variant="soft" color="danger" onClick={() => void remove()}>
                {t("watchlist.row.remove")}
              </Button>
            </>
          ) : (
            <>
              <LightIconButton
                aria-label={t("watchlist.row.refresh", { name: account.name })}
                tooltip={t("watchlist.row.readAgain")}
                size="sm"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <IconRefresh size={14} className={cn(refreshing && "animate-spin")} />
              </LightIconButton>
              <LightIconButton
                aria-label={t("watchlist.row.unwatchName", { name: account.name })}
                tooltip={t("watchlist.row.unwatch")}
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
          <span className="text-t-text-tertiary">{t("watchlist.row.followers", { count: account.followers ?? 0 })}</span>
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
            <span className="text-t-text-tertiary"> {t("watchlist.row.perPost")}</span>
          </span>
        )}
        {perWeek !== null && (
          <span className="tabular-nums">
            <span className="text-t-text">
              {perWeek >= 10
                ? Math.round(perWeek)
                : perWeek.toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
            <span className="text-t-text-tertiary"> {t("watchlist.row.perWeek")}</span>
          </span>
        )}
        <span className="ml-auto text-t-text-light">
          {account.checked_at
            ? t("watchlist.row.read", {
                ago: formatDistanceToNow(new Date(account.checked_at), { addSuffix: true, locale: dateLocale() }),
              })
            : t("watchlist.row.notRead")}
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
  const metric = (key: "views" | "likes" | "comments" | "shares", value: number | null) =>
    value !== null && i18n.t(`social:watchlist.metrics.${key}`, { count: value, value: compact(value) });
  const metrics = [
    metric("views", post.views),
    metric("likes", post.likes),
    metric("comments", post.comments),
    metric("shares", post.shares),
  ]
    .filter(Boolean)
    .join(", ");
  const values = {
    platform: platformInfo(author.platform).label,
    author: author.name || author.handle,
    relation: i18n.t(`social:watchlist.relationNames.${relationOf(author.relation).value}`),
    metrics,
    url: post.url,
    text: post.text.slice(0, 2000),
  };
  return metrics
    ? i18n.t("social:watchlist.inspire.promptMetrics", values)
    : i18n.t("social:watchlist.inspire.prompt", values);
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
  const { t } = useTranslation(["social", "common"]);
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
        <p className="line-clamp-3 leading-[1.45] whitespace-pre-line text-t-text">{post.text || t("calendar.noText")}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-t-text-secondary">
          <Metric icon={IconEye} value={post.views} label="views" />
          <Metric icon={IconHeart} value={post.likes} label="likes" />
          <Metric icon={IconMessageCircle} value={post.comments} label="comments" />
          <Metric icon={IconRepeat} value={post.shares} label="shares" />
          {post.published_at && (
            <span className="text-t-text-light">{format(new Date(post.published_at), "d MMM yyyy", { locale: dateLocale() })}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-[var(--t-color-iris11)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onAsk(inspirationPrompt(post, author))}
          >
            <IconSparkles size={13} /> {t("watchlist.inspire.button")}
          </button>
          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-t-text-tertiary hover:text-t-text"
            >
              <IconExternalLink size={12} /> {t("common:open")}
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

function Loading() {
  const { t } = useTranslation("social");
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("watchlist.loading")}>
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
  const { t } = useTranslation(["social", "common"]);
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
            <span>{t("watchlist.error", { error })}</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              {t("common:retry")}
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
            <h2 className="text-[16px] font-semibold text-t-text">{t("watchlist.empty.title")}</h2>
            <p className="leading-[1.55] text-t-text-secondary">{t("watchlist.empty.body")}</p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {(["competitors", "inspiration", "own"] as const)
                .map((chip) => ({
                  label: t(`watchlist.empty.chips.${chip}.label`),
                  message: t(`watchlist.empty.chips.${chip}.message`),
                }))
                .map((chip) => (
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
              <LightIconButton aria-label={t("watchlist.back")} size="sm" onClick={() => setSelectedId(null)}>
                <IconArrowLeft size={16} />
              </LightIconButton>
              <Avatar src={selected.avatar_url} name={selected.name || selected.handle} size={28} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold text-t-text">{selected.name || selected.handle}</span>
                <span className="text-[12px] text-t-text-tertiary">
                  {t("watchlist.detail.summary", {
                    platform: platformInfo(selected.platform).label,
                    followers: compact(selected.followers),
                    count: selected.posts.length,
                  })}
                </span>
              </div>
              {selected.profile_url && (
                <Button
                  size="sm"
                  variant="ghost"
                  startIcon={<IconExternalLink size={14} />}
                  render={<a href={selected.profile_url} target="_blank" rel="noreferrer" />}
                >
                  {t("watchlist.detail.profile")}
                </Button>
              )}
            </div>
            {selected.posts.length === 0 ? (
              <p className="py-10 text-center text-t-text-tertiary">{t("watchlist.detail.empty")}</p>
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
                aria-label={t("watchlist.show")}
                size="sm"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "all", label: t("watchlist.filterAll", { count: accounts.length }) },
                  ...RELATIONS.filter((r) => counts[r.value]).map((r) => ({
                    value: r.value,
                    label: t("watchlist.filterRelation", {
                      relation: t(`watchlist.relations.${r.value}`),
                      count: counts[r.value] ?? 0,
                    }),
                  })),
                ]}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-t-text-tertiary">{t("watchlist.accounts")}</h2>
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
                <h2 className="text-[12px] font-semibold text-t-text-tertiary">{t("watchlist.topPosts")}</h2>
                {topPosts.length === 0 ? (
                  <p className="rounded-lg border border-t-border px-3 py-8 text-center text-t-text-tertiary">
                    {t("watchlist.topPostsEmpty")}
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
