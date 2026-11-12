// Writing a post: its accounts, its text (with a version of its own per account when needed), media, a time in the
// brand's zone, AI rewrites, and a live preview per platform. Saves as a draft, schedules, or publishes now after a
// confirmation naming the accounts. Published posts open read-only, with their links and a retry when they failed.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { cn } from "cn";
import { LightIconButton } from "twenty-ui/components/input";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronDown,
  IconExternalLink,
  IconPhoto,
  IconPlayerPlayFilled,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconWand,
  IconX,
} from "@tabler/icons-react";

import { addDays, dayOf, timeOf, weekdayOf, zonedDate } from "@/components/social/calendar";
import { AccountAvatar, PlatformGlyph } from "@/components/social/platform-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  countFor,
  deleteImportedPost,
  deletePost,
  platformInfo,
  problemsFor,
  retryPost,
  REWRITES,
  rewriteText,
  savePost,
  statusLabel,
  uploadMedia,
  type Brand,
  type EditorRequest,
  type Media,
  type SocialAccount,
  type SocialPost,
} from "@/lib/social";
import { intlLocale } from "@/lib/i18n";

type Busy = null | "draft" | "schedule" | "publish" | "delete" | "retry" | "rewrite";

const READ_ONLY = new Set(["published", "publishing", "partial"]);

