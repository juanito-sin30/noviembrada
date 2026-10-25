-- NOVIEMBRADA · núcleo: esquema, reglas y API.
-- Principio: ningún cliente lee ni escribe tablas directamente. Todo pasa por funciones
-- `security definer` que devuelven lo imprescindible. Las tablas tienen RLS activada y NINGUNA política.

create extension if not exists pgcrypto with schema extensions;

---------------------------------------------------------------------------------------------------
-- Tablas
---------------------------------------------------------------------------------------------------
create table public.game_config (
  id            int primary key default 1 check (id = 1),
  edition       int not null default 1,
  start_at      timestamptz not null default '2026-10-31 23:00:00+00',  -- 1 nov 00:00:00 Europe/Madrid (CET)
  end_at        timestamptz not null default '2026-11-30 22:59:59+00',  -- 30 nov 23:59:59 Europe/Madrid
  dispute_end_at timestamptz not null default '2026-12-07 22:59:59+00', -- 7 dic 23:59:59 Europe/Madrid
  clock_offset  interval not null default '0',                          -- solo se toca en modo de prueba
  test_mode     boolean not null default false,
  draw_done     boolean not null default false,
  forced_loser  uuid                                                    -- perdedor automático por abandono del portador
);
insert into public.game_config default values;

create table public.players (
  id            uuid primary key references auth.users(id) on delete cascade,
  name          text not null,
  name_key      text not null unique,
  status        text not null check (status in ('pending','admitted','rejected','left')),
  is_admin      boolean not null default false,
  founder       boolean not null default false,
  edition       int not null default 1,
  created_at    timestamptz not null default now(),
  left_at       timestamptz,
  last_seen     timestamptz,
  last_reminder timestamptz
);

create table public.touches (
  id            bigint generated always as identity primary key,
  from_id       uuid references public.players(id),   -- null = sorteo inicial
  to_id         uuid not null references public.players(id),
  touched_at    timestamptz not null,
  registered_at timestamptz not null,
  place         text not null default '',
  status        text not null default 'pending' check (status in ('pending','confirmed','disputed','void')),
  resolved_at   timestamptz
);
create index on public.touches (touched_at, id);

create table public.touch_media (
  id         bigint generated always as identity primary key,
  touch_id   bigint not null references public.touches(id) on delete cascade,
  owner_id   uuid not null references public.players(id),
  path       text not null unique,
  kind       text not null check (kind in ('foto','video')),
  created_at timestamptz not null default now()
);

create table public.cases (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('dispute','admission','reform','truce')),
  touch_id     bigint references public.touches(id),
  candidate_id uuid references public.players(id),
  question     text not null,
  body         text not null default '',
  opened_at    timestamptz not null,
  closes_at    timestamptz not null,
  round        int not null default 1,
  status       text not null default 'open' check (status in ('open','closed')),
  verdict      text,
  outcome      text,
  parties      uuid[] not null default '{}',
  eligible     uuid[] not null                       -- votantes fijados al abrir el caso
);

create table public.case_versions (
  case_id    bigint not null references public.cases(id) on delete cascade,
  player_id  uuid not null references public.players(id),
  body       text not null,
  created_at timestamptz not null,
  primary key (case_id, player_id)
);

-- Voto anónimo: quién ha votado (sin voto) y el voto (sin quién, sin hora, sin id).
create table public.case_voted (
  case_id   bigint not null references public.cases(id) on delete cascade,
  player_id uuid not null references public.players(id),
  primary key (case_id, player_id)
);
create table public.case_votes (
  case_id bigint not null references public.cases(id) on delete cascade,
  choice  text not null check (choice in ('si','no','valido','nulo','abs'))
);
create index on public.case_votes (case_id);

