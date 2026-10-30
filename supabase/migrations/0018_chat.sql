-- Chat anónimo: un alias fijo por jugador y edición; el servidor guarda el autor, los demás solo ven el alias.
create table public.chat_aliases (
  edition int not null, player_id uuid not null references public.players(id) on delete cascade, alias text not null,
  primary key (edition, player_id), unique (edition, alias)
);
create table public.chat_messages (
  id bigserial primary key, edition int not null, author uuid not null references public.players(id) on delete cascade,
  alias text not null, body text not null check (char_length(body) between 1 and 500), created_at timestamptz not null default now()
);
create index on public.chat_messages (edition, id);
alter table public.chat_aliases enable row level security;
alter table public.chat_messages enable row level security;
revoke all on public.chat_aliases, public.chat_messages from anon, authenticated;
revoke all on sequence public.chat_messages_id_seq from anon, authenticated;

create or replace function public.chat_alias_of(p_player uuid, p_edition int) returns text
language plpgsql security definer set search_path = public, pg_temp as
$$
declare a text; n int := 0;
  names text[] := array['Zorro','Cuervo','Lobo','Búho','Gato','Tejón','Halcón','Ciervo','Lince','Oso','Cisne','Jabalí','Nutria','Buitre','Lechuza','Mapache','Garza','Cabra','Erizo','Tigre','Pantera','Águila','Foca','Mirlo'];
begin
  select alias into a from public.chat_aliases where edition = p_edition and player_id = p_player;
  if found then return a; end if;
  loop
    a := names[1 + floor(random() * array_length(names, 1))::int] || ' ' || (1 + floor(random() * 99))::int;
    begin
      insert into public.chat_aliases (edition, player_id, alias) values (p_edition, p_player, a);
      return a;
    exception when unique_violation then
      select alias into a from public.chat_aliases where edition = p_edition and player_id = p_player;
      if found then return a; end if;
      n := n + 1; if n > 200 then raise exception 'alias_exhausted'; end if;
    end;
  end loop;
end
$$;
revoke execute on function public.chat_alias_of(uuid, int) from public, anon, authenticated;

create or replace function public.chat_list() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); ed int;
begin
  if v is null then raise exception 'no_session'; end if;
  if not (v = any(public.active_ids())) then raise exception 'not_admitted'; end if;
  select edition into ed from public.game_config where id = 1;
  return jsonb_build_object('alias', public.chat_alias_of(v, ed), 'messages',
    (select coalesce(jsonb_agg(m order by m.id), '[]'::jsonb) from (
       select id, alias, body, created_at as at, author = v as mine
         from public.chat_messages where edition = ed order by id desc limit 150) m));
end
$$;

create or replace function public.chat_send(p_body text) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); ed int; t text := btrim(coalesce(p_body, ''));
begin
  if v is null then raise exception 'no_session'; end if;
  if not (v = any(public.active_ids())) then raise exception 'not_admitted'; end if;
  if char_length(t) < 1 or char_length(t) > 500 then raise exception 'chat_length'; end if;
  select edition into ed from public.game_config where id = 1;
  if (select count(*) from public.chat_messages where author = v and created_at > now() - interval '1 minute') >= 15 then
    raise exception 'chat_rate';
  end if;
  insert into public.chat_messages (edition, author, alias, body) values (ed, v, public.chat_alias_of(v, ed), t);
end
$$;

create or replace function public.admin_chat_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  perform public.require_admin();
  delete from public.chat_messages where id = p_id;
end
$$;
revoke execute on function public.chat_list(), public.chat_send(text), public.admin_chat_delete(bigint) from public, anon;
grant execute on function public.chat_list(), public.chat_send(text), public.admin_chat_delete(bigint) to authenticated;
