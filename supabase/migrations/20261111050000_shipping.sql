-- Shipping a project: publishing its build, and the database it can have.

-- The project's published build, served on the sites origin under /<slug>/. Null until it is first published.
alter table public.threads add column published_slug text unique check (published_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');
alter table public.threads add column published_at timestamptz;

-- The files of each published build, written and served by the server only.
create table public.published_files (
  slug text not null,
  path text not null,
  content bytea not null,
  content_type text not null,
  primary key (slug, path)
);
alter table public.published_files enable row level security;
revoke all on public.published_files from anon, authenticated;

-- A project's own database: a Postgres schema exposed through the API, owned by a login role that reaches only that
-- schema. The agent's SQL runs as that role, never as the server's. The password stays on the server.
alter table public.threads add column database_schema text unique;
create table public.app_databases (
  thread_id uuid primary key references public.threads (id) on delete cascade,
  schema_name text not null unique check (schema_name ~ '^app_[a-f0-9]{32}$'),
  role_name text not null unique,
  password text not null,
  created_at timestamptz not null default now()
);
alter table public.app_databases enable row level security;
revoke all on public.app_databases from anon, authenticated;
