-- Posts a brand published outside Zernio (straight on LinkedIn, X…), imported by their URL and read through
-- ScrapeCreators, so the calendar and the analytics show everything the brand posted. Their numbers are read again
-- every day while they are recent.

create table public.social_imported_posts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.social_brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('instagram', 'tiktok', 'twitter', 'linkedin', 'youtube')),
  url text not null,
  -- The platform's ids for the post (a LinkedIn post has an activity and a content id): to recognise it again, and
  -- to tell it apart from the same post published through Zernio.
  external_ids text[] not null default '{}',
  content text not null default '',
  thumbnail text,
  published_at timestamptz,
  views integer,
  likes integer,
  comments integer,
  shares integer,
  checked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (brand_id, url)
);

create index social_imported_posts_by_brand on public.social_imported_posts (brand_id, published_at desc);

alter table public.social_imported_posts enable row level security;
create policy "Users read their imported posts" on public.social_imported_posts
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.social_imported_posts from anon, authenticated;
grant select on public.social_imported_posts to authenticated;
