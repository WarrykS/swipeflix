-- SwipeFlix schema.
-- RLS is on with no policies: the client only goes through the security definer
-- functions below, which check that the caller is a member of the room.

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid not null,
  name text not null,
  joined_at timestamptz not null default now(),
  primary key (room_id, member_id)
);

create table public.swipes (
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid not null,
  movie_id integer not null,
  liked boolean not null,
  movie jsonb,
  created_at timestamptz not null default now(),
  primary key (room_id, member_id, movie_id)
);
create index swipes_room_movie_idx on public.swipes (room_id, movie_id) where liked;

create table public.matches (
  room_id uuid not null references public.rooms(id) on delete cascade,
  movie_id integer not null,
  movie jsonb,
  watched boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (room_id, movie_id)
);

alter table public.rooms enable row level security;
alter table public.members enable row level security;
alter table public.swipes enable row level security;
alter table public.matches enable row level security;

-- Helpers
create or replace function public._gen_room_code()
returns text language plpgsql set search_path = '' as $$
declare
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
begin
  for i in 1..6 loop
    result := result || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return result;
end $$;

create or replace function public._member_room(p_code text, p_member uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_room uuid;
begin
  select r.id into v_room
  from public.rooms r join public.members m on m.room_id = r.id
  where r.code = upper(p_code) and m.member_id = p_member;
  if v_room is null then
    raise exception 'not_member' using errcode = 'P0001';
  end if;
  return v_room;
end $$;

-- Room lifecycle
create or replace function public.create_room(p_member uuid, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text; v_room uuid;
begin
  loop
    v_code := public._gen_room_code();
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;
  insert into public.rooms (code) values (v_code) returning id into v_room;
  insert into public.members (room_id, member_id, name) values (v_room, p_member, left(trim(p_name), 30));
  return v_code;
end $$;

create or replace function public.join_room(p_code text, p_member uuid, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_room uuid; v_count int;
begin
  select id into v_room from public.rooms where code = upper(trim(p_code));
  if v_room is null then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.members where room_id = v_room and member_id = p_member) then
    update public.members set name = left(trim(p_name), 30) where room_id = v_room and member_id = p_member;
  else
    select count(*) into v_count from public.members where room_id = v_room;
    if v_count >= 2 then
      raise exception 'room_full' using errcode = 'P0001';
    end if;
    insert into public.members (room_id, member_id, name) values (v_room, p_member, left(trim(p_name), 30));
  end if;
  return upper(trim(p_code));
end $$;

create or replace function public.set_filters(p_code text, p_member uuid, p_filters jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_room uuid := public._member_room(p_code, p_member);
begin
  update public.rooms set filters = coalesce(p_filters, '{}'::jsonb) where id = v_room;
end $$;

-- Full state for one member
create or replace function public.get_state(p_code text, p_member uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_room uuid := public._member_room(p_code, p_member);
begin
  return jsonb_build_object(
    'code', (select code from public.rooms where id = v_room),
    'filters', (select filters from public.rooms where id = v_room),
    'me', (select name from public.members where room_id = v_room and member_id = p_member),
    'partner', (select name from public.members where room_id = v_room and member_id <> p_member limit 1),
    'swiped', coalesce((select jsonb_agg(movie_id) from public.swipes
                        where room_id = v_room and member_id = p_member), '[]'::jsonb),
    'partner_likes', coalesce((
      select jsonb_agg(s.movie order by s.created_at)
      from public.swipes s
      where s.room_id = v_room and s.member_id <> p_member and s.liked and s.movie is not null
        and not exists (select 1 from public.swipes x
                        where x.room_id = v_room and x.member_id = p_member and x.movie_id = s.movie_id)
    ), '[]'::jsonb),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object('movie', m.movie, 'watched', m.watched, 'created_at', m.created_at)
                       order by m.created_at desc)
      from public.matches m where m.room_id = v_room
    ), '[]'::jsonb)
  );
end $$;

-- Swiping: returns true when the like completes a match
create or replace function public.swipe(p_code text, p_member uuid, p_movie_id int, p_liked boolean, p_movie jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_room uuid := public._member_room(p_code, p_member);
begin
  insert into public.swipes (room_id, member_id, movie_id, liked, movie)
  values (v_room, p_member, p_movie_id, p_liked, p_movie)
  on conflict (room_id, member_id, movie_id)
  do update set liked = excluded.liked, movie = excluded.movie, created_at = now();

  if p_liked and exists (
    select 1 from public.swipes
    where room_id = v_room and member_id <> p_member and movie_id = p_movie_id and liked
  ) then
    insert into public.matches (room_id, movie_id, movie)
    values (v_room, p_movie_id, p_movie)
    on conflict do nothing;
    return true;
  end if;
  return false;
end $$;

create or replace function public.set_watched(p_code text, p_member uuid, p_movie_id int, p_watched boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_room uuid := public._member_room(p_code, p_member);
begin
  update public.matches set watched = p_watched where room_id = v_room and movie_id = p_movie_id;
end $$;

-- Functions keep Supabase's default EXECUTE grants (anon, authenticated).
