// The rich text editor the newsletter and the mail composer share, on TipTap: a sticky toolbar, a menu over the
// selection (with room for the caller's own actions, the AI's), "/" for blocks, a handle to drag any block, links
// edited in place, and images dropped, pasted or picked, uploaded with their progress shown in the text.
//
// The newsletter variant knows Substack's blocks (button, paywall, YouTube, kept embeds) and writes in a serif;
// the mail variant adds alignment, colors and highlights, and writes in the interface's sans.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Extension, type Editor, type JSONContent, type Range } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import Typography from "@tiptap/extension-typography";
import FileHandler from "@tiptap/extension-file-handler";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBlockquote,
  IconBold,
  IconBrandYoutube,
  IconCheck,
  IconChevronDown,
  IconClearFormatting,
  IconClick,
  IconCode,
  IconExternalLink,
  IconGripVertical,
  IconH1,
  IconH2,
  IconH3,
  IconHighlight,
  IconItalic,
  IconLink,
  IconLinkOff,
  IconList,
  IconListNumbers,
  IconLock,
  IconPalette,
  IconPhoto,
  IconPilcrow,
  IconSeparatorHorizontal,
  IconSourceCode,
  IconStrikethrough,
  IconUnderline,
  IconUserPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";

import i18n from "@/lib/i18n";

import { CtaButton, Figure, Paywall, RawEmbed, Youtube, youtubeId, type FigureAttrs } from "./nodes";

export type Variant = "newsletter" | "mail";

export type RichEditorHandle = {
  editor: Editor | null;
  /** Opens the file picker and inserts the images it returns. */
  pickImages: () => void;
};

type Props = {
  variant: Variant;
  /** The first content: TipTap JSON, or HTML. Later changes go through the handle's editor. */
  initialContent: JSONContent | string;
  onChange: (editor: Editor) => void;
  /** Uploads an image and resolves to its address (a URL, or a data URL for mail). */
  uploadImage: (file: File) => Promise<string>;
  /** Files dropped or pasted that are not images (mail: attachments). */
  onFiles?: (files: File[]) => void;
  placeholder?: string;
  editable?: boolean;
  autofocus?: boolean;
  /** More buttons at the end of the selection menu: the AI's actions. */
  bubbleActions?: (editor: Editor) => ReactNode;
  /** More controls at the end of the toolbar. */
  toolbarEnd?: ReactNode;
  /** Shown between the toolbar and the text: a post's title and subtitle. */
  header?: ReactNode;
  className?: string;
  contentClassName?: string;
  ref?: Ref<RichEditorHandle>;
};

const COLORS = [
  { id: "default", value: null },
  { id: "gray", value: "#667085" },
  { id: "red", value: "#d92d20" },
  { id: "orange", value: "#e04f16" },
  { id: "green", value: "#079455" },
  { id: "blue", value: "#1570ef" },
  { id: "purple", value: "#7a5af8" },
] as const;
const HIGHLIGHTS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa"];

// Buttons ----------------------------------------------------------------------------------------------------------

function Tool({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-t-text-secondary transition-colors hover:bg-t-hover hover:text-t-text disabled:pointer-events-none disabled:opacity-35",
        active && "bg-t-hover text-t-text",
        className,
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-t-border" />;

/** A small menu under a toolbar button. */
function Popover({ trigger, children, label }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 items-center gap-0.5 rounded-md px-1.5 text-t-text-secondary transition-colors hover:bg-t-hover hover:text-t-text",
          open && "bg-t-hover text-t-text",
        )}
      >
        {trigger(open)}
      </button>
      {open && (
        <div className="rich-pop absolute top-full left-0 z-30 mt-1 min-w-44 rounded-lg border border-t-border bg-t-primary p-1 shadow-xl">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, active, onClick }: { icon?: ReactNode; label: string; hint?: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-t-text hover:bg-t-hover",
        active && "bg-t-hover",
      )}
    >
      {icon && <span className="flex size-5 shrink-0 items-center justify-center text-t-text-secondary">{icon}</span>}
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-t-text-light">{hint}</span>}
      {active && <IconCheck size={14} className="text-t-text-secondary" />}
    </button>
  );
}

// Blocks: the "/" menu and the toolbar's insert menu share them --------------------------------------------------

type BlockId = "text" | "h1" | "h2" | "h3" | "bullets" | "numbers" | "quote" | "image" | "divider" | "code" | "subscribe" | "button" | "youtube" | "paywall";

