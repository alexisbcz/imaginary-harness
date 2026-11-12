// Writing a post, alone or with the AI: a title, a subtitle and the rich editor, which edits Substack's own document
// (paywall, buttons, YouTube, images uploaded to Substack), and a preview of what readers get. Saves itself to
// Substack as you type. The AI rewrites a selection, writes on from the cursor, turns an outline into a
// draft, proposes titles and reviews the draft, and each of its changes waits for Accept. Publishing and
// scheduling ask first; published posts open read-only, with their comments.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { useTranslation } from "react-i18next";
import { LightIconButton, SegmentedControl } from "twenty-ui/components/input";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input, Switch, Textarea } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBold,
  IconBrandYoutube,
  IconBulb,
  IconChevronDown,
  IconClick,
  IconClock,
  IconExternalLink,
  IconH2,
  IconH3,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconLock,
  IconMessageCircle,
  IconPhoto,
  IconQuote,
  IconSend,
  IconSeparatorHorizontal,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconUserPlus,
  IconWand,
  IconX,
} from "@tabler/icons-react";

import type { Editor } from "@tiptap/core";
import { Markdown } from "@/components/markdown";
import { RichEditor, type RichEditorHandle } from "@/components/rich-editor/rich-editor";
import { markdownToTiptap, tiptapToMarkdown } from "@/components/rich-editor/substack";
import { PostPreview } from "@/components/newsletter/preview";
import { SimpleSelect } from "@/components/simple-select";
import { intlLocale } from "@/lib/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ASSIST_ACTIONS,
  AUDIENCES,
  assist,
  audienceLabel,
  checkPost,
  deleteDraft,
  formatMoment,
  fromLocalInput,
  getComments,
  getPost,
  markdownToDoc,
  publishPost,
  saveDraft,
  schedulePost,
  toLocalInput,
  unschedulePost,
  uploadImage,
  wordCount,
  type Audience,
  type Newsletter,
  type PostDetail,
  type SubstackComment,
} from "@/lib/newsletter";

type View = "edit" | "preview";
type SaveState = "saved" | "dirty" | "saving" | "error";
type Fields = { title: string; subtitle: string; markdown: string };

/** An AI change waiting for the writer's word. */
type Proposal =
  | { kind: "replace"; label: string; from: number; to: number; original: string; text: string }
  | { kind: "insert"; label: string; at: number; text: string }
  | { kind: "document"; label: string; text: string }
  | { kind: "titles"; titles: { title: string; subtitle: string }[] }
  | { kind: "feedback"; text: string };

const SAVE_DELAY_MS = 1200;

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup className={cn("flex max-h-[90svh] flex-col overflow-hidden p-0", wide ? "w-[min(720px,calc(100vw-16px))]" : "w-[min(480px,calc(100vw-16px))]")}>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-t-border-light pr-2 pl-4">
              <Dialog.Title className="flex-1 text-[14px] font-semibold">{title}</Dialog.Title>
              <Dialog.Close render={<LightIconButton aria-label={t("close")}><IconX size={16} /></LightIconButton>} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
            {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-t-border-light px-4 py-3">{footer}</div>}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-t-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-t-text-light">{hint}</span>}
    </label>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A post's audience as a known value, to pick its phrase in a sentence ("to paid subscribers"). */
const knownAudience = (value: string) => AUDIENCES.find((a) => a.value === value)?.value;

// Published posts ------------------------------------------------------------------------------------------------

