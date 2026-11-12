// The editor's own blocks, each drawn by a React node view: a figure (an image with its size, alt text and caption,
// and an upload in progress), a call-to-action button, the paywall, a YouTube video, and a block kept as Substack
// wrote it. They are atoms: selected, dragged and deleted whole; their fields edit in place.

import { useEffect, useRef, useState } from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import {
  IconAlertTriangle,
  IconBrandYoutubeFilled,
  IconLink,
  IconLock,
  IconPuzzle,
  IconReplace,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";

import i18n from "@/lib/i18n";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    figure: { setFigure: (attrs: FigureAttrs) => ReturnType };
    ctaButton: { setCtaButton: (attrs: { text: string; url: string }) => ReturnType };
    paywall: { setPaywall: () => ReturnType };
    youtube: { setYoutube: (attrs: { videoId: string }) => ReturnType };
  }
}

export type FigureSize = "small" | "medium" | "full";
export type FigureAttrs = {
  src: string;
  alt?: string;
  caption?: string;
  size?: FigureSize;
  /** While uploading: the upload's id, to find the node again when its address arrives. */
  uploadId?: string | null;
  error?: string | null;
};

/** Called by a figure's "Replace": the editor picks a file and uploads it in the node's place. */
export type ReplaceImage = (pos: number) => void;

// A floating row of small controls over a selected block.
function Controls({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      contentEditable={false}
      className={cn(
        "absolute z-10 flex items-center gap-0.5 rounded-lg border border-t-border bg-t-primary p-0.5 font-sans text-[12px] shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ControlButton({
  label,
  active,
  onClick,
  children,
  danger,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-t-text-secondary transition-colors hover:bg-t-hover hover:text-t-text",
        active && "bg-t-hover text-t-text",
        danger && "hover:text-[var(--t-color-red10)]",
      )}
    >
      {children}
    </button>
  );
}

// Figure -----------------------------------------------------------------------------------------------------------

function FigureView({ node, updateAttributes, deleteNode, selected, editor, getPos, extension }: ReactNodeViewProps) {
  const { t } = useTranslation("editor");
  const attrs = node.attrs as Required<FigureAttrs>;
  const [editingAlt, setEditingAlt] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const editable = editor.isEditable;
  const replace = (extension.options as { onReplace?: ReplaceImage }).onReplace;
  const widths: Record<FigureSize, string> = { small: "max-w-[45%]", medium: "max-w-[75%]", full: "max-w-full" };

  return (
    <NodeViewWrapper as="figure" className="rich-figure relative my-6" data-size={attrs.size} data-drag-handle>
      <div className={cn("relative mx-auto w-fit", widths[attrs.size] ?? "max-w-full")}>
        <img
          src={attrs.src}
          alt={attrs.alt}
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cn(
            "block max-h-[640px] rounded-md object-contain transition-[filter,opacity] duration-300",
            selected && editable && "outline-2 outline-offset-2 outline-[var(--t-color-blue9)]",
            attrs.uploadId && "opacity-60 blur-[1px]",
            !loaded && "min-h-24 min-w-48 bg-t-secondary",
          )}
        />
        {attrs.uploadId && (
          <div contentEditable={false} className="absolute inset-0 flex items-center justify-center">
            <span className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 font-sans text-[12px] text-white backdrop-blur">
              <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              {t("figure.uploading")}
            </span>
          </div>
        )}
        {attrs.error && (
          <div contentEditable={false} className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-md bg-[var(--t-color-red9)] px-3 py-1.5 font-sans text-[12px] text-white">
            <IconAlertTriangle size={14} /> {attrs.error}
          </div>
        )}
        {selected && editable && !attrs.uploadId && (
          <Controls className="top-2 left-1/2 -translate-x-1/2">
            {(["small", "medium", "full"] as const).map((size) => (
              <ControlButton key={size} label={t(`figure.width.${size}`)} active={attrs.size === size} onClick={() => updateAttributes({ size })}>
                {t(`figure.short.${size}`)}
              </ControlButton>
            ))}
            <span className="mx-0.5 h-4 w-px bg-t-border" />
            <ControlButton label={t("figure.altLabel")} active={editingAlt || Boolean(attrs.alt)} onClick={() => setEditingAlt((v) => !v)}>
              {t("figure.alt")}
            </ControlButton>
            {replace && (
              <ControlButton label={t("figure.replace")} onClick={() => {
                const pos = getPos();
                if (typeof pos === "number") replace(pos);
              }}>
                <IconReplace size={15} />
              </ControlButton>
            )}
            <ControlButton label={t("figure.remove")} danger onClick={deleteNode}>
              <IconTrash size={15} />
            </ControlButton>
          </Controls>
        )}
        {editingAlt && selected && (
          <Controls className="top-12 left-1/2 w-[min(360px,90%)] -translate-x-1/2 p-1.5">
            <input
              autoFocus
              value={attrs.alt ?? ""}
              placeholder={t("figure.altPlaceholder")}
              onChange={(e) => updateAttributes({ alt: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  setEditingAlt(false);
                  editor.commands.focus();
                }
              }}
              className="w-full rounded-md bg-t-secondary px-2 py-1.5 text-[13px] text-t-text outline-none placeholder:text-t-text-light"
            />
          </Controls>
        )}
      </div>
      {(editable || attrs.caption) && (
        <input
          value={attrs.caption ?? ""}
          readOnly={!editable}
          placeholder={t("figure.caption")}
          onChange={(e) => updateAttributes({ caption: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const pos = getPos();
              if (typeof pos === "number")
                editor.chain().insertContentAt(pos + node.nodeSize, { type: "paragraph" }).focus(pos + node.nodeSize + 1).run();
            }
          }}
          className={cn(
            "rich-caption mt-2 block w-full bg-transparent text-center font-sans text-[13px] text-t-text-tertiary outline-none placeholder:text-t-text-light",
            !attrs.caption && "opacity-0 group-hover:opacity-100 focus:opacity-100",
            (selected || attrs.caption) && "opacity-100",
          )}
        />
      )}
    </NodeViewWrapper>
  );
}

