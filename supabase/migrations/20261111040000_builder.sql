-- The app builder: a thread is a project, whose workspace is a web app with a live preview.

alter table public.threads alter column title set default 'New project';

-- What the agent did while answering, for the chat to show: one entry per tool call
-- ({ id, tool, args, status: running | done | error, summary? }), written by the agent as it works.
alter table public.messages add column steps jsonb not null default '[]'::jsonb;

-- `build` lets the agent change the project; `chat` only discusses it, and the agent's file tools are blocked.
alter table public.messages add column mode text not null default 'build' check (mode in ('build', 'chat'));

-- Images sent with a message (screenshots, mockups), shrunk by the app before upload. Kept out of `messages` so
-- Realtime does not carry them.
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data bytea not null check (octet_length(data) <= 5 * 1024 * 1024),
  created_at timestamptz not null default now()
);

create index attachments_by_thread on public.attachments (thread_id);

alter table public.attachments enable row level security;

create policy "Users read their attachments" on public.attachments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users attach to their threads" on public.attachments
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.threads t where t.id = thread_id and t.user_id = (select auth.uid()))
  );

revoke all on public.attachments from anon, authenticated;
grant select on public.attachments to authenticated;
grant insert (id, thread_id, mime_type, data) on public.attachments to authenticated;

-- The attachments a message carries, by id.
alter table public.messages add column attachments uuid[] not null default '{}';

grant insert (mode, attachments) on public.messages to authenticated;
