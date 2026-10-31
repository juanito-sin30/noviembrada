-- Último mensaje ajeno del chat (para el puntito de «no leído»; sin notificación push).
create or replace function public.chat_last() returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as
$$
declare v uuid := auth.uid(); ed int;
begin
  if v is null or not (v = any(public.active_ids())) then return 0; end if;
  select edition into ed from public.game_config where id = 1;
  return coalesce((select max(id) from public.chat_messages where edition = ed and author <> v), 0);
end
$$;
revoke execute on function public.chat_last() from public, anon;
grant execute on function public.chat_last() to authenticated;
