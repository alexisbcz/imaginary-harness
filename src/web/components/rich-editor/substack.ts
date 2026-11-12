// TipTap's document and Substack's are both ProseMirror: the same tree under other names (bulletList and
// bullet_list, bold and strong…). These map one onto the other, node by node, so the editor edits Substack's own
// document; what neither knows travels as a raw embed and comes back exactly as it was.

import type { JSONContent } from "@tiptap/core";
import {
  buttonNode,
  docToMarkdown,
  imageNode,
  markdownToDoc,
  type Mark,
  type PMDoc,
  type PMNode,
} from "../../../newsletter/document.ts";

const MARKS_IN: Record<string, string> = { strong: "bold", em: "italic", strikethrough: "strike", code: "code", link: "link" };
const MARKS_OUT = Object.fromEntries(Object.entries(MARKS_IN).map(([k, v]) => [v, k]));

const plain = (nodes: PMNode[] = []): string => nodes.map((n) => (n.type === "text" ? (n.text ?? "") : plain(n.content))).join("");

function marksIn(marks: Mark[] | undefined) {
  const out = (marks ?? [])
    .filter((m) => MARKS_IN[m.type])
    .map((m) => (m.type === "link" ? { type: "link", attrs: { href: String(m.attrs?.href ?? "") } } : { type: MARKS_IN[m.type]! }));
  return out.length ? out : undefined;
}

function children(nodes: PMNode[] | undefined) {
  const out = (nodes ?? []).map(toTiptap).filter((n): n is JSONContent => n !== null);
  return out.length ? out : undefined;
}

function toTiptap(node: PMNode): JSONContent | null {
  switch (node.type) {
    case "text":
      return node.text ? { type: "text", text: node.text, marks: marksIn(node.marks) } : null;
    case "hard_break":
      return { type: "hardBreak" };
    case "paragraph":
      return { type: "paragraph", content: children(node.content) };
    case "heading":
      return { type: "heading", attrs: { level: Math.min(6, Math.max(1, Number(node.attrs?.level) || 2)) }, content: children(node.content) };
    case "blockquote":
      return { type: "blockquote", content: children(node.content) ?? [{ type: "paragraph" }] };
    case "bullet_list":
      return { type: "bulletList", content: children(node.content) };
    case "ordered_list":
      return { type: "orderedList", attrs: { start: Number(node.attrs?.start) || 1 }, content: children(node.content) };
    case "list_item":
      return { type: "listItem", content: children(node.content) ?? [{ type: "paragraph" }] };
    case "code_block":
    case "highlighted_code_block": {
      const text = plain(node.content);
      return { type: "codeBlock", attrs: { language: node.attrs?.language ?? null }, content: text ? [{ type: "text", text }] : undefined };
    }
    case "horizontal_rule":
      return { type: "horizontalRule" };
    case "paywall":
      return { type: "paywall" };
    case "button":
      return { type: "ctaButton", attrs: { text: String(node.attrs?.text ?? ""), url: String(node.attrs?.url ?? "") } };
    case "youtube2":
      if (node.attrs?.videoId && !node.attrs.startTime && !node.attrs.endTime) return { type: "youtube", attrs: { videoId: node.attrs.videoId } };
      break;
    case "captionedImage": {
      const image = node.content?.find((c) => c.type === "image2" || c.type === "image");
      const caption = node.content?.find((c) => c.type === "caption");
      if (!image?.attrs?.src) break;
      const width = Number(image.attrs.resizeWidth) || 0;
      return {
        type: "figure",
        attrs: {
          src: String(image.attrs.src),
          alt: String(image.attrs.alt ?? ""),
          caption: caption ? plain(caption.content) : "",
          size: width && width < 400 ? "small" : width && width < 600 ? "medium" : "full",
        },
      };
    }
  }
  return { type: "rawEmbed", attrs: { node } };
}

export function substackToTiptap(doc: PMDoc): JSONContent {
  const content = children(doc.content);
  return { type: "doc", content: content ?? [{ type: "paragraph" }] };
}

function marksOut(marks: JSONContent["marks"]): Mark[] | undefined {
  const out = (marks ?? [])
    .filter((m) => MARKS_OUT[m.type])
    .map((m) => (m.type === "link" ? { type: "link", attrs: { href: String(m.attrs?.href ?? "") } } : { type: MARKS_OUT[m.type]! }));
  return out.length ? out : undefined;
}

function childrenOut(nodes: JSONContent[] | undefined) {
  const out = (nodes ?? []).map(fromTiptap).filter((n): n is PMNode => n !== null);
  return out.length ? out : undefined;
}

const SIZE_WIDTHS: Record<string, number | null> = { small: 300, medium: 500, full: null };

function fromTiptap(node: JSONContent): PMNode | null {
  switch (node.type) {
    case "text":
      return node.text ? { type: "text", text: node.text, ...(marksOut(node.marks) ? { marks: marksOut(node.marks) } : {}) } : null;
    case "hardBreak":
      return { type: "hard_break" };
    case "paragraph": {
      const content = childrenOut(node.content);
      return content ? { type: "paragraph", content } : { type: "paragraph" };
    }
    case "heading":
      return { type: "heading", attrs: { level: Number(node.attrs?.level) || 2 }, content: childrenOut(node.content) };
    case "blockquote":
      return { type: "blockquote", content: childrenOut(node.content) };
    case "bulletList":
      return { type: "bullet_list", content: childrenOut(node.content) };
    case "orderedList":
      return { type: "ordered_list", attrs: { start: Number(node.attrs?.start) || 1, order: 1 }, content: childrenOut(node.content) };
    case "listItem":
      return { type: "list_item", content: childrenOut(node.content) };
    case "codeBlock": {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return {
        type: "code_block",
        ...(node.attrs?.language ? { attrs: { language: node.attrs.language } } : {}),
        ...(text ? { content: [{ type: "text", text }] } : {}),
      };
    }
    case "horizontalRule":
      return { type: "horizontal_rule" };
    case "paywall":
      return { type: "paywall" };
    case "ctaButton":
      return buttonNode(String(node.attrs?.text ?? ""), String(node.attrs?.url ?? ""));
    case "youtube":
      return { type: "youtube2", attrs: { videoId: node.attrs?.videoId, startTime: null, endTime: null } };
    case "figure": {
      // An image still uploading has no address Substack can keep yet.
      if (!node.attrs?.src || node.attrs.uploadId || String(node.attrs.src).startsWith("blob:")) return null;
      const figure = imageNode(String(node.attrs.src), String(node.attrs.alt ?? ""), String(node.attrs.caption ?? ""));
      const width = SIZE_WIDTHS[String(node.attrs.size)] ?? null;
      if (width) (figure.content![0]!.attrs as Record<string, unknown>).resizeWidth = width;
      return figure;
    }
    case "rawEmbed":
      return (node.attrs?.node as PMNode | null) ?? null;
  }
  // Marks and nodes the newsletter does not use (underline…) keep their text.
  const content = childrenOut(node.content);
  return content ? { type: "paragraph", content } : null;
}

export function tiptapToSubstack(doc: JSONContent): PMDoc {
  return { type: "doc", content: childrenOut(doc.content) ?? [] };
}

export const tiptapToMarkdown = (doc: JSONContent) => docToMarkdown(tiptapToSubstack(doc));
export const markdownToTiptap = (markdown: string) => substackToTiptap(markdownToDoc(markdown));
