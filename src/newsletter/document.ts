// A newsletter post's body both ways: the Markdown the editor and the copilot write, and the ProseMirror document
// Substack stores (`draft_body`). Shared with the web app, which previews the document Substack will receive.
//
// Markdown, plus a few Substack blocks written as directives on a line of their own:
//   ::paywall                     everything below is for paid subscribers
//   ::button[Subscribe now](%%checkout_url%%)
//   ::subscribe                   Substack's subscribe button
//   ::share                       a share button
//   ::youtube[dQw4w9WgXcQ]
//   ::embed[<base64>]             a block Richelieu does not edit (a post embed, a poll…), kept as Substack wrote it
// `![alt](https://… "caption")` alone on a line is a captioned image.

export type Mark = { type: string; attrs?: Record<string, unknown> };
export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: Mark[];
};
export type PMDoc = { type: "doc"; content: PMNode[] };

/** Substack's placeholders for its own buttons. */
export const BUTTON_URLS = {
  subscribe: "%%checkout_url%%",
  share: "%%share_url%%",
  comment: "%%half_magic_comments_url%%",
} as const;

// Inline ---------------------------------------------------------------------------------------------------------

const textNode = (text: string, marks: Mark[]): PMNode =>
  marks.length ? { type: "text", text, marks: marks.map((m) => ({ ...m })) } : { type: "text", text };

