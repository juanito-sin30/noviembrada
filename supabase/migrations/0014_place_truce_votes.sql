-- Lugar obligatorio y privado, votos cambiables (siguen siendo anónimos) y treguas.
alter table public.cases add column truce_place text, add column truce_start timestamptz, add column truce_end timestamptz;
alter table public.case_votes add column th text;   -- hash del testigo secreto de quien vota: permite cambiar el voto sin saber de quién es
create index on public.case_votes (case_id, th);

create or replace function public.close_case(p_case bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  c public.cases; cfg public.game_config; a text; b text; ta int; tb int;
  t public.touches; txt text; res text; nxt timestamptz; pid uuid; ok boolean;
begin
  select * into c from public.cases where id = p_case and status = 'open' for update;
  if not found then return; end if;
  select * into cfg from public.game_config where id = 1;
  if c.kind = 'dispute' then a := 'valido'; b := 'nulo'; else a := 'si'; b := 'no'; end if;
  select count(*) filter (where choice = a), count(*) filter (where choice = b)
    into ta, tb from public.case_votes where case_id = c.id;

  -- Empate: la votación se repite una sola vez (disputas y reformas).
  if ta = tb and c.round = 1 and c.kind in ('dispute','reform') then
    nxt := public.app_now() + interval '24 hours';
    if c.kind = 'dispute' then nxt := least(nxt, cfg.dispute_end_at); end if;
    if nxt > public.app_now() then
      delete from public.case_votes where case_id = c.id;
      delete from public.case_voted where case_id = c.id;
      update public.cases set round = 2, closes_at = nxt where id = c.id;
      foreach pid in array c.eligible loop perform public.enqueue(pid, 'vote'); end loop;
      return;
    end if;
  end if;

  if c.kind = 'dispute' then
    select * into t from public.touches where id = c.touch_id;
    if tb > ta then
      update public.touches set status = 'void', resolved_at = public.app_now() where id = t.id;
      txt := format('Toque nulo por %s votos a %s. El estatus vuelve a %s.', tb, ta, public.pname(t.from_id));
      res := 'nulo';
    elsif ta > tb then
      update public.touches set status = 'confirmed', resolved_at = public.app_now() where id = t.id;
      txt := format('Toque válido por %s votos a %s. %s la lleva.', ta, tb, public.pname(t.to_id));
      res := 'valido';
    else
      update public.touches set status = 'confirmed', resolved_at = public.app_now() where id = t.id;
      txt := format('Empate a %s tras repetir la votación. El estatus queda como estaba antes de la disputa.', ta);
      res := 'valido';
    end if;
    foreach pid in array c.parties loop perform public.enqueue(pid, 'result'); end loop;

  elsif c.kind = 'admission' then
    ok := ta > tb;   -- empate = rechazado
    if ok then
      update public.players set status = 'admitted',
             edition = case when public.app_now() > cfg.end_at then cfg.edition + 1 else cfg.edition end
       where id = c.candidate_id;
      txt := format('Admitido por %s votos a %s. %s entra en la Junta y en el juego.', ta, tb, public.pname(c.candidate_id));
    else
      update public.players set status = 'rejected' where id = c.candidate_id;
      txt := case when tb > ta then format('Rechazado por %s votos a %s. %s se queda fuera.', tb, ta, public.pname(c.candidate_id))
                   else format('Empate a %s. %s se queda fuera.', ta, public.pname(c.candidate_id)) end;
    end if;
    res := case when ok then 'si' else 'no' end;
    perform public.enqueue(c.candidate_id, 'result');

  elsif c.kind = 'truce' then
    ok := tb = 0 and ta > 0;   -- un solo voto en contra la anula
    res := case when ok then 'si' else 'no' end;
    txt := case when ok then format('Tregua aprobada en %s, de %s a %s.', c.truce_place,
                                    to_char(c.truce_start at time zone 'Europe/Madrid', 'DD/MM HH24:MI'),
                                    to_char(c.truce_end at time zone 'Europe/Madrid', 'DD/MM HH24:MI'))
                when tb > 0 then format('Tregua rechazada: %s voto(s) en contra bastan para anularla.', tb)
                else 'Tregua rechazada: nadie la ha apoyado.' end;
    foreach pid in array c.eligible loop perform public.enqueue(pid, 'result'); end loop;
    foreach pid in array c.parties loop perform public.enqueue(pid, 'result'); end loop;

  else  -- reform
    ok := ta > tb;
    res := case when ok then 'si' else 'no' end;
    txt := case when ok then format('Aprobada por %s votos a %s.', ta, tb)
                when tb > ta then format('Rechazada por %s votos a %s. No se cambia nada.', tb, ta)
                else format('Empate a %s tras repetir la votación. No se cambia nada.', ta) end;
    foreach pid in array c.eligible loop perform public.enqueue(pid, 'result'); end loop;
  end if;

  update public.cases set status = 'closed', verdict = txt, outcome = res where id = c.id;
end
$$;

create or replace function public.get_case(p_case bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); c public.cases; act boolean;
begin
  if v is null then raise exception 'no_session'; end if;
  perform public.tick();
  select * into c from public.cases where id = p_case;
  act := v = any(public.active_ids());
  if not found or c.candidate_id = v
     or not (v = any(c.eligible) or v = any(c.parties) or (c.status = 'closed' and act)) then
    raise exception 'not_found';
  end if;
  return jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'question', c.question, 'body', c.body, 'status', c.status,
    'closes_at', c.closes_at, 'round', c.round, 'verdict', c.verdict,
    'candidate', public.pname(c.candidate_id),
    'parties', (select coalesce(jsonb_agg(public.pname(x)), '[]'::jsonb) from unnest(c.parties) x),
    'party', v = any(c.parties),
    'voters', cardinality(c.eligible),
    'voted', (select count(*) from public.case_voted cv where cv.case_id = c.id),
    'i_voted', exists (select 1 from public.case_voted cv where cv.case_id = c.id and cv.player_id = v),
    'versions', case when c.kind = 'dispute' then (
        select jsonb_agg(jsonb_build_object('who', public.pname(x), 'text',
               (select cvs.body from public.case_versions cvs where cvs.case_id = c.id and cvs.player_id = x),
               'media', coalesce((select jsonb_agg(jsonb_build_object('path', m.path, 'kind', m.kind) order by m.id)
                                    from public.touch_media m where m.touch_id = c.touch_id and m.owner_id = x), '[]'::jsonb)))
          from unnest(c.parties) x) else null end,
    'touch_id', c.touch_id,
    'truce_place', c.truce_place, 'truce_start', c.truce_start, 'truce_end', c.truce_end,
    'touch_place', case when c.kind = 'dispute' and (v = any(c.eligible) or v = any(c.parties))
                        then (select tt.place from public.touches tt where tt.id = c.touch_id) end);
