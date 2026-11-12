# Social

Richelieu runs a brand's social media with an agent: a calendar of drafts and scheduled posts, a composer with
previews for each platform, analytics, a watchlist of competitors, and a copilot that plans, writes and reads the
numbers. Posting, scheduling and analytics go through [Zernio](https://zernio.com). Reading public accounts goes
through [ScrapeCreators](https://scrapecreators.com).

- [Setup](#setup)
- [What it does](#what-it-does)
- [The copilot](#the-copilot)
- [How it works](#how-it-works)
- [Limits](#limits)

## Setup

```sh
# .env
ZERNIO_API_KEY=sk_...            # zernio.com → API keys: accounts, posts, scheduling, analytics
SCRAPECREATORS_API_KEY=...       # scrapecreators.com: the watchlist and the copilot's research
ZERNIO_LINK_EXISTING=true        # optional: lets a brand take over a Zernio profile that already has accounts
```

Open **Social** in the sidebar and create a brand. Each brand gets a Zernio profile of its own, unless it takes over
an existing one: with `ZERNIO_LINK_EXISTING=true`, the first screen lists the profiles of the Zernio account. Any user
of the server can take them over, so leave the setting off on a shared server.

On the **Brand** tab, connect the accounts. Each platform's own sign-in opens through Zernio and comes back to the
page. Supported: LinkedIn, X, Instagram, Threads, Facebook, TikTok, YouTube and Pinterest.

## What it does

- **Calendar**: month and week views. Drafts show dashed, scheduled posts solid, published posts with a check, and
  failures in red. Drag a draft or a scheduled post to another day or hour to move it. A tray holds drafts that
  have no date yet. "Plan my week" asks the copilot to fill the next week.
- **Composer**: one text for every account, or a version per platform. Each platform shows its character count, X
  counts links as 23, and the composer says when a platform needs an image or a video. It also has image and video
  uploads, previews per platform, and one-click rewrites in the brand's voice (stronger hook, shorter, fix
  spelling…). You can save a draft, schedule, or publish now; publishing asks first.
- **Analytics**: followers and their growth for each account, impressions, engagements and engagement rate against
  the previous period, a sortable table of posts, platforms compared, and a weekday × hour heatmap of when the
  brand's posts do best.
- **Watchlist**: public accounts on Instagram, TikTok, X, LinkedIn and YouTube, marked as competitor, inspiration or
  your own. Each shows followers, growth, engagement and posting rhythm, and their recent posts ranked by
  engagement. "Write a post inspired by this" hands a post to the copilot. Accounts are read again every day.
- **Posts published elsewhere**: Zernio only knows the posts that went through it. A post published straight on
  LinkedIn, X, Instagram, TikTok or YouTube can be imported by its link (**Import a post** on the calendar, short
  links like `lnkd.in` included, or by giving the link to the copilot). It then shows on the calendar and in the
  analytics with its likes, comments and views, read again every day for 30 days. LinkedIn shows no impressions
  this way. A post that went through Zernio is recognised and not imported twice.
- **Brand brief**: what the brand does, its audience, voice, content pillars, what to avoid, example posts, time
  zone, and a goal of posts per week for each platform. Every post the copilot or the composer writes starts from it.

## The copilot

Each brand has a conversation of its own beside the calendar. It is a thread of kind `social`, answered by the same
Pi Durable agent with a different set of tools (`src/social/agent.ts`):

| Tool                                    | What it does                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `social_overview`                       | accounts with followers and growth, the next two weeks, the last 30 days            |
| `social_performance`                    | best and weakest posts, platforms compared, best weekdays and hours                 |
| `list_social_posts`                     | posts in a date range                                                               |
| `draft_social_post`                     | a draft on the calendar, with versions per platform and media                       |
| `update_social_post`                    | changes a draft or a scheduled post                                                 |
| `schedule_social_post`                  | schedules a draft, only when the user asked for it                                  |
| `delete_social_post`                    | deletes a draft or a scheduled post, only when asked                                |
| `update_brand_brief`                    | saves what it learned about the brand                                               |
| `read_website`                          | reads a public page (the brand's site, a launch post)                               |
| `web_research`                          | searches the web and reads pages: a cited answer (blade.sh)                         |
| `research_social_account`               | any public account and its most engaging posts                                      |
| `list_watchlist`, `watch_social_account` | the watchlist                                                                       |
| `import_social_post`                    | imports a post published outside Richelieu, from its link                           |

What keeps it safe:

- A conversation reaches only its brand. The brand's Zernio profile is checked on every account and every post,
  because the Zernio key belongs to the server and every user shares it.
- The copilot cannot publish right away. It drafts, and it schedules only what the user asked for. Publishing now
  is a click in the composer, and the composer asks before it publishes.
- Drafting is replay-safe. The tool call is the idempotency key, so a call that runs again after a crash finds its
  draft instead of writing a second one.
- Posts, bios and pages it reads are marked as data written by others.

Project chats don't get the social tools, and the copilot doesn't get the app builder's.

## How it works

| Where                                   | What                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `src/social/zernio.ts`                  | the Zernio client: profiles, accounts, posts, media, analytics                |
| `src/social/scrapecreators.ts`          | the ScrapeCreators client, reading five platforms into one shape             |
| `src/social/service.ts`                 | brands, scoping to the brand's profile, validation, analytics, the watchlist |
| `src/social/platforms.ts`               | character limits and media rules, shared with the web app                    |
| `src/social/writer.ts`                  | the brief as the model reads it, and the composer's rewrites                 |
| `src/social/agent.ts`                   | the copilot's tools and instructions                                          |
| `src/server/social-api.ts`              | `/api/social/*`                                                               |
| `src/web/routes/social.tsx`             | the page; its views live in `src/web/components/social/`                     |
| `supabase/migrations/…_social.sql`      | `social_brands`, `social_watch`, `social_imported_posts`, `threads.kind`      |

Posts live in Zernio, not in Postgres: the calendar reads them through the API, so changes made in Zernio's own
dashboard show up too. Postgres keeps the brand, its brief, its copilot thread and its watchlist. The browser reads
these under RLS and changes them only through the API. Zernio reads are cached for a minute (accounts) and five
minutes (analytics).

## Limits

- Analytics depend on what each platform reports to Zernio. Some report impressions and some only views. Follower
  history starts when the account is connected.
- The watchlist reads public data. LinkedIn company posts come without engagement numbers, and X returns popular
  tweets rather than the latest ones.
- No approval workflow between teammates yet: a brand belongs to one user.
- No first-comment, thread or carousel editing in the composer; the copilot can still write threads as text.