/** Inline Markdown to text nodes: **strong**, *em* / _em_, `code`, ~~strikethrough~~, [links](url), \escapes. */
export function parseInline(source: string, marks: Mark[] = []): PMNode[] {
  const out: PMNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push(textNode(buffer, marks));
    buffer = "";
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const char = source[i]!;
    if (char === "\\" && i + 1 < source.length && /[\\`*_~[\]()#>!-]/.test(source[i + 1]!)) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push(textNode(source.slice(i + 1, end), [...marks, { type: "code" }]));
        i = end + 1;
        continue;
      }
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      out.push(...parseInline(link[1]!, [...marks, { type: "link", attrs: { href: link[2] } }]));
      i += link[0].length;
      continue;
    }
    const pair = (delimiter: string, type: string) => {
      if (!rest.startsWith(delimiter)) return false;
      const inner = rest.slice(delimiter.length);
      // An opening delimiter is followed by a non-space; the closing one is the next match preceded by a non-space.
      if (!inner || /^\s/.test(inner)) return false;
      let end = -1;
      for (let j = 1; j < inner.length; j++) {
        if (!inner.startsWith(delimiter, j) || /\s/.test(inner[j - 1]!)) continue;
        // A run of the delimiter's character ("***") closes with its last characters: inner marks close first.
        let run = 0;
        while (inner[j + run] === delimiter[0]) run++;
        // ** inside *: a run of exactly two belongs to a strong mark, not to this one.
        if (delimiter.length === 1 && run === 2) {
          j += 1;
          continue;
        }
        end = j + run - delimiter.length;
        break;
      }
      if (end < 0) return false;
      flush();
      out.push(...parseInline(inner.slice(0, end), [...marks, { type }]));
      i += delimiter.length * 2 + end;
      return true;
    };
    if (pair("**", "strong") || pair("__", "strong") || pair("~~", "strikethrough") || pair("*", "em")) continue;
    // _em_ only at word boundaries, so snake_case stays text.
    if (char === "_" && (i === 0 || /[\s(]/.test(source[i - 1]!)) && pair("_", "em")) continue;
    buffer += char;
    i++;
  }
  flush();
  // Adjacent text with the same marks is one node.
  return out.reduce<PMNode[]>((merged, node) => {
    const last = merged.at(-1);
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text += node.text!;
    else merged.push(node);
    return merged;
  }, []);
}

// Blocks ---------------------------------------------------------------------------------------------------------

const paragraph = (text: string): PMNode => {
  const content = parseInline(text);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function encodeEmbed(node: PMNode) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(node))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeEmbed(value: string): PMNode | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const node = JSON.parse(decodeURIComponent(escape(atob(base64)))) as PMNode;
    return node && typeof node.type === "string" ? node : null;
  } catch {
    return null;
  }
}

export function imageNode(src: string, alt: string, caption: string): PMNode {
  const image: PMNode = {
    type: "image2",
    attrs: {
      src,
      alt: alt || null,
      title: null,
      fullscreen: null,
      imageSize: null,
      height: null,
      width: null,
      resizeWidth: null,
      bytes: null,
      type: null,
      href: null,
      belowTheFold: false,
      internalRedirect: null,
    },
  };
  const content: PMNode[] = [image];
  if (caption) content.push({ type: "caption", content: parseInline(caption) });
  return { type: "captionedImage", content };
}

export const buttonNode = (text: string, url: string): PMNode => ({
  type: "button",
  attrs: { url, text, action: null, class: "button-wrapper" },
});

/** Parses a list starting at `lines[start]`; returns the list node and the line after it. */
function parseList(lines: string[], start: number): [PMNode, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: PMNode[] = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]!);
    if (!match || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) break;
    let text = match[3]!;
    i++;
    // Continuation lines (indented, not a new item) join the item's paragraph.
    while (i < lines.length && lines[i]!.trim() && !LIST_ITEM.exec(lines[i]!) && /^\s+/.test(lines[i]!)) {
      text += ` ${lines[i]!.trim()}`;
      i++;
    }
    const content: PMNode[] = [paragraph(text)];
    const nested = i < lines.length ? LIST_ITEM.exec(lines[i]!) : null;
    if (nested && nested[1]!.length > indent) {
      const [sub, next] = parseList(lines, i);
      content.push(sub);
      i = next;
    }
    items.push({ type: "list_item", content });
  }
  const list: PMNode = ordered
    ? { type: "ordered_list", attrs: { start: Number(first[2]!.replace(/\D/g, "")) || 1, order: 1 }, content: items }
    : { type: "bullet_list", content: items };
  return [list, i];
}

function parseBlocks(lines: string[]): PMNode[] {
  const blocks: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    // Fenced code.
    const fence = /^(```|~~~)\s*([\w+-]*)/.exec(trimmed);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) code.push(lines[i++]!);
      i++;
      const text = code.join("\n");
      blocks.push({
        type: "code_block",
        ...(fence[2] ? { attrs: { language: fence[2] } } : {}),
        ...(text ? { content: [{ type: "text", text }] } : {}),
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      blocks.push({ type: "heading", attrs: { level: heading[1]!.length }, content: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "horizontal_rule" });
      i++;
      continue;
    }
    // Directives.
    if (/^::paywall\s*$/i.test(trimmed)) {
      blocks.push({ type: "paywall" });
      i++;
      continue;
    }
    if (/^::subscribe\s*$/i.test(trimmed)) {
      blocks.push(buttonNode("Subscribe now", BUTTON_URLS.subscribe));
      i++;
      continue;
    }
    if (/^::share\s*$/i.test(trimmed)) {
      blocks.push(buttonNode("Share", BUTTON_URLS.share));
      i++;
      continue;
    }
    const button = /^::button\[([^\]]*)\]\(([^)\s]+)\)\s*$/i.exec(trimmed);
    if (button) {
      blocks.push(buttonNode(button[1]!, button[2]!));
      i++;
      continue;
    }
    const youtube = /^::youtube\[([\w-]{6,})\]\s*$/i.exec(trimmed);
    if (youtube) {
      blocks.push({ type: "youtube2", attrs: { videoId: youtube[1], startTime: null, endTime: null } });
      i++;
      continue;
    }
    const embed = /^::embed\[([\w-]+)\]\s*$/.exec(trimmed);
    if (embed) {
      const node = decodeEmbed(embed[1]!);
      if (node) blocks.push(node);
      i++;
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(trimmed);
    if (image) {
      blocks.push(imageNode(image[2]!, image[1]!, image[3] ?? ""));
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) quoted.push(lines[i++]!.trim().replace(/^>\s?/, ""));
      blocks.push({ type: "blockquote", content: parseBlocks(quoted) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    // A paragraph: lines up to a blank line or the start of another block.
    const text: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!.trim();
      if (
        !current ||
        (text.length &&
          (/^(#{1,6}\s|```|~~~|>|::|!\[)/.test(current) || LIST_ITEM.test(lines[i]!) || /^(-{3,}|\*{3,})$/.test(current)))
      )
        break;
      text.push(current);
      i++;
    }
    blocks.push(paragraph(text.join(" ")));
  }
  return blocks;
}

export function markdownToDoc(markdown: string): PMDoc {
  return { type: "doc", content: parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n")) };
}

// Back to Markdown ------------------------------------------------------------------------------------------------

const escapeText = (text: string) => text.replace(/([\\`*~[\]])/g, "\\$1").replace(/(^|\s)_/g, "$1\\_");

function inlineToMarkdown(nodes: PMNode[] = []): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "hard_break") {
      out += " ";
      continue;
    }
    if (node.type !== "text") {
      out += inlineToMarkdown(node.content);
      continue;
    }
    const marks = node.marks ?? [];
    const has = (type: string) => marks.some((m) => m.type === type);
    let text = has("code") ? `\`${node.text ?? ""}\`` : escapeText(node.text ?? "");
    // Delimiters hug the text: move edge spaces outside them.
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text)![0];
    text = text.trim();
    if (text) {
      if (has("em")) text = `*${text}*`;
      if (has("strong")) text = `**${text}**`;
      if (has("strikethrough")) text = `~~${text}~~`;
      const link = marks.find((m) => m.type === "link");
      if (link) text = `[${text}](${String(link.attrs?.href ?? "")})`;
    }
    out += lead + text + trail;
  }
  // Adjacent links with the same target, split by marks, read better merged: leave as is (still valid Markdown).
  return out;
}

const plainText = (nodes: PMNode[] = []): string =>
  nodes.map((n) => (n.type === "text" ? (n.text ?? "") : plainText(n.content))).join("");

function blockToMarkdown(node: PMNode, depth = 0): string {
  switch (node.type) {
    case "paragraph":
      return inlineToMarkdown(node.content);
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inlineToMarkdown(node.content)}`;
    case "horizontal_rule":
      return "---";
    case "paywall":
      return "::paywall";
    case "blockquote":
    case "pullquote":
      return (node.content ?? [])
        .map((child) => blockToMarkdown(child, depth))
        .join("\n\n")
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "code_block":
    case "highlighted_code_block":
      return `\`\`\`${String(node.attrs?.language ?? "")}\n${plainText(node.content)}\n\`\`\``;
    case "bullet_list":
    case "ordered_list": {
      const ordered = node.type === "ordered_list";
      let n = Number(node.attrs?.start) || 1;
      return (node.content ?? [])
        .map((item) => {
          const marker = ordered ? `${n++}.` : "-";
          const [first, ...rest] = item.content ?? [];
          const head = `${"  ".repeat(depth)}${marker} ${first ? blockToMarkdown(first, depth + 1) : ""}`;
          const tail = rest.map((child) =>
            child.type === "bullet_list" || child.type === "ordered_list"
              ? blockToMarkdown(child, depth + 1)
              : `${"  ".repeat(depth + 1)}${blockToMarkdown(child, depth + 1)}`,
          );
          return [head, ...tail].join("\n");
        })
        .join("\n");
    }
    case "captionedImage": {
      const image = node.content?.find((c) => c.type === "image2" || c.type === "image");
      const caption = node.content?.find((c) => c.type === "caption");
      if (!image) break;
      const alt = String(image.attrs?.alt ?? "").replace(/[[\]]/g, "");
      const captionText = caption ? plainText(caption.content).replace(/"/g, "'") : "";
      return `![${alt}](${String(image.attrs?.src ?? "")}${captionText ? ` "${captionText}"` : ""})`;
    }
    case "button": {
      const url = String(node.attrs?.url ?? "");
      const text = String(node.attrs?.text ?? "");
      if (url === BUTTON_URLS.subscribe && text === "Subscribe now") return "::subscribe";
      if (url === BUTTON_URLS.share && text === "Share") return "::share";
      return `::button[${text.replace(/[[\]]/g, "")}](${url})`;
    }
    case "youtube2":
      if (node.attrs?.videoId && !node.attrs.startTime && !node.attrs.endTime) return `::youtube[${String(node.attrs.videoId)}]`;
      break;
  }
  // Anything else stays as Substack wrote it.
  return `::embed[${encodeEmbed(node)}]`;
}

export function docToMarkdown(doc: PMDoc | null | undefined): string {
  return (doc?.content ?? [])
    .map((node) => blockToMarkdown(node))
    .join("\n\n")
    .trim();
}

/** `draft_body` as Substack sends it: a JSON string, or already parsed. */
export function parseBody(body: unknown): PMDoc {
  if (typeof body === "string") {
    if (!body.trim()) return { type: "doc", content: [] };
    try {
      return parseBody(JSON.parse(body));
    } catch {
      return markdownToDoc(body);
    }
  }
  if (body && typeof body === "object" && (body as PMDoc).type === "doc")
    return { type: "doc", content: (body as PMDoc).content ?? [] };
  return { type: "doc", content: [] };
}

/** The text a reader sees, for word counts and the copilot. */
export function docText(doc: PMDoc): string {
  return doc.content.map((node) => plainText([node])).join("\n\n");
}

export function wordCount(markdown: string) {
  return docText(markdownToDoc(markdown)).split(/\s+/).filter(Boolean).length;
}

/** The first embed-free text, for a post's preview line. */
export function excerpt(markdown: string, length = 180) {
  const text = docText(markdownToDoc(markdown)).replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
