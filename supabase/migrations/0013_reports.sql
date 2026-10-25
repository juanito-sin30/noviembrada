-- Cierre automático de edición, informe, historial, ranking acumulado y avisos de pillado.

---------------------------------------------------------------------------------------------------
-- Archivo de ediciones cerradas
---------------------------------------------------------------------------------------------------
create table public.edition_archive (
  edition     int primary key,
  closed_at   timestamptz not null,
  loser_id    uuid,
  loser_name  text not null,
  report      jsonb not null
);
alter table public.edition_archive enable row level security;
revoke all on public.edition_archive from anon, authenticated;
drop function if exists public.start_new_edition(timestamptz, timestamptz, timestamptz);

-- Tramos que cada jugador la ha llevado en la edición en curso (cadena válida).
create function public.edition_spans() returns table (player_id uuid, closed boolean, secs bigint)
language sql stable security definer set search_path = public, pg_temp as
$$
  with cfg as (select end_at from public.game_config where id = 1),
  ch as (
    select t.to_id, t.touched_at as s, lead(t.touched_at) over (order by t.touched_at, t.id) as e
      from public.valid_chain() t)
  select ch.to_id, ch.e is not null,
         extract(epoch from coalesce(ch.e, greatest(cfg.end_at, ch.s)) - ch.s)::bigint
    from ch, cfg
$$;

-- Informe completo de la edición en curso (solo tiene sentido cuando ya ha terminado).
create function public.build_report() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare
  cfg public.game_config; ct public.touches; loser uuid; plist jsonb; chain jsonb; st jsonb;
begin
  select * into cfg from public.game_config where id = 1;
  ct := public.current_touch();
  loser := coalesce(cfg.forced_loser, ct.to_id);

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'secs', secs, 'pos', pos) order by secs, lower(name)), '[]'::jsonb)
    into plist
    from (select id, name, secs, rank() over (order by secs) as pos
            from (select p.id, p.name, coalesce(sum(sp.secs), 0)::bigint as secs
                    from public.players p
                    left join public.edition_spans() sp on sp.player_id = p.id
                   where (p.status = 'admitted' and p.edition = cfg.edition) or sp.player_id is not null
                   group by p.id, p.name) z) x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'from', public.pname(t.from_id), 'to', public.pname(t.to_id), 'touched_at', t.touched_at,
      'place', t.place, 'status', t.status,
      'counts', exists (select 1 from public.valid_chain() vc where vc.id = t.id),
      'verdict', (select c.verdict from public.cases c where c.touch_id = t.id and c.kind = 'dispute' order by c.id desc limit 1),
      'disputed', exists (select 1 from public.cases c where c.touch_id = t.id and c.kind = 'dispute'),
      'media', coalesce((select jsonb_agg(jsonb_build_object('path', m.path, 'kind', m.kind) order by m.id)
                           from public.touch_media m where m.touch_id = t.id), '[]'::jsonb)) order by t.touched_at, t.id), '[]'::jsonb)
    into chain
    from public.touches t where t.edition = cfg.edition;

  select jsonb_build_object(
    'touches',  (select count(*) from public.valid_chain() where from_id is not null),
    'voided',   (select count(*) from public.touches where edition = cfg.edition and status = 'void'),
    'disputes', (select count(*) from public.cases c join public.touches t on t.id = c.touch_id
                  where c.kind = 'dispute' and t.edition = cfg.edition),
    'players',  jsonb_array_length(plist),
    'longest',  (select jsonb_build_object('name', x->>'name', 'secs', (x->>'secs')::bigint)
                   from jsonb_array_elements(plist) x order by (x->>'secs')::bigint desc limit 1),
    'shortest', (select jsonb_build_object('name', p.name, 'secs', sp.secs)
                   from public.edition_spans() sp join public.players p on p.id = sp.player_id
                  where sp.closed and sp.secs > 0 order by sp.secs limit 1))
    into st;

  return jsonb_build_object(
    'edition', cfg.edition,
    'year', extract(year from (cfg.start_at at time zone 'Europe/Madrid'))::int,
    'start_at', cfg.start_at, 'end_at', cfg.end_at,
    'loser', public.pname(loser), 'players', plist, 'chain', chain, 'stats', st);
end
$$;

