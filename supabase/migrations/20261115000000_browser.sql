-- The agent's browser keeps each project's sign-ins: the cookies and storage of its last session, sealed
-- (src/newsletter/secrets.ts), restored when the browser starts again. The browser never reads them back to anyone;
-- the table has no grant for the web app.

create table public.browser_profiles (
  project_id uuid primary key references public.projects (id) on delete cascade,
  state_sealed text not null,
  updated_at timestamptz not null default now()
);

alter table public.browser_profiles enable row level security;
revoke all on public.browser_profiles from anon, authenticated;
