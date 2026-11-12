// A brand's numbers, as a social lead reads them on a Monday: followers and their growth, reach and engagement
// against the previous period, when its posts do best, each platform's share, and the posts that did best.

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
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
import { dateLocale, intlLocale } from "@/lib/i18n";

/** The periods, in days; their labels are `analytics.period`. */
const PERIODS = ["7", "30", "90"] as const;

/** A weekday's name (0 = Monday), in the current language. */
const weekdayName = (index: number, weekday: "short" | "long") =>
  new Intl.DateTimeFormat(intlLocale(), { weekday, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + index, 12)));
const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];
/** Four-hour buckets: a heatmap a person can read at a glance. `part` names the key of "Monday mornings". */
const BUCKETS = [
  { from: 0, label: "0–4", part: "nights" },
  { from: 4, label: "4–8", part: "earlyMornings" },
  { from: 8, label: "8–12", part: "mornings" },
  { from: 12, label: "12–16", part: "afternoons" },
  { from: 16, label: "16–20", part: "evenings" },
  { from: 20, label: "20–24", part: "lateEvenings" },
] as const;

/** The change from `previous` to `current`, as a ratio; null when there is nothing to compare with. */
const change = (current: number, previous: number) => (previous > 0 ? (current - previous) / previous : null);

