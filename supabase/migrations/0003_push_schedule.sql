-- Avisos y plazos: pg_net dispara la función al insertar en outbox y pg_cron la llama cada minuto.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Valores privados (URL de la función y secreto). Sin políticas: nadie con token de cliente los lee.
create table public.app_secrets (key text primary key, value text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

create function public.call_send_push() returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$
declare u text; s text;
begin
  select value into u from public.app_secrets where key = 'send_push_url';
  select value into s from public.app_secrets where key = 'cron_secret';
  if u is null or s is null then return; end if;
  perform net.http_post(url := u, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', s), body := '{}'::jsonb);
end
$$;
revoke execute on function public.call_send_push() from public, anon, authenticated;

create function public.outbox_notify() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as
$$ begin perform public.call_send_push(); return null; end $$;
revoke execute on function public.outbox_notify() from public, anon, authenticated;

-- Una llamada por sentencia (no por fila).
create trigger outbox_after_insert after insert on public.outbox
  for each statement execute function public.outbox_notify();

select cron.schedule('noviembrada-tick', '* * * * *', $$ select public.call_send_push() $$);
