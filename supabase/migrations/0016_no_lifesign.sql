-- Se elimina el recordatorio de «señal de vida».
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

  select * into cfg from public.game_config where id = 1;

  -- Votaciones a punto de cerrarse: recordatorio solo a quien aún no ha votado (una vez por ronda).
  for r in select c.id, c.round, c.closes_at, c.eligible from public.cases c
            where c.status = 'open' and c.reminded_round < c.round
              and c.closes_at > v_now and c.closes_at <= v_now + interval '6 hours' loop
    update public.cases set reminded_round = r.round where id = r.id;
    perform public.enqueue_msg(x, 'voteremind',
      format('La Junta de Sabios os reclama. Una votación se cierra en %s y vuestro voto aún no consta en acta.',
             case greatest(1, round(extract(epoch from r.closes_at - v_now) / 3600))::int
               when 1 then 'una hora' when 2 then 'dos horas' when 3 then 'tres horas' when 4 then 'cuatro horas'
               when 5 then 'cinco horas' else 'seis horas' end),
      'voteremind-' || r.id)
      from unnest(r.eligible) x
     where x = any(public.active_ids())
       and not exists (select 1 from public.case_voted cv where cv.case_id = r.id and cv.player_id = x);
  end loop;

  -- Treguas aprobadas: aviso una hora antes y al terminar.
  for r in select id, truce_place as place, truce_end as e from public.cases
            where kind = 'truce' and status = 'closed' and outcome = 'si' and not truce_start_notified
              and truce_start - v_now <= interval '1 hour' and truce_end > v_now loop
    update public.cases set truce_start_notified = true where id = r.id;
    perform public.enqueue_msg(x, 'truce',
      format('Por voluntad de la Junta, en una hora cesan las hostilidades en %s, hasta las %s. Respetad la tregua.',
             r.place, to_char(r.e at time zone 'Europe/Madrid', 'HH24:MI')), 'truce-start-' || r.id)
      from unnest(public.active_ids()) x;
  end loop;
  for r in select id, truce_place as place, truce_end as e from public.cases
            where kind = 'truce' and status = 'closed' and outcome = 'si' and not truce_end_notified and truce_end <= v_now loop
    update public.cases set truce_end_notified = true, truce_start_notified = true where id = r.id;
    if v_now - r.e < interval '12 hours' then
      perform public.enqueue_msg(x, 'truce', format('La tregua en %s ha concluido. Que se reanude el juego.', r.place), 'truce-end-' || r.id)
        from unnest(public.active_ids()) x;
    end if;
  end loop;

  -- Penúltimo día (10:00, hora de Madrid) y final de la edición.
  if not cfg.test_mode and cfg.draw_done then
    if cfg.lastday_notified < cfg.edition and v_now < cfg.end_at
       and v_now >= ((date_trunc('day', cfg.end_at at time zone 'Europe/Madrid') - interval '1 day' + interval '10 hours') at time zone 'Europe/Madrid') then
      update public.game_config set lastday_notified = cfg.edition where id = 1;
      perform public.enqueue_msg(x, 'lastday',
        'Queda un solo día. Mañana, a medianoche, la historia escribirá un nombre. Que no sea el tuyo.', 'lastday-' || cfg.edition)
        from unnest(public.active_ids()) x;
    end if;
    if cfg.end_notified < cfg.edition and v_now > cfg.end_at then
      update public.game_config set end_notified = cfg.edition where id = 1;
      perform public.enqueue_msg(x, 'endofgame',
        format('El tiempo ha concluido. La edición %s ha terminado y el veredicto aguarda ser sellado. Acude a conocerlo.', cfg.edition),
        'endofgame-' || cfg.edition)
        from unnest(public.active_ids()) x;
    end if;
  end if;

  perform public.close_edition();

end
$$;
