-- Todos los avisos llevan texto propio (tono formal y dramático) y se añaden los recordatorios nuevos.
alter table public.cases       add column reminded_round int not null default 0,
                               add column truce_start_notified boolean not null default false,
                               add column truce_end_notified boolean not null default false;
alter table public.game_config add column end_notified int not null default 0,
                               add column lastday_notified int not null default 0;

-- Avisos genéricos: ahora también con texto (el tag evita repetidos del mismo tipo en un mismo envío).
create or replace function public.enqueue(p_player uuid, p_kind text) returns void
language sql security definer set search_path = public, pg_temp as
$$
  insert into public.outbox (player_id, kind, body, tag)
  values (p_player, p_kind,
    case p_kind
      when 'vote'     then 'La Junta de Sabios ha sido convocada. Hay un caso que exige vuestro voto.'
      when 'version'  then 'Tu toque ha sido impugnado. Dispones de 24 horas para presentar tu versión ante la Junta.'
      when 'result'   then 'La Junta ha dictado sentencia. Acude a conocer el veredicto.'
      when 'reminder' then 'La Noviembrada te reclama. Abre la aplicación y da señal de vida.'
    end,
    p_kind)
$$;

create or replace function public.request_join(p_name text, p_contract boolean, p_honor boolean, p_media boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v uuid := auth.uid(); k text := public.name_key_of(coalesce(p_name, '')); n int;
  cfg public.game_config; st text; cid bigint;
begin
  if v is null then raise exception 'no_session'; end if;
  if not (coalesce(p_contract,false) and coalesce(p_honor,false) and coalesce(p_media,false)) then
    raise exception 'checks_required';
  end if;
  if length(trim(p_name)) < 2 or length(k) < 2 then raise exception 'invalid_name'; end if;
  if exists (select 1 from public.players where id = v) then raise exception 'already_requested'; end if;
  if not exists (select 1 from auth.users u where u.id = v and u.email = k || '@noviembrada.local') then
    raise exception 'email_mismatch';
  end if;
  if exists (select 1 from public.players where name_key = k) then raise exception 'name_taken'; end if;

  select * into cfg from public.game_config where id = 1;
  select count(*) into n from public.players where founder;
  if n < 3 then
    insert into public.players (id, name, name_key, status, founder, edition)
    values (v, regexp_replace(trim(p_name), '\s+', ' ', 'g'), k, 'admitted', true, cfg.edition);
    return jsonb_build_object('status', 'admitted', 'founder', true);
  end if;

  insert into public.players (id, name, name_key, status, edition)
  values (v, regexp_replace(trim(p_name), '\s+', ' ', 'g'), k, 'pending', cfg.edition);
  insert into public.cases (kind, candidate_id, question, body, opened_at, closes_at, eligible)
  values ('admission', v, format('¿Admitimos a %s en la Noviembrada?', regexp_replace(trim(p_name), '\s+', ' ', 'g')),
          format('%s ha pedido unirse y ha marcado «He firmado el contrato en papel». Si la Junta lo acepta, entra en la Junta y en el juego en ese momento. Hasta entonces no ve el estado, no toca ni puede ser tocado.', regexp_replace(trim(p_name), '\s+', ' ', 'g')),
          public.app_now(), public.app_now() + interval '48 hours', public.active_ids())
  returning id into cid;
  perform public.enqueue_msg(x, 'join', format('%s solicita ser admitido en la Noviembrada. La Junta debe pronunciarse: entra y vota.', left(regexp_replace(trim(p_name), '\s+', ' ', 'g'), 40)), 'join-' || cid)
    from unnest(public.active_ids()) x;
  return jsonb_build_object('status', 'pending', 'case_id', cid);
end
$$;

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
    then format('Se alza el telón de la Noviembrada, edición %s. La lleva el perdedor del año pasado. ¿Sabrá redimirse?', cfg.edition)
    else format('Se alza el telón de la Noviembrada, edición %s. El sorteo está hecho: alguien la lleva, y guardará silencio.', cfg.edition) end;
  perform public.enqueue_msg(x, 'draw', msg, 'draw') from unnest(ids) x;
  return true;
end
$$;

create or replace function public.close_edition() returns void
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
    format('Se ha sellado el acta de la edición %s. El Perdedor del Año es %s. Consulta el informe en Jugadores, Historial.', cfg.edition, public.pname(loser)),
    'informe-' || cfg.edition) from unnest(ids) x;
end
$$;

create or replace function public.register_touch(p_to uuid, p_ago int, p_place text default '') returns bigint
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v uuid := public.me_active(); cfg public.game_config; ct public.touches; at timestamptz; tid bigint;
begin
  perform public.tick();
  if length(trim(coalesce(p_place, ''))) < 2 then raise exception 'place_required'; end if;
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
  if length(public.name_key_of(p_place)) >= 2 and exists (
       select 1 from public.cases z
        where z.kind = 'truce' and z.status = 'closed' and z.outcome = 'si'
          and at >= z.truce_start and at < z.truce_end and length(public.name_key_of(z.truce_place)) >= 2
          and (public.name_key_of(p_place) like '%' || public.name_key_of(z.truce_place) || '%'
            or public.name_key_of(z.truce_place) like '%' || public.name_key_of(p_place) || '%')) then
    raise exception 'truce';
  end if;

  insert into public.touches (from_id, to_id, touched_at, registered_at, place, status)
  values (v, p_to, at, public.app_now(), left(coalesce(trim(p_place), ''), 120), 'pending')
  returning id into tid;
  perform public.enqueue_msg(p_to, 'touch',
    'Has sido tocado. La llevas desde este instante. Dispones de 24 horas para impugnarlo, si el honor te asiste.', 'touch-' || tid);
  perform public.enqueue_msg(x, 'pillado', 'El estatus ha cambiado de manos. Nadie sabe de cuáles. La Noviembrada continúa.', 'pillado-' || tid)
    from unnest(public.active_ids()) x;
  return tid;
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