function Comment({ comment, depth = 0 }: { comment: SubstackComment; depth?: number }) {
  return (
    <li className={cn("flex flex-col gap-1", depth > 0 && "border-l border-t-border-light pl-3")}>
      <div className="flex items-center gap-2 text-[12px]">
        {comment.photo_url && <img src={comment.photo_url} alt="" className="size-5 rounded-full" />}
        <span className="font-medium text-t-text">{comment.name}</span>
        <span className="text-t-text-tertiary">{comment.date ? new Date(comment.date).toLocaleDateString(intlLocale()) : ""}</span>
        {comment.reactions > 0 && <span className="text-t-text-tertiary">· {comment.reactions} ♥</span>}
      </div>
      <p className="leading-[1.5] whitespace-pre-wrap text-t-text-secondary">{comment.body}</p>
      {comment.children.length > 0 && (
        <ul className="mt-2 flex flex-col gap-3">
          {comment.children.map((child) => (
            <Comment key={child.id} comment={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function PublishedPost({ newsletter, post, onAsk }: { newsletter: Newsletter; post: PostDetail; onAsk: (message: string) => void }) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [comments, setComments] = useState<SubstackComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getComments(newsletter.id, post.id).then(setComments, (e) => setError(errorText(e)));
  }, [newsletter.id, post.id]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-2 px-6 pt-5 text-[12px] text-t-text-tertiary">
        <span>{t("editor.published.meta", { time: formatMoment(post.post_date, newsletter.timezone), audience: audienceLabel(post.audience) })}</span>
        <span className="flex-1" />
        <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() => onAsk(t("editor.published.learnPrompt", { id: post.id, title: post.title }))}>
          {t("editor.published.learn")}
        </Button>
        <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() => onAsk(t("editor.published.notesPrompt", { id: post.id, title: post.title }))}>
          {t("editor.published.notes")}
        </Button>
        {post.url && (
          <Button size="sm" variant="outline" startIcon={<IconExternalLink size={14} />} render={<a href={post.url} target="_blank" rel="noreferrer" />}>
            {t("posts.openOnSubstack")}
          </Button>
        )}
      </div>
      <p className="mx-auto max-w-[760px] px-6 pt-2 text-[12px] text-t-text-light">
        {t("editor.published.readOnly")}
      </p>
      <PostPreview
        doc={markdownToDoc(post.markdown)}
        title={post.title}
        subtitle={post.subtitle}
        author={newsletter.substack_user_name}
        publication={newsletter.name}
        coverImage={post.cover_image}
      />
      <section className="mx-auto max-w-[680px] px-6 pb-10">
        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-t-text">
          <IconMessageCircle size={16} /> {t("editor.published.comments")}
        </h2>
        {error ? (
          <p className="text-t-text-danger">{error}</p>
        ) : comments === null ? (
          <Loader />
        ) : comments.length === 0 ? (
          <p className="text-t-text-tertiary">{t("editor.published.noComments")}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {comments.map((c) => (
              <Comment key={c.id} comment={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// The editor -----------------------------------------------------------------------------------------------------

/** The AI's actions, in the menu over a selection: kept open inside the menu, so the selection stays. */
function AiBubble({ onRun, onCustom, busy }: { onRun: (action: string) => void; onCustom: () => void; busy: boolean }) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-[var(--t-color-purple10)] transition-colors hover:bg-t-hover",
          open && "bg-t-hover",
        )}
      >
        {busy ? <Loader /> : <IconSparkles size={15} />} {t("assist.ai")} <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="rich-pop absolute top-full right-0 z-40 mt-2 w-56 rounded-xl border border-t-border bg-t-primary p-1 shadow-2xl">
          {ASSIST_ACTIONS.map((action) => (
            <button
              key={action.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onRun(action.value);
              }}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] text-t-text hover:bg-t-hover"
            >
              {t(`assist.actions.${action.value}`)}
            </button>
          ))}
          <div className="my-1 h-px bg-t-border-light" />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpen(false);
              onCustom();
            }}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] text-t-text hover:bg-t-hover"
          >
            {t("assist.custom")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The selection's content as Markdown, and what it reads as, to find it again. */
function selectionOf(editor: Editor) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const markdown = tiptapToMarkdown({ type: "doc", content: editor.state.doc.slice(from, to).content.toJSON() });
  return { from, to, text: editor.state.doc.textBetween(from, to, "\n"), markdown };
}

/** Markdown as content to insert: a lone paragraph goes in as its text, so it stays inline. */
function insertable(markdown: string) {
  const content = markdownToTiptap(markdown).content ?? [];
  return content.length === 1 && content[0]!.type === "paragraph" ? (content[0]!.content ?? []) : content;
}

export function PostEditor({
  newsletter,
  postId,
  revision,
  onBack,
  onAsk,
  onChanged,
}: {
  newsletter: Newsletter;
  postId: number;
  /** Changes when the copilot may have edited the post. */
  revision: string;
  onBack: () => void;
  onAsk: (message: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [post, setPost] = useState<PostDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({ title: "", subtitle: "", markdown: "" });
  // Remounts the editor on content that comes from elsewhere (a load, the copilot, the AI's whole-post drafts).
  const [generation, setGeneration] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [view, setView] = useState<View>("edit");
  const [busy, setBusy] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [dialog, setDialog] = useState<null | "publish" | "schedule" | "settings" | "delete" | "custom">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rich = useRef<RichEditorHandle>(null);
  const revisionRef = useRef<string | null>(null);
  const timer = useRef<Timer | undefined>(undefined);
  const latest = useRef(fields);
  latest.current = fields;
  const saving = useRef<Promise<void> | null>(null);
  const saveRef = useRef<SaveState>("saved");
  saveRef.current = save;
  // The selection an AI action was asked about, kept while the menu that asks takes the focus.
  const pendingSelection = useRef<ReturnType<typeof selectionOf>>(null);

  const adopt = useCallback((loaded: PostDetail) => {
    setPost(loaded);
    revisionRef.current = loaded.revision;
    setFields({ title: loaded.title, subtitle: loaded.subtitle, markdown: loaded.markdown });
    setGeneration((g) => g + 1);
    setSave("saved");
    setConflict(false);
  }, []);

  // Loads the post; when the copilot may have changed it, again, unless the writer has unsaved changes.
  useEffect(() => {
    let active = true;
    getPost(newsletter.id, postId).then(
      (loaded) => {
        if (!active) return;
        // Our own last save: nothing new.
        if (revisionRef.current && loaded.revision === revisionRef.current) return;
        const state = saveRef.current;
        if (state === "dirty" || state === "saving" || state === "error") {
          setConflict(true);
          return;
        }
        adopt(loaded);
      },
      (e) => active && setLoadError(errorText(e)),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsletter.id, postId, revision, adopt]);

  const flush = useCallback(
    async (force = false) => {
      clearTimeout(timer.current);
      if (saving.current) await saving.current;
      const snapshot = latest.current;
      setSave("saving");
      const run = (async () => {
        try {
          const saved = await saveDraft(newsletter.id, postId, {
            title: snapshot.title,
            subtitle: snapshot.subtitle,
            markdown: snapshot.markdown,
            revision: force ? null : revisionRef.current,
          });
          revisionRef.current = saved.revision;
          setPost(saved);
          setSaveError(null);
          setConflict(false);
          // Typed meanwhile: still dirty.
          setSave(latest.current === snapshot ? "saved" : "dirty");
          onChanged();
        } catch (e) {
          const message = errorText(e);
          if (/changed since you opened it/.test(message)) setConflict(true);
          setSaveError(message);
          setSave("error");
        }
      })();
      saving.current = run;
      await run;
      saving.current = null;
    },
    [newsletter.id, postId, onChanged],
  );

  const editable = post !== null && post.state !== "published";

  function change(next: Partial<Fields>) {
    if (!editable) return;
    setFields((current) => {
      const merged = { ...current, ...next };
      latest.current = merged;
      return merged;
    });
    setSave("dirty");
    clearTimeout(timer.current);
    if (!conflict) timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  // Saves before leaving, and warns when it cannot.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (save === "dirty" || save === "saving" || save === "error") event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // ⌘S saves now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  const doc = useMemo(() => markdownToDoc(fields.markdown), [fields.markdown]);
  const initialContent = useMemo(() => markdownToTiptap(fields.markdown), [generation]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDocument = (markdown: string) => {
    change({ markdown });
    setGeneration((g) => g + 1);
  };

  // The AI ---------------------------------------------------------------------------------------------------

  async function runAssist(action: string, options: { instruction?: string; label?: string } = {}) {
    const editor = rich.current?.editor;
    if (!editor) return;
    const selected = pendingSelection.current ?? selectionOf(editor);
    pendingSelection.current = null;
    const known = ASSIST_ACTIONS.find((a) => a.value === action);
    const label = options.label ?? (known ? t(`assist.actions.${known.value}`) : t("assist.ai"));
    setBusy(`ai:${action}`);
    setNotice(null);
    try {
      let text = fields.markdown;
      let after: string | undefined;
      if (action === "continue") {
        const at = editor.state.selection.to;
        const $at = editor.state.doc.resolve(at);
        const end = $at.depth >= 1 ? $at.after(1) : at;
        text = tiptapToMarkdown({ type: "doc", content: editor.state.doc.slice(0, end).content.toJSON() });
        after = tiptapToMarkdown({ type: "doc", content: editor.state.doc.slice(end).content.toJSON() });
        const result = await assist(newsletter.id, { action: "continue", text, after, title: fields.title, subtitle: fields.subtitle });
        if (result.kind !== "titles") setProposal({ kind: "insert", label: t("assist.continue"), at: end, text: result.text });
        return;
      }
      if (selected && !["expand", "titles", "review"].includes(action)) text = selected.markdown;
      const result = await assist(newsletter.id, {
        action: action as never,
        text,
        instruction: options.instruction,
        title: fields.title,
        subtitle: fields.subtitle,
      });
      if (result.kind === "titles") setProposal({ kind: "titles", titles: result.titles });
      else if (result.kind === "feedback") setProposal({ kind: "feedback", text: result.text });
      else if (result.kind === "document") setProposal({ kind: "document", label, text: result.text });
      else if (result.kind === "replace")
        setProposal(
          selected
            ? { kind: "replace", label, from: selected.from, to: selected.to, original: selected.text, text: result.text }
            : { kind: "document", label, text: result.text },
        );
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  function accept() {
    const editor = rich.current?.editor;
    if (!proposal || !editor) return;
    if (proposal.kind === "replace") {
      // The text may have moved while the AI wrote: replace it only where it still is.
      const size = editor.state.doc.content.size;
      const still = proposal.to <= size && editor.state.doc.textBetween(proposal.from, proposal.to, "\n") === proposal.original;
      if (!still) {
        setNotice(t("assist.passageChanged"));
        return;
      }
      editor.chain().focus().insertContentAt({ from: proposal.from, to: proposal.to }, insertable(proposal.text)).run();
    } else if (proposal.kind === "insert") {
      const at = Math.min(proposal.at, editor.state.doc.content.size);
      editor.chain().focus().insertContentAt(at, markdownToTiptap(proposal.text).content ?? []).run();
    } else if (proposal.kind === "document") setDocument(proposal.text);
    setProposal(null);
  }

  // Render ---------------------------------------------------------------------------------------------------

  if (loadError)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-t-text-danger">{loadError}</p>
        <Button size="sm" variant="outline" onClick={onBack}>{t("editor.back")}</Button>
      </div>
    );
  if (!post)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader />
      </div>
    );

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-t-border-light px-2">
      <LightIconButton aria-label={t("editor.back")} tooltip={t("editor.back")} onClick={async () => {
        if (save === "dirty") await flush();
        onBack();
      }}>
        <IconArrowLeft size={16} />
      </LightIconButton>
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-t-text-tertiary tabular-nums">
        <span
          className={cn(
            "size-1.5 rounded-full",
            post.state === "published" ? "bg-[var(--t-color-green9)]" : post.state === "scheduled" ? "bg-[var(--t-color-blue9)]" : "bg-[var(--t-color-gray8)]",
          )}
        />
        {post.state === "published"
          ? t("editor.state.published")
          : post.state === "scheduled"
            ? t("editor.state.scheduled", { time: formatMoment(post.scheduled_for, newsletter.timezone) })
            : t("editor.state.draft")}
        {editable && (
          <>
            {" · "}
            {save === "saving" ? (
              t("common:saving")
            ) : save === "dirty" ? (
              t("editor.save.dirty")
            ) : save === "error" ? (
              <span className="text-t-text-danger">{t("editor.save.error")}</span>
            ) : (
              t("editor.save.saved")
            )}
          </>
        )}
      </span>
      <span className="flex-1" />
      {editable && (
        <>
          <SegmentedControl<View>
            aria-label={t("editor.view.label")}
            size="sm"
            value={view}
            onValueChange={setView}
            options={[
              { value: "edit", label: t("editor.view.edit") },
              { value: "preview", label: t("editor.view.preview") },
            ]}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="sm" variant="ghost" startIcon={busy?.startsWith("ai:") ? <Loader /> : <IconWand size={14} />} endIcon={<IconChevronDown size={12} />} disabled={busy !== null}>
                  {t("assist.ai")}
                </Button>
              }
              onMouseDown={() => {
                const editor = rich.current?.editor;
                pendingSelection.current = editor ? selectionOf(editor) : null;
              }}
            />
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 py-1 text-[11px] text-t-text-tertiary">{t("assist.onSelection")}</div>
              {ASSIST_ACTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => void runAssist(option.value)}>
                  {t(`assist.actions.${option.value}`)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => setDialog("custom")}>{t("assist.custom")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void runAssist("continue", { label: t("assist.continue") })}>{t("assist.continueFromCursor")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void runAssist("expand", { label: t("assist.expand") })}>{t("assist.expandMenu")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void runAssist("titles")}>{t("assist.titles")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void runAssist("review")}>{t("assist.review")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAsk(t("assist.copilotPrompt", { id: post.id, title: fields.title || t("common:untitled") }))}>
                {t("assist.copilot")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <LightIconButton aria-label={t("editor.settings.label")} tooltip={t("editor.settings.tooltip")} onClick={() => setDialog("settings")}>
            <IconSettings size={16} />
          </LightIconButton>
          {post.state === "scheduled" && post.scheduled_by === "richelieu" ? (
            <Button size="sm" variant="outline" onClick={async () => {
              setBusy("unschedule");
              try {
                await unschedulePost(newsletter.id, post.id);
                adopt(await getPost(newsletter.id, post.id));
                onChanged();
              } catch (e) {
                setNotice(errorText(e));
              } finally {
                setBusy(null);
              }
            }} loading={busy === "unschedule"}>
              {t("notes.unschedule")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" startIcon={<IconClock size={14} />} onClick={() => setDialog("schedule")}>
              {t("notes.schedule")}
            </Button>
          )}
          <Button size="sm" variant="solid" color="accent" startIcon={<IconSend size={14} />} onClick={async () => {
            if (save !== "saved") await flush();
            setDialog("publish");
          }}>
            {t("notes.publish")}
          </Button>
        </>
      )}
    </div>
  );

  if (!editable)
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="min-h-0 flex-1">
          <PublishedPost newsletter={newsletter} post={post} onAsk={onAsk} />
        </div>
      </div>
    );

  const serif = { fontFamily: "Georgia, 'Iowan Old Style', serif" };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-t-border-light bg-t-secondary px-4 py-2">
          <IconAlertTriangle size={16} className="text-[var(--t-color-orange9)]" />
          <span className="min-w-0 flex-1 text-t-text">{t("editor.conflict.body")}</span>
          <Button size="sm" variant="outline" onClick={async () => adopt(await getPost(newsletter.id, post.id))}>
            {t("editor.conflict.theirs")}
          </Button>
          <Button size="sm" variant="solid" color="accent" onClick={() => void flush(true)}>
            {t("editor.conflict.mine")}
          </Button>
        </div>
      )}
      {(notice || (saveError && !conflict)) && (
        <div className="flex items-center gap-2 border-b border-t-border-light px-4 py-2 text-t-text-danger">
          <span className="min-w-0 flex-1">{notice ?? saveError}</span>
          {saveError && !notice && <Button size="sm" variant="ghost" onClick={() => void flush()}>{t("common:retry")}</Button>}
          {notice && <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>{t("common:dismiss")}</Button>}
        </div>
      )}
      {post.release_error && (
        <div className="flex items-center gap-2 border-b border-t-border-light px-4 py-2 text-t-text-danger">
          <IconAlertTriangle size={16} /> {t("editor.releaseFailed", { error: post.release_error })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "preview" ? (
          <div className="min-h-full bg-t-secondary/40">
            <PostPreview doc={doc} title={fields.title} subtitle={fields.subtitle} author={newsletter.substack_user_name} publication={newsletter.name} coverImage={post.cover_image} />
          </div>
        ) : (
          <RichEditor
            key={generation}
            ref={rich}
            variant="newsletter"
            initialContent={initialContent}
            onChange={(editor) => {
              // The editor may normalize what it loaded without a change to Substack's document: no save then.
              const markdown = tiptapToMarkdown(editor.getJSON());
              if (markdown !== latest.current.markdown) change({ markdown });
            }}
            uploadImage={(file) => uploadImage(newsletter.id, file, post.id)}
            className="min-h-full"
            contentClassName="mx-auto w-full max-w-[720px] px-6 pb-[30vh] sm:px-12"
            header={
              <div className="mx-auto w-full max-w-[720px] px-6 pt-10 pb-6 sm:px-12">
                <textarea
                  aria-label={t("preview.title")}
                  rows={1}
                  placeholder={t("preview.title")}
                  value={fields.title}
                  onChange={(e) => change({ title: e.target.value.replace(/\n/g, " ") })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                    }
                  }}
                  className="field-sizing-content w-full resize-none bg-transparent text-[34px] leading-[1.15] font-bold tracking-[-0.015em] text-t-text outline-none placeholder:text-t-text-light"
                  style={serif}
                />
                <textarea
                  aria-label={t("editor.subtitle")}
                  rows={1}
                  placeholder={t("editor.subtitlePlaceholder")}
                  value={fields.subtitle}
                  onChange={(e) => change({ subtitle: e.target.value.replace(/\n/g, " ") })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      rich.current?.editor?.commands.focus("start");
                    }
                  }}
                  className="field-sizing-content mt-3 w-full resize-none bg-transparent text-[20px] leading-snug text-t-text-secondary outline-none placeholder:text-t-text-light"
                  style={serif}
                />
                {post.cover_image && <img src={post.cover_image} alt="" className="mt-6 max-h-72 w-full rounded-md object-cover" />}
                <div className="mt-6 flex items-center gap-2 font-sans text-[12px] text-t-text-tertiary">
                  {newsletter.substack_user_name && <span>{newsletter.substack_user_name}</span>}
                  {post.audience !== "everyone" && (
                    <span className="rounded-full bg-[color-mix(in_oklab,#ff6719_14%,transparent)] px-2 py-0.5 font-medium text-[#c2410c]">
                      {audienceLabel(post.audience)}
                    </span>
                  )}
                </div>
              </div>
            }
            bubbleActions={(editor) => (
              <AiBubble
                busy={busy?.startsWith("ai:") ?? false}
                onRun={(action) => {
                  pendingSelection.current = selectionOf(editor);
                  void runAssist(action);
                }}
                onCustom={() => {
                  pendingSelection.current = selectionOf(editor);
                  setDialog("custom");
                }}
              />
            )}
            toolbarEnd={
              <LightIconButton aria-label={t("editor.delete.confirm")} tooltip={t("editor.delete.confirm")} onClick={() => setDialog("delete")}>
                <IconTrash size={15} />
              </LightIconButton>
            }
          />
        )}
      </div>

      {proposal && <ProposalPanel proposal={proposal} onAccept={accept} onDiscard={() => setProposal(null)} onPickTitle={(picked) => {
        change({ title: picked.title, subtitle: picked.subtitle });
        setProposal(null);
      }} />}

      {dialog === "custom" && (
        <PromptDialog
          title={t("assist.customDialog.title")}
          label={t("assist.customDialog.label")}
          placeholder={t("assist.customDialog.placeholder")}
          submit={t("assist.customDialog.submit")}
          onClose={() => setDialog(null)}
          onSubmit={(instruction) => {
            setDialog(null);
            void runAssist("custom", { instruction, label: t("assist.customDialog.proposal") });
          }}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog newsletter={newsletter} post={post} onClose={() => setDialog(null)} onSaved={(saved) => {
          revisionRef.current = saved.revision;
          setPost(saved);
          onChanged();
        }} />
      )}
      {dialog === "schedule" && (
        <ScheduleDialog newsletter={newsletter} post={post} onClose={() => setDialog(null)} onScheduled={async (warnings) => {
          setDialog(null);
          if (warnings.length) setNotice(t("editor.schedule.warnings", { warnings: warnings.join("; ") }));
          adopt(await getPost(newsletter.id, post.id));
          onChanged();
        }} />
      )}
      {dialog === "publish" && (
        <PublishDialog newsletter={newsletter} post={{ ...post, title: fields.title }} onClose={() => setDialog(null)} onPublished={async () => {
          setDialog(null);
          adopt(await getPost(newsletter.id, post.id));
          onChanged();
        }} />
      )}
      {dialog === "delete" && (
        <Modal
          title={t("editor.delete.title")}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>{t("common:cancel")}</Button>
              <Button size="sm" variant="solid" color="danger" loading={busy === "delete"} onClick={async () => {
                setBusy("delete");
                try {
                  clearTimeout(timer.current);
                  await deleteDraft(newsletter.id, post.id);
                  onChanged();
                  onBack();
                } catch (e) {
                  setNotice(errorText(e));
                  setBusy(null);
                  setDialog(null);
                }
              }}>{t("editor.delete.confirm")}</Button>
            </>
          }
        >
          <p className="text-t-text-secondary">{t("editor.delete.body", { title: fields.title || t("common:untitled") })}</p>
        </Modal>
      )}
    </div>
  );
}

// The AI's proposals ---------------------------------------------------------------------------------------------

function ProposalPanel({
  proposal,
  onAccept,
  onDiscard,
  onPickTitle,
}: {
  proposal: Proposal;
  onAccept: () => void;
  onDiscard: () => void;
  onPickTitle: (title: { title: string; subtitle: string }) => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const heading =
    proposal.kind === "titles"
      ? t("assist.proposal.titles")
      : proposal.kind === "feedback"
        ? t("assist.proposal.review")
        : t("assist.proposal.heading", { label: proposal.label });
  return (
    <div className="flex max-h-[45svh] shrink-0 flex-col border-t border-t-border bg-t-secondary/60">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <IconSparkles size={15} className="text-t-text-tertiary" />
        <span className="flex-1 font-medium text-t-text">{heading}</span>
        {(proposal.kind === "replace" || proposal.kind === "insert" || proposal.kind === "document") && (
          <Button size="sm" variant="solid" color="accent" onClick={onAccept}>
            {proposal.kind === "insert"
              ? t("assist.proposal.insert")
              : proposal.kind === "document"
                ? t("assist.proposal.replaceDraft")
                : t("assist.proposal.accept")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          {proposal.kind === "feedback" || proposal.kind === "titles" ? t("common:close") : t("assist.proposal.discard")}
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto px-4 pb-4">
        {proposal.kind === "titles" ? (
          <ul className="flex flex-col gap-1.5">
            {proposal.titles.map((idea) => (
              <li key={idea.title}>
                <button type="button" onClick={() => onPickTitle(idea)} className="w-full rounded-md border border-t-border bg-t-primary px-3 py-2 text-left hover:bg-t-hover">
                  <div className="font-medium text-t-text">{idea.title}</div>
                  {idea.subtitle && <div className="text-[12px] text-t-text-secondary">{idea.subtitle}</div>}
                </button>
              </li>
            ))}
          </ul>
        ) : proposal.kind === "feedback" ? (
          <div className="rounded-md border border-t-border bg-t-primary px-4 py-2">
            <Markdown>{proposal.text}</Markdown>
          </div>
        ) : (
          <div className={cn("grid gap-3", proposal.kind === "replace" && "md:grid-cols-2")}>
            {proposal.kind === "replace" && (
              <div className="rounded-md border border-t-border bg-t-primary px-3 py-2">
                <div className="mb-1 text-[11px] font-medium text-t-text-tertiary uppercase">{t("assist.proposal.now")}</div>
                <p className="whitespace-pre-wrap text-t-text-secondary line-through decoration-t-text-light/50">{proposal.original}</p>
              </div>
            )}
            <div className="rounded-md border border-[var(--t-color-green7)] bg-t-primary px-3 py-2">
              <div className="mb-1 text-[11px] font-medium text-t-text-tertiary uppercase">{proposal.kind === "replace" ? t("assist.proposal.proposed") : t("assist.proposal.toAdd")}</div>
              <p className="whitespace-pre-wrap text-t-text">{proposal.text}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Dialogs --------------------------------------------------------------------------------------------------------

function PromptDialog({
  title,
  label,
  placeholder,
  submit,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  placeholder: string;
  submit: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const { t } = useTranslation("common");
  const [value, setValue] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <Field label={label}>
          <Input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>{t("cancel")}</Button>
          <Button size="sm" type="submit" variant="solid" color="accent" disabled={!value.trim()}>{submit}</Button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsDialog({
  newsletter,
  post,
  onClose,
  onSaved,
}: {
  newsletter: Newsletter;
  post: PostDetail;
  onClose: () => void;
  onSaved: (post: PostDetail) => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [values, setValues] = useState({
    audience: post.audience,
    write_comment_permissions: post.write_comment_permissions as "everyone" | "subscribers" | "only_paid" | "none",
    description: post.description,
    social_title: post.social_title,
    search_engine_title: post.search_engine_title,
    search_engine_description: post.search_engine_description,
    slug: post.slug,
    cover_image: post.cover_image ?? "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }));
  const cover = useRef<HTMLInputElement>(null);

  return (
    <Modal
      title={t("editor.settings.label")}
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>{t("common:cancel")}</Button>
          <Button size="sm" variant="solid" color="accent" loading={busy === "save"} onClick={async () => {
            setBusy("save");
            setError(null);
            try {
              onSaved(await saveDraft(newsletter.id, post.id, { ...values, cover_image: values.cover_image || null }));
              onClose();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(null);
            }
          }}>{t("common:save")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("editor.settings.readers")} hint={!newsletter.paid ? t("editor.settings.paidHint") : undefined}>
            <SimpleSelect<Audience>
              label={t("editor.settings.audience")}
              value={values.audience}
              onValueChange={(v) => set("audience", v)}
              options={AUDIENCES.map((a) => ({ value: a.value, label: t(`audiences.${a.value}`) }))}
            />
          </Field>
          <Field label={t("editor.settings.commenters")}>
            <SimpleSelect
              label={t("editor.settings.comments")}
              value={values.write_comment_permissions}
              onValueChange={(v) => set("write_comment_permissions", v)}
              options={[
                { value: "everyone", label: t("editor.settings.commentOptions.everyone") },
                { value: "subscribers", label: t("editor.settings.commentOptions.subscribers") },
                { value: "only_paid", label: t("editor.settings.commentOptions.only_paid") },
                { value: "none", label: t("editor.settings.commentOptions.none") },
              ]}
            />
          </Field>
        </div>
        <Field label={t("editor.settings.cover")} hint={t("editor.settings.coverHint")}>
          <div className="flex gap-2">
            <Input className="flex-1" value={values.cover_image} placeholder="https://" onChange={(e) => set("cover_image", e.target.value)} />
            <Button size="sm" variant="outline" loading={busy === "cover"} onClick={() => cover.current?.click()}>{t("editor.settings.upload")}</Button>
            <input ref={cover} type="file" accept="image/*" hidden onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy("cover");
              try {
                set("cover_image", await uploadImage(newsletter.id, file, post.id));
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(null);
              }
            }} />
          </div>
          {values.cover_image && <img src={values.cover_image} alt="" className="mt-2 max-h-40 rounded-sm object-cover" />}
        </Field>
        <Field label={t("editor.settings.description")} hint={t("editor.settings.descriptionHint")}>
          <div className="flex flex-col gap-1.5">
            <Textarea rows={2} value={values.description} onChange={(e) => set("description", e.target.value)} />
            <Button size="sm" variant="ghost" className="self-start" startIcon={busy === "summary" ? <Loader /> : <IconSparkles size={14} />} disabled={busy !== null} onClick={async () => {
              setBusy("summary");
              try {
                const result = await assist(newsletter.id, { action: "summary", text: (await getPost(newsletter.id, post.id)).markdown, title: post.title, subtitle: post.subtitle });
                if (result.kind !== "titles") set("description", result.text);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(null);
              }
            }}>{t("editor.settings.writeWithAi")}</Button>
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("editor.settings.socialTitle")}>
            <Input value={values.social_title} placeholder={post.title} onChange={(e) => set("social_title", e.target.value)} />
          </Field>
          <Field label={t("editor.settings.slug")} hint={newsletter.publication_url ? `${newsletter.publication_url}/p/${values.slug || "…"}` : undefined}>
            <Input value={values.slug} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} />
          </Field>
          <Field label={t("editor.settings.seoTitle")}>
            <Input value={values.search_engine_title} placeholder={post.title} onChange={(e) => set("search_engine_title", e.target.value)} />
          </Field>
          <Field label={t("editor.settings.seoDescription")}>
            <Input value={values.search_engine_description} onChange={(e) => set("search_engine_description", e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleDialog({
  newsletter,
  post,
  onClose,
  onScheduled,
}: {
  newsletter: Newsletter;
  post: PostDetail;
  onClose: () => void;
  onScheduled: (warnings: string[]) => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const tomorrow = new Date(Date.now() + 86_400_000);
  const initial = toLocalInput(tomorrow, newsletter.timezone).replace(/T\d\d:\d\d$/, "T08:00");
  const [when, setWhen] = useState(initial);
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = fromLocalInput(when, newsletter.timezone);
  return (
    <Modal
      title={t("editor.schedule.title")}
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>{t("common:cancel")}</Button>
          <Button size="sm" variant="solid" color="accent" loading={busy} disabled={!at} onClick={async () => {
            if (!at) return;
            setBusy(true);
            setError(null);
            try {
              const { warnings } = await schedulePost(newsletter.id, post.id, at, send);
              onScheduled(warnings);
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}>{t("notes.schedule")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("notes.scheduleDialog.when", { timeZone: newsletter.timezone })}>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-t-text">
          <Switch.Root size="sm" checked={send} onCheckedChange={setSend}>
            <Switch.Thumb />
          </Switch.Root>
          {t("editor.schedule.email", {
            audience: knownAudience(post.audience) ? t(`audienceTo.${knownAudience(post.audience)!}`) : post.audience,
          })}
        </label>
        <p className="text-[12px] leading-[1.5] text-t-text-tertiary">
          {t("editor.schedule.how")}
        </p>
      </div>
    </Modal>
  );
}

function PublishDialog({
  newsletter,
  post,
  onClose,
  onPublished,
}: {
  newsletter: Newsletter;
  post: PostDetail;
  onClose: () => void;
  onPublished: () => void;
}) {
  const { t } = useTranslation(["newsletter", "common"]);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ url: string | null; emailed: boolean } | null>(null);
  useEffect(() => {
    checkPost(newsletter.id, post.id).then(setProblems, (e) => setError(errorText(e)));
  }, [newsletter.id, post.id]);

  if (done)
    return (
      <Modal title={t("editor.publish.doneTitle")} onClose={onPublished} footer={<Button size="sm" variant="solid" color="accent" onClick={onPublished}>{t("common:done")}</Button>}>
        <p className="text-t-text">
          {done.emailed ? t("editor.publish.liveEmailed", { title: post.title }) : t("editor.publish.liveWeb", { title: post.title })}
        </p>
        {done.url && (
          <a href={done.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-t-text-secondary underline">
            {done.url} <IconExternalLink size={13} />
          </a>
        )}
      </Modal>
    );

  return (
    <Modal
      title={t("editor.publish.title")}
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>{t("common:cancel")}</Button>
          <Button
            size="sm"
            variant="solid"
            color={send ? "danger" : "accent"}
            loading={busy}
            disabled={problems === null || problems.length > 0}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setDone(await publishPost(newsletter.id, post.id, send));
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {send ? t("editor.publish.confirmSend") : t("editor.publish.confirmWeb")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-t-text">
          {t("editor.publish.body", {
            title: post.title || t("common:untitled"),
            site: newsletter.publication_url?.replace(/^https:\/\//, "") ?? "",
            audience: knownAudience(post.audience) ? t(`audienceFor.${knownAudience(post.audience)!}`) : post.audience,
          })}
        </p>
        <label className="flex items-center gap-2 text-t-text">
          <Switch.Root size="sm" checked={send} onCheckedChange={setSend}>
            <Switch.Thumb />
          </Switch.Root>
          {send ? t("editor.publish.emailIrreversible") : t("editor.publish.email")}
        </label>
        {problems === null && !error ? (
          <div className="flex items-center gap-2 text-t-text-tertiary"><Loader /> {t("editor.publish.checking")}</div>
        ) : problems && problems.length > 0 ? (
          <div className="rounded-md border border-t-border bg-t-secondary px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-t-text"><IconBulb size={14} /> {t("editor.publish.before")}</div>
            <ul className="list-disc pl-5 text-t-text-secondary">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
