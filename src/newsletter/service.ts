// What the newsletter API and the copilot do: newsletters and their Substack connection, drafts (written in
// Markdown, stored in Substack as ProseMirror), publishing now or at a time, images, comments, stats, ideas and
// Notes. Every Substack call goes out with the newsletter's own session, which only the server can read.

import type { SQL } from "bun";
import { docToMarkdown, markdownToDoc, parseBody, wordCount, type PMDoc } from "./document.ts";
import { SubstackMcp, type McpCredentials } from "./mcp.ts";
import { open, seal } from "./secrets.ts";
import {
  AUDIENCES,
  postUrl,
  publicationOrigin,
  sessionToken,
  Substack,
  SubstackError,
  type Audience,
  type PostStatsRow,
  type PublicationStats,
  type SubstackComment,
  type SubstackDraft,
  type SubstackPostSummary,
} from "./substack.ts";

export class NewsletterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Newsletter = {
  id: string;
  user_id: string;
  name: string;
  publication_url: string | null;
  publication_id: number | null;
  subdomain: string | null;
  logo_url: string | null;
  paid: boolean;
  substack_user_id: number | null;
  substack_user_name: string | null;
  connected_at: Date | null;
  connection_error: string | null;
  description: string;
  audience: string;
  voice: string;
  pillars: string[];
  avoid: string;
  examples: string;
  format: string;
  timezone: string;
  cadence: number;
  default_audience: Audience;
  thread_id: string | null;
  created_at: Date;
};

export const BRIEF_FIELDS = [
  "name",
  "description",
  "audience",
  "voice",
  "pillars",
  "avoid",
  "examples",
  "format",
  "timezone",
  "cadence",
  "default_audience",
] as const;
export type NewsletterPatch = Partial<Pick<Newsletter, (typeof BRIEF_FIELDS)[number]>>;

export type PostState = "draft" | "scheduled" | "published";

export type Release = {
  id: string;
  newsletter_id: string;
  draft_id: number;
  title: string;
  publish_at: Date;
  send_email: boolean;
  status: "pending" | "publishing" | "published" | "failed" | "cancelled";
  error: string | null;
  attempts: number;
  published_at: Date | null;
  post_url: string | null;
};

/** A post in Richelieu's words, whatever list it came from. */
export type NewsletterPost = {
  id: number;
  state: PostState;
  title: string;
  subtitle: string;
  audience: Audience;
  updated_at: string | null;
  post_date: string | null;
  /** When it goes out: Richelieu's release, or Substack's own schedule. */
  scheduled_for: string | null;
  scheduled_by: "richelieu" | "substack" | null;
  send_email: boolean | null;
  url: string | null;
  cover_image: string | null;
  comments: number;
  reactions: number;
  release_error: string | null;
};

export type PostDetail = NewsletterPost & {
  markdown: string;
  words: number;
  description: string;
  social_title: string;
  search_engine_title: string;
  search_engine_description: string;
  slug: string;
  write_comment_permissions: string;
  /** Substack's draft_updated_at, sent back with a save to detect edits made meanwhile. */
  revision: string | null;
};

export type DraftInput = {
  title?: string;
  subtitle?: string;
  markdown?: string;
  audience?: Audience;
  cover_image?: string | null;
  description?: string;
  social_title?: string;
  search_engine_title?: string;
  search_engine_description?: string;
  slug?: string;
  write_comment_permissions?: "everyone" | "subscribers" | "only_paid" | "none";
};

export type Idea = {
  id: string;
  newsletter_id: string;
  title: string;
  notes: string;
  status: "idea" | "planned" | "drafting" | "done" | "dropped";
  planned_for: string | null;
  draft_id: number | null;
  source: "user" | "copilot";
  created_at: Date;
  updated_at: Date;
};

export type Note = {
  id: string;
  newsletter_id: string;
  body: string;
  status: "draft" | "scheduled" | "publishing" | "published" | "failed";
  publish_at: Date | null;
  published_at: Date | null;
  url: string | null;
  error: string | null;
  source: "user" | "copilot";
  created_at: Date;
};

export type Analytics = {
  stats: PublicationStats | null;
  posts: PostStatsRow[];
  synced_at: string;
};

export const validTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const IDEA_STATUSES = ["idea", "planned", "drafting", "done", "dropped"] as const;
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

