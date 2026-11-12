-- Newsletter: Substack publications run from Richelieu. Drafts, scheduled and published posts live in Substack; here
-- live the publication's connection (its session cookie sealed, out of the browser's reach), its brief, its
-- copilot thread, a backlog of ideas, the releases Richelieu publishes at their time, and Notes. The web app reads
-- these through PostgREST (RLS) and changes them through the newsletter API.

alter table public.threads drop constraint if exists threads_kind_check;
alter table public.threads add constraint threads_kind_check check (kind in ('project', 'social', 'newsletter'));

create table public.newsletters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- The Substack publication, once connected: its origin (https://name.substack.com or its custom domain).
  publication_url text,
  publication_id bigint,
  subdomain text,
  logo_url text,
  paid boolean not null default false,
  substack_user_id bigint,
  substack_user_name text,
  connected_at timestamptz,
  -- Why the last call to Substack failed (an expired session…), until one succeeds.
  connection_error text,
  -- The brief the copilot writes from.
  description text not null default '',
  audience text not null default '',
  voice text not null default '',
  pillars text[] not null default '{}',
  avoid text not null default '',
  examples text not null default '',
  -- Structure the issues follow: sections, recurring segments, length.
  format text not null default '',
  timezone text not null default 'UTC',
  -- Issues a week the newsletter aims for.
  cadence numeric not null default 1 check (cadence >= 0 and cadence <= 14),
  default_audience text not null default 'everyone' check (default_audience in ('everyone', 'only_paid', 'founding', 'only_free')),
  thread_id uuid unique references public.threads (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index newsletters_by_user on public.newsletters (user_id, created_at);

-- The Substack session cookie, sealed (src/newsletter/secrets.ts). No grant for the browser.
create table public.newsletter_credentials (
  newsletter_id uuid primary key references public.newsletters (id) on delete cascade,
  token_sealed text not null,
  updated_at timestamptz not null default now()
);

-- Ideas for future issues: a backlog the user and the copilot both fill.
create table public.newsletter_ideas (
  id uuid primary key default gen_random_uuid(),
  newsletter_id uuid not null references public.newsletters (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  notes text not null default '',
  status text not null default 'idea' check (status in ('idea', 'planned', 'drafting', 'done', 'dropped')),
  planned_for date,
  -- The Substack draft written from it.
  draft_id bigint,
  source text not null default 'user' check (source in ('user', 'copilot')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index newsletter_ideas_by_newsletter on public.newsletter_ideas (newsletter_id, created_at desc);

-- Drafts Richelieu publishes at a time: Substack's own scheduling is not reachable through its API, so the server
-- publishes them when their time comes. Posts scheduled in Substack's dashboard show from Substack.
create table public.newsletter_releases (
  id uuid primary key default gen_random_uuid(),
  newsletter_id uuid not null references public.newsletters (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  draft_id bigint not null,
  title text not null default '',
  publish_at timestamptz not null,
  send_email boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'publishing', 'published', 'failed', 'cancelled')),
  error text,
  attempts integer not null default 0,
  published_at timestamptz,
  post_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index newsletter_releases_one_pending on public.newsletter_releases (newsletter_id, draft_id)
  where status in ('pending', 'publishing');
create index newsletter_releases_due on public.newsletter_releases (publish_at) where status = 'pending';

-- Notes: Substack's short posts, drafted here and published (now or at a time) as the signed-in writer.
create table public.newsletter_notes (
  id uuid primary key default gen_random_uuid(),
  newsletter_id uuid not null references public.newsletters (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null default '' check (char_length(body) <= 10000),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed')),
  publish_at timestamptz,
  published_at timestamptz,
  substack_id bigint,
  url text,
  error text,
  source text not null default 'user' check (source in ('user', 'copilot')),
  -- The copilot's tool call that wrote it: a rerun after a crash finds it instead of writing a second one.
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index newsletter_notes_by_newsletter on public.newsletter_notes (newsletter_id, created_at desc);
create index newsletter_notes_due on public.newsletter_notes (publish_at) where status = 'scheduled';

-- The drafts the copilot created, by its tool call: Substack takes no idempotency key, so a call that runs again
-- after a crash finds its draft here (or, claimed but not recorded, among the drafts made since) instead of writing
-- a second one.
create table public.newsletter_draft_keys (
  key text primary key,
  newsletter_id uuid not null references public.newsletters (id) on delete cascade,
  title text not null default '',
  draft_id bigint,
  created_at timestamptz not null default now()
);

alter table public.newsletter_draft_keys enable row level security;
revoke all on public.newsletter_draft_keys from anon, authenticated;

alter table public.newsletters enable row level security;
alter table public.newsletter_credentials enable row level security;
alter table public.newsletter_ideas enable row level security;
alter table public.newsletter_releases enable row level security;
alter table public.newsletter_notes enable row level security;

create policy "Users read their newsletters" on public.newsletters
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their newsletter ideas" on public.newsletter_ideas
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their newsletter releases" on public.newsletter_releases
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their newsletter notes" on public.newsletter_notes
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.newsletters, public.newsletter_credentials, public.newsletter_ideas, public.newsletter_releases,
  public.newsletter_notes from anon, authenticated;
grant select on public.newsletters, public.newsletter_ideas, public.newsletter_releases, public.newsletter_notes
  to authenticated;

alter publication supabase_realtime add table public.newsletters, public.newsletter_ideas, public.newsletter_releases,
  public.newsletter_notes;