---------------------------------------------------------------------------------------------------
-- Cierre automático: acabado el mes, sin disputas ni toques por resolver
---------------------------------------------------------------------------------------------------
create function public.close_edition() returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare cfg public.game_config; rep jsonb; ids uuid[]; loser uuid; yr int; ct public.touches;
begin
  select * into cfg from public.game_config where id = 1;
  if cfg.test_mode or not cfg.draw_done or public.app_now() <= cfg.end_at then return; end if;
  if exists (select 1 from public.cases where kind = 'dispute' and status = 'open') then return; end if;
  if exists (select 1 from public.touches where edition = cfg.edition and status in ('pending', 'disputed')) then return; end if;

  select * into cfg from public.game_config where id = 1 for update;
  if not cfg.draw_done then return; end if;   -- otro proceso ya lo cerró

  ids := public.active_ids();
  ct := public.current_touch();
  loser := coalesce(cfg.forced_loser, ct.to_id);
  rep := public.build_report();
  insert into public.edition_archive (edition, closed_at, loser_id, loser_name, report)
  values (cfg.edition, public.app_now(), loser, public.pname(loser), rep);

  yr := extract(year from (cfg.start_at at time zone 'Europe/Madrid'))::int + 1;
  update public.players set edition = cfg.edition + 1 where status = 'admitted' and edition = cfg.edition;
  update public.game_config set
    edition = cfg.edition + 1, last_loser = loser, draw_done = false, forced_loser = null,
    start_at = make_timestamptz(yr, 11, 1, 0, 0, 0, 'Europe/Madrid'),
    end_at = make_timestamptz(yr, 11, 30, 23, 59, 59, 'Europe/Madrid'),
    dispute_end_at = make_timestamptz(yr, 12, 7, 23, 59, 59, 'Europe/Madrid')
   where id = 1;

  perform public.enqueue_msg(x, 'informe',
    format('Informe de la edición %s listo: %s es el Perdedor del Año. Míralo en Jugadores, Historial.', cfg.edition, public.pname(loser)),
    'informe-' || cfg.edition) from unnest(ids) x;
end
$$;

create or replace function public.tick() returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare cfg public.game_config; r record; v_now timestamptz := public.app_now();
begin
  select * into cfg from public.game_config where id = 1;

  if not cfg.draw_done and not cfg.test_mode and v_now >= cfg.start_at and v_now <= cfg.end_at then
    perform public.do_draw();
  end if;

  update public.touches set status = 'confirmed', resolved_at = v_now
   where status = 'pending' and registered_at + interval '24 hours' <= v_now;

  for r in select id from public.cases where status = 'open' and closes_at <= v_now order by id loop
    perform public.close_case(r.id);
  end loop;

  perform public.close_edition();

  select * into cfg from public.game_config where id = 1;
  if v_now >= cfg.start_at and v_now <= cfg.end_at then
    for r in select p.id from public.players p
              where p.status = 'admitted' and p.edition = cfg.edition
                and coalesce(p.last_seen, p.created_at) < v_now - interval '48 hours'
                and (p.last_reminder is null or p.last_reminder < v_now - interval '24 hours') loop
      perform public.enqueue(r.id, 'reminder');
      update public.players set last_reminder = v_now where id = r.id;
    end loop;
  end if;
end
$$;

---------------------------------------------------------------------------------------------------
-- API: informe, historial y ranking acumulado
---------------------------------------------------------------------------------------------------
create function public.edition_report(p_edition int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare cfg public.game_config; a public.edition_archive;
begin
  perform public.me_active();
  perform public.tick();
  select * into a from public.edition_archive where edition = p_edition;
  if found then return a.report || jsonb_build_object('provisional', false); end if;
  select * into cfg from public.game_config where id = 1;
  if p_edition = cfg.edition and public.app_now() > cfg.end_at and cfg.draw_done then
    return public.build_report() || jsonb_build_object('provisional', true, 'dispute_end_at', cfg.dispute_end_at);
  end if;
  raise exception 'not_found';
end
$$;

create function public.list_editions() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.me_active();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'edition', a.edition, 'year', a.report->'year', 'loser', a.loser_name,
      'players', a.report->'stats'->'players', 'touches', a.report->'stats'->'touches') order by a.edition desc)
    from public.edition_archive a), '[]'::jsonb);
end
$$;

