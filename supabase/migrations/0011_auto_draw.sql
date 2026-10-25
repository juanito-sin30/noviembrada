-- Sorteo automático: al llegar start_at (1 nov 00:00, Europe/Madrid) se elige a quien la lleva sin intervención
-- de nadie y se avisa a todos. El resultado sigue siendo secreto. Se dispara desde tick() (cron cada minuto).
-- En modo de prueba no se sortea solo: lo hace el administrador a mano.
create function public.do_draw() returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare cfg public.game_config; ids uuid[]; pick uuid; idx bigint;
begin
  select * into cfg from public.game_config where id = 1 for update;
  if cfg.draw_done then return false; end if;
  ids := public.active_ids();
  if cardinality(ids) < 2 then return false; end if;
  idx := (('x' || encode(extensions.gen_random_bytes(7), 'hex'))::bit(56)::bigint) % cardinality(ids);
  pick := ids[idx + 1];
  insert into public.touches (from_id, to_id, touched_at, registered_at, status, place, resolved_at)
  values (null, pick, cfg.start_at, cfg.start_at, 'confirmed', 'Sorteo inicial', cfg.start_at);
  update public.game_config set draw_done = true where id = 1;
  perform public.enqueue_msg(x, 'draw',
    format('¡Que empiece la Noviembrada, edición %s! Ya se ha hecho el sorteo: alguien la lleva. Y no te lo dirá.', cfg.edition),
    'draw') from unnest(ids) x;
  return true;
end
$$;
revoke execute on function public.do_draw() from public, anon, authenticated;

create or replace function public.admin_draw() returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare cfg public.game_config;
begin
  perform public.require_admin();
  select * into cfg from public.game_config where id = 1;
  if cfg.draw_done then raise exception 'already_drawn'; end if;
  if cardinality(public.active_ids()) < 2 then raise exception 'not_enough_players'; end if;
  perform public.do_draw();
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