create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  player_id  uuid not null references public.players(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

create table public.outbox (
  id         bigint generated always as identity primary key,
  player_id  uuid not null references public.players(id) on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index on public.outbox (sent_at) where sent_at is null;

alter table public.game_config        enable row level security;
alter table public.players            enable row level security;
alter table public.touches            enable row level security;
alter table public.touch_media        enable row level security;
alter table public.cases              enable row level security;
alter table public.case_versions      enable row level security;
alter table public.case_voted         enable row level security;
alter table public.case_votes         enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.outbox             enable row level security;
-- Sin políticas: authenticated y anon no pueden leer ni escribir nada directamente.
revoke all on all tables in schema public from anon, authenticated;

---------------------------------------------------------------------------------------------------
-- Utilidades internas (no expuestas a clientes)
---------------------------------------------------------------------------------------------------
create function public.app_now() returns timestamptz
language sql stable security definer set search_path = public, pg_temp as
$$ select now() + clock_offset from public.game_config where id = 1 $$;

create function public.name_key_of(p_name text) returns text
language sql immutable as
$$
  select trim(both '.' from regexp_replace(
    translate(lower(p_name), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', '.', 'g'))
$$;

create function public.pname(p_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select name from public.players where id = p_id $$;

create function public.enqueue(p_player uuid, p_kind text) returns void
language sql security definer set search_path = public, pg_temp as
$$ insert into public.outbox (player_id, kind) values (p_player, p_kind) $$;

-- Jugador con sesión y admitido en la edición en curso.
create function public.me_active() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'no_session'; end if;
  perform 1 from public.players p, public.game_config c
   where p.id = v and p.status = 'admitted' and p.edition = c.edition;
  if not found then raise exception 'not_admitted'; end if;
  return v;
end
$$;

create function public.active_ids() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as
$$
  select coalesce(array_agg(p.id order by p.id), '{}')
    from public.players p, public.game_config c
   where p.status = 'admitted' and p.edition = c.edition
$$;

-- Cadena válida de toques: se reproduce en orden; un toque solo cuenta si lo hace el portador de ese momento.
-- Los anulados se saltan, y los que dependían de uno anulado quedan sin efecto.
create function public.valid_chain() returns setof public.touches
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare h uuid; r public.touches;
begin
  for r in select * from public.touches where status <> 'void' order by touched_at, id loop
    if r.from_id is null then
      if h is null then h := r.to_id; return next r; end if;
    elsif r.from_id = h then
      h := r.to_id; return next r;
    end if;
  end loop;
end
$$;

create function public.current_touch() returns public.touches
language sql stable security definer set search_path = public, pg_temp as
$$ select t from public.valid_chain() t order by t.touched_at desc, t.id desc limit 1 $$;

---------------------------------------------------------------------------------------------------
-- Cierre de casos y plazos perezosos
---------------------------------------------------------------------------------------------------
create function public.close_case(p_case bigint) returns void
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

  else  -- reform / truce
    if c.kind = 'truce' then ok := tb = 0 and ta > 0; else ok := ta > tb; end if;
    res := case when ok then 'si' else 'no' end;
    txt := case when ok then format('Aprobada por %s votos a %s.', ta, tb)
                when tb > ta then format('Rechazada por %s votos a %s. No se cambia nada.', tb, ta)
                else format('Empate a %s tras repetir la votación. No se cambia nada.', ta) end;
    foreach pid in array c.eligible loop perform public.enqueue(pid, 'result'); end loop;
  end if;

  update public.cases set status = 'closed', verdict = txt, outcome = res where id = c.id;
end
$$;

-- Plazos: silencio de 24 h = confirmado; casos vencidos se cierran; recordatorios de señal de vida.
create function public.tick() returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare cfg public.game_config; r record; v_now timestamptz := public.app_now();
begin
  select * into cfg from public.game_config where id = 1;

  update public.touches set status = 'confirmed', resolved_at = v_now
   where status = 'pending' and registered_at + interval '24 hours' <= v_now;

  for r in select id from public.cases where status = 'open' and closes_at <= v_now order by id loop
    perform public.close_case(r.id);
  end loop;

  -- Señal de vida: 48 h sin abrir la app → recordatorio a ese jugador (genérico, igual para todos).
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
-- API de jugador
---------------------------------------------------------------------------------------------------

-- Alta: la llama quien acaba de crear su cuenta de Auth (correo sintético <name_key>@noviembrada.local).
create function public.request_join(p_name text, p_contract boolean, p_honor boolean, p_media boolean) returns jsonb
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
  perform public.enqueue(x, 'vote') from unnest(public.active_ids()) x;
  return jsonb_build_object('status', 'pending', 'case_id', cid);
end
$$;

create function public.heartbeat() returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'no_session'; end if;
  update public.players set last_seen = public.app_now() where id = auth.uid();
  perform public.tick();
end
$$;

-- Lo que ve el propio jugador. Solo él puede saber si la lleva.
create function public.me() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v uuid := auth.uid(); p public.players; cfg public.game_config; ct public.touches;
  holds boolean := false; notice jsonb := null; nt public.touches; opens int;
begin
  if v is null then raise exception 'no_session'; end if;
  perform public.tick();
  select * into p from public.players where id = v;
  if not found then return jsonb_build_object('player', null); end if;
  select * into cfg from public.game_config where id = 1;

  if p.status <> 'admitted' or p.edition <> cfg.edition then
    return jsonb_build_object(
      'player', jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status,
                                   'next_edition', p.status = 'admitted' and p.edition > cfg.edition),
      'now', public.app_now(), 'start_at', cfg.start_at, 'end_at', cfg.end_at);
  end if;

  if cfg.draw_done then
    ct := public.current_touch();
    holds := ct.to_id = v;
  end if;

  select * into nt from public.touches where to_id = v and status = 'pending' and from_id is not null
   order by touched_at desc limit 1;
  if found then
    notice := jsonb_build_object('touch_id', nt.id, 'from', public.pname(nt.from_id), 'touched_at', nt.touched_at,
      'registered_at', nt.registered_at, 'place', nt.place,
      'media', coalesce((select jsonb_agg(jsonb_build_object('path', m.path, 'kind', m.kind) order by m.id)
                           from public.touch_media m where m.touch_id = nt.id), '[]'::jsonb));
  end if;

  select count(*) into opens from public.cases c
   where c.status = 'open' and v = any(c.eligible) and not v = any(c.parties)
     and not exists (select 1 from public.case_voted cv where cv.case_id = c.id and cv.player_id = v);

  return jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'is_admin', p.is_admin),
    'now', public.app_now(), 'start_at', cfg.start_at, 'end_at', cfg.end_at, 'dispute_end_at', cfg.dispute_end_at,
    'test_mode', cfg.test_mode, 'draw_done', cfg.draw_done,
    'finished', public.app_now() > cfg.end_at,
    'holds', holds,
    'passed_from', case when holds then public.pname(ct.from_id) end,
    'hold_since', case when holds then ct.touched_at end,
    'notice', notice,
    'open_votes', opens);
end
$$;

-- Jugadores a los que puedo tocar. "blocked" (Regla de Tres) solo se informa al portador.
create function public.get_targets() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); ct public.touches; lf uuid := null;
begin
  ct := public.current_touch();
  if ct.to_id = v then lf := ct.from_id; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'blocked', p.id = lf) order by p.name)
                     from public.players p, public.game_config c
                    where p.status = 'admitted' and p.edition = c.edition and p.id <> v), '[]'::jsonb);