/** "Wed 12 Nov, 09:00" in a zone. */
function formatMoment(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat(intlLocale(), {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const zoneLabel = (timeZone: string) =>
  new Intl.DateTimeFormat(intlLocale(), { timeZone, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? timeZone;

const isMediaFile = (file: File) => file.type.startsWith("image/") || file.type.startsWith("video/");

/** "LinkedIn and X", "LinkedIn, X et Instagram": a list in the current language. */
const listOf = (items: string[]) => new Intl.ListFormat(intlLocale(), { type: "conjunction" }).format(items);

/** The statuses a post's account can have, as the editor names them. */
const PLATFORM_STATUSES = ["pending", "scheduled", "publishing", "published", "failed", "cancelled"] as const;

export function PostEditor({
  brand,
  accounts,
  request,
  onClose,
  onSaved,
  onAsk,
}: {
  brand: Brand;
  accounts: SocialAccount[];
  request: EditorRequest;
  onClose: () => void;
  onSaved: () => void;
  onAsk: (message: string) => void;
}) {
  const { t } = useTranslation(["social", "common"]);
  const timeZone = brand.timezone || "UTC";
  const post = request.post;
  const readOnly = post ? READ_ONLY.has(post.status) : false;

  const [selected, setSelected] = useState<string[]>(() =>
    post ? post.platforms.map((p) => p.account_id).filter(Boolean) : accounts.filter((a) => a.active).map((a) => a.id),
  );
  const [content, setContent] = useState(post?.content ?? request.content ?? "");
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (post?.platforms ?? []).filter((p) => p.custom_content).map((p) => [p.account_id, p.custom_content!]),
    ),
  );
  const [tab, setTab] = useState<string>("all");
  const [media, setMedia] = useState<Media[]>(post?.media ?? []);
  const [uploading, setUploading] = useState(0);
  const initialMoment = post?.scheduled_for ? new Date(post.scheduled_for) : (request.date ?? null);
  const [day, setDay] = useState(initialMoment ? dayOf(initialMoment, timeZone) : "");
  const [time, setTime] = useState(initialMoment ? timeOf(initialMoment, timeZone) : "");
  const [busy, setBusy] = useState<Busy>(null);
  const [confirm, setConfirm] = useState<null | "publish" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ tab: string; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);

  // A connected account only: one that was disconnected since stays out.
  const chosen = useMemo(() => accounts.filter((a) => selected.includes(a.id)), [accounts, selected]);
  const activeAccount = chosen.find((a) => a.id === tab);
  useEffect(() => {
    if (tab !== "all" && !selected.includes(tab)) setTab("all");
  }, [selected, tab]);

  const textFor = (accountId: string) => custom[accountId] ?? content;
  const editing = activeAccount ? textFor(activeAccount.id) : content;

  const moment = day && time ? zonedDate(day, time, timeZone) : null;
  const problems = chosen.flatMap((a) => problemsFor(a.platform, textFor(a.id), media));
  const scheduleBlocker =
    chosen.length === 0
      ? t("editor.blockers.account")
      : uploading
        ? t("editor.blockers.upload")
        : problems[0]
          ? problems[0]
          : !moment
            ? t("editor.blockers.moment")
            : moment.getTime() < Date.now() + 60_000
              ? t("editor.blockers.future")
              : null;
  const publishBlocker =
    chosen.length === 0 ? t("editor.blockers.account") : uploading ? t("editor.blockers.upload") : (problems[0] ?? null);

  function setEditing(value: string) {
    if (activeAccount) setCustom((current) => ({ ...current, [activeAccount.id]: value }));
    else setContent(value);
  }

  function toggle(accountId: string) {
    setSelected((current) =>
      current.includes(accountId) ? current.filter((id) => id !== accountId) : [...current, accountId],
    );
  }

  async function addFiles(files: Iterable<File>) {
    const list = [...files].filter(isMediaFile);
    if (list.length === 0) return;
    setError(null);
    setUploading((n) => n + list.length);
    await Promise.all(
      list.map(async (file) => {
        try {
          const uploaded = await uploadMedia(brand.id, file);
          setMedia((current) => [...current, uploaded]);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setUploading((n) => n - 1);
        }
      }),
    );
  }

  async function rewrite(instruction: string) {
    if (!editing.trim()) return;
    setBusy("rewrite");
    setError(null);
    try {
      const result = await rewriteText(brand.id, {
        text: editing,
        instruction,
        platform: activeAccount?.platform ?? (chosen.length === 1 ? chosen[0]!.platform : undefined),
      });
      setUndo({ tab, text: editing });
      setEditing(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function save(mode: "draft" | "schedule" | "publish") {
    setBusy(mode);
    setError(null);
    try {
      await savePost(
        brand.id,
        {
          content,
          channels: chosen.map((a) => ({
            account_id: a.id,
            custom_content: custom[a.id]?.trim() ? custom[a.id] : null,
          })),
          media,
          scheduled_for: mode === "publish" ? null : (moment?.toISOString() ?? null),
          mode,
          ...(post ? {} : { idempotency_key: idempotencyKey.current }),
        },
        post?.id,
      );
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirm(null);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!post) return;
    setBusy("delete");
    setError(null);
    try {
      if (post.source === "imported") await deleteImportedPost(brand.id, post.id);
      else await deletePost(brand.id, post.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirm(null);
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    if (!post) return;
    setBusy("retry");
    setError(null);
    try {
      await retryPost(brand.id, post.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Quick picks, in the brand's zone.
  const today = dayOf(new Date(), timeZone);
  const nextMonday = addDays(today, 7 - weekdayOf(today));
  const quickPicks = [
    { label: t("editor.when.tomorrow"), day: addDays(today, 1), time: "09:00" },
    { label: t("editor.when.nextMonday"), day: nextMonday, time: "09:00" },
  ];

  const title = readOnly
    ? statusLabel(post!.status)
    : post
      ? post.status === "scheduled"
        ? t("editor.titles.scheduled")
        : post.status === "failed"
          ? t("editor.titles.failed")
          : t("editor.titles.draft")
      : t("editor.titles.new");

  const accountsLabel = chosen.map((a) => `${platformInfo(a.platform).label} · ${a.name}`).join(", ");

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup className="flex max-h-[min(820px,94svh)] w-[min(1040px,calc(100vw-16px))] flex-col overflow-hidden p-0">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-t-border-light pr-2 pl-4">
              <Dialog.Title className="flex-1 text-[14px] font-semibold">{title}</Dialog.Title>
              {post?.scheduled_for && !readOnly && (
                <span className="text-[12px] text-t-text-tertiary tabular-nums">
                  {formatMoment(new Date(post.scheduled_for), timeZone)}
                </span>
              )}
              <Dialog.Close
                render={
                  <LightIconButton aria-label={t("common:close")}>
                    <IconX size={16} />
                  </LightIconButton>
                }
              />
            </div>

            {readOnly ? (
              <PublishedView post={post!} timeZone={timeZone} brand={brand} accounts={accounts} />
            ) : (
              <div
                className="flex min-h-0 flex-1 flex-col md:flex-row"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) {
                    event.preventDefault();
                    void save("draft");
                  }
                }}
              >
                {/* The editor */}
                <div
                  className={cn(
                    "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:border-r md:border-t-border-light",
                    dragging && "bg-[var(--t-color-blue2)]",
                  )}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("Files")) return;
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget === event.target) setDragging(false);
                  }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.files.length) return;
                    event.preventDefault();
                    setDragging(false);
                    void addFiles(event.dataTransfer.files);
                  }}
                >
                  {/* Accounts */}
                  <section className="flex flex-col gap-2 border-b border-t-border-light px-4 py-3">
                    <span className="text-[12px] font-medium text-t-text-tertiary">{t("editor.postOn")}</span>
                    {accounts.length === 0 ? (
                      <p className="text-t-text-secondary">
                        <Trans
                          t={t}
                          i18nKey="editor.noAccount"
                          components={{
                            link: (
                              <Link
                                to={`/social/${brand.id}/brand`}
                                onClick={onClose}
                                className="font-medium text-t-text underline underline-offset-2"
                              />
                            ),
                          }}
                        />
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {accounts.map((account) => {
                          const on = selected.includes(account.id);
                          return (
                            <button
                              key={account.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggle(account.id)}
                              className={cn(
                                "flex h-9 items-center gap-2 rounded-full border py-1 pr-3 pl-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                on
                                  ? "border-[var(--t-color-blue7)] bg-[var(--t-color-blue3)] text-t-text"
                                  : "border-t-border text-t-text-tertiary opacity-70 hover:opacity-100",
                              )}
                            >
                              <AccountAvatar
                                avatar={account.avatar}
                                platform={account.platform}
                                name={account.name}
                                size={26}
                                className={cn(!on && "grayscale")}
                              />
                              <span className="max-w-[160px] truncate text-[13px]">{account.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Text tabs: the shared text, and one per account once customized */}
                  <section className="flex flex-1 flex-col px-4 pt-3 pb-3">
                    <div className="flex flex-wrap items-center gap-1 pb-2">
                      <TabButton active={tab === "all"} onClick={() => setTab("all")}>
                        {chosen.length > 1 ? t("editor.tabs.all") : t("editor.tabs.text")}
                      </TabButton>
                      {chosen.length > 1 &&
                        chosen.map((account) => (
                          <TabButton
                            key={account.id}
                            active={tab === account.id}
                            onClick={() => setTab(account.id)}
                            muted={custom[account.id] === undefined}
                          >
                            <PlatformGlyph platform={account.platform} size={12} />
                            {custom[account.id] === undefined
                              ? t("editor.customizeFor", { platform: platformInfo(account.platform).label })
                              : platformInfo(account.platform).label}
                          </TabButton>
                        ))}
                      <div className="flex-1" />
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              size="sm"
                              variant="ghost"
                              startIcon={busy === "rewrite" ? <Loader /> : <IconWand size={14} />}
                              endIcon={<IconChevronDown size={12} />}
                              disabled={!editing.trim() || busy !== null}
                            >
                              {t("editor.rewrite")}
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-52">
                          {REWRITES.map((option) => (
                            <DropdownMenuItem key={option.value} onClick={() => void rewrite(option.value)}>
                              {t(`rewrites.${option.value}`)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        size="sm"
                        variant="ghost"
                        startIcon={<IconSparkles size={14} />}
                        onClick={() =>
                          onAsk(
                            editing.trim()
                              ? activeAccount
                                ? post
                                  ? t("editor.ask.improveDraftFor", { platform: platformInfo(activeAccount.platform).label, id: post.id, text: editing })
                                  : t("editor.ask.improveFor", { platform: platformInfo(activeAccount.platform).label, text: editing })
                                : post
                                  ? t("editor.ask.improveDraft", { id: post.id, text: editing })
                                  : t("editor.ask.improve", { text: editing })
                              : (() => {
                                  const platforms = chosen.length
                                    ? listOf(chosen.map((a) => platformInfo(a.platform).label))
                                    : t("editor.ask.ourAccounts");
                                  return moment
                                    ? t("editor.ask.writeAt", { platforms, time: formatMoment(moment, timeZone) })
                                    : t("editor.ask.write", { platforms });
                                })(),
                          )
                        }
                      >
                        {t("editor.askCopilot")}
                      </Button>
                    </div>

                    {activeAccount && custom[activeAccount.id] === undefined ? (
                      <div className="flex flex-1 flex-col items-start gap-2 rounded-md border border-dashed border-t-border p-4 text-t-text-secondary">
                        <p>{t("editor.usesShared", { platform: platformInfo(activeAccount.platform).label })}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setCustom((current) => ({ ...current, [activeAccount.id]: content }))}
                        >
                          {t("editor.customizeFor", { platform: platformInfo(activeAccount.platform).label })}
                        </Button>
                      </div>
                    ) : (
                      <AutoTextarea
                        value={editing}
                        onChange={setEditing}
                        autoFocus={!post}
                        placeholder={
                          activeAccount
                            ? t("editor.placeholders.version", { platform: platformInfo(activeAccount.platform).label })
                            : t("editor.placeholders.shared")
                        }
                        onPasteFiles={(files) => void addFiles(files)}
                      />
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
                      {chosen.map((account) => {
                        const info = platformInfo(account.platform);
                        const count = countFor(account.platform, textFor(account.id));
                        const over = count > info.limit;
                        return (
                          <span
                            key={account.id}
                            className={cn(
                              "flex items-center gap-1 text-[11px] tabular-nums",
                              over ? "font-medium text-t-text-danger" : "text-t-text-tertiary",
                            )}
                          >
                            <PlatformGlyph platform={account.platform} size={11} />
                            {count.toLocaleString(intlLocale())}/{info.limit.toLocaleString(intlLocale())}
                          </span>
                        );
                      })}
                      <div className="flex-1" />
                      {undo && (
                        <button
                          type="button"
                          onClick={() => {
                            if (undo.tab === "all") setContent(undo.text);
                            else setCustom((current) => ({ ...current, [undo.tab]: undo.text }));
                            setTab(undo.tab);
                            setUndo(null);
                          }}
                          className="flex items-center gap-1 text-[12px] text-t-text-secondary hover:text-t-text"
                        >
                          <IconArrowBackUp size={13} /> {t("editor.undoRewrite")}
                        </button>
                      )}
                      {activeAccount && custom[activeAccount.id] !== undefined && (
                        <button
                          type="button"
                          onClick={() =>
                            setCustom((current) => {
                              const next = { ...current };
                              delete next[activeAccount.id];
                              return next;
                            })
                          }
                          className="text-[12px] text-t-text-secondary hover:text-t-text"
                        >
                          {t("editor.useShared")}
                        </button>
                      )}
                    </div>

                    {problems.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {[...new Set(problems)].map((problem) => (
                          <li key={problem} className="flex items-start gap-1.5 text-[12px] text-[var(--t-color-amber11)]">
                            <IconAlertTriangle size={13} className="mt-px shrink-0" />
                            {problem}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* Media */}
                  <section className="flex flex-col gap-2 border-t border-t-border-light px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-[12px] font-medium text-t-text-tertiary">{t("editor.media.title")}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        startIcon={<IconPhoto size={14} />}
                        onClick={() => fileInput.current?.click()}
                      >
                        {t("editor.media.add")}
                      </Button>
                      <input
                        ref={fileInput}
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        hidden
                        onChange={(event) => {
                          if (event.target.files) void addFiles(event.target.files);
                          event.target.value = "";
                        }}
                      />
                    </div>
                    {media.length === 0 && uploading === 0 ? (
                      <p className="text-[12px] text-t-text-light">{t("editor.media.empty")}</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {media.map((item) => (
                          <div
                            key={item.url}
                            className="group relative size-20 overflow-hidden rounded-md border border-t-border bg-t-secondary"
                          >
                            <MediaThumb media={item} />
                            <button
                              type="button"
                              aria-label={t("common:remove")}
                              onClick={() => setMedia((current) => current.filter((m) => m.url !== item.url))}
                              className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              <IconX size={12} />
                            </button>
                          </div>
                        ))}
                        {Array.from({ length: uploading }, (_, i) => (
                          <div
                            key={`up-${i}`}
                            className="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-t-border text-[11px] text-t-text-tertiary"
                          >
                            <Loader />
                            {t("editor.media.uploading")}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* When */}
                  <section className="flex flex-col gap-2 border-t border-t-border-light px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-[12px] font-medium text-t-text-tertiary">{t("editor.when.title")}</span>
                      <span className="text-[11px] text-t-text-light">
                        {timeZone} ({zoneLabel(timeZone)})
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="date"
                        aria-label={t("editor.when.date")}
                        value={day}
                        min={today}
                        onChange={(event) => {
                          setDay(event.target.value);
                          if (event.target.value && !time) setTime("09:00");
                        }}
                        className="h-8 rounded-md border border-t-border bg-t-primary px-2 text-t-text tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <input
                        type="time"
                        aria-label={t("editor.when.time")}
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
                        className="h-8 rounded-md border border-t-border bg-t-primary px-2 text-t-text tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      {quickPicks.map((pick) => (
                        <button
                          key={pick.label}
                          type="button"
                          onClick={() => {
                            setDay(pick.day);
                            setTime(pick.time);
                          }}
                          className="h-7 rounded-full border border-t-border px-2.5 text-[12px] text-t-text-secondary hover:bg-t-hover hover:text-t-text"
                        >
                          {pick.label}
                        </button>
                      ))}
                      {(day || time) && (
                        <button
                          type="button"
                          onClick={() => {
                            setDay("");
                            setTime("");
                          }}
                          className="text-[12px] text-t-text-tertiary hover:text-t-text"
                        >
                          {t("editor.when.noDate")}
                        </button>
                      )}
                    </div>
                  </section>
                </div>

                {/* The preview */}
                <aside className="flex max-h-[40svh] min-h-0 flex-col overflow-y-auto bg-t-secondary/60 md:max-h-none md:w-[400px] md:shrink-0">
                  <div className="sticky top-0 z-10 bg-t-secondary/95 px-4 pt-3 pb-2 text-[12px] font-medium text-t-text-tertiary backdrop-blur">
                    {t("editor.preview.title")}
                  </div>
                  <div className="flex flex-col gap-3 px-4 pb-4">
                    {chosen.length === 0 ? (
                      <p className="text-[12px] text-t-text-light">{t("editor.preview.empty")}</p>
                    ) : (
                      chosen.map((account) => (
                        <PreviewCard
                          key={account.id}
                          account={account}
                          text={textFor(account.id)}
                          media={media}
                          when={moment}
                          timeZone={timeZone}
                        />
                      ))
                    )}
                  </div>
                </aside>
              </div>
            )}

            {/* Footer */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-t-border-light px-4 py-2.5">
              {error && (
                <p className="flex w-full items-start gap-1.5 pb-1 text-t-text-danger">
                  <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {error}
                </p>
              )}
              {confirm === "publish" ? (
                <>
                  <span className="min-w-0 flex-1 text-t-text">
                    <Trans
                      t={t}
                      i18nKey="editor.confirmPublish"
                      values={{ accounts: accountsLabel }}
                      components={{ b: <span className="font-medium" /> }}
                    />
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)} disabled={busy !== null}>
                    {t("common:cancel")}
                  </Button>
                  <Button size="sm" variant="solid" color="accent" loading={busy === "publish"} onClick={() => void save("publish")}>
                    {t("editor.publishNow")}
                  </Button>
                </>
              ) : confirm === "delete" ? (
                <>
                  <span className="min-w-0 flex-1 text-t-text">
                    {post?.source === "imported"
                      ? t("editor.confirmRemoveImported")
                      : t("editor.confirmDelete")}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)} disabled={busy !== null}>
                    {t("common:cancel")}
                  </Button>
                  <Button size="sm" variant="solid" color="danger" loading={busy === "delete"} onClick={() => void remove()}>
                    {t("common:delete")}
                  </Button>
                </>
              ) : readOnly ? (
                <>
                  {post?.source === "imported" && (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm("delete")} disabled={busy !== null}>
                      {t("editor.removeFromRichelieu")}
                    </Button>
                  )}
                  <div className="flex-1" />
                  {post && (post.status === "partial" || post.platforms.some((p) => p.status === "failed")) && (
                    <Button
                      size="sm"
                      variant="outline"
                      startIcon={<IconRefresh size={14} />}
                      loading={busy === "retry"}
                      onClick={() => void retry()}
                    >
                      {t("editor.retryFailed")}
                    </Button>
                  )}
                  <Button size="sm" variant="solid" color="neutral" onClick={onClose}>
                    {t("common:close")}
                  </Button>
                </>
              ) : (
                <>
                  {post && (
                    <LightIconButton
                      aria-label={t("editor.deletePost")}
                      tooltip={t("common:delete")}
                      onClick={() => setConfirm("delete")}
                      disabled={busy !== null}
                    >
                      <IconTrash size={16} />
                    </LightIconButton>
                  )}
                  {post?.status === "failed" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      startIcon={<IconRefresh size={14} />}
                      loading={busy === "retry"}
                      onClick={() => void retry()}
                    >
                      {t("common:retry")}
                    </Button>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-t-text-tertiary">
                    {scheduleBlocker && moment ? scheduleBlocker : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirm("publish")}
                    disabled={busy !== null || publishBlocker !== null}
                  >
                    {t("editor.publishNow")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy === "draft"}
                    disabled={busy !== null || uploading > 0}
                    onClick={() => void save("draft")}
                    shortcut={["Mod", "Enter"]}
                  >
                    {t("editor.saveDraft")}
                  </Button>
                  <Button
                    size="sm"
                    variant="solid"
                    color="accent"
                    loading={busy === "schedule"}
                    disabled={busy !== null || scheduleBlocker !== null}
                    onClick={() => void save("schedule")}
                    title={scheduleBlocker ?? undefined}
                  >
                    {post?.status === "scheduled" ? t("editor.updateSchedule") : t("editor.schedule")}
                  </Button>
                </>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TabButton({
  active,
  muted = false,
  onClick,
  children,
}: {
  active: boolean;
  muted?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-t-tertiary font-medium text-t-text" : "text-t-text-secondary hover:bg-t-hover hover:text-t-text",
        muted && !active && "text-t-text-tertiary",
      )}
    >
      {children}
    </button>
  );
}

/** A textarea that grows with its text. */
function AutoTextarea({
  value,
  onChange,
  placeholder,
  autoFocus,
  onPasteFiles,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onPasteFiles: (files: File[]) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(180, element.scrollHeight)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => {
        const files = [...event.clipboardData.files].filter(isMediaFile);
        if (files.length) {
          event.preventDefault();
          onPasteFiles(files);
        }
      }}
      className="min-h-[180px] w-full resize-none rounded-md border border-t-border bg-t-primary px-3 py-2.5 text-[14px] leading-[1.55] text-t-text outline-none placeholder:text-t-text-light focus-visible:border-[var(--t-color-blue8)] focus-visible:ring-2 focus-visible:ring-[var(--t-color-blue5)]"
    />
  );
}

function MediaThumb({ media, className }: { media: Media; className?: string }) {
  if (media.type === "video")
    return (
      <span className={cn("relative block size-full", className)}>
        <video src={media.url} muted playsInline preload="metadata" className="size-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-7 items-center justify-center rounded-full bg-black/55 text-white">
            <IconPlayerPlayFilled size={13} />
          </span>
        </span>
      </span>
    );
  return <img src={media.url} alt="" className={cn("size-full object-cover", className)} />;
}

/** Media laid out as feeds do: one full width, two side by side, more in a grid of four. */
function MediaGrid({ media }: { media: Media[] }) {
  if (media.length === 0) return null;
  const shown = media.slice(0, 4);
  return (
    <div
      className={cn(
        "grid gap-0.5 overflow-hidden rounded-md border border-t-border-light",
        shown.length === 1 ? "grid-cols-1" : "grid-cols-2",
      )}
    >
      {shown.map((item, index) => (
        <div
          key={item.url}
          className={cn(
            "relative bg-t-tertiary",
            shown.length === 1 ? "aspect-[4/3]" : "aspect-square",
            shown.length === 3 && index === 0 && "row-span-2 aspect-auto",
          )}
        >
          <MediaThumb media={item} />
          {index === 3 && media.length > 4 && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[18px] font-semibold text-white">
              +{media.length - 4}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Where each platform folds a long post. */
const FOLD: Record<string, number> = { linkedin: 210, instagram: 125, facebook: 480 };

/** A post as it will look in a feed: neutral, with the platform's glyph and its fold. */
function PreviewCard({
  account,
  text,
  media,
  when,
  timeZone,
}: {
  account: SocialAccount;
  text: string;
  media: Media[];
  when: Date | null;
  timeZone: string;
}) {
  const { t } = useTranslation(["social", "common"]);
  const [expanded, setExpanded] = useState(false);
  const fold = FOLD[account.platform];
  const folded = fold !== undefined && !expanded && text.length > fold;
  const shown = folded ? text.slice(0, fold).trimEnd() : text;
  const mediaFirst = account.platform === "instagram" || account.platform === "tiktok" || account.platform === "youtube";
  const handle = account.username.includes(" ") ? account.username : `@${account.username.replace(/^@/, "")}`;
  return (
    <article className="overflow-hidden rounded-lg border border-t-border bg-t-primary shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center gap-2.5 px-3 pt-3">
        <AccountAvatar avatar={account.avatar} platform={account.platform} name={account.name} size={34} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-semibold text-t-text">{account.name}</div>
          <div className="truncate text-[11px] text-t-text-tertiary">
            {handle} · {when ? formatMoment(when, timeZone) : t("editor.titles.draft")}
          </div>
        </div>
        <PlatformGlyph platform={account.platform} size={14} className="text-t-text-light" />
      </header>
      <div className="flex flex-col gap-2.5 px-3 pt-2.5 pb-3">
        {mediaFirst && <MediaGrid media={media} />}
        {text.trim() ? (
          <p className="text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-t-text">
            {shown}
            {folded && (
              <>
                …{" "}
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="text-t-text-tertiary hover:text-t-text-secondary"
                >
                  {t("editor.preview.seeMore")}
                </button>
              </>
            )}
          </p>
        ) : (
          <p className="text-[13px] text-t-text-light italic">{t("editor.preview.noText")}</p>
        )}
        {!mediaFirst && <MediaGrid media={media} />}
      </div>
    </article>
  );
}

/** A published (or publishing) post: what went out, where, and what failed. */
function PublishedView({
  post,
  timeZone,
  brand,
  accounts,
}: {
  post: SocialPost;
  timeZone: string;
  brand: Brand;
  accounts: SocialAccount[];
}) {
  const { t } = useTranslation(["social", "common"]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4">
        {post.published_at && (
          <p className="text-[12px] text-t-text-tertiary tabular-nums">
            {t(post.source === "imported" ? "editor.published.atImported" : "editor.published.at", {
              time: formatMoment(new Date(post.published_at), timeZone),
              zone: timeZone,
            })}
          </p>
        )}
        {post.metrics && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-t-text-secondary tabular-nums">
            {(
              [
                ["views", post.metrics.views],
                ["likes", post.metrics.likes],
                ["comments", post.metrics.comments],
                ["shares", post.metrics.shares],
              ] as const
            )
              .filter(([, value]) => value !== null)
              .map(([label, value]) => (
                <span key={label}>
                  <span className="font-semibold text-t-text">{value!.toLocaleString(intlLocale())}</span>{" "}
                  {t(`editor.published.metrics.${label}`, { count: value! })}
                </span>
              ))}
          </div>
        )}
        <p className="text-[14px] leading-[1.55] whitespace-pre-wrap text-t-text">{post.content || t("editor.published.noText")}</p>
        {post.media.length > 0 && (
          <div className="max-w-[420px]">
            <MediaGrid media={post.media} />
          </div>
        )}
      </div>
      <aside className="flex flex-col gap-2 border-t border-t-border-light bg-t-secondary/60 px-4 py-4 md:w-[340px] md:shrink-0 md:border-t-0 md:border-l">
        <span className="text-[12px] font-medium text-t-text-tertiary">{t("editor.published.accounts")}</span>
        {post.platforms.map((platform) => {
          const account = accounts.find((a) => a.id === platform.account_id);
          const failed = platform.status === "failed";
          return (
            <div
              key={`${platform.platform}:${platform.account_id}`}
              className="flex flex-col gap-1 rounded-md border border-t-border bg-t-primary px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <AccountAvatar
                  avatar={platform.avatar ?? account?.avatar ?? null}
                  platform={platform.platform}
                  name={platform.username || brand.name}
                  size={24}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-t-text">
                  {platform.username || platformInfo(platform.platform).label}
                </span>
                <span
                  className={cn(
                    "text-[11px] capitalize",
                    failed ? "text-t-text-danger" : platform.status === "published" ? "text-[var(--t-color-green11)]" : "text-t-text-tertiary",
                  )}
                >
                  {platform.status === null
                    ? "—"
                    : (PLATFORM_STATUSES as readonly string[]).includes(platform.status)
                      ? t(`platformStatus.${platform.status as (typeof PLATFORM_STATUSES)[number]}`)
                      : platform.status}
                </span>
              </div>
              {platform.url && (
                <a
                  href={platform.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[12px] text-t-text-secondary hover:text-t-text"
                >
                  <IconExternalLink size={12} /> {t("editor.published.seeOn", { platform: platformInfo(platform.platform).label })}
                </a>
              )}
              {platform.error && <p className="text-[12px] text-t-text-danger">{platform.error}</p>}
            </div>
          );
        })}
      </aside>
    </div>
  );
}
