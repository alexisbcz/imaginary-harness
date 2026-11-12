// A brand's content calendar: its drafts, scheduled and published posts on a month or a week, in the brand's time
// zone. Drafts and scheduled posts move by drag and drop; undated drafts wait in a tray until they get a day. On a
// phone the calendar is an agenda.

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { LightIconButton, SegmentedControl } from "twenty-ui/components/input";
import { Skeleton } from "twenty-ui/primitives/feedback";
import { Button, Input } from "twenty-ui/primitives/input";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconLink,
  IconPlugConnected,
  IconPlus,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";

import { PlatformGlyph } from "@/components/social/platform-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  importPost,
  platformInfo,
  reschedulePost,
  STATUS_LABELS,
  usePosts,
  type BrandViewProps,
  type SocialPost,
} from "@/lib/social";

// Time in a time zone -----------------------------------------------------------------------------------------

/** A calendar day, independent of any zone: "2026-11-12". */
export type Day = string;

const pad = (n: number) => String(n).padStart(2, "0");

/** The wall-clock parts of a moment in a zone. */
export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** The day a moment falls on in a zone. */
export const dayOf = (date: Date, timeZone: string): Day => {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** "HH:MM" of a moment in a zone. */
export const timeOf = (date: Date, timeZone: string) => {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

/** The moment a zone's clock shows `time` on `day`. */
export function zonedDate(day: Day, time: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // The zone's offset at that moment, then once more in case the first guess crossed a DST change.
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(result), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    result += guess - shown;
  }
  return new Date(result);
}

export function addDays(day: Day, n: number): Day {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day: Day) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

const startOfWeek = (day: Day) => addDays(day, -weekdayOf(day));

function dayLabel(day: Day, options: Intl.DateTimeFormatOptions) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** When a new post on `day` should go out: 09:00 if that is still ahead, else the next full hour. */
export function defaultSlot(day: Day, timeZone: string): Date {
  const nine = zonedDate(day, "09:00", timeZone);
  if (nine.getTime() > Date.now() + 5 * 60_000) return nine;
  const next = new Date(Math.ceil((Date.now() + 5 * 60_000) / 3_600_000) * 3_600_000);
  return dayOf(next, timeZone) === day ? next : nine;
}

// Posts -------------------------------------------------------------------------------------------------------

/** When a post shows on the calendar: its publication, else its planned time. */
const momentOf = (post: SocialPost) => post.published_at ?? post.scheduled_for;

const movable = (post: SocialPost) => ["draft", "scheduled", "failed"].includes(post.status);

type StatusFilter = "all" | "draft" | "scheduled" | "published" | "failed";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Failed" },
];

function matchesStatus(post: SocialPost, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "published") return post.status === "published" || post.status === "partial";
  if (filter === "failed") return post.status === "failed" || post.status === "cancelled";
  if (filter === "scheduled") return post.status === "scheduled" || post.status === "publishing";
  return post.status === filter || post.status === "pending_approval";
}

const chipTone: Record<SocialPost["status"], string> = {
  draft: "border-dashed border-t-border bg-t-primary text-t-text-secondary",
  pending_approval: "border-dashed border-t-border bg-t-primary text-t-text-secondary",
  scheduled: "border-[var(--t-color-blue6)] bg-[var(--t-color-blue3)] text-t-text",
  publishing: "border-[var(--t-color-blue6)] bg-[var(--t-color-blue3)] text-t-text",
  published: "border-[var(--t-color-green5)] bg-[var(--t-color-green2)] text-t-text",
  partial: "border-[var(--t-color-amber6)] bg-[var(--t-color-amber2)] text-t-text",
  failed: "border-[var(--t-border-color-danger)] bg-[var(--t-background-danger)] text-t-text-danger",
  cancelled: "border-t-border bg-t-secondary text-t-text-tertiary line-through",
};

function StatusMark({ post }: { post: SocialPost }) {
  if (post.status === "published") return <IconCheck size={11} className="shrink-0 text-[var(--t-color-green10)]" />;
  if (post.status === "failed" || post.status === "partial")
    return <IconAlertTriangle size={11} className="shrink-0" />;
  if (post.status === "scheduled") return <IconClock size={11} className="shrink-0 text-[var(--t-color-blue10)]" />;
  return null;
}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim() || "(no text)";

