-- El toque cuenta desde que lo registra quien la llevaba; el tocado ya no confirma, solo puede disputar (24 h).
create or replace function public.respond_touch(p_touch bigint, p_action text, p_text text default null) returns bigint
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
  if p_action <> 'dispute' then raise exception 'invalid_action'; end if;

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
end
$$;
revoke execute on function public.respond_touch(bigint, text, text) from public, anon;
grant execute on function public.respond_touch(bigint, text, text) to authenticated;
