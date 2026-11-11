-- Threads and messages: what the web app reads and writes through supabase-js (PostgREST + RLS + Realtime).
-- The agent answers new user messages; Pi Durable keeps its own state in the `pi` schema.

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'New chat',
  -- The Pi Durable conversation behind the thread, set by the agent.
  conversation_id bigint unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index threads_by_user on public.threads (user_id, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'assistant')),
  content text not null default '',
  -- user: pending -> done | failed. assistant: streaming -> done | failed.
  status text not null default 'pending' check (status in ('pending', 'streaming', 'done', 'failed')),
  error text,
  -- The user message an assistant message answers.
  reply_to uuid unique references public.messages (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index messages_by_thread on public.messages (thread_id, created_at);
create index messages_pending on public.messages (created_at) where role = 'user' and status = 'pending';

-- A new message bumps its thread to the top of the list.
create function public.touch_thread() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;

create trigger messages_touch_thread after insert on public.messages
  for each row execute function public.touch_thread();

-- Row level security: each user sees and writes only their own rows. Users write user messages; the agent
-- (connected as postgres) writes the rest.
alter table public.threads enable row level security;
alter table public.messages enable row level security;

create policy "Users read their threads" on public.threads
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create their threads" on public.threads
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users rename their threads" on public.threads
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their threads" on public.threads
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their messages" on public.messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users send messages in their threads" on public.messages
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and role = 'user'
    and status = 'pending'
    and exists (select 1 from public.threads t where t.id = thread_id and t.user_id = (select auth.uid()))
  );

-- Column privileges: users never set a thread's conversation nor a message's role or status.
revoke all on public.threads, public.messages from anon, authenticated;
grant select, delete on public.threads to authenticated;
grant insert (id, title), update (title) on public.threads to authenticated;
grant select on public.messages to authenticated;
grant insert (id, thread_id, content) on public.messages to authenticated;

-- Realtime: the app follows its threads and the agent's streamed answers; the agent follows new messages.
alter table public.messages replica identity full;
alter publication supabase_realtime add table public.threads, public.messages;
