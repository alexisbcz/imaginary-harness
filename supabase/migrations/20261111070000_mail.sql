-- Mail: the domains Richelieu receives mail for, the addresses on them, their folders and messages. The web app
-- reads them through PostgREST (RLS) and follows them through Realtime; it changes them only through the functions
-- below, which keep IMAP's UIDs and modification sequences right. What only the mail server reads (DKIM private
-- keys, raw messages, the outbound queue, certificates) lives in the `mail` schema, out of the API's reach.

create schema if not exists mail;
revoke all on schema mail from public, anon, authenticated;

-- Domains ----------------------------------------------------------------------------------------------------

create table public.mail_domains (
  id uuid primary key default gen_random_uuid(),
  -- The owner. A server domain (added with the CLI) has none, and is open: any user may take an address on it.
  user_id uuid references auth.users (id) on delete cascade,
  name text not null unique check (name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  open boolean not null default false,
  dkim_selector text not null,
  -- The TXT value to publish at <selector>._domainkey.<name>.
  dkim_record text not null,
  -- Set once the DNS records check out: only verified domains send.
  verified_at timestamptz,
  -- The latest DNS check, record by record: { mx: { ok, found, expected }, spf: ..., dkim: ..., dmarc: ... }.
  checks jsonb not null default '{}',
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create table mail.dkim_keys (
  domain_id uuid not null references public.mail_domains (id) on delete cascade,
  selector text not null,
  private_key text not null,
  dns_record text not null,
  -- The key that signs; older ones stay published until their selector is removed from DNS.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (domain_id, selector)
);

-- Accounts ---------------------------------------------------------------------------------------------------

create table public.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  domain_id uuid not null references public.mail_domains (id) on delete cascade,
  local_part text not null check (local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  address text not null unique,
  display_name text not null default '' check (char_length(display_name) <= 120),
  -- What the agent does with new mail: nothing, a summary, or a summary and a draft reply.
  assistant text not null default 'summarize' check (assistant in ('off', 'summarize', 'draft')),
  -- Catch every address of the domain that has no account of its own.
  catch_all boolean not null default false,
  created_at timestamptz not null default now(),
  unique (domain_id, local_part)
);

create index mail_accounts_by_user on public.mail_accounts (user_id);

create table public.mail_folders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200 and name !~ '[[:cntrl:]]'),
  special_use text check (special_use in ('inbox', 'sent', 'drafts', 'archive', 'junk', 'trash')),
  -- IMAP's identity of the folder's UIDs (a 32-bit number), and the next UID to give.
  uid_validity bigint not null default (extract(epoch from clock_timestamp())::bigint % 4294967295),
  uid_next bigint not null default 1,
  -- Grows with every change to the folder's messages (CONDSTORE's HIGHESTMODSEQ).
  modseq bigint not null default 1,
  subscribed boolean not null default true,
  created_at timestamptz not null default now(),
  unique (account_id, name)
);

create unique index mail_folders_special on public.mail_folders (account_id, special_use) where special_use is not null;

-- Messages ---------------------------------------------------------------------------------------------------

create table public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  folder_id uuid not null references public.mail_folders (id) on delete cascade,
  uid bigint not null,
  modseq bigint not null default 1,
  flags text[] not null default '{}',
  internal_date timestamptz not null default now(),
  size integer not null,
  message_id text,
  in_reply_to text,
  "references" text[] not null default '{}',
  -- Messages of one conversation share it: the first Message-ID of their references.
  thread_key text,
  subject text not null default '',
  from_name text not null default '',
  from_address text not null default '',
  to_addresses jsonb not null default '[]',
  cc_addresses jsonb not null default '[]',
  sent_at timestamptz,
  snippet text not null default '',
  text_body text not null default '',
  html_body text,
  attachments jsonb not null default '[]',
  -- What the receiving server found: { spf, dkim, dmarc, ip, helo }.
  authentication jsonb,
  -- For sent messages, each recipient's delivery: [{ address, status, detail, at }].
  delivery jsonb,
  -- The agent's reading of the message.
  summary text,
  category text,
  assistant_status text check (assistant_status in ('pending', 'running', 'done', 'failed', 'skipped')),
  created_at timestamptz not null default now(),
  unique (folder_id, uid)
);

