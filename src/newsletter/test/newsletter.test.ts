import { describe, expect, it } from "bun:test";
import { applyEdits } from "../agent.ts";
import { docToMarkdown, markdownToDoc, parseBody, parseInline, wordCount, type PMDoc } from "../document.ts";
import { open, seal } from "../secrets.ts";
import { publicationOrigin, sessionToken, Substack, SubstackError } from "../substack.ts";

describe("markdown to Substack's document", () => {
  it("reads inline marks", () => {
    expect(parseInline("a **bold** and *em* `code` ~~gone~~ [link](https://x.com)")).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: "bold", marks: [{ type: "strong" }] },
      { type: "text", text: " and " },
      { type: "text", text: "em", marks: [{ type: "em" }] },
      { type: "text", text: " " },
      { type: "text", text: "code", marks: [{ type: "code" }] },
      { type: "text", text: " " },
      { type: "text", text: "gone", marks: [{ type: "strikethrough" }] },
      { type: "text", text: " " },
      { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.com" } }] },
    ]);
  });

  it("leaves snake_case and lone stars as text", () => {
    expect(parseInline("my_var_name costs 2 * 3")).toEqual([{ type: "text", text: "my_var_name costs 2 * 3" }]);
  });

  it("nests marks", () => {
    expect(parseInline("**bold *and em***")).toEqual([
      { type: "text", text: "bold ", marks: [{ type: "strong" }] },
      { type: "text", text: "and em", marks: [{ type: "strong" }, { type: "em" }] },
    ]);
  });

  it("reads blocks and Substack's directives", () => {
    const doc = markdownToDoc(`# Title

A paragraph
on two lines.

- one
- two
  - nested

1. first
2. second

> quoted

![a cat](https://img/cat.png "My cat")

::paywall

::subscribe

::button[Read more](https://example.com)

::youtube[dQw4w9WgXcQ]

---

\`\`\`ts
const x = 1;
\`\`\``);
    expect(doc.content.map((n) => n.type)).toEqual([
      "heading",
      "paragraph",
      "bullet_list",
      "ordered_list",
      "blockquote",
      "captionedImage",
      "paywall",
      "button",
      "button",
      "youtube2",
      "horizontal_rule",
      "code_block",
    ]);
    expect(doc.content[1]!.content![0]!.text).toBe("A paragraph on two lines.");
    expect(doc.content[2]!.content![1]!.content![1]!.type).toBe("bullet_list");
    expect(doc.content[5]!.content![1]).toEqual({ type: "caption", content: [{ type: "text", text: "My cat" }] });
    expect(doc.content[7]!.attrs).toMatchObject({ url: "%%checkout_url%%", text: "Subscribe now" });
  });

  it("round-trips", () => {
    const markdown = `## A section

Some **bold**, *em*, \`code\` and a [link](https://example.com).

- one
- two
  - nested

1. first
2. second

> a quote
>
> on two paragraphs

![alt](https://img/x.png "caption")

::paywall

::subscribe

::button[Go](https://example.com)

---

\`\`\`js
let a = 1;
\`\`\``;
    expect(docToMarkdown(markdownToDoc(markdown))).toBe(markdown);
  });

  it("keeps blocks it does not edit, exactly", () => {
    const embed = { type: "digestPostEmbed", attrs: { postId: 42, title: "Ünïcödé “quotes”" } };
    const doc: PMDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }, embed] };
    const markdown = docToMarkdown(doc);
    expect(markdown).toMatch(/^hi\n\n::embed\[[\w-]+\]$/);
    expect(markdownToDoc(markdown)).toEqual(doc);
  });

  it("escapes text that would read as Markdown", () => {
    const doc: PMDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "2 * 3 = [six] _x" }] }] };
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });

  it("parses draft_body as Substack sends it", () => {
    const doc = markdownToDoc("hello");
    expect(parseBody(JSON.stringify(doc))).toEqual(doc);
    expect(parseBody(null)).toEqual({ type: "doc", content: [] });
    expect(parseBody("")).toEqual({ type: "doc", content: [] });
  });

  it("counts words", () => {
    expect(wordCount("# Hi there\n\nOne **two** three.\n\n::paywall")).toBe(5);
  });
});