export const Figure = Node.create<{ onReplace?: ReplaceImage }>({
  name: "figure",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ onReplace: undefined }),
  addAttributes: () => ({
    src: { default: "" },
    alt: { default: "" },
    caption: { default: "" },
    size: { default: "full" },
    uploadId: { default: null, rendered: false },
    error: { default: null, rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "figure",
      getAttrs: (el) => {
        const img = (el as HTMLElement).querySelector("img");
        if (!img) return false;
        return {
          src: img.getAttribute("src") ?? "",
          alt: img.getAttribute("alt") ?? "",
          caption: (el as HTMLElement).querySelector("figcaption")?.textContent ?? "",
          size: (el as HTMLElement).dataset.size ?? "full",
        };
      },
    },
    {
      tag: "img[src]",
      getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute("src"), alt: (el as HTMLElement).getAttribute("alt") ?? "" }),
    },
  ],
  renderHTML: ({ HTMLAttributes, node }) => [
    "figure",
    { "data-size": node.attrs.size },
    ["img", { src: HTMLAttributes.src, alt: HTMLAttributes.alt ?? "" }],
    ...(node.attrs.caption ? [["figcaption", {}, node.attrs.caption]] : []),
  ],
  addCommands() {
    return {
      setFigure:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(FigureView);
  },
});

// Call to action -------------------------------------------------------------------------------------------------

/** Substack's special addresses, and the key of each one's name in `button.targets`. */
const BUTTON_TARGETS: Record<string, "subscribe" | "share" | "comments"> = {
  "%%checkout_url%%": "subscribe",
  "%%share_url%%": "share",
  "%%half_magic_comments_url%%": "comments",
};

function ButtonView({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const { t } = useTranslation("editor");
  const { text, url } = node.attrs as { text: string; url: string };
  const editable = editor.isEditable;
  const label = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selected && editable && !text) label.current?.focus();
  }, [selected, editable, text]);
  return (
    <NodeViewWrapper className="relative my-7 flex flex-col items-center" data-drag-handle>
      <span
        className={cn(
          "inline-flex rounded-md bg-[var(--rich-accent)] px-1 py-1 shadow-sm transition-shadow",
          selected && editable && "ring-2 ring-[var(--t-color-blue9)] ring-offset-2 ring-offset-[var(--t-background-primary)]",
        )}
      >
        <input
          ref={label}
          value={text}
          readOnly={!editable}
          size={Math.max(6, text.length + 1)}
          placeholder={t("button.placeholder")}
          onChange={(e) => updateAttributes({ text: e.target.value })}
          className="bg-transparent px-4 py-1.5 text-center font-sans text-[15px] font-semibold text-white outline-none placeholder:text-white/60"
        />
      </span>
      {selected && editable && (
        <Controls className="top-full mt-2 w-[min(420px,92%)] p-1">
          <IconLink size={14} className="mx-1.5 shrink-0 text-t-text-tertiary" />
          <select
            value={BUTTON_TARGETS[url] ? url : "link"}
            onChange={(e) => updateAttributes({ url: e.target.value === "link" ? "https://" : e.target.value })}
            className="h-7 shrink-0 rounded-md bg-t-secondary px-1.5 text-[12px] text-t-text outline-none"
          >
            <option value="link">{t("button.link")}</option>
            {Object.entries(BUTTON_TARGETS).map(([value, name]) => (
              <option key={value} value={value}>{t(`button.targets.${name}`)}</option>
            ))}
          </select>
          {!BUTTON_TARGETS[url] && (
            <input
              value={url}
              placeholder="https://"
              onChange={(e) => updateAttributes({ url: e.target.value })}
              className="h-7 min-w-0 flex-1 rounded-md bg-t-secondary px-2 text-[12px] text-t-text outline-none"
            />
          )}
          <ControlButton label={t("button.remove")} danger onClick={deleteNode}>
            <IconTrash size={14} />
          </ControlButton>
        </Controls>
      )}
    </NodeViewWrapper>
  );
}