function Delta({ value, suffix }: { value: number | null; suffix?: string }) {
  const { t } = useTranslation("social");
  if (value === null) return <span className="text-t-text-light">{t("analytics.delta.none")}</span>;
  if (Math.abs(value) < 0.0005) return <span className="truncate text-t-text-light">{t("analytics.delta.same")}</span>;
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
        {percent(Math.abs(value), Math.abs(value) < 0.1 ? 1 : 0)}
      </span>
      <span className="truncate text-t-text-light">{suffix ?? t("analytics.delta.vsPrevious")}</span>
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
  const { t } = useTranslation("social");
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label={t("analytics.kpis.followers")}
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
            <Trans
              t={t}
              i18nKey="analytics.kpis.growthIn"
              values={{
                growth: `${growth > 0 ? "+" : ""}${compact(growth)}${start > 0 && growth !== 0 ? ` (${growth > 0 ? "+" : ""}${percent(growth / start, 1)})` : ""}`,
                count: analytics.days,
              }}
              components={{ light: <span className="font-normal text-t-text-light" /> }}
            />
          </span>
        }
      />
      <StatTile
        label={t("analytics.kpis.impressions")}
        value={compact(totals.impressions)}
        footer={<Delta value={change(totals.impressions, previous.impressions)} />}
      />
      <StatTile
        label={t("analytics.kpis.engagements")}
        value={compact(totals.engagements)}
        footer={<Delta value={change(totals.engagements, previous.engagements)} />}
      />
      <StatTile
        label={t("analytics.kpis.rate")}
        value={percent(totals.engagement_rate)}
        footer={
          totals.engagement_rate !== null && previousRate !== null ? (
            <span className="text-t-text-light tabular-nums">
              {t("analytics.kpis.periodBefore", { rate: percent(previousRate) })}
            </span>
          ) : (
            <span className="text-t-text-light">{t("analytics.kpis.rateHint")}</span>
          )
        }
      />
      <StatTile
        label={t("analytics.kpis.posts")}
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
  const { t } = useTranslation("social");
  const account = ordered.find((a) => a.id === selected) ?? ordered[0];
  if (!account) return null;

  const color = `var(--t-color-${platformColor(account.platform) === "gray" ? "iris" : platformColor(account.platform)}9)`;
  const config = { followers: { label: t("analytics.kpis.followers"), color } } satisfies ChartConfig;
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
      title={t("analytics.followers.title")}
      description={t("analytics.followers.description", {
        account: account.name,
        platform: platformInfo(account.platform).label,
        count: analytics.days,
      })}
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
        <p className="py-10 text-center text-t-text-tertiary">{t("analytics.followers.empty")}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold text-t-text tabular-nums">
              {(account.followers ?? 0).toLocaleString(intlLocale())}
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
              {account.growth.toLocaleString(intlLocale())} ({percent(account.growth_percentage / 100, 1)})
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
                tickFormatter={(value: string) => format(new Date(`${value}T00:00:00`), "d MMM", { locale: dateLocale() })}
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
                    labelFormatter={(value) =>
                      format(new Date(`${String(value)}T00:00:00`), "EEE d MMM yyyy", { locale: dateLocale() })
                    }
                    formatter={(value) => (
                      <span className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{t("analytics.kpis.followers")}</span>
                        <span className="font-medium tabular-nums">{Number(value).toLocaleString(intlLocale())}</span>
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
  const { t } = useTranslation("social");
  const grid = useMemo(() => {
    const cells = WEEKDAY_INDEXES.map(() => BUCKETS.map(() => ({ posts: 0, engagements: 0 })));
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
      title={t("analytics.bestTimes.title")}
      description={
        top && max > 0
          ? t("analytics.bestTimes.best", {
              when: t(`analytics.bestTimes.parts.${BUCKETS[top.bucket]!.part}`, { day: weekdayName(top.weekday, "long") }),
              avg: top.avg.toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
              days: analytics.days * 2,
            })
          : t("analytics.bestTimes.description")
      }
    >
      {total === 0 ? (
        <p className="py-6 text-center text-t-text-tertiary">{t("analytics.bestTimes.empty")}</p>
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
                <tr key={weekday}>
                  <th scope="row" className="pr-1 text-left font-normal text-t-text-tertiary">
                    {weekdayName(weekday, "short")}
                  </th>
                  {row.map((cell, bucket) => {
                    const strength = cell.avg !== null && max > 0 ? cell.avg / max : 0;
                    return (
                      <td
                        key={bucket}
                        title={
                          cell.posts
                            ? t("analytics.bestTimes.cell", {
                                day: weekdayName(weekday, "long"),
                                hours: BUCKETS[bucket]!.label,
                                avg: cell.avg!.toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                                count: cell.posts,
                              })
                            : t("analytics.bestTimes.cellEmpty", { day: weekdayName(weekday, "long"), hours: BUCKETS[bucket]!.label })
                        }
                        className="h-7 rounded-[4px] text-center tabular-nums"
                        style={{
                          background: cell.posts
                            ? `color-mix(in oklab, var(--t-color-green9) ${Math.round(12 + strength * 78)}%, transparent)`
                            : "var(--t-background-tertiary, rgba(127,127,127,0.08))",
                          color: strength > 0.55 ? "white" : undefined,
                        }}
                      >
                        {cell.posts
                          ? cell.avg!.toLocaleString(intlLocale(), {
                              minimumFractionDigits: cell.avg! >= 10 ? 0 : 1,
                              maximumFractionDigits: cell.avg! >= 10 ? 0 : 1,
                            })
                          : ""}
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
  const { t } = useTranslation("social");
  return (
    <Section title={t("analytics.byPlatform.title")} description={t("analytics.byPlatform.description", { count: analytics.days })}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-t-text-tertiary">{t("analytics.byPlatform.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <div key={row.platform} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <PlatformGlyph platform={row.platform} className="text-t-text-secondary" />
                <span className="flex-1 font-medium text-t-text">{platformInfo(row.platform).label}</span>
                <span className="text-[12px] text-t-text-tertiary tabular-nums">
                  {t("analytics.byPlatform.summary", { count: row.posts, engagements: compact(row.engagements) })}
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
                {row.impressions > 0
                  ? t("analytics.byPlatform.impressionsRate", {
                      impressions: compact(row.impressions),
                      rate: percent(row.engagements / row.impressions),
                    })
                  : t("analytics.byPlatform.impressions", { impressions: compact(row.impressions) })}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

type SortKey = "published_at" | "impressions" | "likes" | "comments" | "shares" | "engagement_rate";

/** The sortable number columns; their labels are `analytics.posts.columns.<key>`. */
const COLUMNS = ["impressions", "likes", "comments", "shares", "engagement_rate"] as const satisfies SortKey[];

function TopPosts({ posts, onAsk }: { posts: AnalyzedPost[]; onAsk: (message: string) => void }) {
  const { t } = useTranslation("social");
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
    <Section title={t("analytics.posts.title")} description={t("analytics.posts.description")}>
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="border-b border-t-border-light text-[12px]">
            <tr>
              <th className="w-4" />
              {header("published_at", t("analytics.posts.columns.date"), "left")}
              <th className="px-2 py-2 text-left font-medium text-t-text-tertiary">{t("analytics.posts.columns.post")}</th>
              {COLUMNS.map((c) => header(c, t(`analytics.posts.columns.${c}`)))}
              <th className="w-4" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((post) => (
              <tr key={post.id} className="group border-b border-t-border-light last:border-0 hover:bg-t-hover">
                <td />
                <td className="px-2 py-2.5 align-top whitespace-nowrap text-t-text-secondary tabular-nums">
                  {format(new Date(post.published_at), "d MMM", { locale: dateLocale() })}
                  <div className="mt-1 flex gap-1 text-t-text-tertiary">
                    {post.platforms.map((p) => (
                      <PlatformGlyph key={p} platform={p} size={13} />
                    ))}
                  </div>
                  {post.imported && (
                    <span className="mt-1 block text-[10px] text-t-text-light" title={t("analytics.posts.importedHint")}>
                      {t("analytics.posts.imported")}
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
                      <p className="line-clamp-2 leading-[1.45] text-t-text">{post.content || t("calendar.noText")}</p>
                      <div className="flex gap-3 text-[12px] opacity-70 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        {post.url && (
                          <a
                            href={post.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-t-text-tertiary hover:text-t-text"
                          >
                            <IconExternalLink size={12} /> {t("analytics.posts.view")}
                          </a>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-t-text-tertiary hover:text-t-text"
                          onClick={() =>
                            onAsk(
                              t("analytics.posts.morePrompt", {
                                impressions: compact(post.impressions || post.views),
                                likes: post.likes,
                                comments: post.comments,
                                shares: post.shares,
                                platforms: post.platforms.map((p) => platformInfo(p).label).join(", "),
                                content: post.content,
                              }),
                            )
                          }
                        >
                          <IconSparkles size={12} /> {t("analytics.posts.more")}
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
  const { t } = useTranslation("social");
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label={t("analytics.loading")}>
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
  const { t } = useTranslation(["social", "common"]);
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
          title={t("analytics.empty.title")}
        >
          <p>{t("analytics.empty.body")}</p>
          <Button
            className="mt-4"
            size="sm"
            variant="solid"
            color="accent"
            render={<Link to={`/social/${brand.id}/brand`} />}
          >
            {t("calendar.connect")}
          </Button>
        </Empty>
      </div>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<(typeof PERIODS)[number]>
            aria-label={t("analytics.periodLabel")}
            size="sm"
            value={String(days) as (typeof PERIODS)[number]}
            onValueChange={(value) => setDays(Number(value))}
            options={PERIODS.map((p) => ({ value: p, label: t("analytics.period", { count: Number(p) }) }))}
          />
          <span className="flex-1 text-[12px] text-t-text-light">
            {analytics?.synced_at
              ? t("analytics.synced", {
                  ago: formatDistanceToNow(new Date(analytics.synced_at), { addSuffix: true, locale: dateLocale() }),
                })
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
            {t("analytics.refresh")}
          </Button>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--t-border-color-danger)] bg-[var(--t-background-danger)] px-3 py-2 text-t-text-danger">
            <span>{t("analytics.error", { error })}</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              {t("common:retry")}
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
              <Section title={t("analytics.posts.title")}>
                <Empty
                  icon={
                    <IconTile size="lg" color="green">
                      <IconChartAreaLineFilled />
                    </IconTile>
                  }
                  title={t("analytics.noPosts.title", { count: analytics.days })}
                >
                  <p>{t("analytics.noPosts.body")}</p>
                  <Button
                    className="mt-4"
                    size="sm"
                    variant="outline"
                    startIcon={<IconSparkles size={14} />}
                    onClick={() =>
                      onAsk(
                        t("analytics.noPosts.prompt"),
                      )
                    }
                  >
                    {t("analytics.noPosts.button")}
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
