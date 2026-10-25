-- Evita avisos duplicados: quien llama reclama las filas pendientes de forma atómica.
-- Dos ejecuciones simultáneas (trigger + cron) ya no pueden recoger el mismo aviso.
create function public.claim_outbox(p_limit int default 500)
returns table (id bigint, player_id uuid, kind text, body text, tag text)
language sql security definer set search_path = public, pg_temp as
$$
  update public.outbox o set sent_at = now()
   where o.id in (select x.id from public.outbox x where x.sent_at is null order by x.id limit p_limit for update skip locked)
  returning o.id, o.player_id, o.kind, o.body, o.tag
$$;
revoke execute on function public.claim_outbox(int) from public, anon, authenticated;
grant execute on function public.claim_outbox(int) to service_role;