export const CtaButton = Node.create({
  name: "ctaButton",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({ text: { default: i18n.t("editor:subscribeNow") }, url: { default: "%%checkout_url%%" } }),
  parseHTML: () => [
    {
      tag: "a[data-button]",
      getAttrs: (el) => ({ text: (el as HTMLElement).textContent ?? "", url: (el as HTMLElement).getAttribute("href") ?? "" }),
    },
  ],
  renderHTML: ({ node }) => ["p", { style: "text-align:center" }, ["a", mergeAttributes({ "data-button": "", href: node.attrs.url }), node.attrs.text]],
  addCommands() {
    return {
      setCtaButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ButtonView);
  },
});

// Paywall --------------------------------------------------------------------------------------------------------

function PaywallView({ selected }: ReactNodeViewProps) {
  const { t } = useTranslation("editor");
  return (
    <NodeViewWrapper className="my-8" data-drag-handle>
      <div
        contentEditable={false}
        className={cn(
          "flex items-center gap-3 rounded-md py-1 font-sans text-[11px] font-semibold tracking-[0.08em] text-[var(--rich-accent)] uppercase",
          selected && "bg-t-hover",
        )}
      >
        <span className="h-px flex-1 bg-[var(--rich-accent)] opacity-40" />
        <IconLock size={13} /> {t("paywall")}
        <span className="h-px flex-1 bg-[var(--rich-accent)] opacity-40" />
      </div>
    </NodeViewWrapper>
  );
}

export const Paywall = Node.create({
  name: "paywall",
  group: "block",
  atom: true,
  draggable: true,
  parseHTML: () => [{ tag: "div[data-paywall]" }],
  renderHTML: () => ["div", { "data-paywall": "" }],
  addCommands() {
    return {
      setPaywall:
        () =>
        ({ commands, editor }) => {
          // One paywall a post: move it rather than add a second.
          let existing = -1;
          editor.state.doc.descendants((node, pos) => {
            if (node.type.name === this.name) existing = pos;
          });
          if (existing >= 0) commands.deleteRange({ from: existing, to: existing + 1 });
          return commands.insertContent({ type: this.name });
        },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(PaywallView);
  },
});

// YouTube --------------------------------------------------------------------------------------------------------

function YoutubeView({ node, selected }: ReactNodeViewProps) {
  const id = String(node.attrs.videoId ?? "");
  return (
    <NodeViewWrapper className="my-6" data-drag-handle>
      <div
        contentEditable={false}
        className={cn(
          "relative aspect-video overflow-hidden rounded-md bg-black",
          selected && "outline-2 outline-offset-2 outline-[var(--t-color-blue9)]",
        )}
      >
        <img src={`https://img.youtube.com/vi/${id}/hqdefault.jpg`} alt="" className="size-full object-cover opacity-90" draggable={false} />
        <IconBrandYoutubeFilled size={64} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[#ff0033] drop-shadow-lg" />
      </div>
    </NodeViewWrapper>
  );
}

export const Youtube = Node.create({
  name: "youtube",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ videoId: { default: "" } }),
  parseHTML: () => [{ tag: "div[data-youtube]", getAttrs: (el) => ({ videoId: (el as HTMLElement).dataset.youtube }) }],
  renderHTML: ({ node }) => ["div", { "data-youtube": node.attrs.videoId }],
  addCommands() {
    return {
      setYoutube:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(YoutubeView);
  },
});

export function youtubeId(url: string) {
  return /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/.exec(url)?.[1] ?? (/^[\w-]{11}$/.test(url.trim()) ? url.trim() : null);
}

// A block kept as Substack wrote it ------------------------------------------------------------------------------

function EmbedView({ node, selected }: ReactNodeViewProps) {
  const { t } = useTranslation("editor");
  const kind = String((node.attrs.node as { type?: string } | null)?.type ?? "block");
  return (
    <NodeViewWrapper className="my-5" data-drag-handle>
      <div
        contentEditable={false}
        className={cn(
          "flex items-center gap-2 rounded-md border border-dashed border-t-border px-3 py-2.5 font-sans text-[13px] text-t-text-tertiary",
          selected && "border-[var(--t-color-blue9)] bg-t-hover",
        )}
      >
        <IconPuzzle size={15} /> {t("embed", { kind: kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() })}
      </div>
    </NodeViewWrapper>
  );
}

export const RawEmbed = Node.create({
  name: "rawEmbed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ node: { default: null } }),
  parseHTML: () => [{ tag: "div[data-raw-embed]" }],
  renderHTML: () => ["div", { "data-raw-embed": "" }],
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});

