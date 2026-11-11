-- A person's name. Richelieu will not open without one. Built apps share this Auth service and sign
-- people up with only an email, so a missing name does not reject the account: it leaves no profile,
-- and Richelieu asks for the name before the app.

create table public.profiles (
  id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null constraint profiles_name_valid check (
    char_length(name) between 1 and 80
    and name = btrim(name)
    and name !~ '[[:space:]]{2,}'
    and name !~ '[[:cntrl:]]'
  )
);

alter table public.profiles enable row level security;

-- The id is the default auth.uid(), and that column is not granted, so a user can only create their own row.
create policy "Users read their profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "Users set their name" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

revoke all on public.profiles from anon, authenticated;
grant select (id, name) on public.profiles to authenticated;
grant insert (name) on public.profiles to authenticated;

-- Copies a valid name out of the new account's metadata. An empty or unusable name is skipped.
create function public.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  display_name text := regexp_replace(
    btrim(coalesce(new.raw_user_meta_data ->> 'name', '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
begin
  if char_length(display_name) between 1 and 80
     and display_name !~ '[[:cntrl:]]' then
    insert into public.profiles (id, name) values (new.id, display_name);
  end if;
  return new;
end;
$$;

revoke all on function public.create_profile() from public, anon, authenticated;
grant execute on function public.create_profile() to supabase_auth_admin;

create trigger create_profile_for_user after insert on auth.users
  for each row execute function public.create_profile();

notify pgrst, 'reload schema';
