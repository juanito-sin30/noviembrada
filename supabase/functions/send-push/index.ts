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

  // Reclamo atómico: cada aviso lo recoge una sola ejecución, aunque haya varias a la vez.
  const { data: rows, error } = await sb.rpc('claim_outbox', { p_limit: 500 });
  if (error) return new Response(error.message, { status: 500 });
  if (!rows?.length) return Response.json({ sent: 0 });

  const WELCOME = { title: 'NOVIEMBRADA', body: 'Bienvenido a la Noviembrada pibes ETSEIB', tag: 'welcome' };
  // Por jugador: avisos con texto propio (bienvenida, solicitudes de ingreso) y, si hay más, uno genérico.
  type Msg = { title: string; body: string; tag: string };
  const per = new Map<string, { msgs: Map<string, Msg>; generic: boolean }>();
  for (const r of rows as { player_id: string; kind: string; body: string | null; tag: string | null }[]) {
    const e = per.get(r.player_id) ?? { msgs: new Map<string, Msg>(), generic: false };
    per.set(r.player_id, e);
    if (r.kind === 'welcome') e.msgs.set('welcome', WELCOME);
    else if (r.body) e.msgs.set(r.tag ?? r.body, { title: 'NOVIEMBRADA', body: r.body, tag: r.tag ?? 'noviembrada' });
    else e.generic = true;
  }
  const { data: subs } = await sb.from('push_subscriptions').select('id, player_id, endpoint, p256dh, auth').in('player_id', [...per.keys()]);

  let sent = 0, dead: number[] = [];
  const push = async (s: { id: number; endpoint: string; p256dh: string; auth: string }, payload: string) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id); else console.error('push', code);
    }
  };
  await Promise.all((subs ?? []).map(async (s) => {
    const e = per.get(s.player_id)!;
    for (const m of e.msgs.values()) await push(s, JSON.stringify(m));
    if (e.generic) await push(s, '{}');            // el resto: siempre «Tienes un aviso.»
  }));
  if (dead.length) await sb.from('push_subscriptions').delete().in('id', dead);
  return Response.json({ sent, queued: rows.length });
});
