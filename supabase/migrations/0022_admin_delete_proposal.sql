-- El administrador puede eliminar propuestas (reformas y treguas) de la Junta. Los votos se borran con ellas.
create or replace function public.admin_delete_proposal(p_case bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  perform public.require_admin();
  delete from public.cases where id = p_case and kind in ('reform', 'truce');
  if not found then raise exception 'not_found'; end if;
end
$$;
revoke execute on function public.admin_delete_proposal(bigint) from public, anon;
grant execute on function public.admin_delete_proposal(bigint) to authenticated;