create index mail_messages_by_folder on public.mail_messages (folder_id, internal_date desc);
create index mail_messages_by_thread on public.mail_messages (account_id, thread_key);
create index mail_messages_by_message_id on public.mail_messages (account_id, message_id);
create index mail_messages_assistant on public.mail_messages (created_at) where assistant_status = 'pending';
create index mail_messages_search on public.mail_messages using gin (
  to_tsvector('simple', subject || ' ' || from_name || ' ' || from_address || ' ' || text_body)
);

-- The message as it arrived, byte for byte: what IMAP serves and DKIM signed.
create table mail.blobs (
  message_id uuid primary key references public.mail_messages (id) on delete cascade,
  raw bytea not null
);

-- Every flag change and move takes the folder's next modification sequence, so IMAP clients see what changed.
create function mail.bump_modseq() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.flags is distinct from old.flags or new.folder_id is distinct from old.folder_id then
    update public.mail_folders set modseq = modseq + 1 where id = new.folder_id returning modseq into new.modseq;
  end if;
  -- The folder a message left changed too.
  if tg_op = 'UPDATE' and new.folder_id is distinct from old.folder_id then
    update public.mail_folders set modseq = modseq + 1 where id = old.folder_id;
  end if;
  return new;
end;
$$;

create trigger mail_messages_modseq before insert or update on public.mail_messages
  for each row execute function mail.bump_modseq();

create function mail.bump_folder_on_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.mail_folders set modseq = modseq + 1 where id = old.folder_id;
  return old;
end;
$$;

create trigger mail_messages_expunged after delete on public.mail_messages
  for each row execute function mail.bump_folder_on_delete();

-- The standard folders of a new account.
create function mail.create_folders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.mail_folders (account_id, user_id, name, special_use) values
    (new.id, new.user_id, 'INBOX', 'inbox'),
    (new.id, new.user_id, 'Sent', 'sent'),
    (new.id, new.user_id, 'Drafts', 'drafts'),
    (new.id, new.user_id, 'Archive', 'archive'),
    (new.id, new.user_id, 'Junk', 'junk'),
    (new.id, new.user_id, 'Trash', 'trash');
  return new;
end;
$$;

create trigger mail_accounts_folders after insert on public.mail_accounts
  for each row execute function mail.create_folders();

-- Gives `count` consecutive UIDs of a folder; returns the first.
create function mail.allocate_uids(folder uuid, count integer) returns bigint
language sql security definer set search_path = '' as $$
  update public.mail_folders set uid_next = uid_next + count where id = folder returning uid_next - count;
$$;

-- Moves messages to another folder of their account, with new UIDs there, in the order given.
create function mail.move_messages(ids uuid[], target uuid) returns setof public.mail_messages
language plpgsql security definer set search_path = '' as $$
declare
  first_uid bigint;
  moving integer;
begin
  select count(*) into moving from public.mail_messages m
    join public.mail_folders f on f.id = target and f.account_id = m.account_id
    where m.id = any(ids) and m.folder_id <> target;
  if moving = 0 then return; end if;
  first_uid := mail.allocate_uids(target, moving);
  return query
  with ordered as (
    select m.id, row_number() over (order by array_position(ids, m.id)) - 1 as n
    from public.mail_messages m
    join public.mail_folders f on f.id = target and f.account_id = m.account_id
    where m.id = any(ids) and m.folder_id <> target
  )
  update public.mail_messages m set folder_id = target, uid = first_uid + o.n
  from ordered o where m.id = o.id
  returning m.*;
end;
$$;

-- Mail servers ------------------------------------------------------------------------------------------------

