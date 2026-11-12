// Writing a post, alone or with the AI: a title, a subtitle and a Markdown body with a toolbar for Substack's
// blocks (paywall, buttons, images uploaded to Substack), and a preview of the document Substack receives. Saves
// itself to Substack as you type. The AI rewrites a selection, writes on from the cursor, turns an outline into a
// draft, proposes titles and reviews the draft, and each of its changes waits for Accept. Publishing and
// scheduling ask first; published posts open read-only, with their comments.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
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

import { Markdown } from "@/components/markdown";
import { PostPreview } from "@/components/newsletter/preview";
import { SimpleSelect } from "@/components/simple-select";
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

type View = "write" | "split" | "preview";
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
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup className={cn("flex max-h-[90svh] flex-col overflow-hidden p-0", wide ? "w-[min(720px,calc(100vw-16px))]" : "w-[min(480px,calc(100vw-16px))]")}>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-t-border-light pr-2 pl-4">
              <Dialog.Title className="flex-1 text-[14px] font-semibold">{title}</Dialog.Title>
              <Dialog.Close render={<LightIconButton aria-label="Close"><IconX size={16} /></LightIconButton>} />
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

// The toolbar ----------------------------------------------------------------------------------------------------

type Edit = { text: string; selectionStart: number; selectionEnd: number };

/** Wraps the selection in a mark, or inserts it with a placeholder. */
function wrap(value: string, start: number, end: number, before: string, after = before, placeholder = "text"): Edit {
  const selected = value.slice(start, end) || placeholder;
  const text = value.slice(0, start) + before + selected + after + value.slice(end);
  return { text, selectionStart: start + before.length, selectionEnd: start + before.length + selected.length };
}

