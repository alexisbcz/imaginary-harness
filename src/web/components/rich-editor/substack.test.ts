import { describe, expect, it } from "bun:test";
import { markdownToDoc, docToMarkdown } from "../../../newsletter/document.ts";
import { substackToTiptap, tiptapToSubstack } from "./substack.ts";

describe("TipTap and Substack documents", () => {
  it("round-trips every block the editor knows", () => {
    const markdown = `## A section

Some **bold**, *em*, ~~gone~~, \`code\` and a [link](https://example.com).

- one
- two
  - nested

3. third
4. fourth

> a quote

![alt](https://img/x.png "caption")

::paywall

::subscribe

::button[Go](https://example.com)

::youtube[dQw4w9WgXcQ]

---

\`\`\`js
let a = 1;
\`\`\``;
    const doc = markdownToDoc(markdown);
    const tiptap = substackToTiptap(doc);
    expect(tiptap.content!.map((n) => n.type)).toEqual([
      "heading", "paragraph", "bulletList", "orderedList", "blockquote", "figure", "paywall", "ctaButton", "ctaButton", "youtube", "horizontalRule", "codeBlock",
    ]);
    expect(docToMarkdown(tiptapToSubstack(tiptap))).toBe(markdown);
  });

  it("keeps blocks it does not know exactly", () => {
    const embed = { type: "digestPostEmbed", attrs: { postId: 42 } };
    const tiptap = substackToTiptap({ type: "doc", content: [embed] });
    expect(tiptap.content![0]).toEqual({ type: "rawEmbed", attrs: { node: embed } });
    expect(tiptapToSubstack(tiptap).content).toEqual([embed]);
  });

  it("leaves images still uploading out of what is saved", () => {
    const saved = tiptapToSubstack({
      type: "doc",
      content: [
        { type: "figure", attrs: { src: "blob:http://x/1", uploadId: "u1" } },
        { type: "figure", attrs: { src: "https://cdn/x.png", size: "small", caption: "c" } },
      ],
    });
    expect(saved.content.length).toBe(1);
    expect(saved.content[0]!.content![0]!.attrs!.resizeWidth).toBe(300);
    expect(substackToTiptap(saved).content![0]!.attrs!.size).toBe("small");
  });
});