end
$$;

create function public.register_touch(p_to uuid, p_ago int, p_place text default '') returns bigint
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
  perform public.enqueue(p_to, 'touch');
  return tid;
end
$$;

create function public.respond_touch(p_touch bigint, p_action text, p_text text default null) returns bigint
language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v uuid := public.me_active(); t public.touches; cfg public.game_config; cid bigint; elig uuid[]; n int;
begin
  perform public.tick();
  select * into cfg from public.game_config where id = 1;
  select * into t from public.touches where id = p_touch for update;
  if not found or t.to_id <> v or t.from_id is null then raise exception 'not_found'; end if;
  if t.status <> 'pending' then raise exception 'already_resolved'; end if;
  if t.registered_at + interval '24 hours' <= public.app_now() then raise exception 'expired'; end if;

  if p_action = 'confirm' then
    update public.touches set status = 'confirmed', resolved_at = public.app_now() where id = t.id;
    return null;
  elsif p_action = 'dispute' then
    n := length(trim(coalesce(p_text, '')));
    if n < 40 or n > 600 then raise exception 'text_length'; end if;
    if public.app_now() >= cfg.dispute_end_at then raise exception 'too_late'; end if;
    update public.touches set status = 'disputed' where id = t.id;
    select coalesce(array_agg(x), '{}') into elig from unnest(public.active_ids()) x
     where x <> t.from_id and x <> t.to_id;
    insert into public.cases (kind, touch_id, question, body, opened_at, closes_at, parties, eligible)
    values ('dispute', t.id,
            format('¿Es válido el toque de %s a %s?', public.pname(t.from_id), public.pname(t.to_id)), '',
            public.app_now(), least(public.app_now() + interval '48 hours', cfg.dispute_end_at),
            array[t.from_id, t.to_id], elig)
    returning id into cid;
    insert into public.case_versions (case_id, player_id, body, created_at)
    values (cid, v, trim(p_text), public.app_now());
    perform public.enqueue(t.from_id, 'version');
    perform public.enqueue(x, 'vote') from unnest(elig) x;
    return cid;
  end if;
  raise exception 'invalid_action';
