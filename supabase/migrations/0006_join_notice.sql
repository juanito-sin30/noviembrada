-- Avisos con texto propio (solo para solicitudes de ingreso y la bienvenida).
-- El resto de avisos siguen siendo genéricos: «Tienes un aviso.»
alter table public.outbox add column body text, add column tag text;

create function public.enqueue_msg(p_player uuid, p_kind text, p_body text, p_tag text) returns void
language sql security definer set search_path = public, pg_temp as
$$ insert into public.outbox (player_id, kind, body, tag) values (p_player, p_kind, p_body, p_tag) $$;
revoke execute on function public.enqueue_msg(uuid, text, text, text) from public, anon, authenticated;

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
  perform public.enqueue_msg(x, 'join', format('%s solicita unirse a la Noviembrada. Entra en la Junta y vota.', left(regexp_replace(trim(p_name), '\s+', ' ', 'g'), 40)), 'join-' || cid)
    from unnest(public.active_ids()) x;
  return jsonb_build_object('status', 'pending', 'case_id', cid);
end
$$;

revoke execute on function public.request_join(text, boolean, boolean, boolean) from public, anon;
grant execute on function public.request_join(text, boolean, boolean, boolean) to authenticated;
