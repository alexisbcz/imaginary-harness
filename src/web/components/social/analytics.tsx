// A brand's numbers, as a social lead reads them on a Monday: followers and their growth, reach and engagement
// against the previous period, when its posts do best, each platform's share, and the posts that did best.

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "cn";
import { SegmentedControl } from "twenty-ui/components/input";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconChartAreaLineFilled,
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconPlugConnected,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { IconTile } from "@/components/icon-tile";
import { AccountAvatar, PlatformGlyph, platformColor } from "@/components/social/platform-icon";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import {
  compact,
  percent,
  platformInfo,
  useAnalytics,
  type Analytics,
  type AnalyzedPost,
  type BrandViewProps,
} from "@/lib/social";

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Four-hour buckets: a heatmap a person can read at a glance. */
const BUCKETS = [
  { from: 0, label: "0–4", part: "nights" },
  { from: 4, label: "4–8", part: "early mornings" },
  { from: 8, label: "8–12", part: "mornings" },
  { from: 12, label: "12–16", part: "afternoons" },
  { from: 16, label: "16–20", part: "evenings" },
  { from: 20, label: "20–24", part: "late evenings" },
];

/** The change from `previous` to `current`, as a ratio; null when there is nothing to compare with. */
const change = (current: number, previous: number) => (previous > 0 ? (current - previous) / previous : null);

function Delta({ value, suffix = "vs previous period" }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="text-t-text-light">No earlier data</span>;
  if (Math.abs(value) < 0.0005) return <span className="truncate text-t-text-light">Same as the previous period</span>;
  const up = value > 0;
  const Arrow = up ? IconArrowUpRight : IconArrowDownRight;
  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 font-medium tabular-nums",
          up ? "text-[var(--t-color-green10)]" : "text-[var(--t-color-red10)]",
        )}
      >
        <Arrow size={13} />
        {Math.abs(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%
      </span>
      <span className="truncate text-t-text-light">{suffix}</span>
    </span>
  );
}

function StatTile({ label, value, footer }: { label: string; value: string; footer: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-t-border px-3.5 py-3">
      <span className="text-[12px] text-t-text-tertiary">{label}</span>
      <span className="text-[22px] leading-tight font-semibold text-t-text tabular-nums">{value}</span>
      <span className="min-w-0 text-[12px]">{footer}</span>
    </div>
  );
}

