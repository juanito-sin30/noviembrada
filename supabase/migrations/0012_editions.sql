-- Ediciones: el sorteo al azar es solo para la primera. Las siguientes empiezan con el perdedor de la anterior.
alter table public.touches     add column edition int not null default 1;
alter table public.game_config add column last_loser uuid references public.players(id);

-- Cada toque nuevo pertenece a la edición en curso.
create function public.touches_set_edition() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$ begin new.edition := (select edition from public.game_config where id = 1); return new; end $$;
create trigger touches_edition before insert on public.touches
  for each row execute function public.touches_set_edition();

-- La cadena solo mira la edición en curso.
create or replace function public.valid_chain() returns setof public.touches
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare h uuid; r public.touches; ed int := (select edition from public.game_config where id = 1);
begin
  for r in select * from public.touches where status <> 'void' and edition = ed order by touched_at, id loop
    if r.from_id is null then
      if h is null then h := r.to_id; return next r; end if;
    elsif r.from_id = h then
      h := r.to_id; return next r;
    end if;
  end loop;
end
$$;

create or replace function public.final_result() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); cfg public.game_config; ct public.touches; loser uuid; prov boolean;
begin
  perform public.tick();
  select * into cfg from public.game_config where id = 1;
  if public.app_now() <= cfg.end_at then raise exception 'not_finished'; end if;
  ct := public.current_touch();
  loser := coalesce(cfg.forced_loser, ct.to_id);
  prov := exists (select 1 from public.cases where kind = 'dispute' and status = 'open');
  return jsonb_build_object(
    'loser', public.pname(loser), 'provisional', prov, 'dispute_end_at', cfg.dispute_end_at,
    'chain', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'from', public.pname(t.from_id), 'to', public.pname(t.to_id), 'touched_at', t.touched_at,
        'place', t.place, 'status', t.status,
        'counts', exists (select 1 from public.valid_chain() vc where vc.id = t.id),
        'media', coalesce((select jsonb_agg(jsonb_build_object('path', m.path, 'kind', m.kind) order by m.id)
                             from public.touch_media m where m.touch_id = t.id), '[]'::jsonb)) order by t.touched_at, t.id)
        from public.touches t where t.edition = cfg.edition), '[]'::jsonb));
end
$$;

-- Arranque: edición 1 = sorteo; ediciones siguientes = la lleva el perdedor de la anterior (si sigue jugando).
create or replace function public.do_draw() returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare cfg public.game_config; ids uuid[]; pick uuid; idx bigint; inherited boolean := false; msg text;
begin
  select * into cfg from public.game_config where id = 1 for update;
  if cfg.draw_done then return false; end if;
  ids := public.active_ids();
  if cardinality(ids) < 2 then return false; end if;
  if cfg.edition > 1 and cfg.last_loser is not null and cfg.last_loser = any(ids) then
    pick := cfg.last_loser; inherited := true;
  else
    idx := (('x' || encode(extensions.gen_random_bytes(7), 'hex'))::bit(56)::bigint) % cardinality(ids);
    pick := ids[idx + 1];
  end if;
  insert into public.touches (from_id, to_id, touched_at, registered_at, status, place, resolved_at)
  values (null, pick, cfg.start_at, cfg.start_at, 'confirmed',
          case when inherited then 'Perdedor de la edición anterior' else 'Sorteo inicial' end, cfg.start_at);
  update public.game_config set draw_done = true where id = 1;
  msg := case when inherited
    then format('¡Que empiece la Noviembrada, edición %s! La lleva el perdedor del año pasado. ¿Seguirá siéndolo?', cfg.edition)
    else format('¡Que empiece la Noviembrada, edición %s! Ya se ha hecho el sorteo: alguien la lleva. Y no te lo dirá.', cfg.edition) end;
  perform public.enqueue_msg(x, 'draw', msg, 'draw') from unnest(ids) x;
  return true;
end
$$;

-- Preparar la edición siguiente (se ejecuta con el SQL editor / `supabase db query`; no está expuesta a clientes).
create function public.start_new_edition(p_start timestamptz, p_end timestamptz, p_dispute_end timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare cfg public.game_config; ct public.touches; loser uuid;
begin
  select * into cfg from public.game_config where id = 1 for update;
  if not cfg.draw_done then raise exception 'edition_not_played'; end if;
  if public.app_now() <= cfg.end_at then raise exception 'not_finished'; end if;
  if p_start <= public.app_now() or p_end <= p_start or p_dispute_end < p_end then raise exception 'invalid_dates'; end if;
  ct := public.current_touch();
  loser := coalesce(cfg.forced_loser, ct.to_id);
  update public.players set edition = cfg.edition + 1 where status = 'admitted' and edition = cfg.edition;
  update public.game_config set edition = cfg.edition + 1, last_loser = loser, draw_done = false, forced_loser = null,
         start_at = p_start, end_at = p_end, dispute_end_at = p_dispute_end, clock_offset = '0' where id = 1;
end
$$;
revoke execute on function public.start_new_edition(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.do_draw() from public, anon, authenticated;
revoke execute on function public.touches_set_edition() from public, anon, authenticated;
grant execute on function public.admin_draw() to authenticated;
