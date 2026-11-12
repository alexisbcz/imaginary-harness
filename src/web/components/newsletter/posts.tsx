// A publication's posts: what goes out next, the drafts, and what was published, with a new draft (blank, or
// written by the copilot) one click away.

import { useState } from "react";
import { Loader } from "twenty-ui/primitives/feedback";
import { Button, Input } from "twenty-ui/primitives/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { IconClock, IconExternalLink, IconFilePencil, IconHeart, IconMessageCircle, IconSparkles } from "@tabler/icons-react";

import {
  audienceLabel,
  createDraft,
  formatMoment,
  usePosts,
  type Newsletter,
  type NewsletterPost,
} from "@/lib/newsletter";

function Row({ post, newsletter, onOpen }: { post: NewsletterPost; newsletter: Newsletter; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-t-hover">
        {post.cover_image ? (
          <img src={post.cover_image} alt="" className="size-10 shrink-0 rounded object-cover" />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded bg-t-secondary text-t-text-light">
            <IconFilePencil size={16} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-t-text">{post.title || "Untitled"}</span>
          <span className="block truncate text-[12px] text-t-text-tertiary">
            {post.subtitle || (post.state === "draft" ? `Edited ${formatMoment(post.updated_at, newsletter.timezone)}` : "")}
          </span>
        </span>
        {post.audience !== "everyone" && (
          <Tag variant="soft" color="amber" className="hidden text-[11px] sm:inline-flex">
            {audienceLabel(post.audience)}
          </Tag>
        )}
        {post.release_error && (
          <Tag variant="soft" color="red" className="text-[11px]">Release failed</Tag>
        )}
        <span className="shrink-0 text-right text-[12px] text-t-text-tertiary tabular-nums">
          {post.state === "scheduled" ? (
            <span className="flex items-center gap-1">
              <IconClock size={13} />
              {formatMoment(post.scheduled_for, newsletter.timezone)}
              {post.send_email === false && " · web"}
              {post.scheduled_by === "substack" && " · Substack"}
            </span>
          ) : post.state === "published" ? (
            <span className="flex items-center gap-2">
              {post.reactions > 0 && (
                <span className="flex items-center gap-0.5"><IconHeart size={12} />{post.reactions}</span>
              )}
              {post.comments > 0 && (
                <span className="flex items-center gap-0.5"><IconMessageCircle size={12} />{post.comments}</span>
              )}
              {formatMoment(post.post_date, newsletter.timezone, false)}
            </span>
          ) : null}
        </span>
        {post.url && (
          <a
            href={post.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-t-text-tertiary hover:bg-t-hover hover:text-t-text"
            aria-label="Open on Substack"
          >
            <IconExternalLink size={14} />
          </a>
        )}
      </button>
    </li>
  );
}

function Group({ title, posts, ...rest }: { title: string; posts: NewsletterPost[]; newsletter: Newsletter; onOpen: (id: number) => void }) {
  if (posts.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-medium text-t-text-tertiary">
        {title} <span className="text-t-text-light">{posts.length}</span>
      </h2>
      <ul className="flex flex-col divide-y divide-t-border-light overflow-hidden rounded-md border border-t-border">
        {posts.map((post) => (
          <Row key={post.id} post={post} newsletter={rest.newsletter} onOpen={() => rest.onOpen(post.id)} />
        ))}
      </ul>
    </section>
  );
}

export function NewsletterPosts({
  newsletter,
  revision,
  onOpen,
  onAsk,
}: {
  newsletter: Newsletter;
  revision: string;
  onOpen: (id: number) => void;
  onAsk: (message: string) => void;
}) {
  const { data: posts, error, loading } = usePosts(newsletter, revision);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function blank() {
    setCreating(true);
    setCreateError(null);
    try {
      onOpen((await createDraft(newsletter.id, { title: "" })).id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const query = search.trim().toLowerCase();
  const shown = (posts ?? []).filter((p) => !query || `${p.title} ${p.subtitle}`.toLowerCase().includes(query));
  const scheduled = shown.filter((p) => p.state === "scheduled").sort((a, b) => (a.scheduled_for ?? "").localeCompare(b.scheduled_for ?? ""));
  const drafts = shown.filter((p) => p.state === "draft");
  const published = shown.filter((p) => p.state === "published");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-5 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" color="accent" startIcon={<IconFilePencil size={14} />} loading={creating} onClick={() => void blank()}>
            New draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            startIcon={<IconSparkles size={14} />}
            onClick={() =>
              onAsk(
                "Look at what my readers opened and shared most, and my ideas backlog. Propose the next issue (three angles to choose from), then write the draft for the one I pick.",
              )
            }
          >
            Write the next issue with the copilot
          </Button>
          <span className="flex-1" />
          <Input aria-label="Search posts" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" />
        </div>
        {createError && <p className="text-t-text-danger">{createError}</p>}
        {error ? (
          <p className="text-t-text-danger">{error}</p>
        ) : !posts ? (
          <div className="flex h-24 items-center justify-center">{loading && <Loader />}</div>
        ) : posts.length === 0 ? (
          <div className="rounded-md border border-dashed border-t-border px-5 py-8 text-center text-t-text-secondary">
            No posts yet. Start a draft, or ask the copilot to write your first issue.
          </div>
        ) : (
          <>
            <Group title="Scheduled" posts={scheduled} newsletter={newsletter} onOpen={onOpen} />
            <Group title="Drafts" posts={drafts} newsletter={newsletter} onOpen={onOpen} />
            <Group title="Published" posts={published} newsletter={newsletter} onOpen={onOpen} />
            {shown.length === 0 && <p className="text-t-text-tertiary">No post matches “{search}”.</p>}
          </>
        )}
      </div>
    </div>
  );
}
