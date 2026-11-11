-- The git forge: repositories, refs and git objects of each organization, served by `src/forge` through an API
-- compatible with code.storage's (the `@pierre/storage` SDK) and git's smart HTTP protocol. Only the server reads
-- this schema; PostgREST does not expose it.

create schema forge;
revoke all on schema forge from public, anon, authenticated;

-- An organization signs its tokens (ES256 JWTs, `iss` = name) with a private key; the forge checks them against
-- its public keys, several during a rotation.
create table forge.orgs (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  public_keys text[] not null check (cardinality(public_keys) > 0),
  created_at timestamptz not null default now()
);

create table forge.repos (
  org text not null references forge.orgs (name) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and id !~ '\.git$'),
  default_branch text not null default 'main',
  -- Where a fork came from: {"provider": "code", "owner": org, "name": repo}.
  base_repo jsonb,
  created_at timestamptz not null default now(),
  primary key (org, id)
);

create index repos_by_created on forge.repos (org, created_at desc, id);

-- Objects are content-addressed per organization, so forks share them. `data` is the object's content without
-- git's header, zlib-deflated as git stores loose objects.
create table forge.objects (
  org text not null references forge.orgs (name) on delete cascade,
  oid text not null check (oid ~ '^[0-9a-f]{40}$'),
  type text not null check (type in ('commit', 'tree', 'blob', 'tag')),
  size bigint not null,
  data bytea not null,
  primary key (org, oid)
);

-- Branches and tags (`refs/heads/*`, `refs/tags/*`, `refs/notes/*`). Ephemeral refs live apart: git sees them
-- only through the `+ephemeral` remote.
create table forge.refs (
  org text not null,
  repo text not null,
  ephemeral boolean not null default false,
  name text not null check (name ~ '^refs/'),
  oid text not null check (oid ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, repo, ephemeral, name),
  foreign key (org, repo) references forge.repos (org, id) on delete cascade
);
