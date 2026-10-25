-- Aviso de bienvenida: se envía una vez a cada jugador, en cuanto activa los avisos en su móvil.
alter table public.players add column welcomed boolean not null default false;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if auth.uid() is null then raise exception 'no_session'; end if;
  insert into public.push_subscriptions (player_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set player_id = excluded.player_id, p256dh = excluded.p256dh, auth = excluded.auth;
  if not (select welcomed from public.players where id = auth.uid()) then
    update public.players set welcomed = true where id = auth.uid();
    perform public.enqueue(auth.uid(), 'welcome');
  end if;
end
$$;
revoke execute on function public.push_subscribe(text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text) to authenticated;