end
$$;

create function public.add_version(p_case bigint, p_text text) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); c public.cases; n int := length(trim(coalesce(p_text, '')));
begin
  perform public.tick();
  select * into c from public.cases where id = p_case;
  if not found or c.kind <> 'dispute' or not v = any(c.parties) then raise exception 'not_found'; end if;
  if c.status <> 'open' or c.opened_at + interval '24 hours' <= public.app_now() then raise exception 'expired'; end if;
  if n < 40 or n > 600 then raise exception 'text_length'; end if;
  insert into public.case_versions (case_id, player_id, body, created_at)
  values (c.id, v, trim(p_text), public.app_now());   -- PK impide una segunda versión
end
$$;

create function public.propose_reform(p_question text, p_body text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); cid bigint;
begin
  if length(trim(coalesce(p_question,''))) < 5 or length(trim(coalesce(p_body,''))) < 10 then raise exception 'text_length'; end if;
  insert into public.cases (kind, question, body, opened_at, closes_at, eligible)
  values ('reform', left(trim(p_question), 200), left(trim(p_body), 1000), public.app_now(),
          public.app_now() + interval '48 hours', public.active_ids())
  returning id into cid;
  perform public.enqueue(x, 'vote') from unnest(public.active_ids()) x;
  return cid;
end
$$;

create function public.list_cases() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); act boolean;
begin
  if v is null then raise exception 'no_session'; end if;
  perform public.tick();
  act := v = any(public.active_ids());
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'question', c.question, 'status', c.status, 'closes_at', c.closes_at,
      'verdict', c.verdict, 'party', v = any(c.parties),
      'voted', exists (select 1 from public.case_voted cv where cv.case_id = c.id and cv.player_id = v))
      order by (c.status = 'closed'), c.id desc)
    from public.cases c
    where (v = any(c.eligible) or v = any(c.parties) or (c.status = 'closed' and act))
      and c.candidate_id is distinct from v
  ), '[]'::jsonb);
end
$$;

create function public.get_case(p_case bigint) returns jsonb
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
    'touch_id', c.touch_id);
end
$$;

create function public.cast_vote(p_case bigint, p_choice text) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); c public.cases;
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
  begin
    insert into public.case_voted (case_id, player_id) values (c.id, v);
  exception when unique_violation then raise exception 'already_voted';
  end;
  insert into public.case_votes (case_id, choice) values (c.id, p_choice);
  if (select count(*) from public.case_voted where case_id = c.id) >= cardinality(c.eligible) then
    perform public.close_case(c.id);
  end if;
end
$$;

-- Pruebas (fotos y vídeos) --------------------------------------------------------------------
create function public.add_media(p_touch bigint, p_path text, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); t public.touches;
begin
  select * into t from public.touches where id = p_touch;
  if not found then raise exception 'not_found'; end if;
  if not (t.from_id = v or (t.to_id = v and t.status = 'disputed')) then raise exception 'not_allowed'; end if;
  if p_path not like p_touch::text || '/' || v::text || '/%' then raise exception 'bad_path'; end if;
  if (select count(*) from public.touch_media where touch_id = p_touch and owner_id = v) >= 4 then
    raise exception 'too_many_media';
  end if;
  insert into public.touch_media (touch_id, owner_id, path, kind) values (p_touch, v, p_path, p_kind);
end
$$;

-- Quién puede subir: <touch_id>/<uid>/<archivo>, solo el tocador, o el tocado si disputa.
create function public.can_upload_media(p_path text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); tid bigint; t public.touches;
begin
  if v is null or split_part(p_path, '/', 2) <> v::text then return false; end if;
  begin tid := split_part(p_path, '/', 1)::bigint; exception when others then return false; end;
  select * into t from public.touches where id = tid;
  if not found then return false; end if;
  return t.from_id = v or (t.to_id = v and t.status = 'disputed');