/** Prefixes each selected line (a heading, a quote, a list). */
function prefixLines(value: string, start: number, end: number, prefix: (index: number) => string): Edit {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const stop = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(lineStart, stop).split("\n");
  const replaced = lines.map((line, i) => prefix(i) + line.replace(/^(#{1,6}\s|>\s?|[-*]\s|\d+\.\s)/, "")).join("\n");
  const text = value.slice(0, lineStart) + replaced + value.slice(stop);
  return { text, selectionStart: lineStart, selectionEnd: lineStart + replaced.length };
}

/** Inserts a block on lines of its own at the cursor. */
function insertBlock(value: string, at: number, block: string): Edit {
  const before = value.slice(0, at).replace(/\s*$/, "");
  const after = value.slice(at).replace(/^\s*/, "");
  const head = before ? `${before}\n\n` : "";
  const text = `${head}${block}${after ? `\n\n${after}` : "\n\n"}`;
  const cursor = head.length + block.length + 2;
  return { text, selectionStart: cursor, selectionEnd: cursor };
}

function ToolButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <LightIconButton aria-label={label} tooltip={label} size="sm" onClick={onClick} disabled={disabled}>
      {children}
    </LightIconButton>
  );
}

// Published posts ------------------------------------------------------------------------------------------------

function Comment({ comment, depth = 0 }: { comment: SubstackComment; depth?: number }) {
  return (
    <li className={cn("flex flex-col gap-1", depth > 0 && "border-l border-t-border-light pl-3")}>
      <div className="flex items-center gap-2 text-[12px]">
        {comment.photo_url && <img src={comment.photo_url} alt="" className="size-5 rounded-full" />}
        <span className="font-medium text-t-text">{comment.name}</span>
        <span className="text-t-text-tertiary">{comment.date ? new Date(comment.date).toLocaleDateString() : ""}</span>
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
  const [comments, setComments] = useState<SubstackComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getComments(newsletter.id, post.id).then(setComments, (e) => setError(errorText(e)));
  }, [newsletter.id, post.id]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-2 px-6 pt-5 text-[12px] text-t-text-tertiary">
        <span>Published {formatMoment(post.post_date, newsletter.timezone)} · {audienceLabel(post.audience)}</span>
        <span className="flex-1" />
        <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() => onAsk(`Read my post ${post.id} (“${post.title}”), its numbers and its comments. What worked, what didn't, and what should my next issue be to follow up on it?`)}>
          Learn from it
        </Button>
        <Button size="sm" variant="outline" startIcon={<IconSparkles size={14} />} onClick={() => onAsk(`Draft three Substack Notes to bring readers to my post ${post.id} (“${post.title}”).`)}>
          Notes for it
        </Button>
        {post.url && (
          <Button size="sm" variant="outline" startIcon={<IconExternalLink size={14} />} render={<a href={post.url} target="_blank" rel="noreferrer" />}>
            Open on Substack
          </Button>
        )}
      </div>
      <p className="mx-auto max-w-[760px] px-6 pt-2 text-[12px] text-t-text-light">
        A published post changes in Substack's editor, where saving updates the live post.
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
          <IconMessageCircle size={16} /> Comments
        </h2>
        {error ? (
          <p className="text-t-text-danger">{error}</p>
        ) : comments === null ? (
          <Loader />
        ) : comments.length === 0 ? (
          <p className="text-t-text-tertiary">No comments yet.</p>
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
  const [post, setPost] = useState<PostDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>({ title: "", subtitle: "", markdown: "" });
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [view, setView] = useState<View>(() => (window.innerWidth >= 1280 ? "split" : "write"));
  const [busy, setBusy] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [dialog, setDialog] = useState<null | "publish" | "schedule" | "settings" | "delete" | "custom" | "link" | "button" | "youtube">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const revisionRef = useRef<string | null>(null);
  const timer = useRef<Timer | undefined>(undefined);
  const latest = useRef(fields);
  latest.current = fields;
  const saving = useRef<Promise<void> | null>(null);
  const saveRef = useRef<SaveState>("saved");
  saveRef.current = save;

  const adopt = useCallback((loaded: PostDetail) => {
    setPost(loaded);
    revisionRef.current = loaded.revision;
    setFields({ title: loaded.title, subtitle: loaded.subtitle, markdown: loaded.markdown });
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
    setFields((current) => ({ ...current, ...next }));
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

  const doc = useMemo(() => markdownToDoc(fields.markdown), [fields.markdown]);
  const words = useMemo(() => wordCount(fields.markdown), [fields.markdown]);

  function applyEdit(edit: Edit) {
    change({ markdown: edit.text });
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }

  const selection = () => {
    const el = textarea.current;
    return { start: el?.selectionStart ?? fields.markdown.length, end: el?.selectionEnd ?? fields.markdown.length };
  };

  const tool = {
    bold: () => {
      const { start, end } = selection();
      applyEdit(wrap(fields.markdown, start, end, "**"));
    },
    italic: () => {
      const { start, end } = selection();
      applyEdit(wrap(fields.markdown, start, end, "*"));
    },
    heading: (level: 2 | 3) => {
      const { start, end } = selection();
      applyEdit(prefixLines(fields.markdown, start, end, () => `${"#".repeat(level)} `));
    },
    quote: () => {
      const { start, end } = selection();
      applyEdit(prefixLines(fields.markdown, start, end, () => "> "));
    },
    list: (ordered: boolean) => {
      const { start, end } = selection();
      applyEdit(prefixLines(fields.markdown, start, end, (i) => (ordered ? `${i + 1}. ` : "- ")));
    },
    block: (block: string) => applyEdit(insertBlock(fields.markdown, selection().end, block)),
  };

  async function uploadFiles(files: FileList | File[]) {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setBusy("upload");
    try {
      for (const file of images) {
        const url = await uploadImage(newsletter.id, file, postId);
        tool.block(`![${file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "")}](${url})`);
      }
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  // The AI ---------------------------------------------------------------------------------------------------

  async function runAssist(action: string, options: { instruction?: string; label?: string } = {}) {
    const { start, end } = selection();
    const selected = fields.markdown.slice(start, end);
    const whole = !selected.trim();
    setBusy(`ai:${action}`);
    setNotice(null);
    try {
      const result = await assist(newsletter.id, {
        action: action as never,
        text: action === "continue" ? fields.markdown.slice(0, end) : whole ? fields.markdown : selected,
        after: action === "continue" ? fields.markdown.slice(end) : undefined,
        instruction: options.instruction,
        title: fields.title,
        subtitle: fields.subtitle,
      });
      const label = options.label ?? ASSIST_ACTIONS.find((a) => a.value === action)?.label ?? "AI";
      if (result.kind === "titles") setProposal({ kind: "titles", titles: result.titles });
      else if (result.kind === "feedback") setProposal({ kind: "feedback", text: result.text });
      else if (result.kind === "document") setProposal({ kind: "document", label, text: result.text });
      else if (result.kind === "insert") setProposal({ kind: "insert", label, at: end, text: result.text });
      else if (result.kind === "replace")
        setProposal(
          whole
            ? { kind: "replace", label, from: 0, to: fields.markdown.length, original: fields.markdown, text: result.text }
            : { kind: "replace", label, from: start, to: end, original: selected, text: result.text },
        );
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  function accept() {
    if (!proposal) return;
    const md = fields.markdown;
    if (proposal.kind === "replace") {
      // The text may have moved while the AI wrote: replace where the original still is.
      const at = md.slice(proposal.from, proposal.to) === proposal.original ? proposal.from : md.indexOf(proposal.original);
      if (at < 0) {
        setNotice("The passage changed meanwhile: select it again and retry.");
        return;
      }
      applyEdit({
        text: md.slice(0, at) + proposal.text + md.slice(at + proposal.original.length),
        selectionStart: at,
        selectionEnd: at + proposal.text.length,
      });
    } else if (proposal.kind === "insert") applyEdit(insertBlock(md, Math.min(proposal.at, md.length), proposal.text));
    else if (proposal.kind === "document")
      applyEdit({ text: proposal.text, selectionStart: 0, selectionEnd: 0 });
    setProposal(null);
  }

  // Render ---------------------------------------------------------------------------------------------------

  if (loadError)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-t-text-danger">{loadError}</p>
        <Button size="sm" variant="outline" onClick={onBack}>Back to the posts</Button>
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
      <LightIconButton aria-label="Back to the posts" tooltip="Back to the posts" onClick={async () => {
        if (save === "dirty") await flush();
        onBack();
      }}>
        <IconArrowLeft size={16} />
      </LightIconButton>
      <span className="shrink-0 text-[12px] text-t-text-tertiary tabular-nums">
        {post.state === "published"
          ? "Published"
          : post.state === "scheduled"
            ? `Scheduled · ${formatMoment(post.scheduled_for, newsletter.timezone)}`
            : "Draft"}
        {editable && (
          <>
            {" · "}
            {save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved" : save === "error" ? <span className="text-t-text-danger">Not saved</span> : "Saved to Substack"}
            {` · ${words} words`}
          </>
        )}
      </span>
      <span className="flex-1" />
      {editable && (
        <>
          <SegmentedControl<View>
            aria-label="View"
            size="sm"
            value={view}
            onValueChange={setView}
            options={[
              { value: "write", label: "Write" },
              { value: "split", label: "Split" },
              { value: "preview", label: "Preview" },
            ]}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="sm" variant="ghost" startIcon={busy?.startsWith("ai:") ? <Loader /> : <IconWand size={14} />} endIcon={<IconChevronDown size={12} />} disabled={busy !== null}>
                  AI
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 py-1 text-[11px] text-t-text-tertiary">On the selection (or the whole post)</div>
              {ASSIST_ACTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => void runAssist(option.value)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => setDialog("custom")}>Change it my way…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void runAssist("continue", { label: "Continue writing" })}>Continue writing from the cursor</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void runAssist("expand", { label: "Draft from the outline" })}>Turn my notes into a draft</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void runAssist("titles")}>Suggest titles</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void runAssist("review")}>Review the draft</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAsk(`Let's work on my draft ${post.id} (“${fields.title || "Untitled"}”). Read it, then tell me what you would change before I publish it.`)}>
                Work on it with the copilot
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <LightIconButton aria-label="Post settings" tooltip="Audience, description, SEO" onClick={() => setDialog("settings")}>
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
              Unschedule
            </Button>
          ) : (
            <Button size="sm" variant="outline" startIcon={<IconClock size={14} />} onClick={() => setDialog("schedule")}>
              Schedule
            </Button>
          )}
          <Button size="sm" variant="solid" color="accent" startIcon={<IconSend size={14} />} onClick={async () => {
            if (save !== "saved") await flush();
            setDialog("publish");
          }}>
            Publish
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

  const writer = (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-5 pt-6 pb-10">
        <textarea
          aria-label="Title"
          rows={1}
          placeholder="Title"
          value={fields.title}
          onChange={(e) => change({ title: e.target.value.replace(/\n/g, " ") })}
          className="field-sizing-content w-full resize-none bg-transparent font-serif text-[30px] leading-tight font-bold text-t-text outline-none placeholder:text-t-text-light"
          style={{ fontFamily: "Georgia, 'Iowan Old Style', serif" }}
        />
        <textarea
          aria-label="Subtitle"
          rows={1}
          placeholder="Add a subtitle…"
          value={fields.subtitle}
          onChange={(e) => change({ subtitle: e.target.value.replace(/\n/g, " ") })}
          className="field-sizing-content mt-2 w-full resize-none bg-transparent font-serif text-[18px] text-t-text-secondary outline-none placeholder:text-t-text-light"
          style={{ fontFamily: "Georgia, 'Iowan Old Style', serif" }}
        />
        <div className="sticky top-0 z-10 -mx-2 mt-4 mb-2 flex flex-wrap items-center gap-0.5 rounded-md border border-t-border-light bg-t-primary/95 px-1 py-0.5 backdrop-blur">
          <ToolButton label="Section heading" onClick={() => tool.heading(2)}><IconH2 size={16} /></ToolButton>
          <ToolButton label="Subheading" onClick={() => tool.heading(3)}><IconH3 size={16} /></ToolButton>
          <ToolButton label="Bold (⌘B)" onClick={tool.bold}><IconBold size={16} /></ToolButton>
          <ToolButton label="Italic (⌘I)" onClick={tool.italic}><IconItalic size={16} /></ToolButton>
          <ToolButton label="Link (⌘K)" onClick={() => setDialog("link")}><IconLink size={16} /></ToolButton>
          <ToolButton label="Quote" onClick={tool.quote}><IconQuote size={16} /></ToolButton>
          <ToolButton label="Bulleted list" onClick={() => tool.list(false)}><IconList size={16} /></ToolButton>
          <ToolButton label="Numbered list" onClick={() => tool.list(true)}><IconListNumbers size={16} /></ToolButton>
          <span className="mx-1 h-4 w-px bg-t-border" />
          <ToolButton label="Image (uploaded to Substack)" onClick={() => fileInput.current?.click()} disabled={busy === "upload"}>
            {busy === "upload" ? <Loader /> : <IconPhoto size={16} />}
          </ToolButton>
          <ToolButton label="Subscribe button" onClick={() => tool.block("::subscribe")}><IconUserPlus size={16} /></ToolButton>
          <ToolButton label="Button" onClick={() => setDialog("button")}><IconClick size={16} /></ToolButton>
          <ToolButton label="YouTube video" onClick={() => setDialog("youtube")}><IconBrandYoutube size={16} /></ToolButton>
          <ToolButton label="Divider" onClick={() => tool.block("---")}><IconSeparatorHorizontal size={16} /></ToolButton>
          <ToolButton label="Paywall: paid subscribers only below" onClick={() => tool.block("::paywall")}><IconLock size={16} /></ToolButton>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <textarea
          ref={textarea}
          aria-label="Post"
          value={fields.markdown}
          placeholder={"Start writing, or jot an outline and ask the AI to turn it into a draft.\n\n## Sections start like this\n\nMarkdown works: **bold**, *italic*, [links](https://…), > quotes, - lists."}
          onChange={(e) => change({ markdown: e.target.value })}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void uploadFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key === "b") {
              e.preventDefault();
              tool.bold();
            } else if (mod && e.key === "i") {
              e.preventDefault();
              tool.italic();
            } else if (mod && e.key === "k") {
              e.preventDefault();
              setDialog("link");
            } else if (mod && e.key === "s") {
              e.preventDefault();
              void flush();
            }
          }}
          className="field-sizing-content min-h-[50svh] w-full flex-1 resize-none bg-transparent font-serif text-[17px] leading-[1.7] text-t-text outline-none placeholder:text-t-text-light"
          style={{ fontFamily: "Georgia, 'Iowan Old Style', serif" }}
        />
      </div>
    </div>
  );

  const preview = (
    <div className="h-full overflow-y-auto bg-t-secondary/40">
      <PostPreview
        doc={doc}
        title={fields.title}
        subtitle={fields.subtitle}
        author={newsletter.substack_user_name}
        publication={newsletter.name}
        coverImage={post.cover_image}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-t-border-light bg-t-secondary px-4 py-2">
          <IconAlertTriangle size={16} className="text-[var(--t-color-orange9)]" />
          <span className="min-w-0 flex-1 text-t-text">This draft changed elsewhere (the copilot or Substack) while you had unsaved edits.</span>
          <Button size="sm" variant="outline" onClick={async () => adopt(await getPost(newsletter.id, post.id))}>
            Load their version
          </Button>
          <Button size="sm" variant="solid" color="accent" onClick={() => void flush(true)}>
            Keep mine
          </Button>
        </div>
      )}
      {(notice || (saveError && !conflict)) && (
        <div className="flex items-center gap-2 border-b border-t-border-light px-4 py-2 text-t-text-danger">
          <span className="min-w-0 flex-1">{notice ?? saveError}</span>
          {saveError && !notice && <Button size="sm" variant="ghost" onClick={() => void flush()}>Retry</Button>}
          {notice && <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}
        </div>
      )}
      {post.release_error && (
        <div className="flex items-center gap-2 border-b border-t-border-light px-4 py-2 text-t-text-danger">
          <IconAlertTriangle size={16} /> The scheduled release failed: {post.release_error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {view !== "preview" && <div className={cn("min-w-0", view === "split" ? "w-1/2 border-r border-t-border-light" : "flex-1")}>{writer}</div>}
        {view !== "write" && <div className={cn("min-w-0", view === "split" ? "w-1/2" : "flex-1")}>{preview}</div>}
      </div>

      {proposal && <ProposalPanel proposal={proposal} onAccept={accept} onDiscard={() => setProposal(null)} onPickTitle={(t) => {
        change({ title: t.title, subtitle: t.subtitle });
        setProposal(null);
      }} />}

      {dialog === "custom" && (
        <PromptDialog
          title="Change it my way"
          label="What should the AI do with the selection (or the whole post)?"
          placeholder="e.g. turn this into a numbered list of steps"
          submit="Rewrite"
          onClose={() => setDialog(null)}
          onSubmit={(instruction) => {
            setDialog(null);
            void runAssist("custom", { instruction, label: "Your change" });
          }}
        />
      )}
      {dialog === "link" && (
        <PromptDialog
          title="Link"
          label="Address"
          placeholder="https://"
          submit="Add the link"
          onClose={() => setDialog(null)}
          onSubmit={(url) => {
            setDialog(null);
            const { start, end } = selection();
            applyEdit(wrap(fields.markdown, start, end, "[", `](${url.trim()})`, "link text"));
          }}
        />
      )}
      {dialog === "youtube" && (
        <PromptDialog
          title="YouTube video"
          label="The video's address"
          placeholder="https://www.youtube.com/watch?v=…"
          submit="Embed"
          onClose={() => setDialog(null)}
          onSubmit={(url) => {
            setDialog(null);
            const id = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{6,})/.exec(url)?.[1] ?? url.trim();
            if (/^[\w-]{6,}$/.test(id)) tool.block(`::youtube[${id}]`);
            else setNotice("That is not a YouTube address");
          }}
        />
      )}
      {dialog === "button" && <ButtonDialog onClose={() => setDialog(null)} onInsert={(text, url) => {
        setDialog(null);
        tool.block(`::button[${text.replace(/[[\]]/g, "")}](${url})`);
      }} />}
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
          if (warnings.length) setNotice(`Scheduled. Fix before then: ${warnings.join("; ")}`);
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
          title="Delete this draft?"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
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
              }}>Delete the draft</Button>
            </>
          }
        >
          <p className="text-t-text-secondary">“{fields.title || "Untitled"}” leaves Substack's drafts for good.</p>
        </Modal>
      )}
      <div className="flex shrink-0 justify-start border-t border-t-border-light px-3 py-1.5">
        <Button size="sm" variant="ghost" color="danger" startIcon={<IconTrash size={14} />} onClick={() => setDialog("delete")}>
          Delete draft
        </Button>
      </div>
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
  const heading =
    proposal.kind === "titles"
      ? "Title ideas"
      : proposal.kind === "feedback"
        ? "The editor's review"
        : `${proposal.label}: the AI's proposal`;
  return (
    <div className="flex max-h-[45svh] shrink-0 flex-col border-t border-t-border bg-t-secondary/60">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <IconSparkles size={15} className="text-t-text-tertiary" />
        <span className="flex-1 font-medium text-t-text">{heading}</span>
        {(proposal.kind === "replace" || proposal.kind === "insert" || proposal.kind === "document") && (
          <Button size="sm" variant="solid" color="accent" onClick={onAccept}>
            {proposal.kind === "insert" ? "Insert" : proposal.kind === "document" ? "Replace the draft" : "Accept"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          {proposal.kind === "feedback" || proposal.kind === "titles" ? "Close" : "Discard"}
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto px-4 pb-4">
        {proposal.kind === "titles" ? (
          <ul className="flex flex-col gap-1.5">
            {proposal.titles.map((t) => (
              <li key={t.title}>
                <button type="button" onClick={() => onPickTitle(t)} className="w-full rounded-md border border-t-border bg-t-primary px-3 py-2 text-left hover:bg-t-hover">
                  <div className="font-medium text-t-text">{t.title}</div>
                  {t.subtitle && <div className="text-[12px] text-t-text-secondary">{t.subtitle}</div>}
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
                <div className="mb-1 text-[11px] font-medium text-t-text-tertiary uppercase">Now</div>
                <p className="whitespace-pre-wrap text-t-text-secondary line-through decoration-t-text-light/50">{proposal.original}</p>
              </div>
            )}
            <div className="rounded-md border border-[var(--t-color-green7)] bg-t-primary px-3 py-2">
              <div className="mb-1 text-[11px] font-medium text-t-text-tertiary uppercase">{proposal.kind === "replace" ? "Proposed" : "To add"}</div>
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
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" type="submit" variant="solid" color="accent" disabled={!value.trim()}>{submit}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ButtonDialog({ onClose, onInsert }: { onClose: () => void; onInsert: (text: string, url: string) => void }) {
  const [text, setText] = useState("Read more");
  const [kind, setKind] = useState("link");
  const [url, setUrl] = useState("");
  const target = kind === "link" ? url.trim() : kind;
  return (
    <Modal
      title="Button"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="solid" color="accent" disabled={!text.trim() || !target} onClick={() => onInsert(text.trim(), target)}>
            Insert
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="What it does">
          <SimpleSelect
            label="What the button does"
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "link", label: "Opens a link" },
              { value: "%%share_url%%", label: "Shares the post" },
              { value: "%%half_magic_comments_url%%", label: "Opens the comments" },
              { value: "%%checkout_url%%", label: "Subscribes (paid plans)" },
            ]}
          />
        </Field>
        {kind === "link" && (
          <Field label="Address">
            <Input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        )}
        <Field label="Label">
          <Input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
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
      title="Post settings"
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
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
          }}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who can read it" hint={!newsletter.paid ? "Paid audiences need paid subscriptions on Substack." : undefined}>
            <SimpleSelect<Audience> label="Audience" value={values.audience} onValueChange={(v) => set("audience", v)} options={AUDIENCES} />
          </Field>
          <Field label="Who can comment">
            <SimpleSelect
              label="Comments"
              value={values.write_comment_permissions}
              onValueChange={(v) => set("write_comment_permissions", v)}
              options={[
                { value: "everyone", label: "Everyone" },
                { value: "subscribers", label: "Subscribers" },
                { value: "only_paid", label: "Paid subscribers" },
                { value: "none", label: "No one" },
              ]}
            />
          </Field>
        </div>
        <Field label="Cover image" hint="Shown in the post's previews and on social media.">
          <div className="flex gap-2">
            <Input className="flex-1" value={values.cover_image} placeholder="https://" onChange={(e) => set("cover_image", e.target.value)} />
            <Button size="sm" variant="outline" loading={busy === "cover"} onClick={() => cover.current?.click()}>Upload</Button>
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
        <Field label="Description" hint="The line under the title in previews.">
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
            }}>Write it with AI</Button>
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title on social media">
            <Input value={values.social_title} placeholder={post.title} onChange={(e) => set("social_title", e.target.value)} />
          </Field>
          <Field label="Web address" hint={newsletter.publication_url ? `${newsletter.publication_url}/p/${values.slug || "…"}` : undefined}>
            <Input value={values.slug} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} />
          </Field>
          <Field label="Title for search engines">
            <Input value={values.search_engine_title} placeholder={post.title} onChange={(e) => set("search_engine_title", e.target.value)} />
          </Field>
          <Field label="Description for search engines">
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
  const tomorrow = new Date(Date.now() + 86_400_000);
  const initial = toLocalInput(tomorrow, newsletter.timezone).replace(/T\d\d:\d\d$/, "T08:00");
  const [when, setWhen] = useState(initial);
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = fromLocalInput(when, newsletter.timezone);
  return (
    <Modal
      title="Schedule the post"
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
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
          }}>Schedule</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={`When (${newsletter.timezone})`}>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-t-text">
          <Switch.Root size="sm" checked={send} onCheckedChange={setSend}>
            <Switch.Thumb />
          </Switch.Root>
          Also email it to {audienceLabel(post.audience).toLowerCase()}
        </label>
        <p className="text-[12px] leading-[1.5] text-t-text-tertiary">
          Richelieu publishes it at that minute, as it is then: you can keep editing until it goes out. The server must be
          running at that time.
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
      <Modal title="Published" onClose={onPublished} footer={<Button size="sm" variant="solid" color="accent" onClick={onPublished}>Done</Button>}>
        <p className="text-t-text">
          “{post.title}” is live{done.emailed ? " and on its way to your subscribers' inboxes" : " on the web"}.
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
      title="Publish now?"
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-t-text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
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
            {send ? "Publish and send the email" : "Publish on the web"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-t-text">
          “{post.title || "Untitled"}” goes live on {newsletter.publication_url?.replace(/^https:\/\//, "")} for{" "}
          {audienceLabel(post.audience).toLowerCase()}.
        </p>
        <label className="flex items-center gap-2 text-t-text">
          <Switch.Root size="sm" checked={send} onCheckedChange={setSend}>
            <Switch.Thumb />
          </Switch.Root>
          Email it to the subscribers{send ? ": this cannot be undone" : ""}
        </label>
        {problems === null && !error ? (
          <div className="flex items-center gap-2 text-t-text-tertiary"><Loader /> Checking the post…</div>
        ) : problems && problems.length > 0 ? (
          <div className="rounded-md border border-t-border bg-t-secondary px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-t-text"><IconBulb size={14} /> Before publishing</div>
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