-- Ranking acumulado de todas las ediciones cerradas: menos tiempo medio por edición = mejor.
create or replace function public.ranking() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); res jsonb;
begin
  with e as (
    select (p->>'id')::uuid as pid, (p->>'secs')::bigint as secs
      from public.edition_archive a, jsonb_array_elements(a.report->'players') p),
  agg as (
    select e.pid, sum(e.secs)::bigint as total, count(*)::int as n, (sum(e.secs) / count(*))::bigint as avg
      from e group by e.pid)
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', pl.name, 'me', pl.id = v, 'total', agg.total, 'editions', agg.n, 'avg', agg.avg,
           'left', pl.status <> 'admitted', 'pos', agg.pos) order by agg.avg, lower(pl.name)), '[]'::jsonb)
    into res
    from (select *, rank() over (order by avg) as pos from agg) agg
    join public.players pl on pl.id = agg.pid;
  return res;
end
$$;

-- me(): añade la edición en curso y la última cerrada.
alter function public.me() rename to me_core;
create function public.me() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare r jsonb;
begin
  r := public.me_core();
  return r || jsonb_build_object(
    'edition', (select edition from public.game_config where id = 1),
    'last_edition', (select max(edition) from public.edition_archive));
end
$$;

-- Las pruebas de ediciones anteriores las ven todos los jugadores actuales.
create or replace function public.can_view_media(p_path text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); tid bigint; t public.touches; cfg public.game_config;
begin
  if v is null then return false; end if;
  begin tid := split_part(p_path, '/', 1)::bigint; exception when others then return false; end;
  select * into t from public.touches where id = tid;
  if not found then return false; end if;
  if split_part(p_path, '/', 2) = v::text or t.from_id = v or t.to_id = v then return true; end if;
  if exists (select 1 from public.cases c where c.touch_id = tid and v = any(c.eligible)) then return true; end if;
  select * into cfg from public.game_config where id = 1;
  return (t.edition < cfg.edition or public.app_now() > cfg.end_at) and v = any(public.active_ids());
end
$$;

-- Avisos de pillado: al tocado, claro; a todos, anónimo (el tocado recibe también el anónimo para no delatarse).
create or replace function public.register_touch(p_to uuid, p_ago int, p_place text default '') returns bigint
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v uuid := public.me_active(); cfg public.game_config; ct public.touches; at timestamptz; tid bigint;
begin
  perform public.tick();
  select * into cfg from public.game_config where id = 1;
  if public.app_now() < cfg.start_at or public.app_now() > cfg.end_at then raise exception 'outside_game'; end if;
  if not cfg.draw_done then raise exception 'no_draw'; end if;
  ct := public.current_touch();
  if ct.to_id is distinct from v then raise exception 'not_holder'; end if;
  if p_ago is null or p_ago < 0 or p_ago > 30 then raise exception 'too_late'; end if;
  if p_to = v or not (p_to = any(public.active_ids())) then raise exception 'invalid_target'; end if;
  if p_to = ct.from_id then raise exception 'rule_of_three'; end if;
  at := public.app_now() - make_interval(mins => p_ago);
  if at < cfg.start_at or at <= ct.touched_at then raise exception 'before_previous_touch'; end if;

  insert into public.touches (from_id, to_id, touched_at, registered_at, place, status)
  values (v, p_to, at, public.app_now(), left(coalesce(trim(p_place), ''), 120), 'pending')
  returning id into tid;
  perform public.enqueue_msg(p_to, 'touch',
    'Te han pillado. Ya la llevas. Tienes 24 h para disputarlo si no estás de acuerdo.', 'touch-' || tid);
  perform public.enqueue_msg(x, 'pillado', 'Ha habido un pillado. La Noviembrada sigue.', 'pillado-' || tid)
    from unnest(public.active_ids()) x;
  return tid;
end
$$;

---------------------------------------------------------------------------------------------------
-- Permisos
---------------------------------------------------------------------------------------------------
revoke execute on function public.me_core(), public.edition_spans(), public.build_report(), public.close_edition()
  from public, anon, authenticated;
revoke execute on function public.edition_report(int), public.list_editions() from public, anon;
grant execute on function public.edition_report(int), public.list_editions(), public.me(), public.ranking(),
  public.register_touch(uuid, int, text) to authenticated;