end
$$;

-- Quién puede ver: quien subió, las partes, los votantes del caso y, tras el cierre, todos los jugadores.
create function public.can_view_media(p_path text) returns boolean
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
  return public.app_now() > cfg.end_at and v = any(public.active_ids());
end
$$;

-- Final --------------------------------------------------------------------------------------
create function public.final_result() returns jsonb
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
        from public.touches t), '[]'::jsonb));
end
$$;

-- Abandono ----------------------------------------------------------------------------------
create function public.leave_game() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); cfg public.game_config; ct public.touches; was_holder boolean := false;
begin
  select * into cfg from public.game_config where id = 1;
  if cfg.draw_done then ct := public.current_touch(); was_holder := ct.to_id = v; end if;
  update public.players set status = 'left', left_at = public.app_now() where id = v;
  if was_holder and public.app_now() <= cfg.end_at then
    update public.game_config set forced_loser = v where id = 1;
  end if;
  return jsonb_build_object('left', true, 'auto_loser', was_holder);
end
$$;

-- Avisos push ---------------------------------------------------------------------------------
create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'no_session'; end if;
  insert into public.push_subscriptions (player_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set player_id = excluded.player_id, p256dh = excluded.p256dh, auth = excluded.auth;
end
$$;

---------------------------------------------------------------------------------------------------
-- Administración (solo jugadores con is_admin)
---------------------------------------------------------------------------------------------------
create function public.require_admin() returns void
language plpgsql stable security definer set search_path = public, pg_temp as
$$
begin
  if not exists (select 1 from public.players where id = auth.uid() and is_admin) then raise exception 'not_admin'; end if;
end
$$;

-- Sorteo inicial: aleatoriedad criptográfica; no devuelve el resultado.
create function public.admin_draw() returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare cfg public.game_config; ids uuid[]; pick uuid; idx bigint;
begin
  perform public.require_admin();
  select * into cfg from public.game_config where id = 1 for update;
  if cfg.draw_done then raise exception 'already_drawn'; end if;
  ids := public.active_ids();
  if cardinality(ids) < 2 then raise exception 'not_enough_players'; end if;
  idx := (('x' || encode(extensions.gen_random_bytes(7), 'hex'))::bit(56)::bigint) % cardinality(ids);
  pick := ids[idx + 1];
  insert into public.touches (from_id, to_id, touched_at, registered_at, status, place, resolved_at)
  values (null, pick, cfg.start_at, cfg.start_at, 'confirmed', 'Sorteo del 31 de octubre', cfg.start_at);
  update public.game_config set draw_done = true where id = 1;
  perform public.enqueue(x, 'draw') from unnest(ids) x;
end
$$;

-- Modo de prueba: fechas y reloj falsos.
create function public.admin_test_config(p_start timestamptz, p_end timestamptz, p_dispute_end timestamptz, p_offset interval default '0') returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  perform public.require_admin();
  if not (select test_mode from public.game_config where id = 1) then raise exception 'not_test_mode'; end if;
  update public.game_config set start_at = p_start, end_at = p_end, dispute_end_at = p_dispute_end, clock_offset = p_offset where id = 1;
end
$$;

create function public.admin_test_reset() returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  perform public.require_admin();
  if not (select test_mode from public.game_config where id = 1) then raise exception 'not_test_mode'; end if;
  delete from public.cases;
  delete from public.touches;
  delete from public.outbox;
  update public.game_config set draw_done = false, forced_loser = null, clock_offset = '0' where id = 1;
end
$$;

---------------------------------------------------------------------------------------------------
-- Permisos: nada ejecutable por defecto; solo la API de jugador para `authenticated`.
---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.request_join(text, boolean, boolean, boolean), public.heartbeat(), public.me(), public.get_targets(),
  public.register_touch(uuid, int, text), public.respond_touch(bigint, text, text), public.add_version(bigint, text),
  public.propose_reform(text, text), public.list_cases(), public.get_case(bigint), public.cast_vote(bigint, text),
  public.add_media(bigint, text, text), public.can_upload_media(text), public.can_view_media(text),
  public.final_result(), public.leave_game(), public.push_subscribe(text, text, text),
  public.admin_draw(), public.admin_test_config(timestamptz, timestamptz, timestamptz, interval), public.admin_test_reset()
to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
