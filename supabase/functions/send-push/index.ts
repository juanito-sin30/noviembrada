// Envía los avisos pendientes de la tabla `outbox` y ejecuta los plazos (tick).
// El mensaje es SIEMPRE genérico («Tienes un aviso.»): aquí no viaja ningún nombre ni estado.
// Lo llaman pg_cron (cada minuto) y un trigger al insertar en outbox, con la cabecera x-cron-secret.
import { createClient } from 'npm:@supabase/supabase-js@2.100.0';
import webpush from 'npm:web-push@3.6.7';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:avisos@noviembrada.app', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });

  const t = await sb.rpc('tick');
  if (t.error) console.error('tick', t.error.message);

  const { data: rows, error } = await sb.from('outbox').select('id, player_id').is('sent_at', null).order('id').limit(500);
  if (error) return new Response(error.message, { status: 500 });
  if (!rows?.length) return Response.json({ sent: 0 });

  const players = [...new Set(rows.map((r) => r.player_id))];
  const { data: subs } = await sb.from('push_subscriptions').select('id, player_id, endpoint, p256dh, auth').in('player_id', players);

  let sent = 0, dead: number[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, '{}', { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id); else console.error('push', code);
    }
  }));
  if (dead.length) await sb.from('push_subscriptions').delete().in('id', dead);
  await sb.from('outbox').update({ sent_at: new Date().toISOString() }).in('id', rows.map((r) => r.id));
  return Response.json({ sent, queued: rows.length });
});