/** A block's label, hint and keywords are translated at render: `blocks.<id>` in the editor's strings. */
type Block = {
  id: BlockId;
  icon: ReactNode;
  variants: Variant[];
  run: (editor: Editor, helpers: { pickImages: () => void; ask: (label: string, placeholder: string) => Promise<string | null> }) => void;
};

const BLOCKS: Block[] = [
  { id: "text", icon: <IconPilcrow size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().setParagraph().run() },
  { id: "h1", icon: <IconH1 size={16} />, variants: ["mail"], run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: "h2", icon: <IconH2 size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: "h3", icon: <IconH3 size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: "bullets", icon: <IconList size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "numbers", icon: <IconListNumbers size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "quote", icon: <IconBlockquote size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "image", icon: <IconPhoto size={16} />, variants: ["newsletter", "mail"], run: (_e, h) => h.pickImages() },
  { id: "divider", icon: <IconSeparatorHorizontal size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: "code", icon: <IconSourceCode size={16} />, variants: ["newsletter", "mail"], run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: "subscribe", icon: <IconUserPlus size={16} />, variants: ["newsletter"], run: (e) => e.chain().focus().setCtaButton({ text: i18n.t("editor:subscribeNow"), url: "%%checkout_url%%" }).run() },
  { id: "button", icon: <IconClick size={16} />, variants: ["newsletter"], run: (e) => e.chain().focus().setCtaButton({ text: "", url: "https://" }).run() },
  { id: "youtube", icon: <IconBrandYoutube size={16} />, variants: ["newsletter"], run: async (e, h) => {
    const url = await h.ask(i18n.t("editor:youtubeLink"), "https://www.youtube.com/watch?v=…");
    const id = url ? youtubeId(url) : null;
    if (id) e.chain().focus().setYoutube({ videoId: id }).run();
  } },
  { id: "paywall", icon: <IconLock size={16} />, variants: ["newsletter"], run: (e) => e.chain().focus().setPaywall().run() },
];

/** "/" at the start of an empty line: tells the menu where it is and what is typed after it. */
type SlashState = { range: Range; query: string; left: number; top: number; lineTop: number } | null;

function slashOf(editor: Editor): SlashState {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== "paragraph") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = /^\/([\p{L}\d ]{0,20})$/u.exec(before);
  if (!match) return null;
  const from = $from.pos - before.length;
  const coords = editor.view.coordsAtPos(from);
  return { range: { from, to: $from.pos }, query: match[1]!.trim().toLowerCase(), left: coords.left, top: coords.bottom, lineTop: coords.top };
}

/** Lets the "/" menu take the keyboard while it is open. */
function keyboardBridge(handler: { current: ((event: KeyboardEvent) => boolean) | null }) {
  return Extension.create({
    name: "keyboardBridge",
    addProseMirrorPlugins: () => [
      new Plugin({
        key: new PluginKey("keyboardBridge"),
        props: { handleKeyDown: (_view, event) => handler.current?.(event) ?? false },
      }),
    ],
  });
}

// The editor -------------------------------------------------------------------------------------------------------