/** A post on the calendar: its time, platforms and first line, styled by status. */
function PostChip({
  post,
  timeZone,
  onOpen,
  compact = false,
}: {
  post: SocialPost;
  timeZone: string;
  onOpen: () => void;
  compact?: boolean;
}) {
  const at = momentOf(post);
  const platforms = [...new Set(post.platforms.map((p) => p.platform))];
  return (
    <button
      type="button"
      draggable={movable(post)}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/x-post-id", post.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title={`${STATUS_LABELS[post.status]}${at ? ` · ${timeOf(new Date(at), timeZone)}` : ""}\n${post.content.slice(0, 280)}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 overflow-hidden rounded-[5px] border px-1.5 text-left text-[11px] leading-none transition-colors outline-none hover:brightness-[0.97] focus-visible:ring-2 focus-visible:ring-ring dark:hover:brightness-110",
        compact ? "h-[20px]" : "h-[22px]",
        movable(post) && "cursor-grab active:cursor-grabbing",
        chipTone[post.status],
      )}
    >
      {at && <span className="shrink-0 font-medium tabular-nums">{timeOf(new Date(at), timeZone)}</span>}
      {/* In a narrow day the text matters more than the platforms: they show once the chip has room. */}
      <span className="hidden shrink-0 items-center gap-0.5 text-t-text-tertiary @min-[150px]:flex">
        {platforms.slice(0, 3).map((platform) => (
          <PlatformGlyph key={platform} platform={platform} size={11} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{firstLine(post.content)}</span>
      <span className="hidden shrink-0 @min-[110px]:flex">
        <StatusMark post={post} />
      </span>
    </button>
  );
}

/** Adds a post published outside Richelieu, from its link: Zernio only knows the posts that went through it. */
function ImportButton({ brandId, onImported }: { brandId: string; onImported: (post: SocialPost) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const post = await importPost(brandId, url.trim());
      setOpen(false);
      setUrl("");
      onImported(post);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <PopoverTrigger render={<Button size="sm" variant="outline" startIcon={<IconLink size={14} />} />}>
        Import a post
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] gap-3 rounded-lg border border-t-border bg-t-primary p-3 text-t-text shadow-lg">
        <div className="flex flex-col gap-1">
          <span className="font-medium">Import a published post</span>
          <span className="text-[12px] leading-[1.45] text-t-text-tertiary">
            Posts published straight on a platform don't go through Zernio. Paste one's link to add it to the
            calendar and the analytics, with its likes and comments, read again every day.
          </span>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            aria-label="Post link"
            placeholder="https://www.linkedin.com/posts/… or lnkd.in/…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          {error && <span className="text-[12px] text-t-text-danger">{error}</span>}
          <Button type="submit" size="sm" variant="solid" color="accent" loading={busy} disabled={!url.trim()}>
            {busy ? "Reading the post…" : "Import"}
          </Button>
        </form>
        <span className="text-[11px] text-t-text-light">LinkedIn, X, Instagram, TikTok and YouTube.</span>
      </PopoverContent>
    </Popover>
  );
}

// The calendar ------------------------------------------------------------------------------------------------

type Mode = "month" | "week";
const HOUR_HEIGHT = 52;
const MAX_CHIPS = 3;

function planPrompt(brandName: string) {
  return `Plan next week's posts for ${brandName}.

1. Start with social_overview to see what is already planned, and social_performance to see which topics, formats and hours worked best.
2. Fill the gaps for next week (Monday to Sunday) up to the posting goal in our brief; if there is none, aim for 3 to 5 posts across our connected accounts.
3. Put each post on the calendar as a draft (draft_social_post) at one of our best times, spread over the week, mixing our content pillars. Write each one for its platform, in our voice.
4. Do not schedule anything: I will review the drafts on the calendar.

Then give me a short summary: one line per post with its day, platform and angle.`;
}