end
$$;

create or replace function public.build_report() returns jsonb
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
      'status', t.status,
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
        'status', t.status,
        'counts', exists (select 1 from public.valid_chain() vc where vc.id = t.id),
        'media', coalesce((select jsonb_agg(jsonb_build_object('path', m.path, 'kind', m.kind) order by m.id)
                             from public.touch_media m where m.touch_id = t.id), '[]'::jsonb)) order by t.touched_at, t.id)
        from public.touches t where t.edition = cfg.edition), '[]'::jsonb));
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
    'Te han pillado. Ya la llevas. Tienes 24 h para disputarlo si no estás de acuerdo.', 'touch-' || tid);
  perform public.enqueue_msg(x, 'pillado', 'Ha habido un pillado. La Noviembrada sigue.', 'pillado-' || tid)
    from unnest(public.active_ids()) x;
  return tid;
end
$$;


-- Votar o cambiar el voto mientras el caso esté abierto. El testigo (p_token) solo lo conoce el móvil del votante.
drop function public.cast_vote(bigint, text);
create function public.cast_vote(p_case bigint, p_choice text, p_token text default null) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare v uuid := public.me_active(); c public.cases; v_th text;
begin
  perform public.tick();
  select * into c from public.cases where id = p_case for update;
  if not found or c.status <> 'open' then raise exception 'not_found'; end if;
  if v = any(c.parties) then raise exception 'party_cannot_vote'; end if;
  if not v = any(c.eligible) then raise exception 'not_eligible'; end if;
  if p_choice is distinct from 'abs'
     and p_choice <> all (case when c.kind = 'dispute' then array['valido','nulo'] else array['si','no'] end) then
    raise exception 'invalid_choice';
  end if;
  if p_token is not null and length(p_token) >= 16 then
    v_th := encode(extensions.digest(p_token || ':' || c.id || ':' || c.round, 'sha256'), 'hex');
  end if;
  if exists (select 1 from public.case_voted where case_id = c.id and player_id = v) then
    if v_th is null then raise exception 'already_voted'; end if;
    update public.case_votes set choice = p_choice where case_id = c.id and th = v_th;
    if not found then raise exception 'already_voted'; end if;
    return;
  end if;
  insert into public.case_voted (case_id, player_id) values (c.id, v);
  insert into public.case_votes (case_id, choice, th) values (c.id, p_choice, v_th);
  -- Cuando han votado todos, el caso se cierra en 1 hora: margen para cambiar de opinión.
  if (select count(*) from public.case_voted where case_id = c.id) >= cardinality(c.eligible) then
    update public.cases set closes_at = least(closes_at, public.app_now() + interval '1 hour') where id = c.id;
  end if;
