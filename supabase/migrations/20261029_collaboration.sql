-- VerseFlow: collaboration — share links, notes per line, accounts and song members.
-- Safe to run more than once. The app's server talks to the database with its own key; every table gets the
-- same "server access" policy as the others (access is checked by the app's API).

-- ---------- share links: the stems and the mix to download, without an account ----------
create table if not exists shares (
  token text primary key,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null default '',
  files jsonb not null default '[]',
  note text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ready boolean not null default false,
  revoked boolean not null default false
);
create index if not exists shares_project on shares(project_id);

-- ---------- accounts ----------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  pass_hash text not null,
  created_at timestamptz not null default now()
);

-- who works on a song, and how: owner (everything, shares it), editor (writes, records, mixes), viewer (listens, notes)
create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user on project_members(user_id);

-- an invitation to a song, as a link
create table if not exists invites (
  token text primary key,
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false
);
create index if not exists invites_project on invites(project_id);

-- ---------- notes on a line: a comment or a voice message ----------
create table if not exists line_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  line_id uuid not null references lines(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  author_name text not null default '',
  text text not null default '',
  audio_path text,
  audio_seconds real,
  created_at timestamptz not null default now()
);
create index if not exists line_notes_line on line_notes(line_id);
create index if not exists line_notes_project on line_notes(project_id);

-- who recorded a take
alter table takes add column if not exists created_by uuid references users(id) on delete set null;

-- ---------- the same access as the other tables ----------
do $$
declare t text;
begin
  foreach t in array array['shares', 'users', 'project_members', 'invites', 'line_notes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "server access" on %I', t);
    execute format('create policy "server access" on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- voice messages: Chrome records WebM, Safari MP4
update storage.buckets
set allowed_mime_types = (select array_agg(distinct m) from unnest(coalesce(allowed_mime_types, '{}') || array['audio/webm', 'audio/mp4']) m)
where id = 'beats';

-- open devices see new notes too (live sync)
CREATE OR REPLACE FUNCTION public.project_version(pid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select md5(concat_ws('|',
    (select updated_at::text || coalesce(settings::text, '') from projects where id = pid),
    (select count(*) filter (where not deleted) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(coalesce(audio_at, 0)), 0) from lines where project_id = pid),
    (select string_agg(id::text || name || position || coalesce(audio_start::text, ''), ',' order by position) from sections where project_id = pid),
    (select count(*) || ':' || coalesce(sum(start_at + trim_in + coalesce(trim_out, 0) + gain * 7 + pan * 13), 0) || ':' || coalesce(string_agg(case when chosen then id::text end, ','), '') from takes where project_id = pid),
    (select count(*) || ':' || count(*) filter (where state = 'pending') from alternatives where project_id = pid),
    (select count(*) || ':' || coalesce(max(created_at)::text, '') from flows where project_id = pid),
    (select count(*) || ':' || count(*) filter (where undone) from undo_steps where project_id = pid),
    (select coalesce(bpm::text, '') || coalesce(duration::text, '') || coalesce(instrumental_path, '') from audio_tracks where project_id = pid),
    (select count(*) || ':' || coalesce(max(created_at)::text, '') from line_notes where project_id = pid),
    (select count(*)::text from project_members where project_id = pid)
  ));
$function$;