describe("Substack addresses and sessions", () => {
  it("reads publication addresses", () => {
    expect(publicationOrigin("acme")).toBe("https://acme.substack.com");
    expect(publicationOrigin("acme.substack.com/p/hello")).toBe("https://acme.substack.com");
    expect(publicationOrigin("https://news.example.com/")).toBe("https://news.example.com");
    expect(() => publicationOrigin("http://localhost:3000")).toThrow();
    expect(() => publicationOrigin("10.0.0.1")).toThrow();
    expect(() => publicationOrigin("substack.com")).toThrow();
  });

  it("reads the cookie however it is pasted", () => {
    const value = "s%3AabcdefghijklmnopqrstuvwxYZ.0123456789";
    expect(sessionToken(value)).toBe("s:abcdefghijklmnopqrstuvwxYZ.0123456789");
    expect(sessionToken(`ajs=1; substack.sid=${value}; other=2`)).toBe("s:abcdefghijklmnopqrstuvwxYZ.0123456789");
    expect(() => sessionToken("short")).toThrow();
  });

  it("seals sessions", async () => {
    const sealed = await seal("secret-token");
    expect(sealed).not.toContain("secret-token");
    expect(await open(sealed)).toBe("secret-token");
  });
});

describe("the Substack client", () => {
  const calls: { url: string; method: string; body: unknown; cookie: string | null }[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      cookie: new Headers(init?.headers).get("cookie"),
    });
    if (url.includes("/drafts/7/publish")) return Response.json({ id: 7, slug: "hello", is_published: true });
    if (url.includes("/drafts/401")) return new Response("{}", { status: 401 });
    if (url.endsWith("/drafts")) return Response.json({ id: 9, draft_title: "T" });
    return Response.json({ id: 7 });
  }) as unknown as typeof fetch;
  const client = new Substack("https://acme.substack.com", "tok", fetcher);

  it("sends drafts as Substack expects them", async () => {
    await client.createDraft(12, { draft_title: "T", draft_body: markdownToDoc("hi") });
    const call = calls.at(-1)!;
    expect(call.url).toBe("https://acme.substack.com/api/v1/drafts");
    expect(call.cookie).toBe("substack.sid=tok; connect.sid=tok");
    const body = call.body as Record<string, unknown>;
    expect(typeof body.draft_body).toBe("string");
    expect(body.draft_bylines).toEqual([{ id: 12, is_guest: false }]);
  });

  it("sets the email choice before publishing", async () => {
    calls.length = 0;
    await client.publish(7, false);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PUT /api/v1/drafts/7",
      "POST /api/v1/drafts/7/publish",
    ]);
    expect(calls[0]!.body).toEqual({ should_send_email: false });
    expect(calls[1]!.body).toEqual({ send: false, share_automatically: false });
  });

  it("reports an expired session as such", async () => {
    const error = await client.draft(401).catch((e) => e);
    expect(error).toBeInstanceOf(SubstackError);
    expect(error.status).toBe(401);
  });
});

describe("the copilot's edits", () => {
  it("replaces exact passages", () => {
    expect(applyEdits("one two three", JSON.stringify([{ find: "two", replace: "2" }]))).toBe("one 2 three");
  });
  it("refuses missing or ambiguous passages", () => {
    expect(() => applyEdits("a a", JSON.stringify([{ find: "a", replace: "b" }]))).toThrow(/more than once/);
    expect(() => applyEdits("a", JSON.stringify([{ find: "z", replace: "b" }]))).toThrow(/not in the draft/);
    expect(() => applyEdits("a", "nope")).toThrow(/JSON/);
  });
});