end
$$;

-- Tregua: lugar y horas. Se vota entre todos menos quien la propone; un voto en contra la anula.
create function public.propose_truce(p_place text, p_start timestamptz, p_end timestamptz, p_note text default '') returns bigint
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); cfg public.game_config; cid bigint; elig uuid[]; pl text := trim(coalesce(p_place, ''));
begin
  perform public.tick();
  select * into cfg from public.game_config where id = 1;
  if length(pl) < 2 or length(pl) > 120 or length(coalesce(p_note, '')) > 300 then raise exception 'text_length'; end if;
  if p_start is null or p_end is null or p_end <= p_start then raise exception 'bad_dates'; end if;
  if p_start < public.app_now() + interval '2 hours' or p_end > cfg.end_at then raise exception 'bad_dates'; end if;
  select coalesce(array_agg(x), '{}') into elig from unnest(public.active_ids()) x where x <> v;
  insert into public.cases (kind, question, body, opened_at, closes_at, parties, eligible, truce_place, truce_start, truce_end)
  values ('truce', format('¿Aprobamos una tregua en %s?', pl),
          format('Sitio: %s. Desde el %s hasta el %s (hora de Madrid). Mientras dure, en ese sitio no vale pillar a nadie.%s', pl,
                 to_char(p_start at time zone 'Europe/Madrid', 'DD/MM HH24:MI'), to_char(p_end at time zone 'Europe/Madrid', 'DD/MM HH24:MI'),
                 case when length(trim(coalesce(p_note, ''))) > 0 then ' ' || left(trim(p_note), 300) else '' end),
          public.app_now(), least(public.app_now() + interval '12 hours', p_start - interval '1 hour'),
          array[v], elig, pl, p_start, p_end)
  returning id into cid;
  perform public.enqueue(x, 'vote') from unnest(elig) x;
  return cid;
end
$$;

create function public.list_truces() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  perform public.me_active();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'place', c.truce_place, 'start', c.truce_start, 'end', c.truce_end)
                                   order by c.truce_start)
                     from public.cases c
                    where c.kind = 'truce' and c.status = 'closed' and c.outcome = 'si' and c.truce_end > public.app_now()), '[]'::jsonb);
end
$$;

-- Historial privado de pilladas: solo las partes (tocador y tocado) ven el lugar.
create function public.my_touches() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', t.id, 'edition', t.edition, 'role', case when t.from_id = v then 'from' else 'to' end,
        'other', public.pname(case when t.from_id = v then t.to_id else t.from_id end),
        'touched_at', t.touched_at, 'place', t.place, 'status', t.status,
        'verdict', (select c.verdict from public.cases c where c.touch_id = t.id and c.kind = 'dispute' order by c.id desc limit 1),
        'media', coalesce((select jsonb_agg(jsonb_build_object('path', m.path, 'kind', m.kind) order by m.id)
                             from public.touch_media m where m.touch_id = t.id), '[]'::jsonb))
      order by t.touched_at desc, t.id desc)
      from public.touches t where t.from_id is not null and (t.from_id = v or t.to_id = v)), '[]'::jsonb);
end
$$;

revoke execute on function public.cast_vote(bigint, text, text), public.propose_truce(text, timestamptz, timestamptz, text),
  public.list_truces(), public.my_touches() from public, anon;
grant execute on function public.cast_vote(bigint, text, text), public.propose_truce(text, timestamptz, timestamptz, text),
  public.list_truces(), public.my_touches() to authenticated;