export function SocialCalendar({ brand, accounts, revision, onCompose, onAsk }: BrandViewProps) {
  const timeZone = brand.timezone || "UTC";
  const isMobile = useIsMobile();
  const today = dayOf(new Date(), timeZone);
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState<Day>(today);
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  // The visible days: six weeks around the month, or the week.
  const days = useMemo(() => {
    if (mode === "week") {
      const start = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = `${anchor.slice(0, 7)}-01`;
    const start = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [mode, anchor]);

  // A day of margin on each side, for posts near midnight.
  const range = useMemo(
    () => ({
      from: zonedDate(addDays(days[0]!, -1), "00:00", timeZone),
      to: zonedDate(addDays(days.at(-1)!, 2), "00:00", timeZone),
    }),
    [days, timeZone],
  );
  const { data, loading, error, reload, setData } = usePosts(brand.id, range.from, range.to);

  // Reload on the page's say-so (a save, a copilot answer), and when the window comes back.
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (firstRevision.current === revision) return;
    firstRevision.current = revision;
    void reload();
  }, [revision, reload]);
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const posts = useMemo(
    () =>
      (data ?? []).map((post) => (moved[post.id] ? { ...post, scheduled_for: moved[post.id]! } : post)),
    [data, moved],
  );
  const visible = useMemo(
    () =>
      posts.filter(
        (post) =>
          matchesStatus(post, statusFilter) &&
          (platformFilter.length === 0 || post.platforms.some((p) => platformFilter.includes(p.platform))),
      ),
    [posts, statusFilter, platformFilter],
  );

  const byDay = useMemo(() => {
    const map = new Map<Day, SocialPost[]>();
    for (const post of visible) {
      const at = momentOf(post);
      if (!at) continue;
      const day = dayOf(new Date(at), timeZone);
      map.set(day, [...(map.get(day) ?? []), post]);
    }
    for (const list of map.values()) list.sort((a, b) => momentOf(a)!.localeCompare(momentOf(b)!));
    return map;
  }, [visible, timeZone]);

  const undated = useMemo(
    () =>
      posts
        .filter((post) => post.status === "draft" && !post.scheduled_for)
        .filter((post) => platformFilter.length === 0 || post.platforms.some((p) => platformFilter.includes(p.platform)))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [posts, platformFilter],
  );

  const platforms = useMemo(() => [...new Set((accounts ?? []).map((a) => a.platform))], [accounts]);

  /** Moves a post to a new moment: shown at once, undone if the server refuses. */
  async function move(postId: string, at: Date) {
    const post = posts.find((p) => p.id === postId);
    if (!post || !movable(post)) return;
    if (post.scheduled_for && Math.abs(Date.parse(post.scheduled_for) - at.getTime()) < 60_000) return;
    if (post.status === "scheduled" && at.getTime() < Date.now() + 60_000) {
      setNotice("A scheduled post can only move to the future.");
      return;
    }
    setMoved((current) => ({ ...current, [postId]: at.toISOString() }));
    try {
      const saved = await reschedulePost(brand.id, postId, at);
      setData((current) => (current ?? []).map((p) => (p.id === postId ? saved : p)));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setMoved((current) => {
        const next = { ...current };
        delete next[postId];
        return next;
      });
    }
  }

  /** Dropping a post on a day keeps its time of day (09:00 for an undated draft); on an hour, takes the hour. */
  function dropOn(event: DragEvent, day: Day, hour?: number) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/x-post-id");
    const post = posts.find((p) => p.id === id);
    if (!post) return;
    const current = post.scheduled_for ? new Date(post.scheduled_for) : null;
    const minutes = current ? zonedParts(current, timeZone).minute : 0;
    const time =
      hour !== undefined
        ? `${pad(hour)}:${pad(minutes)}`
        : current
          ? timeOf(current, timeZone)
          : "09:00";
    void move(id, zonedDate(day, time, timeZone));
  }

  function step(direction: -1 | 1) {
    if (mode === "week") setAnchor((day) => addDays(day, 7 * direction));
    else {
      const [y, m] = anchor.split("-").map(Number) as [number, number];
      const date = new Date(Date.UTC(y, m - 1 + direction, 1));
      setAnchor(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`);
    }
  }

  const label =
    mode === "month"
      ? dayLabel(`${anchor.slice(0, 7)}-01`, { month: "long", year: "numeric" })
      : `${dayLabel(days[0]!, { day: "numeric", month: "short" })} – ${dayLabel(days[6]!, { day: "numeric", month: "short", year: "numeric" })}`;

  const togglePlatform = (platform: string) =>
    setPlatformFilter((current) =>
      current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform],
    );

  const compose = (day: Day) => onCompose({ date: defaultSlot(day, timeZone) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-t-border-light px-3 py-2">
        {!isMobile && (
          <SegmentedControl<Mode>
            aria-label="Calendar view"
            size="sm"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
            ]}
          />
        )}
        <div className="flex items-center gap-0.5">
          <LightIconButton aria-label="Previous" size="sm" onClick={() => step(-1)}>
            <IconChevronLeft size={16} />
          </LightIconButton>
          <LightIconButton aria-label="Next" size="sm" onClick={() => step(1)}>
            <IconChevronRight size={16} />
          </LightIconButton>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAnchor(today)}>
          Today
        </Button>
        <span className="min-w-0 truncate font-medium text-t-text tabular-nums">{label}</span>
        {loading && data && <span className="text-[11px] text-t-text-light">Updating…</span>}
        <div className="flex-1" />
        <ImportButton
          brandId={brand.id}
          onImported={(post) => {
            void reload();
            onCompose({ post });
          }}
        />
        <Button
          size="sm"
          variant="soft"
          color="accent"
          startIcon={<IconSparkles size={14} />}
          onClick={() => onAsk(planPrompt(brand.name))}
        >
          Plan my week
        </Button>
      </div>

      {/* Filters */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-t-border-light px-3 py-1.5">
        {STATUS_FILTERS.map((filter) => (
          <FilterChip
            key={filter.value}
            active={statusFilter === filter.value}
            onClick={() => setStatusFilter(filter.value)}
          >
            {filter.label}
          </FilterChip>
        ))}
        {platforms.length > 1 && <span className="mx-1 h-4 w-px shrink-0 bg-t-border" />}
        {platforms.length > 1 &&
          platforms.map((platform) => (
            <FilterChip
              key={platform}
              active={platformFilter.includes(platform)}
              onClick={() => togglePlatform(platform)}
            >
              <PlatformGlyph platform={platform} size={12} />
              {platformInfo(platform).label}
            </FilterChip>
          ))}
      </div>

      {accounts !== null && accounts.length === 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-t-border-light bg-t-secondary px-3 py-2 text-t-text-secondary">
          <IconPlugConnected size={15} className="shrink-0 text-t-text-tertiary" />
          <span className="min-w-0 flex-1">
            No account is connected yet: drafts can wait here, but nothing can be scheduled.
          </span>
          <Link to={`/social/${brand.id}/brand`} className="shrink-0 font-medium text-t-text underline-offset-2 hover:underline">
            Connect accounts
          </Link>
        </div>
      )}

      {(notice || (error && !data)) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--t-border-color-danger)] bg-[var(--t-background-danger)] px-3 py-1.5 text-t-text-danger">
          <IconAlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{notice ?? error}</span>
          {notice ? (
            <LightIconButton aria-label="Dismiss" size="xs" onClick={() => setNotice(null)}>
              <IconX size={13} />
            </LightIconButton>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              Retry
            </Button>
          )}
        </div>
      )}

      <div className={cn("flex min-h-0 flex-1", isMobile ? "flex-col" : "flex-row")}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isMobile ? (
            <Agenda
              days={days}
              byDay={byDay}
              today={today}
              timeZone={timeZone}
              loading={!data}
              onOpen={(post) => onCompose({ post })}
              onCompose={compose}
            />
          ) : mode === "month" ? (
            <MonthGrid
              days={days}
              month={anchor.slice(0, 7)}
              today={today}
              byDay={byDay}
              timeZone={timeZone}
              loading={!data}
              onOpen={(post) => onCompose({ post })}
              onCompose={compose}
              onDrop={dropOn}
              onShowWeek={(day) => {
                setAnchor(day);
                setMode("week");
              }}
            />
          ) : (
            <WeekGrid
              days={days}
              today={today}
              byDay={byDay}
              timeZone={timeZone}
              loading={!data}
              onOpen={(post) => onCompose({ post })}
              onCompose={(day, hour) => onCompose({ date: zonedDate(day, `${pad(hour)}:00`, timeZone) })}
              onDrop={dropOn}
            />
          )}
        </div>
        <DraftTray
          drafts={undated}
          loading={!data}
          isMobile={isMobile}
          onOpen={(post) => onCompose({ post })}
          onNew={() => onCompose({})}
        />
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-t-text bg-t-text text-t-primary"
          : "border-t-border text-t-text-secondary hover:bg-t-hover hover:text-t-text",
      )}
    >
      {children}
    </button>
  );
}

/** Accepts a dragged post: highlights while one hovers. */
function useDropTarget(onDrop: (event: DragEvent) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes("text/x-post-id")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        setOver(false);
        onDrop(event);
      },
    },
  };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function MonthGrid({
  days,
  month,
  today,
  byDay,
  timeZone,
  loading,
  onOpen,
  onCompose,
  onDrop,
  onShowWeek,
}: {
  days: Day[];
  month: string;
  today: Day;
  byDay: Map<Day, SocialPost[]>;
  timeZone: string;
  loading: boolean;
  onOpen: (post: SocialPost) => void;
  onCompose: (day: Day) => void;
  onDrop: (event: DragEvent, day: Day) => void;
  onShowWeek: (day: Day) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-t-border-light">
        {WEEKDAYS.map((name) => (
          <div key={name} className="px-2 py-1.5 text-[11px] font-medium text-t-text-tertiary">
            {name}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-y-auto">
        {days.map((day, index) => (
          <MonthDay
            key={day}
            day={day}
            inMonth={day.startsWith(month)}
            isToday={day === today}
            isPast={day < today}
            lastColumn={index % 7 === 6}
            posts={byDay.get(day) ?? []}
            timeZone={timeZone}
            loading={loading}
            onOpen={onOpen}
            onCompose={() => onCompose(day)}
            onDrop={(event) => onDrop(event, day)}
            onShowWeek={() => onShowWeek(day)}
          />
        ))}
      </div>
    </div>
  );
}

function MonthDay({
  day,
  inMonth,
  isToday,
  isPast,
  lastColumn,
  posts,
  timeZone,
  loading,
  onOpen,
  onCompose,
  onDrop,
  onShowWeek,
}: {
  day: Day;
  inMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  lastColumn: boolean;
  posts: SocialPost[];
  timeZone: string;
  loading: boolean;
  onOpen: (post: SocialPost) => void;
  onCompose: () => void;
  onDrop: (event: DragEvent) => void;
  onShowWeek: () => void;
}) {
  const drop = useDropTarget(onDrop);
  const shown = posts.slice(0, posts.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS);
  const hidden = posts.length - shown.length;
  return (
    <div
      {...drop.props}
      className={cn(
        "group @container relative flex min-h-[104px] min-w-0 flex-col gap-1 border-b border-t-border-light p-1.5",
        !lastColumn && "border-r",
        !inMonth && "bg-t-secondary/60",
        drop.over && "bg-[var(--t-color-blue2)] ring-2 ring-[var(--t-color-blue7)] ring-inset",
      )}
    >
      <div className="flex h-5 items-center justify-between">
        <span
          className={cn(
            "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[12px] tabular-nums",
            isToday
              ? "bg-[var(--t-color-blue9)] font-semibold text-white"
              : inMonth
                ? "text-t-text-secondary"
                : "text-t-text-light",
          )}
        >
          {Number(day.slice(8))}
        </span>
        {!isPast && (
          <LightIconButton
            aria-label={`New post on ${day}`}
            size="xs"
            onClick={onCompose}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <IconPlus size={13} />
          </LightIconButton>
        )}
      </div>
      {loading ? (
        inMonth && Number(day.slice(8)) % 3 === 1 ? <Skeleton width="85%" height={18} borderRadius={5} /> : null
      ) : (
        <>
          {shown.map((post) => (
            <PostChip key={post.id} post={post} timeZone={timeZone} onOpen={() => onOpen(post)} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={onShowWeek}
              className="self-start rounded px-1 text-[11px] font-medium text-t-text-tertiary hover:bg-t-hover hover:text-t-text"
            >
              +{hidden} more
            </button>
          )}
        </>
      )}
    </div>
  );
}

function WeekGrid({
  days,
  today,
  byDay,
  timeZone,
  loading,
  onOpen,
  onCompose,
  onDrop,
}: {
  days: Day[];
  today: Day;
  byDay: Map<Day, SocialPost[]>;
  timeZone: string;
  loading: boolean;
  onOpen: (post: SocialPost) => void;
  onCompose: (day: Day, hour: number) => void;
  onDrop: (event: DragEvent, day: Day, hour: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = HOUR_HEIGHT * 8;
  }, []);
  const now = new Date();
  const nowParts = zonedParts(now, timeZone);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b border-t-border-light">
        <div />
        {days.map((day, index) => (
          <div key={day} className="flex items-baseline gap-1.5 px-2 py-1.5">
            <span className="text-[11px] font-medium text-t-text-tertiary">{WEEKDAYS[index]}</span>
            <span
              className={cn(
                "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[12px] tabular-nums",
                day === today ? "bg-[var(--t-color-blue9)] font-semibold text-white" : "text-t-text-secondary",
              )}
            >
              {Number(day.slice(8))}
            </span>
          </div>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid grid-cols-[48px_repeat(7,minmax(0,1fr))]">
          <div>
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                style={{ height: HOUR_HEIGHT }}
                className="pr-2 text-right text-[10px] text-t-text-light tabular-nums"
              >
                <span className="relative -top-1.5">{hour === 0 ? "" : `${pad(hour)}:00`}</span>
              </div>
            ))}
          </div>
          {days.map((day) => {
            const posts = byDay.get(day) ?? [];
            return (
              <div key={day} className="relative border-l border-t-border-light">
                {Array.from({ length: 24 }, (_, hour) => (
                  <WeekSlot
                    key={hour}
                    past={day < today || (day === today && hour < nowParts.hour)}
                    posts={posts.filter((post) => zonedParts(new Date(momentOf(post)!), timeZone).hour === hour)}
                    timeZone={timeZone}
                    loading={loading && hour === 10 && weekdayOf(day) % 2 === 0}
                    onOpen={onOpen}
                    onCompose={() => onCompose(day, hour)}
                    onDrop={(event) => onDrop(event, day, hour)}
                  />
                ))}
                {day === today && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute right-0 left-0 z-10 h-px bg-[var(--t-color-red9)]"
                    style={{ top: (nowParts.hour + nowParts.minute / 60) * HOUR_HEIGHT }}
                  >
                    <span className="absolute -top-[3px] -left-[3px] size-[7px] rounded-full bg-[var(--t-color-red9)]" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WeekSlot({
  past,
  posts,
  timeZone,
  loading,
  onOpen,
  onCompose,
  onDrop,
}: {
  past: boolean;
  posts: SocialPost[];
  timeZone: string;
  loading: boolean;
  onOpen: (post: SocialPost) => void;
  onCompose: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  const drop = useDropTarget(onDrop);
  const shown = posts.slice(0, 2);
  return (
    <div
      {...drop.props}
      role={past ? undefined : "button"}
      tabIndex={past ? undefined : -1}
      aria-label={past ? undefined : "New post at this time"}
      onClick={past ? undefined : onCompose}
      style={{ height: HOUR_HEIGHT }}
      className={cn(
        "group/slot relative flex flex-col gap-0.5 overflow-hidden border-b border-t-border-light p-0.5",
        past ? "bg-t-secondary/40" : "cursor-pointer hover:bg-t-hover/60",
        drop.over && "bg-[var(--t-color-blue2)] ring-2 ring-[var(--t-color-blue7)] ring-inset",
      )}
    >
      {loading && <Skeleton width="90%" height={18} borderRadius={5} />}
      {shown.map((post) => (
        <PostChip key={post.id} post={post} timeZone={timeZone} compact onOpen={() => onOpen(post)} />
      ))}
      {posts.length > 2 && (
        <span className="px-1 text-[10px] text-t-text-tertiary">+{posts.length - 2} more</span>
      )}
      {!past && posts.length === 0 && (
        <IconPlus
          size={13}
          className="absolute top-1/2 left-1/2 -translate-1/2 text-t-text-light opacity-0 group-hover/slot:opacity-100"
        />
      )}
    </div>
  );
}

/** On a phone: the visible days that have posts, in order. */
function Agenda({
  days,
  byDay,
  today,
  timeZone,
  loading,
  onOpen,
  onCompose,
}: {
  days: Day[];
  byDay: Map<Day, SocialPost[]>;
  today: Day;
  timeZone: string;
  loading: boolean;
  onOpen: (post: SocialPost) => void;
  onCompose: (day: Day) => void;
}) {
  const withPosts = days.filter((day) => (byDay.get(day)?.length ?? 0) > 0 || day === today);
  if (loading)
    return (
      <div className="flex flex-col gap-3 p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} width="100%" height={56} borderRadius={8} />
        ))}
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {withPosts.map((day) => (
        <section key={day} className="py-2">
          <div className="flex items-center justify-between pb-1.5">
            <h3 className={cn("text-[12px] font-semibold", day === today ? "text-[var(--t-color-blue11)]" : "text-t-text-secondary")}>
              {day === today ? "Today · " : ""}
              {dayLabel(day, { weekday: "long", day: "numeric", month: "long" })}
            </h3>
            {day >= today && (
              <LightIconButton aria-label="New post on this day" size="xs" onClick={() => onCompose(day)}>
                <IconPlus size={13} />
              </LightIconButton>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {(byDay.get(day) ?? []).map((post) => (
              <AgendaRow key={post.id} post={post} timeZone={timeZone} onOpen={() => onOpen(post)} />
            ))}
            {(byDay.get(day)?.length ?? 0) === 0 && <p className="text-t-text-light">Nothing planned.</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function AgendaRow({ post, timeZone, onOpen }: { post: SocialPost; timeZone: string; onOpen: () => void }) {
  const at = momentOf(post);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left", chipTone[post.status])}
    >
      <span className="w-10 shrink-0 pt-px text-[12px] font-medium tabular-nums">
        {at ? timeOf(new Date(at), timeZone) : ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 leading-[1.4]">{post.content || "(no text)"}</span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-t-text-tertiary">
          {[...new Set(post.platforms.map((p) => p.platform))].map((platform) => (
            <PlatformGlyph key={platform} platform={platform} size={12} />
          ))}
          {STATUS_LABELS[post.status]}
        </span>
      </span>
    </button>
  );
}

/** Drafts without a day, waiting to be dragged onto the calendar. */
function DraftTray({
  drafts,
  loading,
  isMobile,
  onOpen,
  onNew,
}: {
  drafts: SocialPost[];
  loading: boolean;
  isMobile: boolean;
  onOpen: (post: SocialPost) => void;
  onNew: () => void;
}) {
  if (isMobile && !loading && drafts.length === 0) return null;
  return (
    <aside
      aria-label="Unscheduled drafts"
      className={cn(
        "flex shrink-0 flex-col bg-t-secondary/50",
        isMobile ? "max-h-[40%] border-t border-t-border-light" : "w-[232px] border-l border-t-border-light",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="flex-1 text-[12px] font-semibold text-t-text-secondary">
          Unscheduled drafts
          {drafts.length > 0 && <span className="ml-1.5 font-normal text-t-text-light tabular-nums">{drafts.length}</span>}
        </span>
        <LightIconButton aria-label="New draft" size="xs" onClick={onNew}>
          <IconPlus size={13} />
        </LightIconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
        {loading &&
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} width="100%" height={64} borderRadius={8} />)}
        {!loading && drafts.length === 0 && (
          <p className="px-1 py-2 text-[12px] leading-[1.5] text-t-text-light">
            Ideas without a date land here. Drag one onto a day to plan it.
          </p>
        )}
        {drafts.map((post) => (
          <button
            key={post.id}
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/x-post-id", post.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => onOpen(post)}
            className="flex cursor-grab flex-col gap-1.5 rounded-md border border-dashed border-t-border bg-t-primary p-2 text-left transition-colors hover:border-t-text-light active:cursor-grabbing"
          >
            <span className="line-clamp-3 text-[12px] leading-[1.45] text-t-text">{post.content || "(no text)"}</span>
            <span className="flex items-center gap-1 text-t-text-tertiary">
              {[...new Set(post.platforms.map((p) => p.platform))].map((platform) => (
                <PlatformGlyph key={platform} platform={platform} size={12} />
              ))}
              {post.platforms.length === 0 && <span className="text-[11px]">No account</span>}
              {post.media.length > 0 && (
                <span className="ml-auto text-[11px] tabular-nums">
                  {post.media.length} media
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
