// The newsletter service on the local Postgres (migrations applied), against a fake Substack.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrate } from "../../db/migrate.ts";
import { markdownToDoc } from "../document.ts";
import { NewsletterService, type Newsletter } from "../service.ts";

const sql = new Bun.SQL(Bun.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54322/postgres");
const userId = crypto.randomUUID();
const TOKEN = "s:fake-session-token-0123456789";

type Draft = Record<string, unknown> & { id: number };

/** Substack as the service sees it: one writer, one publication, drafts kept in memory. */
function fakeSubstack() {
  const drafts = new Map<number, Draft>();
  let next = 100;
  const published: number[] = [];
  const notes: unknown[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (!String(new Headers(init?.headers).get("cookie")).includes(TOKEN)) return new Response("{}", { status: 401 });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (url.hostname === "substack.com") {
      if (path === "/user/profile/self")
        return Response.json({ id: 42, name: "Ada", publicationUsers: [{ role: "admin", publication: { id: 7, name: "Ada's Notes", subdomain: "ada" } }] });
      if (path === "/comment/feed" && method === "POST") {
        notes.push(body);
        return Response.json({ id: 555, user: { handle: "ada" } });
      }
    }
    if (url.hostname !== "ada.substack.com") return new Response("{}", { status: 404 });
    if (path === "/publication") return Response.json({ id: 7, name: "Ada's Notes", subdomain: "ada", payments_state: "enabled" });
    const list = /^\/post_management\/(drafts|scheduled|published)$/.exec(path);
    if (list) {
      const posts = [...drafts.values()].filter((d) => (list[1] === "published" ? d.is_published : list[1] === "drafts" ? !d.is_published : false));
      return Response.json({ total: posts.length, posts });
    }
    if (path === "/drafts" && method === "POST") {
      const draft = { ...body, id: next++, is_published: false, draft_created_at: new Date().toISOString(), draft_updated_at: new Date().toISOString() };
      drafts.set(draft.id, draft);
      return Response.json(draft);
    }
    const one = /^\/drafts\/(\d+)(\/\w+)?$/.exec(path);
    if (one) {
      const draft = drafts.get(Number(one[1]));
      if (!draft) return new Response('{"error":"Not found"}', { status: 404 });
      if (one[2] === "/publish") {
        Object.assign(draft, { is_published: true, slug: "hello", post_date: new Date().toISOString(), title: draft.draft_title });
        published.push(draft.id);
        return Response.json(draft);
      }
      if (one[2] === "/prepublish") return Response.json({ errors: [] });
      if (method === "PUT") {
        Object.assign(draft, body, { draft_updated_at: new Date(Date.now() + 1000).toISOString() });
        return Response.json(draft);
      }
      if (method === "DELETE") {
        drafts.delete(draft.id);
        return Response.json({});
      }
      return Response.json(draft);
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, drafts, published, notes };
}

const fake = fakeSubstack();
const service = new NewsletterService(sql, { fetcher: fake.fetcher });
let newsletter: Newsletter;

beforeAll(async () => {
  await migrate(sql);
  await sql`INSERT INTO auth.users (id, email, aud, role) VALUES (${userId}, ${`${userId}@test.local`}, 'authenticated', 'authenticated')`;
});

afterAll(async () => {
  await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  service.close();
  await sql.close();
});

describe("a newsletter", () => {
  it("connects to the writer's first publication", async () => {
    newsletter = await service.createNewsletter(userId, { cookie: `substack.sid=${encodeURIComponent(TOKEN)}`, timezone: "Europe/Paris" });
    expect(newsletter.publication_url).toBe("https://ada.substack.com");
    expect(newsletter.name).toBe("Ada's Notes");
    expect(Number(newsletter.substack_user_id)).toBe(42);
    expect(newsletter.paid).toBe(true);
    const [row] = await sql`SELECT token_sealed FROM public.newsletter_credentials WHERE newsletter_id = ${newsletter.id}`;
    expect(row.token_sealed).not.toContain("fake-session");
  });

  it("refuses a session Substack does not know, and keeps nothing", async () => {
    const before = await service.newsletters(userId);
    const error = await service.createNewsletter(userId, { cookie: "s:wrong-session-token-abcdefghij" }).catch((e) => e);
    expect(error.status).toBe(401);
    expect((await service.newsletters(userId)).length).toBe(before.length);
  });

  it("is another user's 404", async () => {
    const error = await service.newsletter(crypto.randomUUID(), newsletter.id).catch((e) => e);
    expect(error.status).toBe(404);
  });
});

describe("drafts", () => {
  let id: number;

  it("are written in Markdown and stored as Substack's document", async () => {
    const post = await service.createDraft(newsletter, { title: "Hello", markdown: "## Hi\n\nSome **text**.\n\n::paywall\n\nPaid part." });
    id = post.id;
    expect(post.state).toBe("draft");
    expect(post.audience).toBe("everyone");
    expect(post.markdown).toBe("## Hi\n\nSome **text**.\n\n::paywall\n\nPaid part.");
    expect(JSON.parse(String(fake.drafts.get(id)!.draft_body))).toEqual(markdownToDoc(post.markdown));
  });

  it("refuse a save over someone else's edit", async () => {
    const opened = await service.post(newsletter, id);
    await service.saveDraft(newsletter, id, { title: "Changed by the copilot" });
    const error = await service.saveDraft(newsletter, id, { title: "Mine", revision: opened.revision }).catch((e) => e);
    expect(error.status).toBe(409);
  });

  it("are created once per idempotency key", async () => {
    const a = await service.createDraft(newsletter, { title: "Once" }, { idempotencyKey: "pi:1:call-1" });
    const b = await service.createDraft(newsletter, { title: "Once" }, { idempotencyKey: "pi:1:call-1" });
    expect(b.id).toBe(a.id);
    expect([...fake.drafts.values()].filter((d) => d.draft_title === "Once").length).toBe(1);
  });

  it("are scheduled by Richelieu and published when their time comes", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { release } = await service.schedule(newsletter, id, { at, send: false });
    expect((await service.posts(newsletter, { state: "scheduled" })).map((p) => p.id)).toContain(id);
    expect(await service.publishDue()).toBe(0);
    await sql`UPDATE public.newsletter_releases SET publish_at = now() - interval '1 minute' WHERE id = ${release.id}`;
    expect(await service.publishDue()).toBe(1);
    expect(fake.published).toContain(id);
    expect(fake.drafts.get(id)!.should_send_email).toBe(false);
    const [row] = await sql`SELECT status, post_url FROM public.newsletter_releases WHERE id = ${release.id}`;
    expect(row).toEqual({ status: "published", post_url: "https://ada.substack.com/p/hello" });
    const post = await service.post(newsletter, id);
    expect(post.state).toBe("published");
  });

  it("cannot be edited or deleted once published", async () => {
    expect((await service.saveDraft(newsletter, id, { title: "x" }).catch((e) => e)).status).toBe(409);
    expect((await service.deleteDraft(newsletter, id).catch((e) => e)).status).toBe(409);
  });

  it("refuse to publish empty", async () => {
    const empty = await service.createDraft(newsletter, { title: "" });
    const error = await service.publish(newsletter, empty.id, { send: true }).catch((e) => e);
    expect(error.status).toBe(422);
    expect(fake.published).not.toContain(empty.id);
  });
});

describe("ideas and notes", () => {
  it("turn an idea into a draft", async () => {
    const idea = await service.createIdea(newsletter, { title: "Why Postgres", notes: "- point one\n- point two" });
    const post = await service.draftFromIdea(newsletter, idea.id);
    expect(post.title).toBe("Why Postgres");
    expect(post.markdown).toBe("- point one\n- point two");
    const updated = await service.idea(newsletter, idea.id);
    expect(updated.status).toBe("drafting");
    expect(Number(updated.draft_id)).toBe(post.id);
  });

  it("publish a scheduled note when its time comes", async () => {
    const note = await service.saveNote(newsletter, { body: "A thought, *briefly*." }, { idempotencyKey: "pi:1:note" });
    const again = await service.saveNote(newsletter, { body: "A thought, *briefly*." }, { idempotencyKey: "pi:1:note" });
    expect(again.id).toBe(note.id);
    await service.scheduleNote(newsletter, note.id, new Date(Date.now() + 120_000).toISOString());
    await sql`UPDATE public.newsletter_notes SET publish_at = now() WHERE id = ${note.id}`;
    await service.publishDue();
    const sent = await service.note(newsletter, note.id);
    expect(sent.status).toBe("published");
    expect(sent.url).toBe("https://substack.com/@ada/note/c-555");
    expect(fake.notes.length).toBe(1);
  });
});
