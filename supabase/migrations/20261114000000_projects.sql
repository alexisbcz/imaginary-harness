-- Projects and chats. A chat is a conversation with the agent; a project is a named place that holds chats and one
-- app (its files, its git repository, its preview, its database and its published build), which every chat of the
-- project builds on. A chat outside any project is a plain conversation: it builds nothing.
--
-- Until now a thread was a project: each project thread becomes a project with the same id (so its repository on
-- the forge, its preview and its database keep their names) and its first chat.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'New project' check (char_length(name) between 1 and 80),
  -- What the project is, for the user and the agent.
  description text not null default '' check (char_length(description) <= 2000),
  -- What the agent follows in every chat of the project.
  instructions text not null default '' check (char_length(instructions) <= 8000),
  -- The published build, served on the sites origin under /<slug>/. Null until it is first published.
  published_slug text unique check (published_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  published_at timestamptz,
  database_schema text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_by_user on public.projects (user_id, updated_at desc);

insert into public.projects (id, user_id, name, published_slug, published_at, database_schema, created_at, updated_at)
select id, user_id, left(coalesce(nullif(btrim(title), ''), 'New project'), 80), published_slug, published_at,
  database_schema, created_at, updated_at
from public.threads where kind = 'project';

-- Threads: `chat` (in a project or not), or a brand's or a newsletter's copilot.
alter table public.threads add column project_id uuid references public.projects (id) on delete cascade;
create index threads_by_project on public.threads (project_id, updated_at desc);
alter table public.threads drop constraint if exists threads_kind_check;
update public.threads set project_id = id, kind = 'chat' where kind = 'project';
alter table public.threads alter column kind set default 'chat';
alter table public.threads add constraint threads_kind_check check (kind in ('chat', 'social', 'newsletter'));
alter table public.threads add constraint threads_project_is_chat check (project_id is null or kind = 'chat');
alter table public.threads alter column title set default 'New chat';
alter table public.threads drop column published_slug, drop column published_at, drop column database_schema;

-- The app's files and database belong to the project.
alter table public.files drop constraint files_thread_id_fkey;
alter table public.files rename column thread_id to project_id;
alter table public.files add constraint files_project_id_fkey
  foreign key (project_id) references public.projects (id) on delete cascade;

alter table public.app_databases drop constraint app_databases_thread_id_fkey;
alter table public.app_databases rename column thread_id to project_id;
alter table public.app_databases add constraint app_databases_project_id_fkey
  foreign key (project_id) references public.projects (id) on delete cascade;

-- A new message bumps its thread, and its project, to the top of their lists.
create or replace function public.touch_thread() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  project uuid;
begin
  update public.threads set updated_at = now() where id = new.thread_id returning project_id into project;
  if project is not null then
    update public.projects set updated_at = now() where id = project;
  end if;
  return new;
end;
$$;

-- Row level security: each user sees and changes only their own projects.
alter table public.projects enable row level security;

create policy "Users read their projects" on public.projects
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create their projects" on public.projects
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users edit their projects" on public.projects
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their projects" on public.projects
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.projects from anon, authenticated;
grant select, delete on public.projects to authenticated;
grant insert (id, name, description, instructions), update (name, description, instructions)
  on public.projects to authenticated;

-- A user starts chats, in their own projects only; the copilots' threads are made by the server.
drop policy "Users create their threads" on public.threads;
create policy "Users create their chats" on public.threads
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and kind = 'chat'
    and (
      project_id is null
      or exists (select 1 from public.projects p where p.id = project_id and p.user_id = (select auth.uid()))
    )
  );
grant insert (project_id) on public.threads to authenticated;

alter publication supabase_realtime add table public.projects;
