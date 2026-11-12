// What the mail composer's editor becomes when it is sent: HTML that mail clients draw the same way (styles inlined,
// as Gmail and Outlook ignore style sheets), with each image pasted or dropped into the text carried as an inline
// part of the message (cid:), and a plain-text version beside it.

export type InlineAttachment = {
  filename: string;
  contentType: string;
  data: string;
  size: number;
  contentId: string;
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif`;

const STYLES: Record<string, string> = {
  p: "margin:0 0 12px 0;",
  h1: "margin:20px 0 10px 0;font-size:24px;line-height:1.25;font-weight:700;",
  h2: "margin:18px 0 8px 0;font-size:20px;line-height:1.3;font-weight:700;",
  h3: "margin:16px 0 6px 0;font-size:17px;line-height:1.35;font-weight:600;",
  blockquote: "margin:0 0 12px 0;padding:2px 0 2px 14px;border-left:3px solid #d0d5dd;color:#475467;",
  ul: "margin:0 0 12px 0;padding-left:24px;",
  ol: "margin:0 0 12px 0;padding-left:24px;",
  li: "margin:0 0 4px 0;",
  a: "color:#2563eb;text-decoration:underline;",
  code: "font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em;background:#f2f4f7;border-radius:4px;padding:1px 4px;",
  pre: "margin:0 0 12px 0;padding:12px;background:#f2f4f7;border-radius:6px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;",
  hr: "border:0;border-top:1px solid #e4e7ec;margin:20px 0;",
  mark: "border-radius:2px;padding:0 2px;",
};

const WIDTHS: Record<string, string> = { small: "45%", medium: "75%", full: "100%" };

function extensionOf(type: string) {
  return { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[type] ?? "bin";
}

/** The editor's HTML as a message: inline styles, inline images, and the text alternative. */
export function toEmail(html: string, text: string): { html: string; text: string; inline: InlineAttachment[] } {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root")!;
  const inline: InlineAttachment[] = [];

  root.querySelectorAll("img").forEach((img, index) => {
    const src = img.getAttribute("src") ?? "";
    const data = /^data:([\w/+.-]+);base64,(.*)$/.exec(src);
    if (data) {
      const contentId = `img${index}.${crypto.randomUUID()}@richelieu`;
      inline.push({
        filename: `image-${index + 1}.${extensionOf(data[1]!)}`,
        contentType: data[1]!,
        data: data[2]!,
        size: Math.floor((data[2]!.length * 3) / 4),
        contentId,
      });
      img.setAttribute("src", `cid:${contentId}`);
    }
  });

  // Figures become centered blocks with a width; captions sit under them.
  root.querySelectorAll("figure").forEach((figure) => {
    const width = WIDTHS[figure.getAttribute("data-size") ?? "full"] ?? "100%";
    const block = doc.createElement("div");
    block.setAttribute("style", "margin:16px 0;text-align:center;");
    const img = figure.querySelector("img");
    if (img) {
      img.setAttribute("style", `display:inline-block;max-width:${width};width:${width};height:auto;border:0;border-radius:6px;`);
      block.appendChild(img);
    }
    const caption = figure.querySelector("figcaption");
    if (caption?.textContent) {
      const p = doc.createElement("div");
      p.setAttribute("style", "margin-top:6px;font-size:12px;color:#667085;");
      p.textContent = caption.textContent;
      block.appendChild(p);
    }
    figure.replaceWith(block);
  });

  for (const [tag, style] of Object.entries(STYLES))
    root.querySelectorAll(tag).forEach((el) => {
      // Text alignment and colors from the editor stay; the base style goes first.
      el.setAttribute("style", `${style}${el.getAttribute("style") ?? ""}`);
    });
  // Code inside a block is styled by its block.
  root.querySelectorAll("pre code").forEach((el) => el.removeAttribute("style"));
  // A paragraph inside a list item needs no margin.
  root.querySelectorAll("li > p").forEach((el) => el.setAttribute("style", `margin:0;${(el.getAttribute("style") ?? "").replace(STYLES.p!, "")}`));

  const body = `<div style="font-family:${FONT};font-size:14px;line-height:1.6;color:#101828;">${root.innerHTML}</div>`;
  return { html: body, text: text.replace(/\n{3,}/g, "\n\n").trim(), inline };
}

/** Plain text (a reply's quote, an old draft) as the editor's HTML: paragraphs, with quoted lines as quotes. */
export function textToHtml(text: string) {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) quoted.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(`<blockquote>${textToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith(">")) paragraph.push(escape(lines[i++]!));
    if (paragraph.length) blocks.push(`<p>${paragraph.join("<br>")}</p>`);
    else {
      if (blocks.length === 0 || i > 0) blocks.push("<p></p>");
      i++;
    }
  }
  return blocks.join("").replace(/(<p><\/p>){2,}/g, "<p></p>");
}

/** An image file as a data URL, shrunk so a photo does not weigh megabytes in a message. */
export async function imageDataUrl(file: File, maxSide = 1600): Promise<string> {
  if (file.type === "image/gif" || file.type === "image/svg+xml") return readDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  return canvas.toDataURL(type, 0.86);
}

const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
