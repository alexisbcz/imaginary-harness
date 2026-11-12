-- Social: brands whose social media the agent helps run. Posts, drafts, connected accounts and their analytics live
-- in Zernio (one Zernio profile per brand); the brand's brief, its copilot thread and the public accounts it watches
-- (competitors and inspiration, read through ScrapeCreators) live here. The web app reads these tables through
-- PostgREST (RLS) and changes them through the social API, which holds the API keys.

-- A thread is a project (the app builder) or a brand's social copilot.
alter table public.threads add column kind text not null default 'project' check (kind in ('project', 'social'));

create table public.social_brands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  website text not null default '',
  -- The brief the agent writes from: what the company does, for whom, how it speaks, what it posts about.
  description text not null default '',
  audience text not null default '',
  voice text not null default '',
  pillars text[] not null default '{}',
  avoid text not null default '',
  examples text not null default '',
  timezone text not null default 'UTC',
  -- How many posts a week the brand aims for, per platform: { "linkedin": 3, "twitter": 5 }.
  cadence jsonb not null default '{}',
  -- The Zernio profile that groups the brand's connected accounts, and the copilot's conversation.
  zernio_profile_id text unique,
  -- False when the brand took over a profile that already existed in Zernio: deleting the brand keeps it.
  zernio_profile_owned boolean not null default true,
  thread_id uuid unique references public.threads (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index social_brands_by_user on public.social_brands (user_id, created_at);

-- Public accounts a brand keeps an eye on.
create table public.social_watch (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.social_brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('instagram', 'tiktok', 'twitter', 'linkedin', 'youtube')),
  -- A handle, or a LinkedIn company or profile URL.
  handle text not null,
  relation text not null default 'competitor' check (relation in ('competitor', 'inspiration', 'self')),
  name text not null default '',
  avatar_url text,
  profile_url text,
  followers integer,
  -- Their latest posts, normalized: [{ id, url, text, thumbnail, published_at, views, likes, comments, shares }].
  posts jsonb not null default '[]',
  checked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (brand_id, platform, handle)
);

create index social_watch_by_brand on public.social_watch (brand_id);

-- One row a day per watched account, for its growth.
create table public.social_watch_history (
  watch_id uuid not null references public.social_watch (id) on delete cascade,
  day date not null,
  followers integer,
  avg_engagement numeric,
  primary key (watch_id, day)
);

alter table public.social_brands enable row level security;
alter table public.social_watch enable row level security;
alter table public.social_watch_history enable row level security;

create policy "Users read their brands" on public.social_brands
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their watched accounts" on public.social_watch
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users read their watched accounts' history" on public.social_watch_history
  for select to authenticated using (
    exists (select 1 from public.social_watch w where w.id = watch_id and w.user_id = (select auth.uid()))
  );

revoke all on public.social_brands, public.social_watch, public.social_watch_history from anon, authenticated;
grant select on public.social_brands, public.social_watch, public.social_watch_history to authenticated;

alter publication supabase_realtime add table public.social_brands, public.social_watch;
