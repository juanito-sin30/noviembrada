-- El administrador puede admitir de golpe a un candidato, sin esperar a la votación.
create or replace function public.admin_accept(p_case bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
declare c public.cases; cfg public.game_config;
begin
  perform public.require_admin();
  select * into c from public.cases where id = p_case and kind = 'admission' and status = 'open' for update;
  if not found then raise exception 'not_found'; end if;
  select * into cfg from public.game_config where id = 1;
  update public.players set status = 'admitted',
         edition = case when public.app_now() > cfg.end_at then cfg.edition + 1 else cfg.edition end
   where id = c.candidate_id;
  update public.cases set status = 'closed', outcome = 'si', verdict = 'Aceptado por el departamento Administrativo' where id = c.id;
  perform public.enqueue(c.candidate_id, 'result');
end
$$;
revoke execute on function public.admin_accept(bigint) from public, anon;
grant execute on function public.admin_accept(bigint) to authenticated;
