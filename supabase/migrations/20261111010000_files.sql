-- Files: each thread's workspace, written by the agent's file tools and shown in the app as a tree and diffs.

create table public.files (
  thread_id uuid not null references public.threads (id) on delete cascade,
  path text not null check (path ~ '^[^/].*[^/]$' and path !~ '(^|/)\.\.?(/|$)'),
  user_id uuid not null references auth.users (id) on delete cascade,
  contents text not null,
  -- The contents before the latest change; null for a file the latest change created.
  previous text,
  updated_at timestamptz not null default now(),
  primary key (thread_id, path)
);

alter table public.files enable row level security;

create policy "Users read their files" on public.files
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.files from anon, authenticated;
grant select on public.files to authenticated;

alter table public.files replica identity full;
alter publication supabase_realtime add table public.files;