-- Passwords for mail clients (IMAP and SMTP submission), one per device, never the account's own password.
create table public.mail_app_passwords (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  hash text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index mail_app_passwords_by_user on public.mail_app_passwords (user_id);

-- Messages waiting to leave, one row per recipient, retried with backoff until delivered or expired.
create table mail.outbound (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.mail_accounts (id) on delete set null,
  -- The copy in the sender's Sent folder, whose `delivery` shows how it went.
  sent_message_id uuid references public.mail_messages (id) on delete set null,
  mail_from text not null,
  raw bytea not null,
  -- Makes a retried send (a crash, a replayed agent tool call) queue the message once.
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 days'
);

create table mail.outbound_recipients (
  outbound_id uuid not null references mail.outbound (id) on delete cascade,
  address text not null,
  domain text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  primary key (outbound_id, address)
);

create index mail_outbound_due on mail.outbound_recipients (next_attempt_at) where status = 'queued';

-- TLS certificates for the mail server's names, from ACME or imported, shared by every process.
create table mail.certificates (
  hostname text primary key,
  certificate text not null,
  private_key text not null,
  issuer text not null default '',
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- ACME: the account key, and the HTTP-01 answers the web server gives while an order is being validated.
create table mail.acme_accounts (
  directory text primary key,
  jwk jsonb not null,
  url text,
  created_at timestamptz not null default now()
);

create table mail.acme_challenges (
  token text primary key,
  key_authorization text not null,
  created_at timestamptz not null default now()
);

-- Pi Durable conversations the mail assistant runs, one per account and thread of messages.
create table mail.conversations (
  conversation_id bigint primary key,
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_key text not null,
  unique (account_id, thread_key)
);

-- Row level security ------------------------------------------------------------------------------------------

alter table public.mail_domains enable row level security;
alter table public.mail_accounts enable row level security;
alter table public.mail_folders enable row level security;
alter table public.mail_messages enable row level security;
alter table public.mail_app_passwords enable row level security;

create policy "Users read their domains and open ones" on public.mail_domains
  for select to authenticated using ((select auth.uid()) = user_id or open);
create policy "Users delete their domains" on public.mail_domains
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their accounts" on public.mail_accounts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users change their accounts" on public.mail_accounts
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their accounts" on public.mail_accounts
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their folders" on public.mail_folders
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their messages" on public.mail_messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users delete their messages" on public.mail_messages
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their app passwords" on public.mail_app_passwords
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users revoke their app passwords" on public.mail_app_passwords
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.mail_domains, public.mail_accounts, public.mail_folders, public.mail_messages, public.mail_app_passwords
  from anon, authenticated;
grant select, delete on public.mail_domains to authenticated;
grant select, delete on public.mail_accounts to authenticated;
grant update (display_name, assistant, catch_all) on public.mail_accounts to authenticated;
grant select on public.mail_folders to authenticated;
grant select, delete on public.mail_messages to authenticated;
grant select (id, user_id, name, last_used_at, created_at), delete on public.mail_app_passwords to authenticated;

-- What the web app changes, through functions that check ownership -------------------------------------------

-- Adds and removes flags (\Seen, \Flagged...) of the user's messages.
create function public.mail_set_flags(ids uuid[], add_flags text[] default '{}', remove_flags text[] default '{}')
returns void
language sql security definer set search_path = '' as $$
  update public.mail_messages
  set flags = array(select distinct f from unnest(flags || add_flags) f where f <> all(remove_flags) order by f)
  where id = any(ids) and user_id = (select auth.uid());
$$;

-- Moves the user's messages to one of their folders.
create function public.mail_move(ids uuid[], target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.mail_folders where id = target and user_id = (select auth.uid())) then
    raise exception 'No such folder' using errcode = '42501';
  end if;
  perform mail.move_messages(
    array(select id from public.mail_messages where id = any(ids) and user_id = (select auth.uid())),
    target
  );
end;
$$;

-- Creates a folder in one of the user's accounts.
create function public.mail_create_folder(account uuid, folder_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  created uuid;
begin
  insert into public.mail_folders (account_id, user_id, name)
  select id, user_id, btrim(folder_name) from public.mail_accounts where id = account and user_id = (select auth.uid())
  returning id into created;
  if created is null then raise exception 'No such account' using errcode = '42501'; end if;
  return created;
end;
$$;

revoke all on function public.mail_set_flags(uuid[], text[], text[]), public.mail_move(uuid[], uuid),
  public.mail_create_folder(uuid, text) from public, anon;
grant execute on function public.mail_set_flags(uuid[], text[], text[]), public.mail_move(uuid[], uuid),
  public.mail_create_folder(uuid, text) to authenticated;
revoke all on all functions in schema mail from public, anon, authenticated;

-- Realtime: the inbox follows its folders and messages.
alter publication supabase_realtime add table public.mail_folders, public.mail_messages, public.mail_accounts, public.mail_domains;

notify pgrst, 'reload schema';
