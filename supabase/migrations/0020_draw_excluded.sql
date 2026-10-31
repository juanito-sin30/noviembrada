-- Jugadores que están en la partida pero no entran en el sorteo (por ejemplo, de Erasmus).
alter table public.players add column draw_excluded boolean not null default false;
update public.players set draw_excluded = true where name = 'Hampton';

create or replace function public.do_draw() returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare cfg public.game_config; ids uuid[]; cand uuid[]; pick uuid; idx bigint; inherited boolean := false; msg text;
begin
  select * into cfg from public.game_config where id = 1 for update;
  if cfg.draw_done then return false; end if;
  ids := public.active_ids();
  if cardinality(ids) < 2 then return false; end if;
  if cfg.edition > 1 and cfg.last_loser is not null and cfg.last_loser = any(ids) then
    pick := cfg.last_loser; inherited := true;
  else
    select coalesce(array_agg(x order by x), '{}') into cand from unnest(ids) x
     where not exists (select 1 from public.players p where p.id = x and p.draw_excluded);
    if cardinality(cand) < 1 then return false; end if;
    idx := (('x' || encode(extensions.gen_random_bytes(7), 'hex'))::bit(56)::bigint) % cardinality(cand);
    pick := cand[idx + 1];
  end if;
  insert into public.touches (from_id, to_id, touched_at, registered_at, status, place, resolved_at)
  values (null, pick, cfg.start_at, cfg.start_at, 'confirmed',
          case when inherited then 'Perdedor de la edición anterior' else 'Sorteo inicial' end, cfg.start_at);
  update public.game_config set draw_done = true where id = 1;
  msg := case when inherited
    then format('Se alza el telón de la Noviembrada, edición %s. La lleva el perdedor del año pasado. ¿Sabrá redimirse?', cfg.edition)
    else format('Se alza el telón de la Noviembrada, edición %s. El sorteo está hecho: alguien la lleva, y guardará silencio.', cfg.edition) end;
  perform public.enqueue_msg(x, 'draw', msg, 'draw') from unnest(ids) x;
  return true;
end
$$;

