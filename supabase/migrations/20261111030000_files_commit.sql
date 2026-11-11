-- Each workspace file now lives in a git repository on the forge (one per thread, named after it);
-- `public.files` mirrors the head, with the commit that last changed each file.
alter table public.files add column commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$');