export function RichEditor({
  variant,
  initialContent,
  onChange,
  uploadImage,
  onFiles,
  placeholder,
  editable = true,
  autofocus,
  bubbleActions,
  toolbarEnd,
  header,
  className,
  contentClassName,
  ref,
}: Props) {
  const { t } = useTranslation("editor");
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceAt = useRef<number | null>(null);
  const keyHandler = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  const uploadRef = useRef(uploadImage);
  uploadRef.current = uploadImage;
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [linkEditing, setLinkEditing] = useState(false);
  const [prompt, setPrompt] = useState<{ label: string; placeholder: string; resolve: (v: string | null) => void } | null>(null);

  /** Inserts images at a position (the end of the selection by default) and uploads them in place. */
  const insertImages = useCallback(async (editor: Editor, files: File[], at?: number) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    if (others.length) filesRef.current?.(others);
    let pos = at ?? editor.state.selection.to;
    for (const file of images) {
      const uploadId = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      const attrs: FigureAttrs = { src: preview, alt: file.name.replace(/\.[^.]+$/, ""), uploadId, size: "full" };
      if (replaceAt.current !== null) {
        const p = replaceAt.current;
        replaceAt.current = null;
        editor.chain().command(({ tr }) => {
          tr.setNodeMarkup(p, undefined, { ...editor.state.doc.nodeAt(p)?.attrs, src: preview, uploadId, error: null });
          return true;
        }).run();
      } else {
        editor.chain().insertContentAt(pos, { type: "figure", attrs }).run();
        pos = editor.state.selection.to;
      }
      const update = (patch: Partial<FigureAttrs>) => {
        editor.state.doc.descendants((node, nodePos) => {
          if (node.type.name === "figure" && node.attrs.uploadId === uploadId) {
            editor.view.dispatch(editor.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, ...patch }));
            return false;
          }
          return true;
        });
      };
      try {
        const src = await uploadRef.current(file);
        update({ src, uploadId: null, error: null });
        URL.revokeObjectURL(preview);
      } catch (error) {
        update({ uploadId: null, error: error instanceof Error ? error.message : i18n.t("editor:uploadFailed") });
      }
    }
  }, []);

  const editor = useEditor({
    editable,
    autofocus: autofocus ? "end" : false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: variant === "mail" ? [1, 2, 3] : [1, 2, 3, 4] },
        underline: variant === "mail" ? {} : false,
        // i18n-ignore: a link's rel attribute
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
        dropcursor: { color: "var(--t-color-blue9)", width: 2 },
      }),
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? i18n.t("editor:placeholder.heading")
            : (placeholder ?? (variant === "newsletter" ? i18n.t("editor:placeholder.newsletter") : i18n.t("editor:placeholder.mail"))),
      }),
      CharacterCount,
      Typography,
      Figure.configure({ onReplace: (pos) => {
        replaceAt.current = pos;
        fileInput.current?.click();
      } }),
      FileHandler.configure({
        onDrop: (e, files, pos) => void insertImages(e, files, pos),
        onPaste: (e, files) => void insertImages(e, files),
      }),
      keyboardBridge(keyHandler),
      ...(variant === "newsletter" ? [CtaButton, Paywall, Youtube, RawEmbed] : []),
      ...(variant === "mail"
        ? [TextAlign.configure({ types: ["heading", "paragraph"] }), TextStyle, Color, Highlight.configure({ multicolor: true })]
        : []),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: cn("rich-content", variant === "newsletter" ? "rich-newsletter" : "rich-mail", contentClassName),
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor),
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const pickImages = useCallback(() => fileInput.current?.click(), []);
  useImperativeHandle(ref, () => ({ editor, pickImages }), [editor, pickImages]);

  const ask = useCallback(
    (label: string, placeholder: string) => new Promise<string | null>((resolve) => setPrompt({ label, placeholder, resolve })),
    [],
  );

  // The "/" menu ---------------------------------------------------------------------------------------------
  const [slash, setSlash] = useState<SlashState>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const next = editor.isEditable ? slashOf(editor) : null;
      setSlash((current) => {
        if (current?.query !== next?.query) setSlashIndex(0);
        return next;
      });
    };
    editor.on("transaction", update);
    editor.on("blur", () => setSlash(null));
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);
  const blocks = useMemo(
    () =>
      BLOCKS.filter((b) => b.variants.includes(variant)).filter(
        (b) =>
          !slash?.query ||
          `${t(`blocks.${b.id}.label`)} ${t(`blocks.${b.id}.keywords`)}`.toLowerCase().includes(slash.query),
      ),
    [variant, slash?.query, t],
  );
  const runBlock = useCallback(
    (block: Block) => {
      if (!editor) return;
      if (slash) editor.chain().focus().deleteRange(slash.range).run();
      setSlash(null);
      block.run(editor, { pickImages, ask });
    },
    [editor, slash, pickImages, ask],
  );
  keyHandler.current = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "k") {
      event.preventDefault();
      setLinkEditing(true);
      return true;
    }
    if (!slash || blocks.length === 0) return false;
    if (event.key === "ArrowDown") {
      setSlashIndex((i) => (i + 1) % blocks.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      setSlashIndex((i) => (i - 1 + blocks.length) % blocks.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const block = blocks[slashIndex];
      if (block) runBlock(block);
      return true;
    }
    if (event.key === "Escape") {
      setSlash(null);
      return true;
    }
    return false;
  };

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            code: e.isActive("code"),
            link: e.isActive("link"),
            href: (e.getAttributes("link").href as string | undefined) ?? "",
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            bullets: e.isActive("bulletList"),
            numbers: e.isActive("orderedList"),
            quote: e.isActive("blockquote"),
            codeBlock: e.isActive("codeBlock"),
            align: (["left", "center", "right"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
            color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
            words: e.storage.characterCount?.words?.() ?? 0,
          }
        : null,
  });

  if (!editor || !state) return null;

  const styleId: BlockId | null = state.h1 ? "h1" : state.h2 ? "h2" : state.h3 ? "h3" : state.codeBlock ? null : "text";
  const styleLabel = styleId ? t(`blocks.${styleId}.label`) : t("style.code");

  return (
    <div className={cn("rich-editor relative flex flex-col", `rich-${variant}-shell`, className)}>
      {editable && (
        <div className="rich-toolbar sticky top-0 z-20 flex items-center gap-0.5 overflow-x-auto border-b border-t-border-light bg-t-primary/90 px-2 py-1 backdrop-blur-md">
          <Tool label={t("toolbar.undo")} shortcut="⌘Z" disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()}>
            <IconArrowBackUp size={17} />
          </Tool>
          <Tool label={t("toolbar.redo")} shortcut="⇧⌘Z" disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()}>
            <IconArrowForwardUp size={17} />
          </Tool>
          <Divider />
          <Popover
            label={t("style.label")}
            trigger={() => (
              <>
                <span className="w-[86px] truncate text-left text-[13px] text-t-text">{styleLabel}</span>
                <IconChevronDown size={13} />
              </>
            )}
          >
            {(close) =>
              BLOCKS.filter((b) => b.variants.includes(variant) && ["text", "h1", "h2", "h3", "code"].includes(b.id)).map((b) => (
                <MenuItem
                  key={b.id}
                  icon={b.icon}
                  label={t(`blocks.${b.id}.label`)}
                  active={b.id === styleId || (b.id === "code" && state.codeBlock)}
                  onClick={() => {
                    b.run(editor, { pickImages, ask });
                    close();
                  }}
                />
              ))
            }
          </Popover>
          <Divider />
          <Tool label={t("toolbar.bold")} shortcut="⌘B" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <IconBold size={17} />
          </Tool>
          <Tool label={t("toolbar.italic")} shortcut="⌘I" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <IconItalic size={17} />
          </Tool>
          {variant === "mail" && (
            <Tool label={t("toolbar.underline")} shortcut="⌘U" active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
              <IconUnderline size={17} />
            </Tool>
          )}
          <Tool label={t("toolbar.strikethrough")} shortcut="⇧⌘S" active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <IconStrikethrough size={17} />
          </Tool>
          <Tool label={t("toolbar.link")} shortcut="⌘K" active={state.link} onClick={() => setLinkEditing(true)}>
            <IconLink size={17} />
          </Tool>
          {variant === "mail" && (
            <Popover label={t("colors.label")} trigger={() => <IconPalette size={17} style={state.color ? { color: state.color } : undefined} />}>
              {(close) => (
                <div className="flex flex-col gap-2 p-1">
                  <span className="text-[11px] font-medium text-t-text-tertiary">{t("colors.text")}</span>
                  <div className="flex gap-1">
                    {COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        title={t(`colors.${c.id}`)}
                        aria-label={t("colors.textColor", { color: t(`colors.${c.id}`) })}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          if (c.value) editor.chain().focus().setColor(c.value).run();
                          else editor.chain().focus().unsetColor().run();
                          close();
                        }}
                        className={cn("flex size-6 items-center justify-center rounded-md border border-t-border text-[13px] font-semibold", state.color === c.value && "ring-2 ring-[var(--t-color-blue9)]")}
                        style={{ color: c.value ?? "var(--t-font-color-primary)" }}
                      >
                        {/* i18n-ignore: a sample letter showing the color */}
                        A
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] font-medium text-t-text-tertiary">{t("colors.highlight")}</span>
                  <div className="flex gap-1">
                    {HIGHLIGHTS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={t("colors.highlightColor", { color })}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          editor.chain().focus().toggleHighlight({ color }).run();
                          close();
                        }}
                        className="size-6 rounded-md border border-black/10"
                        style={{ background: color }}
                      />
                    ))}
                    <button
                      type="button"
                      aria-label={t("colors.removeHighlight")}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        editor.chain().focus().unsetHighlight().run();
                        close();
                      }}
                      className="flex size-6 items-center justify-center rounded-md border border-t-border text-t-text-tertiary"
                    >
                      <IconHighlight size={13} />
                    </button>
                  </div>
                </div>
              )}
            </Popover>
          )}
          <Divider />
          <Tool label={t("toolbar.bulletedList")} active={state.bullets} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <IconList size={17} />
          </Tool>
          <Tool label={t("toolbar.numberedList")} active={state.numbers} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <IconListNumbers size={17} />
          </Tool>
          <Tool label={t("toolbar.quote")} active={state.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <IconBlockquote size={17} />
          </Tool>
          {variant === "mail" && (
            <>
              <Divider />
              {(
                [
                  ["left", IconAlignLeft, t("toolbar.alignLeft")],
                  ["center", IconAlignCenter, t("toolbar.alignCenter")],
                  ["right", IconAlignRight, t("toolbar.alignRight")],
                ] as const
              ).map(([align, Icon, label]) => (
                <Tool key={align} label={label} active={state.align === align} onClick={() => editor.chain().focus().setTextAlign(align).run()}>
                  <Icon size={17} />
                </Tool>
              ))}
            </>
          )}
          <Divider />
          <Tool label={t("toolbar.image")} onClick={pickImages}>
            <IconPhoto size={17} />
          </Tool>
          {variant === "newsletter" && (
            <>
              <Tool label={t("toolbar.button")} onClick={() => runBlock(BLOCKS.find((b) => b.id === "subscribe")!)}>
                <IconClick size={17} />
              </Tool>
              <Tool label={t("toolbar.youtube")} onClick={() => runBlock(BLOCKS.find((b) => b.id === "youtube")!)}>
                <IconBrandYoutube size={17} />
              </Tool>
              <Tool label={t("toolbar.divider")} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                <IconSeparatorHorizontal size={17} />
              </Tool>
              <Tool label={t("toolbar.paywall")} onClick={() => editor.chain().focus().setPaywall().run()}>
                <IconLock size={17} />
              </Tool>
            </>
          )}
          <Tool label={t("toolbar.clearFormatting")} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
            <IconClearFormatting size={17} />
          </Tool>
          <span className="flex-1" />
          <span className="shrink-0 px-2 text-[12px] text-t-text-light tabular-nums">{t("toolbar.words", { count: state.words })}</span>
          {toolbarEnd}
        </div>
      )}

      {editable && (
        <DragHandle editor={editor} className="rich-drag-handle">
          <span className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-t-text-light hover:bg-t-hover hover:text-t-text-secondary active:cursor-grabbing">
            <IconGripVertical size={15} />
          </span>
        </DragHandle>
      )}

      {header}
      <EditorContent editor={editor} className="rich-body flex-1" />

      {editable && (
        <BubbleMenu
          editor={editor}
          options={{ placement: "top", offset: 8, flip: true, shift: { padding: 8 } }}
          shouldShow={({ editor: e, state: s }) => {
            if (!e.isEditable) return false;
            const node = (s.selection as { node?: { type: { name: string } } }).node;
            if (node) return false;
            return !s.selection.empty || e.isActive("link") || linkEditing;
          }}
        >
          <div className="rich-pop flex items-center gap-0.5 rounded-xl border border-t-border bg-t-primary p-1 shadow-xl">
            {linkEditing ? (
              <LinkForm
                href={state.href}
                onDone={(href) => {
                  setLinkEditing(false);
                  if (href === null) return editor.commands.focus();
                  if (!href) return editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  const url = /^(https?:|mailto:|tel:|%%)/i.test(href) ? href : `https://${href}`;
                  if (editor.state.selection.empty && !editor.isActive("link"))
                    editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href: url } }] }).run();
                  else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
                }}
              />
            ) : state.link && editor.state.selection.empty ? (
              <>
                <a href={state.href} target="_blank" rel="noreferrer" className="flex max-w-[260px] items-center gap-1.5 truncate px-2 text-[13px] text-[var(--t-color-blue10)] hover:underline">
                  <IconExternalLink size={13} className="shrink-0" />
                  <span className="truncate">{state.href.replace(/^https?:\/\//, "")}</span>
                </a>
                <Tool label={t("link.edit")} onClick={() => setLinkEditing(true)}>
                  <IconLink size={16} />
                </Tool>
                <Tool label={t("link.remove")} onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}>
                  <IconLinkOff size={16} />
                </Tool>
              </>
            ) : (
              <>
                <Tool label={t("toolbar.bold")} active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
                  <IconBold size={16} />
                </Tool>
                <Tool label={t("toolbar.italic")} active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
                  <IconItalic size={16} />
                </Tool>
                {variant === "mail" && (
                  <Tool label={t("toolbar.underline")} active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
                    <IconUnderline size={16} />
                  </Tool>
                )}
                <Tool label={t("toolbar.strikethrough")} active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
                  <IconStrikethrough size={16} />
                </Tool>
                <Tool label={t("toolbar.inlineCode")} active={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
                  <IconCode size={16} />
                </Tool>
                <Tool label={t("toolbar.link")} active={state.link} onClick={() => setLinkEditing(true)}>
                  <IconLink size={16} />
                </Tool>
                <Divider />
                <Tool label={t("toolbar.heading")} active={state.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                  <IconH2 size={16} />
                </Tool>
                <Tool label={t("toolbar.quote")} active={state.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
                  <IconBlockquote size={16} />
                </Tool>
                {bubbleActions && (
                  <>
                    <Divider />
                    {bubbleActions(editor)}
                  </>
                )}
              </>
            )}
          </div>
        </BubbleMenu>
      )}

      {slash && blocks.length > 0 &&
        createPortal(
          <div
            className="rich-pop fixed z-50 w-64 overflow-hidden rounded-xl border border-t-border bg-t-primary p-1 shadow-2xl"
            style={{
              left: Math.max(8, Math.min(slash.left, window.innerWidth - 272)),
              // Below the line when it fits, else above it: never over the line being typed.
              ...(window.innerHeight - slash.top > 340 ? { top: slash.top + 6 } : { bottom: window.innerHeight - slash.lineTop + 6 }),
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-t-text-tertiary">{t("blocks.title")}</div>
            <div className="max-h-72 overflow-y-auto">
              {blocks.map((block, index) => (
                <button
                  key={block.id}
                  type="button"
                  onMouseEnter={() => setSlashIndex(index)}
                  onClick={() => runBlock(block)}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left", index === slashIndex && "bg-t-hover")}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-t-border bg-t-primary text-t-text-secondary">{block.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-t-text">{t(`blocks.${block.id}.label`)}</span>
                    <span className="block truncate text-[11px] text-t-text-tertiary">{t(`blocks.${block.id}.hint`)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}

      {prompt &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[18vh]" onMouseDown={() => {
            prompt.resolve(null);
            setPrompt(null);
          }}>
            <form
              className="rich-pop w-[min(440px,calc(100vw-32px))] rounded-xl border border-t-border bg-t-primary p-3 shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("value");
                prompt.resolve(typeof value === "string" && value.trim() ? value.trim() : null);
                setPrompt(null);
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-t-text-secondary">{prompt.label}</span>
                <input name="value" autoFocus placeholder={prompt.placeholder} className="h-9 rounded-md border border-t-border bg-t-primary px-2.5 text-[14px] text-t-text outline-none focus:border-[var(--t-color-blue9)]" onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    prompt.resolve(null);
                    setPrompt(null);
                  }
                }} />
              </label>
            </form>
          </div>,
          document.body,
        )}

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void insertImages(editor, replaceAt.current !== null ? files.slice(0, 1) : files);
          else replaceAt.current = null;
        }}
      />
    </div>
  );
}

function LinkForm({ href, onDone }: { href: string; onDone: (href: string | null) => void }) {
  const { t } = useTranslation("editor");
  const { t: tc } = useTranslation("common");
  const [value, setValue] = useState(href);
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(value.trim());
      }}
    >
      <IconLink size={15} className="ml-1.5 text-t-text-tertiary" />
      <input
        autoFocus
        value={value}
        placeholder={t("link.placeholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone(null);
          }
        }}
        className="h-8 w-64 bg-transparent px-1 text-[13px] text-t-text outline-none placeholder:text-t-text-light"
      />
      <button type="submit" className="h-7 rounded-md bg-[var(--t-color-blue9)] px-2.5 text-[12px] font-medium text-white hover:bg-[var(--t-color-blue10)]">
        {tc("apply")}
      </button>
      {href && (
        <button type="button" onClick={() => onDone("")} className="h-7 rounded-md px-2 text-[12px] text-t-text-secondary hover:bg-t-hover">
          {tc("remove")}
        </button>
      )}
    </form>
  );
}
