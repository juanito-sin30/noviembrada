-- Ranking: tiempo total que cada jugador la ha llevado (menos es mejor).
-- Solo cuentan tramos ya cerrados (hasta que la pasó al siguiente); el tramo en curso del portador actual
-- no se muestra hasta que termina el juego, para no delatar quién la lleva ahora.
create function public.ranking() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active(); cfg public.game_config; res jsonb;
begin
  select * into cfg from public.game_config where id = 1;
  with ch as (
    select t.to_id, t.touched_at as s,
           lead(t.touched_at) over (order by t.touched_at, t.id) as e
      from public.valid_chain() t
  ), spans as (
    select to_id,
           extract(epoch from (case when e is not null then e
                                    when public.app_now() > cfg.end_at then greatest(cfg.end_at, s)
                                    else s end) - s)::bigint as secs
      from ch
  ), tot as (
    select p.id, p.name, coalesce(sum(sp.secs), 0)::bigint as secs
      from public.players p
      left join spans sp on sp.to_id = p.id
     where (p.status = 'admitted' and p.edition = cfg.edition) or sp.to_id is not null
     group by p.id, p.name
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'secs', secs, 'me', id = v,
           'pos', pos) order by secs, lower(name)), '[]'::jsonb)
    into res
    from (select id, name, secs, rank() over (order by secs) as pos from tot) x;
  return res;
end
$$;
revoke execute on function public.ranking() from public, anon;
grant execute on function public.ranking() to authenticated;
