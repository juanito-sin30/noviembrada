-- Lista de jugadores admitidos en la edición en curso: solo nombres, nada del estado.
create function public.list_players() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := public.me_active();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', p.name, 'me', p.id = v) order by lower(p.name))
      from public.players p, public.game_config c
     where p.status = 'admitted' and p.edition = c.edition), '[]'::jsonb);
end
$$;
revoke execute on function public.list_players() from public, anon;
grant execute on function public.list_players() to authenticated;