function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-lg border border-t-border p-4", className)}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-semibold text-t-text">{title}</h2>
          {description && <p className="text-[12px] text-t-text-tertiary">{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Kpis({ analytics }: { analytics: Analytics }) {
  const { totals, previous } = analytics;
  const previousRate = previous.impressions > 0 ? previous.engagements / previous.impressions : null;
  const growth = totals.followers_growth;
  const start = totals.followers - growth;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label="Followers"
        value={compact(totals.followers)}
        footer={
          <span
            className={cn(
              "font-medium tabular-nums",
              growth > 0
                ? "text-[var(--t-color-green10)]"
                : growth < 0
                  ? "text-[var(--t-color-red10)]"
                  : "text-t-text-light",
            )}
          >
            {growth > 0 ? "+" : ""}
            {compact(growth)}
            {start > 0 && growth !== 0 ? ` (${growth > 0 ? "+" : ""}${((growth / start) * 100).toFixed(1)}%)` : ""}
            <span className="font-normal text-t-text-light"> in {analytics.days} days</span>
          </span>
        }
      />
      <StatTile
        label="Impressions"
        value={compact(totals.impressions)}
        footer={<Delta value={change(totals.impressions, previous.impressions)} />}
      />
      <StatTile
        label="Engagements"
        value={compact(totals.engagements)}
        footer={<Delta value={change(totals.engagements, previous.engagements)} />}
      />
      <StatTile
        label="Engagement rate"
        value={percent(totals.engagement_rate)}
        footer={
          totals.engagement_rate !== null && previousRate !== null ? (
            <span className="text-t-text-light tabular-nums">
              {percent(previousRate)} the period before
            </span>
          ) : (
            <span className="text-t-text-light">Engagements per impression</span>
          )
        }
      />
      <StatTile
        label="Posts published"
        value={String(totals.posts)}
        footer={<Delta value={change(totals.posts, previous.posts)} />}
      />
    </div>
  );
}

function FollowerChart({ analytics }: { analytics: Analytics }) {
  const accounts = analytics.accounts;
  // Accounts differ by orders of magnitude: one chart per account, the biggest first.
  const ordered = useMemo(
    () => [...accounts].sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0)),
    [accounts],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const account = ordered.find((a) => a.id === selected) ?? ordered[0];
  if (!account) return null;

  const color = `var(--t-color-${platformColor(account.platform) === "gray" ? "iris" : platformColor(account.platform)}9)`;
  const config = { followers: { label: "Followers", color } } satisfies ChartConfig;
  const series = account.series.length
    ? account.series
    : account.followers !== null
      ? [{ date: new Date().toISOString().slice(0, 10), followers: account.followers }]
      : [];
  const values = series.map((p) => p.followers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, Math.round((max - min) * 0.15) || Math.round(max * 0.02));

  return (
    <Section
      title="Follower growth"
      description={`${account.name} on ${platformInfo(account.platform).label}, last ${analytics.days} days`}
      className="xl:col-span-2"
    >
      {ordered.length > 1 && (
        <div className="-mx-1 flex flex-wrap gap-1">
          {ordered.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setSelected(a.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-t-hover focus-visible:ring-2 focus-visible:ring-ring",
                a.id === account.id && "bg-t-tertiary",
              )}
            >
              <AccountAvatar avatar={a.avatar} platform={a.platform} name={a.name} size={22} />
              <span className="flex flex-col leading-tight">
                <span className="max-w-[160px] truncate text-[12px] font-medium text-t-text">{a.name}</span>
                <span className="text-[11px] text-t-text-tertiary tabular-nums">
                  {compact(a.followers)}
                  {a.growth !== 0 && (
                    <span className={a.growth > 0 ? "text-[var(--t-color-green10)]" : "text-[var(--t-color-red10)]"}>
                      {" "}
                      {a.growth > 0 ? "+" : ""}
                      {compact(a.growth)}
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {series.length === 0 ? (
        <p className="py-10 text-center text-t-text-tertiary">No follower history yet for this account.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold text-t-text tabular-nums">
              {(account.followers ?? 0).toLocaleString()}
            </span>
            <span
              className={cn(
                "text-[12px] tabular-nums",
                account.growth > 0
                  ? "text-[var(--t-color-green10)]"
                  : account.growth < 0
                    ? "text-[var(--t-color-red10)]"
                    : "text-t-text-light",
              )}
            >
              {account.growth > 0 ? "+" : ""}
              {account.growth.toLocaleString()} ({account.growth_percentage.toFixed(1)}%)
            </span>
          </div>
          <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
            <AreaChart data={series} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="followers-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-followers)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--color-followers)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tickFormatter={(value: string) => format(new Date(`${value}T00:00:00`), "d MMM")}
              />
              <YAxis
                width={44}
                tickLine={false}
                axisLine={false}
                domain={[Math.max(0, min - pad), max + pad]}
                tickFormatter={(value: number) => compact(value)}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => format(new Date(`${String(value)}T00:00:00`), "EEE d MMM yyyy")}
                    formatter={(value) => (
                      <span className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">Followers</span>
                        <span className="font-medium tabular-nums">{Number(value).toLocaleString()}</span>
                      </span>
                    )}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="followers"
                stroke="var(--color-followers)"
                strokeWidth={2}
                fill="url(#followers-fill)"
                dot={series.length === 1}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        </>
      )}
    </Section>
  );
}

function BestTimes({ analytics }: { analytics: Analytics }) {
  const grid = useMemo(() => {
    const cells = WEEKDAYS.map(() => BUCKETS.map(() => ({ posts: 0, engagements: 0 })));
    for (const slot of analytics.best_times) {
      const bucket = Math.min(5, Math.floor(slot.hour / 4));
      const cell = cells[slot.weekday]?.[bucket];
      if (!cell) continue;
      cell.posts += slot.posts;
      cell.engagements += slot.engagements;
    }
    return cells.map((row) => row.map((c) => ({ ...c, avg: c.posts ? c.engagements / c.posts : null })));
  }, [analytics.best_times]);

  const max = Math.max(0, ...grid.flat().map((c) => c.avg ?? 0));
  let best: { weekday: number; bucket: number; avg: number } | null = null;
  grid.forEach((row, weekday) =>
    row.forEach((cell, bucket) => {
      if (cell.avg !== null && (!best || cell.avg > best.avg)) best = { weekday, bucket, avg: cell.avg };
    }),
  );
  const top = best as { weekday: number; bucket: number; avg: number } | null;
  const total = analytics.best_times.reduce((n, s) => n + s.posts, 0);

  return (
    <Section
      title="Best time to post"
      description={
        top && max > 0
          ? `Your posts do best on ${WEEKDAY_NAMES[top.weekday]} ${BUCKETS[top.bucket]!.part} (${top.avg.toFixed(1)} engagements a post), in ${analytics.days * 2} days of posts.`
          : "Average engagements per post, by weekday and time, in the brand's time zone."
      }
    >
      {total === 0 ? (
        <p className="py-6 text-center text-t-text-tertiary">Publish a few posts to see when they do best.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] border-separate border-spacing-1 text-[11px]">
            <thead>
              <tr>
                <th className="w-9" />
                {BUCKETS.map((b) => (
                  <th key={b.label} className="font-normal text-t-text-light tabular-nums">
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, weekday) => (
                <tr key={WEEKDAYS[weekday]}>
                  <th scope="row" className="pr-1 text-left font-normal text-t-text-tertiary">
                    {WEEKDAYS[weekday]}
                  </th>
                  {row.map((cell, bucket) => {
                    const strength = cell.avg !== null && max > 0 ? cell.avg / max : 0;
                    return (
                      <td
                        key={bucket}
                        title={
                          cell.posts
                            ? `${WEEKDAY_NAMES[weekday]} ${BUCKETS[bucket]!.label}h: ${cell.avg!.toFixed(1)} engagements a post over ${cell.posts} post${cell.posts > 1 ? "s" : ""}`
                            : `${WEEKDAY_NAMES[weekday]} ${BUCKETS[bucket]!.label}h: no posts`
                        }
                        className="h-7 rounded-[4px] text-center tabular-nums"
                        style={{
                          background: cell.posts
                            ? `color-mix(in oklab, var(--t-color-green9) ${Math.round(12 + strength * 78)}%, transparent)`
                            : "var(--t-background-tertiary, rgba(127,127,127,0.08))",
                          color: strength > 0.55 ? "white" : undefined,
                        }}
                      >
                        {cell.posts ? cell.avg!.toFixed(cell.avg! >= 10 ? 0 : 1) : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ByPlatform({ analytics }: { analytics: Analytics }) {
  const rows = [...analytics.by_platform].sort((a, b) => b.engagements - a.engagements);
  const max = Math.max(1, ...rows.map((r) => r.impressions));
  return (
    <Section title="By platform" description={`Last ${analytics.days} days`}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-t-text-tertiary">No posts in this period.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <div key={row.platform} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <PlatformGlyph platform={row.platform} className="text-t-text-secondary" />
                <span className="flex-1 font-medium text-t-text">{platformInfo(row.platform).label}</span>
                <span className="text-[12px] text-t-text-tertiary tabular-nums">
                  {row.posts} post{row.posts === 1 ? "" : "s"} · {compact(row.engagements)} eng.
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-t-tertiary">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(2, (row.impressions / max) * 100)}%`,
                    background: `var(--t-color-${platformColor(row.platform) === "gray" ? "slate" : platformColor(row.platform)}9)`,
                  }}
                />
              </div>
              <span className="text-[11px] text-t-text-light tabular-nums">
                {compact(row.impressions)} impressions
                {row.impressions > 0 ? ` · ${percent(row.engagements / row.impressions)} engagement` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

type SortKey = "published_at" | "impressions" | "likes" | "comments" | "shares" | "engagement_rate";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "impressions", label: "Impr." },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comm." },
  { key: "shares", label: "Shares" },
  { key: "engagement_rate", label: "Eng. rate" },
];

function TopPosts({ posts, onAsk }: { posts: AnalyzedPost[]; onAsk: (message: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "impressions", desc: true });
  const sorted = useMemo(() => {
    const value = (p: AnalyzedPost) =>
      sort.key === "published_at"
        ? Date.parse(p.published_at)
        : sort.key === "impressions"
          ? p.impressions || p.views
          : (p[sort.key] ?? -1);
    return [...posts].sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)));
  }, [posts, sort]);

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => {
    const active = sort.key === key;
    const Chevron = active && !sort.desc ? IconChevronUp : IconChevronDown;
    return (
      <th key={key} className={cn("px-2 py-2 font-medium whitespace-nowrap", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-sm outline-none hover:text-t-text focus-visible:ring-2 focus-visible:ring-ring",
            active ? "text-t-text" : "text-t-text-tertiary",
          )}
        >
          {label}
          <Chevron size={12} className={active ? "opacity-100" : "opacity-0"} />
        </button>
      </th>
    );
  };

  return (
    <Section title="Posts" description="Every post published in the period. Click a column to sort.">
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="border-b border-t-border-light text-[12px]">
            <tr>
              <th className="w-4" />
              {header("published_at", "Date", "left")}
              <th className="px-2 py-2 text-left font-medium text-t-text-tertiary">Post</th>
              {COLUMNS.map((c) => header(c.key, c.label))}
              <th className="w-4" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((post) => (
              <tr key={post.id} className="group border-b border-t-border-light last:border-0 hover:bg-t-hover">
                <td />
                <td className="px-2 py-2.5 align-top whitespace-nowrap text-t-text-secondary tabular-nums">
                  {format(new Date(post.published_at), "d MMM")}
                  <div className="mt-1 flex gap-1 text-t-text-tertiary">
                    {post.platforms.map((p) => (
                      <PlatformGlyph key={p} platform={p} size={13} />
                    ))}
                  </div>
                  {post.imported && (
                    <span className="mt-1 block text-[10px] text-t-text-light" title="Published outside Richelieu, imported by its link">
                      imported
                    </span>
                  )}
                </td>
                <td className="max-w-[380px] px-2 py-2.5 align-top">
                  <div className="flex gap-2.5">
                    {post.thumbnail && (
                      <img
                        src={post.thumbnail}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="size-10 shrink-0 rounded-md border border-t-border-light object-cover"
                        onError={(event) => (event.currentTarget.style.display = "none")}
                      />
                    )}
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="line-clamp-2 leading-[1.45] text-t-text">{post.content || "(no text)"}</p>
                      <div className="flex gap-3 text-[12px] opacity-70 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        {post.url && (
                          <a
                            href={post.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-t-text-tertiary hover:text-t-text"
                          >
                            <IconExternalLink size={12} /> View
                          </a>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-t-text-tertiary hover:text-t-text"
                          onClick={() =>
                            onAsk(
                              `Write 3 new post ideas in the spirit of this post that did well (${compact(post.impressions || post.views)} impressions, ${post.likes} likes, ${post.comments} comments, ${post.shares} shares on ${post.platforms.map((p) => platformInfo(p).label).join(", ")}). Keep what made it work, change the topic and angle, and put them on the calendar as drafts:\n\n"""\n${post.content}\n"""`,
                            )
                          }
                        >
                          <IconSparkles size={12} /> Write more like this
                        </button>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right align-top tabular-nums">
                  {post.impressions || post.views ? compact(post.impressions || post.views) : post.imported ? "—" : "0"}
                </td>
                <td className="px-2 py-2.5 text-right align-top tabular-nums">{compact(post.likes)}</td>
                <td className="px-2 py-2.5 text-right align-top tabular-nums">{compact(post.comments)}</td>
                <td className="px-2 py-2.5 text-right align-top tabular-nums">{compact(post.shares)}</td>
                <td className="px-2 py-2.5 text-right align-top tabular-nums">{percent(post.engagement_rate)}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the analytics">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-t-border px-3.5 py-3">
            <Skeleton width={70} height={10} />
            <Skeleton width={90} height={20} />
            <Skeleton width={120} height={10} />
          </div>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="rounded-lg border border-t-border p-4 xl:col-span-2">
          <Skeleton width={120} height={12} />
          <div className="mt-4">
            <Skeleton width="100%" height={200} />
          </div>
        </div>
        <div className="rounded-lg border border-t-border p-4">
          <Skeleton width={120} height={12} />
          <div className="mt-4">
            <Skeleton width="100%" height={200} />
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-t-border p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="py-2">
            <Skeleton width={`${60 + ((i * 13) % 35)}%`} height={12} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="m-auto flex max-w-[420px] flex-col items-center gap-3 px-6 py-16 text-center">
      {icon}
      <h2 className="text-[16px] font-semibold text-t-text">{title}</h2>
      <div className="leading-[1.55] text-t-text-secondary">{children}</div>
    </div>
  );
}

/** The Analytics tab of a brand. */
export function SocialAnalytics({ brand, accounts, onAsk }: BrandViewProps) {
  const [days, setDays] = useState(30);
  const { data: analytics, error, loading, reload } = useAnalytics(brand.id, days);

  if (accounts && accounts.length === 0)
    return (
      <div className="flex h-full overflow-y-auto">
        <Empty
          icon={
            <IconTile size="lg" color="blue">
              <IconPlugConnected />
            </IconTile>
          }
          title="Connect an account to see its numbers"
        >
          <p>Followers, reach, engagement and the best times to post show up here once an account is connected.</p>
          <Button
            className="mt-4"
            size="sm"
            variant="solid"
            color="accent"
            render={<Link to={`/social/${brand.id}/brand`} />}
          >
            Connect accounts
          </Button>
        </Empty>
      </div>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<(typeof PERIODS)[number]["value"]>
            aria-label="Period"
            size="sm"
            value={String(days) as (typeof PERIODS)[number]["value"]}
            onValueChange={(value) => setDays(Number(value))}
            options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          />
          <span className="flex-1 text-[12px] text-t-text-light">
            {analytics?.synced_at
              ? `Synced ${formatDistanceToNow(new Date(analytics.synced_at), { addSuffix: true })}`
              : ""}
          </span>
          <Button
            size="sm"
            variant="ghost"
            startIcon={<IconRefresh size={14} />}
            loading={loading && analytics !== null}
            disabled={loading}
            onClick={() => void reload()}
          >
            Refresh
          </Button>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--t-border-color-danger)] bg-[var(--t-background-danger)] px-3 py-2 text-t-text-danger">
            <span>The analytics could not load: {error}</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}

        {!analytics ? (
          !error && <Loading />
        ) : (
          <div className={cn("flex flex-col gap-3 transition-opacity", loading && "opacity-60")}>
            <Kpis analytics={analytics} />
            <div className="grid gap-3 xl:grid-cols-3">
              <FollowerChart analytics={analytics} />
              <ByPlatform analytics={analytics} />
            </div>
            <BestTimes analytics={analytics} />
            {analytics.posts.length === 0 ? (
              <Section title="Posts">
                <Empty
                  icon={
                    <IconTile size="lg" color="green">
                      <IconChartAreaLineFilled />
                    </IconTile>
                  }
                  title={`No posts published in the last ${analytics.days} days`}
                >
                  <p>Plan a few on the calendar, or ask the copilot for a week of posts.</p>
                  <Button
                    className="mt-4"
                    size="sm"
                    variant="outline"
                    startIcon={<IconSparkles size={14} />}
                    onClick={() =>
                      onAsk(
                        "Plan next week's posts: look at what did well before, then put a draft for each slot on the calendar at our best times.",
                      )
                    }
                  >
                    Plan next week with the copilot
                  </Button>
                </Empty>
              </Section>
            ) : (
              <TopPosts posts={analytics.posts} onAsk={onAsk} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
