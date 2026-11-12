# Newsletter

Richelieu runs a Substack newsletter from end to end. It keeps posts, drafts and scheduling, a Markdown editor with
a live preview, a backlog of ideas, Notes and analytics, plus a copilot that plans, writes and revises with you.
You can write by hand, let the copilot draft, or work together in the editor. Nothing is published or emailed until
you click.

- [Setup](#setup)
- [Three ways to write](#three-ways-to-write)
- [What it does](#what-it-does)
- [The copilot](#the-copilot)
- [The Substack MCP (optional)](#the-substack-mcp-optional)
- [How it works](#how-it-works)
- [Limits](#limits)

## Setup

Open **Newsletter** in the sidebar and connect a publication:

1. Sign in to substack.com in your browser.
2. Open the developer tools → Application (Storage in Firefox) → Cookies → `https://substack.com`.
3. Copy the value of `substack.sid` and paste it in Richelieu, with the publication's address (`name.substack.com` or
   its custom domain). Leave the address empty to use your first publication.

Substack has no public API. Richelieu calls the private endpoints Substack's own web app uses, acting as you with
that session. Richelieu checks that the session can edit the publication before keeping it. It stores the session
sealed with AES-GCM, in a table the browser cannot read. The session stops working when you sign out of Substack,
and the page then asks for a fresh cookie.

```sh
# .env (all optional)
NEWSLETTER_SECRET=...            # the key that seals Substack sessions; defaults to the service role key
SUBSTACK_MCP=true                # also give the copilot the substack-mcp server's tools (needs Node 22+ and npx)
SUBSTACK_MCP_COMMAND="npx -y substack-mcp@1.3.2"   # how to start it, if not this
```

If you set `NEWSLETTER_SECRET` after connecting, the sessions already stored can no longer be read. Connect them
again.

You can also start without connecting. Ideas, Notes drafts, the brief and the copilot work already.

## Three ways to write

- **By hand.** **New draft** opens the editor: a title, a subtitle and a Markdown body, with a toolbar for headings,
  marks, links, quotes, lists, images, buttons, YouTube, dividers and the paywall. Images you add (button, drag or
  paste) go to Substack's CDN. The draft saves itself to Substack as you type. Write, Split and Preview show the
  document exactly as Substack will receive it.
- **By the copilot.** Ask it for the next issue, or press **Copilot writes it** on an idea. It writes the draft
  straight into Substack, and you review it in the editor.
- **Together.** The editor's **AI** menu works on the selection, or on the whole post when nothing is selected. It
  can improve, make punchier, shorten, develop, simplify, fix the spelling, or change the text your way. It can also
  continue writing from the cursor, turn your notes into a draft, suggest titles with subtitles, and review the
  draft like an editor. Each change shows as a proposal next to the current text, and only **Accept** applies it.
  **Work on it with the copilot** hands the open draft to the conversation.

When you and the copilot edit the same draft, the editor reloads the copilot's changes unless you have unsaved
edits. In that case it asks whether to keep yours or load theirs. Saves compare Substack's `draft_updated_at`, so
neither side silently overwrites the other.

Substack blocks are written as directives on a line of their own:

| Markdown                       | In Substack                                 |
| ------------------------------ | ------------------------------------------- |
| `::paywall`                    | paid subscribers only below                 |
| `::subscribe`, `::share`       | the subscribe and share buttons             |
| `::button[Text](https://…)`    | a button                                    |
| `::youtube[VIDEO_ID]`          | a YouTube embed                             |
| `![alt](https://… "caption")`  | a captioned image                           |
| `::embed[…]`                   | a block Richelieu does not edit, kept as is |

Blocks Richelieu does not know, such as post embeds and polls, survive a round trip through the editor unchanged.

## What it does

- **Posts.** What is scheduled, the drafts, and what was published. A published post opens read-only, with its
  comments and a link to Substack. You edit it in Substack, where saving updates the live post.
- **Publishing.** **Publish** checks the post first (title, body, Substack's own checks). It then asks whether to
  email it, and that choice cannot be undone. **Schedule** picks a time in the newsletter's time zone, and whether
  to send the email.
- **Post settings.** Audience (everyone, free, paid, founding), who can comment, the cover image, the description
  (the AI can write it), the social and search titles, and the web address.
- **Ideas.** A backlog with notes, a status and a planned day. **I'll write it** starts a draft from the idea's
  notes, and **Copilot writes it** asks the copilot to write it.
- **Notes.** Substack Notes are drafted here, by you or the copilot. You can publish one now or schedule it.
- **Analytics.** Subscribers, paid subscribers, open rate and views over 30 days, and a sortable table of each sent
  post's numbers: recipients, open rate, click rate, views, likes, restacks, new subscribers and unsubscribes.
- **Brief.** What the newsletter is about, its readers, voice, recurring themes, the format of an issue, what to
  avoid, sample passages, the time zone, the issues a week, and the default audience. Every draft, assist and copilot
  answer starts from it.

## The copilot

Each newsletter has a conversation of its own beside its pages. It is a thread of kind `newsletter`, answered by the
same Pi Durable agent with its own tools (`src/newsletter/agent.ts`):

| Tool                                                 | What it does                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `newsletter_overview`                                | subscribers, open rate, drafts, what is scheduled, recent posts, ideas |
| `newsletter_performance`                             | each sent post's numbers                                          |
| `list_newsletter_posts`, `read_newsletter_post`      | the posts, and one post's Markdown                                |
| `write_newsletter_draft`                             | a new draft in Substack                                           |
| `update_newsletter_draft`                            | revises a draft: the whole body, or exact find/replace edits      |
| `check_newsletter_post`                              | what would stop it from publishing                                |
| `schedule_newsletter_post`, `unschedule_newsletter_post` | only when the user asked                                      |
| `delete_newsletter_draft`                            | only when the user asked                                          |
| `read_newsletter_comments`                           | readers' comments on a post                                       |
| `list_newsletter_ideas`, `save_newsletter_idea`      | the backlog                                                       |
| `draft_substack_note`, `schedule_substack_note`      | Notes; scheduling only when asked                                 |
| `add_newsletter_image`                               | puts a public image on Substack's CDN                             |
| `update_newsletter_brief`, `read_website`            | the brief, and pages to research                                  |

What keeps it safe:

- The copilot cannot publish now or send an email itself. It drafts, and it schedules only what the user asked for.
- A conversation reaches only its own newsletter's session.
- Drafting is replay-safe. Substack takes no idempotency key, so the tool call claims a key in
  `newsletter_draft_keys` before creating the draft. A call that runs again after a crash finds the draft it made.
- Posts, comments and pages the copilot reads are marked as data written by others.

## The Substack MCP (optional)

With `SUBSTACK_MCP=true`, the copilot also reaches the tools of
[substack-mcp](https://github.com/marcomoauro/substack-mcp) through `substack_mcp_tools` and `call_substack_mcp`.
They cover subscriber lists and exports, sixteen analytics reports (retention, growth sources, referrals, audience
overlap…), the reader feed, tags and comment threads.

Richelieu speaks MCP over stdio to one server process per newsletter. Each process is started on first use with
that newsletter's session in its environment, and stopped after 10 idle minutes (`src/newsletter/mcp.ts`). The
server's `publish_draft`, `delete_draft`, `comment_on_post` and `restack_item` are not offered. Publishing,
deleting and speaking for the user go through Richelieu's own tools and the user's approval. The command is pinned
to a version because the process holds the user's session.

The editor and every page work without it. The MCP adds reach for the copilot, not a dependency.

## How it works

| Where                                      | What                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `src/newsletter/substack.ts`               | the Substack client: drafts, publishing, images, comments, stats, Notes |
| `src/newsletter/document.ts`               | Markdown ⇄ Substack's ProseMirror document, shared with the web app      |
| `src/newsletter/service.ts`                | newsletters, the sealed sessions, drafts, releases, ideas, Notes        |
| `src/newsletter/writer.ts`                 | the brief as the model reads it, and the editor's assists               |
| `src/newsletter/agent.ts`                  | the copilot's tools and instructions                                     |
| `src/newsletter/mcp.ts`                    | the optional substack-mcp client                                         |
| `src/server/newsletter-api.ts`             | `/api/newsletters/*`                                                     |
| `src/web/routes/newsletter.tsx`            | the page; its views live in `src/web/components/newsletter/`            |
| `supabase/migrations/…_newsletter.sql`     | `newsletters`, credentials, ideas, releases, Notes, draft keys           |

Posts live in Substack, not in Postgres, so changes made in Substack's own editor show up here. Substack's
scheduling is not reachable through its API, so Richelieu schedules itself. A `newsletter_releases` row holds the
draft and the time, and the server publishes due releases every minute (`publishDue`, also run by the Vercel
agent's cron). A network failure is retried three times. A refusal from Substack marks the release failed, and the
editor shows why. Posts scheduled in Substack's dashboard show as scheduled too.

## Limits

- Substack's private API can change without notice. Each response is read defensively, and failures show Substack's
  own message.
- Scheduled posts and Notes go out only while the server runs: the local server, a VPS, or the Vercel cron.
- A published post is edited in Substack, not here.
- Sections, guest bylines, podcasts and video posts are not edited here. Their posts still list, and blocks
  Richelieu does not know are kept as they are.
- A newsletter belongs to one user. There is no approval flow between teammates yet.