class Cache {
  private readonly entries = new Map<string, { until: number; value: Promise<unknown> }>();
  get<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { until: Date.now() + ms, value });
    value.catch(() => this.entries.delete(key));
    return value;
  }
  drop(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

const iso = (value: string | Date | null | undefined) =>
  value ? (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) : null;

function summaryOf(post: SubstackPostSummary, origin: string, release?: Release): NewsletterPost {
  const published = post.is_published === true || Boolean(post.post_date && !post.trigger_at && post.is_published !== false);
  const substackScheduled = !published && Boolean(post.trigger_at);
  const pending = release && (release.status === "pending" || release.status === "publishing");
  return {
    id: post.id,
    state: published ? "published" : pending || substackScheduled ? "scheduled" : "draft",
    title: (published ? post.title : post.draft_title) ?? post.title ?? post.draft_title ?? "",
    subtitle: (published ? post.subtitle : post.draft_subtitle) ?? post.subtitle ?? post.draft_subtitle ?? "",
    audience: post.audience ?? "everyone",
    updated_at: iso(post.draft_updated_at ?? post.post_date),
    post_date: published ? iso(post.post_date) : null,
    scheduled_for: pending ? iso(release.publish_at) : substackScheduled ? iso(post.trigger_at) : null,
    scheduled_by: pending ? "richelieu" : substackScheduled ? "substack" : null,
    send_email: pending ? release.send_email : (post.should_send_email ?? null),
    url: published ? postUrl(origin, post) : null,
    cover_image: post.cover_image ?? null,
    comments: post.comment_count ?? 0,
    reactions: post.reaction_count ?? 0,
    release_error: release?.status === "failed" ? release.error : null,
  };
}

export class NewsletterService {
  private readonly cache = new Cache();
  readonly mcp: SubstackMcp;

  constructor(
    private readonly sql: SQL,
    private readonly options: { fetcher?: typeof fetch; mcp?: SubstackMcp } = {},
  ) {
    this.mcp = options.mcp ?? new SubstackMcp();
  }

  status() {
    return { mcp: this.mcp.enabled };
  }

  // Newsletters ----------------------------------------------------------------------------------------------

  newsletters(userId: string) {
    return this.sql<Newsletter[]>`SELECT * FROM public.newsletters WHERE user_id = ${userId} ORDER BY created_at`;
  }

  async newsletter(userId: string, id: string): Promise<Newsletter> {
    if (!UUID.test(id)) throw new NewsletterError(404, "No such newsletter");
    const [row] = await this.sql<Newsletter[]>`
      SELECT * FROM public.newsletters WHERE id = ${id} AND user_id = ${userId}`;
    if (!row) throw new NewsletterError(404, "No such newsletter");
    return row;
  }

  async newsletterOfConversation(conversationId: number): Promise<Newsletter | undefined> {
    const [row] = await this.sql<Newsletter[]>`
      SELECT n.* FROM public.newsletters n JOIN public.threads t ON t.id = n.thread_id
      WHERE t.conversation_id = ${conversationId}`;
    return row;
  }

  private async reload(newsletter: Newsletter) {
    const [row] = await this.sql<Newsletter[]>`SELECT * FROM public.newsletters WHERE id = ${newsletter.id}`;
    if (!row) throw new NewsletterError(404, "No such newsletter");
    return row;
  }

  async createNewsletter(
    userId: string,
    input: NewsletterPatch & { name?: string; publication?: string; cookie?: string },
  ): Promise<Newsletter> {
    const name = (input.name ?? "").trim().slice(0, 80) || "My newsletter";
    const timezone = input.timezone && validTimezone(input.timezone) ? input.timezone : "UTC";
    const created = await this.sql.begin(async (tx) => {
      const [thread] = await tx<{ id: string }[]>`
        INSERT INTO public.threads (user_id, title, kind) VALUES (${userId}, ${`${name} · Newsletter`}, 'newsletter') RETURNING id`;
      const [row] = await tx<Newsletter[]>`
        INSERT INTO public.newsletters (user_id, name, timezone, thread_id)
        VALUES (${userId}, ${name}, ${timezone}, ${thread!.id}) RETURNING *`;
      return row!;
    });
    if (input.cookie?.trim()) {
      try {
        return await this.connect(created, { publication: input.publication ?? "", cookie: input.cookie });
      } catch (error) {
        // A newsletter that cannot connect is not kept half-made.
        await this.deleteNewsletter(created);
        throw error;
      }
    }
    return created;
  }

  async updateNewsletter(newsletter: Newsletter, patch: NewsletterPatch): Promise<Newsletter> {
    const next = { ...newsletter };
    for (const field of BRIEF_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (field === "pillars") {
        if (!Array.isArray(value)) throw new NewsletterError(400, "pillars is a list");
        next.pillars = (value as string[]).map((p) => String(p).trim()).filter(Boolean).slice(0, 12);
      } else if (field === "cadence") {
        const cadence = Number(value);
        if (!Number.isFinite(cadence) || cadence < 0 || cadence > 14)
          throw new NewsletterError(400, "Issues a week: between 0 and 14");
        next.cadence = Math.round(cadence * 10) / 10;
      } else if (field === "timezone") {
        if (!validTimezone(String(value))) throw new NewsletterError(400, `Unknown time zone ${value}`);
        next.timezone = String(value);
      } else if (field === "default_audience") {
        if (!AUDIENCES.includes(value as Audience)) throw new NewsletterError(400, `Unknown audience ${value}`);
        next.default_audience = value as Audience;
      } else if (field === "name") {
        const name = String(value).trim().slice(0, 80);
        if (!name) throw new NewsletterError(400, "Name the newsletter");
        next.name = name;
      } else {
        (next as Record<string, unknown>)[field] = String(value).slice(0, 6000);
      }
    }
    const [updated] = await this.sql<Newsletter[]>`
      UPDATE public.newsletters SET name = ${next.name}, description = ${next.description},
        audience = ${next.audience}, voice = ${next.voice}, pillars = ${this.sql.array(next.pillars, "text")},
        avoid = ${next.avoid}, examples = ${next.examples}, format = ${next.format}, timezone = ${next.timezone},
        cadence = ${next.cadence}, default_audience = ${next.default_audience}, updated_at = now()
      WHERE id = ${newsletter.id} RETURNING *`;
    if (next.name !== newsletter.name && newsletter.thread_id)
      await this.sql`UPDATE public.threads SET title = ${`${next.name} · Newsletter`} WHERE id = ${newsletter.thread_id}`;
    return updated!;
  }

  /** Removes the newsletter from Richelieu. Its posts stay on Substack. */
  async deleteNewsletter(newsletter: Newsletter) {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM public.newsletters WHERE id = ${newsletter.id}`;
      if (newsletter.thread_id) await tx`DELETE FROM public.threads WHERE id = ${newsletter.thread_id}`;
    });
    this.cache.drop(newsletter.id);
  }

  // The Substack connection ----------------------------------------------------------------------------------

  /**
   * Checks a session cookie and a publication, and keeps them: the user behind the cookie must be able to read the
   * publication's drafts. Without a publication address, the user's first publication.
   */
  async connect(newsletter: Newsletter, input: { publication?: string; cookie: string }): Promise<Newsletter> {
    const token = sessionToken(input.cookie);
    const probe = new Substack("https://substack.com", token, this.options.fetcher);
    const me = await probe.me();
    let origin: string;
    if (input.publication?.trim()) origin = publicationOrigin(input.publication);
    else {
      const first = me.publications.find((p) => p.role !== "contributor") ?? me.publications[0];
      if (!first) throw new NewsletterError(400, "This Substack account has no publication: give its address");
      origin = first.custom_domain ? `https://${first.custom_domain}` : `https://${first.subdomain}.substack.com`;
    }
    const client = new Substack(origin, token, this.options.fetcher);
    // Only a writer of the publication can list its drafts.
    try {
      await client.posts("drafts", { limit: 1 });
    } catch (error) {
      if (error instanceof SubstackError && (error.status === 401 || error.status === 403 || error.status === 404))
        throw new NewsletterError(403, `${me.name || "This account"} cannot edit ${origin}: check the address, or that you are one of its admins`);
      throw error;
    }
    const publication = await client.publication().catch(() => null);
    const name = newsletter.name === "My newsletter" && publication?.name ? publication.name : newsletter.name;
    const sealed = await seal(token);
    const [row] = await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO public.newsletter_credentials (newsletter_id, token_sealed) VALUES (${newsletter.id}, ${sealed})
        ON CONFLICT (newsletter_id) DO UPDATE SET token_sealed = EXCLUDED.token_sealed, updated_at = now()`;
      return tx<Newsletter[]>`
        UPDATE public.newsletters SET name = ${name}, publication_url = ${origin}, publication_id = ${publication?.id ?? null},
          subdomain = ${publication?.subdomain ?? null}, logo_url = ${publication?.logo_url ?? null},
          paid = ${publication?.payments_enabled ?? false}, substack_user_id = ${me.id},
          substack_user_name = ${me.name || me.handle}, connected_at = now(), connection_error = null, updated_at = now()
        WHERE id = ${newsletter.id} RETURNING *`;
    });
    if (name !== newsletter.name && newsletter.thread_id)
      await this.sql`UPDATE public.threads SET title = ${`${name} · Newsletter`} WHERE id = ${newsletter.thread_id}`;
    this.cache.drop(newsletter.id);
    return row!;
  }

  async disconnect(newsletter: Newsletter) {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM public.newsletter_credentials WHERE newsletter_id = ${newsletter.id}`;
      await tx`UPDATE public.newsletter_releases SET status = 'cancelled', error = 'Disconnected from Substack', updated_at = now()
        WHERE newsletter_id = ${newsletter.id} AND status = 'pending'`;
      await tx`UPDATE public.newsletters SET connected_at = null, connection_error = null, substack_user_id = null, updated_at = now()
        WHERE id = ${newsletter.id}`;
    });
    this.cache.drop(newsletter.id);
  }

  private async token(newsletter: Newsletter) {
    const [row] = await this.sql<{ token_sealed: string }[]>`
      SELECT token_sealed FROM public.newsletter_credentials WHERE newsletter_id = ${newsletter.id}`;
    if (!row || !newsletter.publication_url || !newsletter.substack_user_id)
      throw new NewsletterError(409, "Connect the newsletter to Substack first (Settings)");
    return open(row.token_sealed);
  }

  /** Runs a Substack call with the newsletter's session; an expired session is recorded on the newsletter. */
  private async withClient<T>(newsletter: Newsletter, run: (client: Substack) => Promise<T>): Promise<T> {
    const client = new Substack(newsletter.publication_url ?? "", await this.token(newsletter), this.options.fetcher);
    try {
      const result = await run(client);
      if (newsletter.connection_error)
        await this.sql`UPDATE public.newsletters SET connection_error = null WHERE id = ${newsletter.id}`;
      return result;
    } catch (error) {
      if (error instanceof SubstackError && error.status === 401)
        await this.sql`UPDATE public.newsletters SET connection_error = ${error.message}, updated_at = now() WHERE id = ${newsletter.id}`;
      throw error;
    }
  }

  async mcpCredentials(newsletter: Newsletter): Promise<McpCredentials> {
    return {
      publicationUrl: newsletter.publication_url!,
      token: await this.token(newsletter),
      userId: newsletter.substack_user_id!,
    };
  }

  // Posts ----------------------------------------------------------------------------------------------------

  private async releases(newsletter: Newsletter) {
    return this.sql<Release[]>`
      SELECT DISTINCT ON (draft_id) * FROM public.newsletter_releases WHERE newsletter_id = ${newsletter.id}
      ORDER BY draft_id, created_at DESC`;
  }

  /** Drafts, scheduled and published posts, with Richelieu's own releases folded in. */
  async posts(newsletter: Newsletter, options: { state?: PostState; search?: string; limit?: number } = {}) {
    // Every list, whatever the state asked: a post Richelieu schedules is among Substack's drafts.
    const lists = ["drafts", "scheduled", "published"] as const;
    const [results, releases] = await Promise.all([
      this.withClient(newsletter, (client) =>
        Promise.all(lists.map((list) => client.posts(list, { limit: options.limit ?? 50, search: options.search }))),
      ),
      this.releases(newsletter),
    ]);
    const byDraft = new Map(releases.map((r) => [Number(r.draft_id), r]));
    const seen = new Set<number>();
    const posts: NewsletterPost[] = [];
    for (const { posts: list } of results)
      for (const post of list) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        posts.push(summaryOf(post, newsletter.publication_url!, byDraft.get(post.id)));
      }
    return options.state ? posts.filter((p) => p.state === options.state) : posts;
  }

  private async pendingRelease(newsletter: Newsletter, draftId: number) {
    const [release] = await this.sql<Release[]>`
      SELECT * FROM public.newsletter_releases WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId}
      ORDER BY created_at DESC LIMIT 1`;
    return release;
  }

  private detailOf(newsletter: Newsletter, draft: SubstackDraft, release?: Release): PostDetail {
    const published = draft.is_published === true;
    const doc = parseBody(published && !draft.draft_body ? draft.body : draft.draft_body);
    const markdown = docToMarkdown(doc);
    return {
      ...summaryOf(draft, newsletter.publication_url!, release),
      markdown,
      words: wordCount(markdown),
      description: draft.description ?? "",
      social_title: draft.social_title ?? "",
      search_engine_title: draft.search_engine_title ?? "",
      search_engine_description: draft.search_engine_description ?? "",
      slug: draft.slug ?? "",
      write_comment_permissions: draft.write_comment_permissions ?? "everyone",
      revision: draft.draft_updated_at ?? null,
    };
  }

  private draftId(id: string | number) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) throw new NewsletterError(404, "No such post");
    return n;
  }

  async post(newsletter: Newsletter, id: string | number): Promise<PostDetail> {
    const draftId = this.draftId(id);
    const [draft, release] = await Promise.all([
      this.withClient(newsletter, (client) => client.draft(draftId)).catch((error) => {
        if (error instanceof SubstackError && error.status === 404) throw new NewsletterError(404, "No such post");
        throw error;
      }),
      this.pendingRelease(newsletter, draftId),
    ]);
    return this.detailOf(newsletter, draft, release);
  }

  private patchOf(input: DraftInput) {
    if (input.audience !== undefined && !AUDIENCES.includes(input.audience))
      throw new NewsletterError(400, `Unknown audience ${input.audience}`);
    if (input.title !== undefined && input.title.length > 280) throw new NewsletterError(400, "The title is too long");
    if (input.markdown !== undefined && input.markdown.length > 400_000) throw new NewsletterError(413, "The post is too long");
    return {
      draft_title: input.title,
      draft_subtitle: input.subtitle,
      draft_body: input.markdown !== undefined ? markdownToDoc(input.markdown) : undefined,
      audience: input.audience,
      cover_image: input.cover_image,
      description: input.description,
      social_title: input.social_title,
      search_engine_title: input.search_engine_title,
      search_engine_description: input.search_engine_description,
      slug: input.slug,
      write_comment_permissions: input.write_comment_permissions,
    };
  }

  /** A new draft. With an idempotency key, a second call with the same key finds the first one's draft. */
  async createDraft(newsletter: Newsletter, input: DraftInput, options: { idempotencyKey?: string } = {}): Promise<PostDetail> {
    const patch = this.patchOf({ audience: newsletter.default_audience, ...input });
    const key = options.idempotencyKey;
    if (key) {
      const [claimed] = await this.sql<{ draft_id: number | null; created_at: Date }[]>`
        INSERT INTO public.newsletter_draft_keys (key, newsletter_id, title) VALUES (${key}, ${newsletter.id}, ${input.title ?? ""})
        ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING draft_id, created_at`;
      if (claimed?.draft_id) return this.post(newsletter, Number(claimed.draft_id));
      // Claimed by a run that crashed before recording its draft: a draft with this title made since is it.
      if (claimed && Date.now() - claimed.created_at.getTime() > 2_000) {
        const { posts } = await this.withClient(newsletter, (client) => client.posts("drafts", { limit: 20 }));
        const found = posts.find(
          (p) =>
            (p.draft_title ?? "") === (input.title ?? "") &&
            p.draft_created_at &&
            new Date(p.draft_created_at).getTime() >= claimed.created_at.getTime() - 60_000,
        );
        if (found) {
          await this.sql`UPDATE public.newsletter_draft_keys SET draft_id = ${found.id} WHERE key = ${key}`;
          return this.post(newsletter, found.id);
        }
      }
    }
    const draft = await this.withClient(newsletter, (client) => client.createDraft(newsletter.substack_user_id!, patch));
    // Substack's POST takes no SEO fields or cover: set them after.
    const extra = Object.fromEntries(
      Object.entries({
        cover_image: patch.cover_image,
        description: patch.description,
        social_title: patch.social_title,
        search_engine_title: patch.search_engine_title,
        search_engine_description: patch.search_engine_description,
        slug: patch.slug,
      }).filter(([, v]) => v !== undefined),
    );
    if (key) await this.sql`UPDATE public.newsletter_draft_keys SET draft_id = ${draft.id} WHERE key = ${key}`;
    if (Object.keys(extra).length) await this.withClient(newsletter, (client) => client.updateDraft(draft.id, extra));
    return this.post(newsletter, draft.id);
  }

  /**
   * Saves a draft. With `revision` (the draft_updated_at the editor loaded), refuses when someone else (the copilot,
   * Substack's own editor) changed the draft since.
   */
  async saveDraft(
    newsletter: Newsletter,
    id: string | number,
    input: DraftInput & { revision?: string | null },
  ): Promise<PostDetail> {
    const draftId = this.draftId(id);
    const current = await this.withClient(newsletter, (client) => client.draft(draftId));
    if (current.is_published)
      throw new NewsletterError(409, "This post is published: edit it on Substack, where saving it updates the live post");
    if (input.revision && current.draft_updated_at && input.revision !== current.draft_updated_at)
      throw new NewsletterError(409, "This draft changed since you opened it (the copilot or Substack edited it). Reload it to see the changes.");
    const updated = await this.withClient(newsletter, (client) => client.updateDraft(draftId, this.patchOf(input)));
    if (input.title !== undefined)
      await this.sql`UPDATE public.newsletter_releases SET title = ${input.title} WHERE newsletter_id = ${newsletter.id}
        AND draft_id = ${draftId} AND status = 'pending'`;
    return this.detailOf(newsletter, { ...current, ...updated }, await this.pendingRelease(newsletter, draftId));
  }

  async deleteDraft(newsletter: Newsletter, id: string | number) {
    const draftId = this.draftId(id);
    const current = await this.withClient(newsletter, (client) => client.draft(draftId));
    if (current.is_published) throw new NewsletterError(409, "A published post is deleted on Substack, not here");
    await this.withClient(newsletter, (client) => client.deleteDraft(draftId));
    await this.sql`UPDATE public.newsletter_releases SET status = 'cancelled', updated_at = now()
      WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId} AND status = 'pending'`;
    await this.sql`UPDATE public.newsletter_ideas SET draft_id = null, status = 'idea', updated_at = now()
      WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId}`;
  }

  /** What would stop the draft from publishing. */
  async check(newsletter: Newsletter, id: string | number): Promise<string[]> {
    const draftId = this.draftId(id);
    const [draft, substackErrors] = await this.withClient(newsletter, (client) =>
      Promise.all([client.draft(draftId), client.prepublish(draftId)]),
    );
    const problems = [...substackErrors];
    if (!draft.draft_title?.trim()) problems.unshift("The post has no title");
    if (!docToMarkdown(parseBody(draft.draft_body)).trim()) problems.unshift("The post is empty");
    return [...new Set(problems)];
  }

  /** Publishes now, and emails it when `send`. Only on the user's own click (the copilot cannot). */
  async publish(newsletter: Newsletter, id: string | number, options: { send: boolean }) {
    const draftId = this.draftId(id);
    const problems = await this.check(newsletter, draftId);
    if (problems.length) throw new NewsletterError(422, `Cannot publish yet: ${problems.join("; ")}`);
    const published = await this.withClient(newsletter, (client) => client.publish(draftId, options.send));
    const url = postUrl(newsletter.publication_url!, published);
    await this.sql`UPDATE public.newsletter_releases SET status = 'published', published_at = now(), post_url = ${url},
      updated_at = now() WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId} AND status IN ('pending', 'publishing', 'failed')`;
    await this.sql`UPDATE public.newsletter_ideas SET status = 'done', updated_at = now()
      WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId}`;
    this.cache.drop(`${newsletter.id}:analytics`);
    return { url, emailed: options.send };
  }

  /** Richelieu publishes the draft at `at`. The draft stays editable until then. */
  async schedule(newsletter: Newsletter, id: string | number, options: { at: string; send: boolean }) {
    const draftId = this.draftId(id);
    const at = new Date(options.at);
    if (Number.isNaN(at.getTime())) throw new NewsletterError(400, "Give the time to publish");
    if (at.getTime() < Date.now() + 60_000) throw new NewsletterError(400, "Pick a time at least a minute from now");
    if (at.getTime() > Date.now() + 365 * 86_400_000) throw new NewsletterError(400, "Pick a time within a year");
    const draft = await this.withClient(newsletter, (client) => client.draft(draftId));
    if (draft.is_published) throw new NewsletterError(409, "This post is already published");
    const [release] = await this.sql.begin(async (tx) => {
      await tx`UPDATE public.newsletter_releases SET status = 'cancelled', updated_at = now()
        WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId} AND status = 'pending'`;
      const [busy] = await tx`SELECT 1 FROM public.newsletter_releases WHERE newsletter_id = ${newsletter.id}
        AND draft_id = ${draftId} AND status = 'publishing'`;
      if (busy) throw new NewsletterError(409, "This post is being published right now");
      return tx<Release[]>`
        INSERT INTO public.newsletter_releases (newsletter_id, user_id, draft_id, title, publish_at, send_email)
        VALUES (${newsletter.id}, ${newsletter.user_id}, ${draftId}, ${draft.draft_title ?? ""}, ${at}, ${options.send})
        RETURNING *`;
    });
    const problems = await this.check(newsletter, draftId).catch(() => []);
    return { release: release!, warnings: problems };
  }

  async unschedule(newsletter: Newsletter, id: string | number) {
    const draftId = this.draftId(id);
    const cancelled = await this.sql`UPDATE public.newsletter_releases SET status = 'cancelled', updated_at = now()
      WHERE newsletter_id = ${newsletter.id} AND draft_id = ${draftId} AND status = 'pending' RETURNING id`;
    if (cancelled.length === 0) throw new NewsletterError(404, "This post is not scheduled by Richelieu");
  }

  /** Publishes the releases and Notes whose time has come. Runs every minute on the server. */
  async publishDue(limit = 10) {
    let done = 0;
    const releases = await this.sql<(Release & { user_id: string })[]>`
      UPDATE public.newsletter_releases SET status = 'publishing', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM public.newsletter_releases WHERE status = 'pending' AND publish_at <= now()
        ORDER BY publish_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) RETURNING *`;
    for (const release of releases) {
      try {
        const [newsletter] = await this.sql<Newsletter[]>`SELECT * FROM public.newsletters WHERE id = ${release.newsletter_id}`;
        if (!newsletter) continue;
        const { url } = await this.publish(newsletter, Number(release.draft_id), { send: release.send_email });
        await this.sql`UPDATE public.newsletter_releases SET status = 'published', published_at = now(), post_url = ${url},
          error = null, updated_at = now() WHERE id = ${release.id}`;
        done++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A network hiccup is tried again in a minute, three times; anything Substack refuses fails at once.
        const retry = release.attempts < 3 && !(error instanceof NewsletterError) && !(error instanceof SubstackError && error.status < 500 && error.status !== 429);
        await this.sql`UPDATE public.newsletter_releases SET status = ${retry ? "pending" : "failed"}, error = ${message},
          updated_at = now() WHERE id = ${release.id}`;
        console.warn(`[newsletter] release ${release.id}:`, message);
      }
    }
    const notes = await this.sql<Note[]>`
      UPDATE public.newsletter_notes SET status = 'publishing', updated_at = now()
      WHERE id IN (
        SELECT id FROM public.newsletter_notes WHERE status = 'scheduled' AND publish_at <= now()
        ORDER BY publish_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) RETURNING *`;
    for (const note of notes) {
      const [newsletter] = await this.sql<Newsletter[]>`SELECT * FROM public.newsletters WHERE id = ${note.newsletter_id}`;
      if (!newsletter) continue;
      await this.sendNote(newsletter, note).catch(() => undefined);
      done++;
    }
    return done;
  }

  // Images, comments, stats ----------------------------------------------------------------------------------

  async uploadImage(newsletter: Newsletter, file: File, postId?: number) {
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) throw new NewsletterError(400, "PNG, JPEG, GIF or WebP images only");
    if (file.size > MAX_IMAGE_BYTES) throw new NewsletterError(413, "Images up to 15 MB");
    const dataUri = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
    return this.withClient(newsletter, (client) => client.uploadImage(dataUri, postId));
  }

  /** Puts an image found on the web on Substack's CDN, for the copilot's covers and illustrations. */
  async rehostImage(newsletter: Newsletter, url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new NewsletterError(400, "https images only");
    if (/substackcdn\.com$|substack-post-media/.test(parsed.hostname)) return { url, width: null, height: null };
    const response = await fetch(parsed, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!response.ok) throw new NewsletterError(400, `Could not download the image (${response.status})`);
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const bytes = await response.arrayBuffer();
    return this.uploadImage(newsletter, new File([bytes], "image", { type }));
  }

  comments(newsletter: Newsletter, postId: string | number): Promise<SubstackComment[]> {
    const id = this.draftId(postId);
    return this.withClient(newsletter, (client) => client.comments(id));
  }

  analytics(newsletter: Newsletter, fresh = false): Promise<Analytics> {
    if (fresh) this.cache.drop(`${newsletter.id}:analytics`);
    return this.cache.get(`${newsletter.id}:analytics`, 5 * 60_000, () =>
      this.withClient(newsletter, async (client) => {
        const [stats, posts] = await Promise.all([
          client.stats().catch(() => null),
          client.postStats(50).then((r) => r.rows).catch(() => [] as PostStatsRow[]),
        ]);
        return { stats, posts, synced_at: new Date().toISOString() };
      }),
    );
  }

  // Ideas ----------------------------------------------------------------------------------------------------

  ideas(newsletter: Newsletter) {
    return this.sql<Idea[]>`
      SELECT id, newsletter_id, title, notes, status, planned_for::text, draft_id, source, created_at, updated_at
      FROM public.newsletter_ideas WHERE newsletter_id = ${newsletter.id}
      ORDER BY (status = 'done' OR status = 'dropped'), planned_for NULLS LAST, created_at DESC`;
  }

  private ideaInput(input: Partial<Pick<Idea, "title" | "notes" | "status" | "planned_for" | "draft_id">>) {
    if (input.status !== undefined && !IDEA_STATUSES.includes(input.status))
      throw new NewsletterError(400, `Unknown status ${input.status}`);
    if (input.planned_for && !/^\d{4}-\d{2}-\d{2}$/.test(input.planned_for))
      throw new NewsletterError(400, "Plan ideas for a day: YYYY-MM-DD");
    if (input.title !== undefined && !input.title.trim()) throw new NewsletterError(400, "Give the idea a title");
  }

  async createIdea(
    newsletter: Newsletter,
    input: { title: string; notes?: string; status?: Idea["status"]; planned_for?: string | null },
    source: Idea["source"] = "user",
  ): Promise<Idea> {
    this.ideaInput(input);
    const [idea] = await this.sql<Idea[]>`
      INSERT INTO public.newsletter_ideas (newsletter_id, user_id, title, notes, status, planned_for, source)
      VALUES (${newsletter.id}, ${newsletter.user_id}, ${input.title.trim().slice(0, 300)}, ${(input.notes ?? "").slice(0, 20_000)},
        ${input.status ?? "idea"}, ${input.planned_for || null}, ${source})
      RETURNING id, newsletter_id, title, notes, status, planned_for::text, draft_id, source, created_at, updated_at`;
    return idea!;
  }

  async idea(newsletter: Newsletter, id: string): Promise<Idea> {
    if (!UUID.test(id)) throw new NewsletterError(404, "No such idea");
    const [idea] = await this.sql<Idea[]>`
      SELECT id, newsletter_id, title, notes, status, planned_for::text, draft_id, source, created_at, updated_at
      FROM public.newsletter_ideas WHERE id = ${id} AND newsletter_id = ${newsletter.id}`;
    if (!idea) throw new NewsletterError(404, "No such idea");
    return idea;
  }

  async updateIdea(
    newsletter: Newsletter,
    id: string,
    patch: Partial<Pick<Idea, "title" | "notes" | "status" | "planned_for" | "draft_id">>,
  ): Promise<Idea> {
    this.ideaInput(patch);
    const idea = { ...(await this.idea(newsletter, id)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    const [updated] = await this.sql<Idea[]>`
      UPDATE public.newsletter_ideas SET title = ${idea.title.trim().slice(0, 300)}, notes = ${idea.notes.slice(0, 20_000)},
        status = ${idea.status}, planned_for = ${idea.planned_for || null}, draft_id = ${idea.draft_id ?? null}, updated_at = now()
      WHERE id = ${id} RETURNING id, newsletter_id, title, notes, status, planned_for::text, draft_id, source, created_at, updated_at`;
    return updated!;
  }

  async deleteIdea(newsletter: Newsletter, id: string) {
    await this.idea(newsletter, id);
    await this.sql`DELETE FROM public.newsletter_ideas WHERE id = ${id}`;
  }

  /** A draft from an idea: its title, and its notes as the outline to write from. */
  async draftFromIdea(newsletter: Newsletter, id: string) {
    const idea = await this.idea(newsletter, id);
    if (idea.draft_id) return this.post(newsletter, Number(idea.draft_id));
    const post = await this.createDraft(newsletter, { title: idea.title, markdown: idea.notes });
    await this.updateIdea(newsletter, id, { draft_id: post.id, status: "drafting" });
    return post;
  }

  // Notes ----------------------------------------------------------------------------------------------------

  notes(newsletter: Newsletter) {
    return this.sql<Note[]>`
      SELECT id, newsletter_id, body, status, publish_at, published_at, url, error, source, created_at
      FROM public.newsletter_notes WHERE newsletter_id = ${newsletter.id} ORDER BY created_at DESC LIMIT 200`;
  }

  async note(newsletter: Newsletter, id: string): Promise<Note> {
    if (!UUID.test(id)) throw new NewsletterError(404, "No such note");
    const [note] = await this.sql<Note[]>`
      SELECT id, newsletter_id, body, status, publish_at, published_at, url, error, source, created_at
      FROM public.newsletter_notes WHERE id = ${id} AND newsletter_id = ${newsletter.id}`;
    if (!note) throw new NewsletterError(404, "No such note");
    return note;
  }

  async saveNote(
    newsletter: Newsletter,
    input: { id?: string; body: string },
    options: { source?: Note["source"]; idempotencyKey?: string } = {},
  ): Promise<Note> {
    const body = input.body.trim();
    if (!body) throw new NewsletterError(400, "Write the note first");
    if (body.length > 10_000) throw new NewsletterError(413, "The note is too long");
    if (input.id) {
      const note = await this.note(newsletter, input.id);
      if (note.status === "published" || note.status === "publishing")
        throw new NewsletterError(409, "This note is published");
      const [updated] = await this.sql<Note[]>`
        UPDATE public.newsletter_notes SET body = ${body}, updated_at = now() WHERE id = ${note.id}
        RETURNING id, newsletter_id, body, status, publish_at, published_at, url, error, source, created_at`;
      return updated!;
    }
    const [created] = await this.sql<Note[]>`
      INSERT INTO public.newsletter_notes (newsletter_id, user_id, body, source, idempotency_key)
      VALUES (${newsletter.id}, ${newsletter.user_id}, ${body}, ${options.source ?? "user"}, ${options.idempotencyKey ?? null})
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING id, newsletter_id, body, status, publish_at, published_at, url, error, source, created_at`;
    return created!;
  }

  async deleteNote(newsletter: Newsletter, id: string) {
    const note = await this.note(newsletter, id);
    if (note.status === "published" || note.status === "publishing")
      throw new NewsletterError(409, "A published note is deleted on Substack");
    await this.sql`DELETE FROM public.newsletter_notes WHERE id = ${note.id}`;
  }

  async scheduleNote(newsletter: Newsletter, id: string, at: string | null) {
    const note = await this.note(newsletter, id);
    if (note.status === "published" || note.status === "publishing") throw new NewsletterError(409, "This note is published");
    if (at === null) {
      await this.sql`UPDATE public.newsletter_notes SET status = 'draft', publish_at = null, updated_at = now() WHERE id = ${note.id}`;
      return this.note(newsletter, id);
    }
    const when = new Date(at);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60_000)
      throw new NewsletterError(400, "Pick a time at least a minute from now");
    await this.withClient(newsletter, async () => undefined);
    await this.sql`UPDATE public.newsletter_notes SET status = 'scheduled', publish_at = ${when}, error = null, updated_at = now()
      WHERE id = ${note.id}`;
    return this.note(newsletter, id);
  }

  private async sendNote(newsletter: Newsletter, note: Note) {
    try {
      const { id, url } = await this.withClient(newsletter, (client) => client.publishNote(markdownToDoc(note.body)));
      await this.sql`UPDATE public.newsletter_notes SET status = 'published', published_at = now(), substack_id = ${id},
        url = ${url}, error = null, updated_at = now() WHERE id = ${note.id}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sql`UPDATE public.newsletter_notes SET status = 'failed', error = ${message}, updated_at = now() WHERE id = ${note.id}`;
      throw error;
    }
    return this.note(newsletter, note.id);
  }

  /** Publishes a note now: the user's click only. */
  async publishNote(newsletter: Newsletter, id: string) {
    const note = await this.note(newsletter, id);
    if (note.status === "published" || note.status === "publishing") throw new NewsletterError(409, "Already published");
    const [claimed] = await this.sql`UPDATE public.newsletter_notes SET status = 'publishing', updated_at = now()
      WHERE id = ${note.id} AND status IN ('draft', 'scheduled', 'failed') RETURNING id`;
    if (!claimed) throw new NewsletterError(409, "This note is being published");
    return this.sendNote(newsletter, note);
  }

  close() {
    this.mcp.close();
  }
}

export type { Audience, PMDoc, PostStatsRow, PublicationStats, SubstackComment };
