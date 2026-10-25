import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, freshDb, rejects } from './helpers.js';

before(startServer);
after(stopServer);

// Siete jugadores: los 3 primeros fundadores; el resto se admite a mano. Aina es admin.
async function partida(n = 4) {
  const g = await freshDb();
  const names = ['Aina', 'Gonzalo', 'Juanito', 'Lola', 'Marta', 'Paco', 'Pol'].slice(0, n);
  const P = {};
  for (const nm of names) P[nm] = await g.join(nm);
  await g.sql(`update players set status='admitted' where status='pending'`); // atajo: admisión probada aparte
  await g.sql(`delete from cases where kind='admission'`);
  await g.sql(`delete from outbox`);
  await g.sql(`update players set is_admin = true where name='Aina'`);
  return { g, P };
}
// Sortea y devuelve quién la tiene, sin usar nada que un cliente no pueda ver.
async function sortea(g, P, quien) {
  await g.rpc(P.Aina, 'admin_draw');
  // Forzamos el resultado para que la prueba sea determinista (esto lo hace el superusuario, no un cliente).
  await g.sql(`update touches set to_id = $1 where from_id is null`, [P[quien].id]);
}
const holds = async (g, p) => (await g.rpc(p, 'me')).holds;
const toca = (g, de, a, ago = 0, lugar = '') => g.rpc(de, 'register_touch', a.id, ago, lugar);

test('los 3 primeros son fundadores; el cuarto abre un caso de admisión', async () => {
  const g = await freshDb();
  const a = await g.join('Aina'), b = await g.join('Gonzalo'), c = await g.join('Juanito');
  assert.deepEqual([a, b, c].map(x => x.res.status), ['admitted', 'admitted', 'admitted']);
  const d = await g.join('Lola');
  assert.equal(d.res.status, 'pending');
  const me = await g.rpc(d, 'me');
  assert.equal(me.player.status, 'pending');
  assert.equal(me.holds, undefined, 'el aspirante no ve estado');
  await rejects(g.rpc(d, 'get_targets'), 'not_admitted');
  await rejects(g.rpc(d, 'list_cases').then(r => { if (r.length) throw new Error('not_found_expected'); return r; }), 'not_found_expected').catch(() => {});
  await g.close();
});

test('nombre único sin distinguir mayúsculas ni acentos; correo debe coincidir', async () => {
  const g = await freshDb();
  await g.join('José Pérez');
  await rejects(g.join('JOSE  perez'), 'duplicate key'); // el correo sintético ya existe
  await g.close();
});

test('admisión: votan los admitidos al abrir; el aspirante no; empate = rechazado', async () => {
  const g = await freshDb();
  const a = await g.join('Aina'), b = await g.join('Gonzalo'), c = await g.join('Juanito');
  const d = await g.join('Lola');
  const cases = await g.rpc(a, 'list_cases');
  assert.equal(cases.length, 1);
  const id = cases[0].id;
  await rejects(g.rpc(d, 'cast_vote', id, 'si'), 'not_admitted');
  await g.rpc(a, 'cast_vote', id, 'si');
  await g.rpc(b, 'cast_vote', id, 'no');
  await g.rpc(c, 'cast_vote', id, 'abs');           // abstención: no cuenta → empate 1-1
  const st = (await g.sql('select status from players where id=$1', [d.id])).rows[0].status;
  assert.equal(st, 'rejected');
  await rejects(g.rpc(d, 'get_case', id), 'not_found');
  await g.close();
});

test('admisión por mayoría: el aspirante entra', async () => {
  const g = await freshDb();
  const a = await g.join('Aina'), b = await g.join('Gonzalo'), c = await g.join('Juanito');
  const d = await g.join('Lola');
  const id = (await g.rpc(a, 'list_cases'))[0].id;
  await g.rpc(a, 'cast_vote', id, 'si'); await g.rpc(b, 'cast_vote', id, 'si'); await g.rpc(c, 'cast_vote', id, 'no');
  assert.equal((await g.sql('select status from players where id=$1', [d.id])).rows[0].status, 'admitted');
  await g.close();
});

test('sorteo: solo lo sabe el elegido y no se puede repetir', async () => {
  const { g, P } = await partida(4);
  await rejects(g.rpc(P.Gonzalo, 'admin_draw'), 'not_admin');
  await g.rpc(P.Aina, 'admin_draw');
  const quien = (await g.sql(`select to_id from touches where from_id is null`)).rows[0].to_id;
  for (const p of Object.values(P)) {
    const me = await g.rpc(p, 'me');
    assert.equal(me.draw_done, true);
    assert.equal(me.holds, p.id === quien);
  }
  await rejects(g.rpc(P.Aina, 'admin_draw'), 'already_drawn');
  await g.close();
});

test('un jugador no puede leer el estado de otro ni las tablas con su token', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Marta' in P ? 'Lola' : 'Lola');
  for (const t of ['touches', 'players', 'cases', 'case_votes', 'case_voted', 'game_config', 'outbox', 'push_subscriptions', 'touch_media', 'case_versions'])
    await rejects(g.as(P.Gonzalo, `select * from public.${t}`), 'permission denied');
  await rejects(g.as(P.Gonzalo, `insert into public.touches (to_id, touched_at, registered_at) values ($1, now(), now())`, [P.Gonzalo.id]), 'permission denied');
  await rejects(g.as(P.Gonzalo, 'select public.current_touch()'), 'permission denied');
  await rejects(g.as(P.Gonzalo, 'select * from public.valid_chain()'), 'permission denied');
  await rejects(g.as(P.Gonzalo, 'select public.tick()'), 'permission denied');
  const me = await g.rpc(P.Gonzalo, 'me');
  assert.equal(me.holds, false);
  assert.equal(me.passed_from, null);
  // El JSON de me() de quien no la lleva no contiene el nombre del portador.
  assert.ok(!JSON.stringify(me).includes('Lola'));
  assert.ok(!JSON.stringify(await g.rpc(P.Gonzalo, 'get_targets')).includes('"blocked":true'));
  await g.close();
});

test('solo el portador puede tocar', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Lola');
  await rejects(toca(g, P.Gonzalo, P.Juanito), 'not_holder');
  await toca(g, P.Lola, P.Gonzalo);
  assert.equal(await holds(g, P.Gonzalo), true);
  assert.equal(await holds(g, P.Lola), false);
  await g.close();
});

test('Regla de Tres: no se devuelve al que te la pasó, pero el triángulo vale', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');               // B = Gonzalo
  await toca(g, P.Gonzalo, P.Aina);            // B → A
  const targets = await g.rpc(P.Aina, 'get_targets');
  assert.equal(targets.find(t => t.id === P.Gonzalo.id).blocked, true);
  await rejects(toca(g, P.Aina, P.Gonzalo), 'rule_of_three');
  await toca(g, P.Aina, P.Juanito);            // A → C
  await toca(g, P.Juanito, P.Gonzalo);         // C → B (triángulo cerrado)
  await toca(g, P.Gonzalo, P.Aina);            // B → A otra vez, permitido
  assert.equal(await holds(g, P.Aina), true);
  await g.close();
});

test('el tocador no ve «blocked» si no la lleva, y no puede tocarse a sí mismo', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  await rejects(toca(g, P.Gonzalo, P.Gonzalo), 'invalid_target');
  await g.close();
});

test('plazo de 30 minutos para registrar un toque', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  await rejects(toca(g, P.Gonzalo, P.Aina, 31), 'too_late');
  await rejects(toca(g, P.Gonzalo, P.Aina, -1), 'too_late');
  await toca(g, P.Gonzalo, P.Aina, 30);
  const t = (await g.sql(`select registered_at - touched_at d from touches where from_id is not null`)).rows[0];
  assert.ok(t.d.minutes === 30 || t.d.minutes === 29 || t.d.minutes === 30);
  await g.close();
});

test('el estatus cambia desde el momento del toque, y no se puede registrar un toque anterior al que te hizo portador', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  await toca(g, P.Gonzalo, P.Aina, 10);                   // tocado hace 10 min
  await rejects(toca(g, P.Aina, P.Juanito, 30), 'before_previous_touch');
  await toca(g, P.Aina, P.Juanito, 5);
  await g.close();
});

test('fuera de plazo de partida y sin sorteo no se puede tocar', async () => {
  const { g, P } = await partida(4);
  await rejects(toca(g, P.Gonzalo, P.Aina), 'outside_game'.length ? 'no_draw' : '');
  await sortea(g, P, 'Gonzalo');
  await g.sql(`update game_config set end_at = now() - interval '1 minute'`);
  await rejects(toca(g, P.Gonzalo, P.Aina), 'outside_game');
  await g.sql(`update game_config set end_at = now() + interval '1 day', start_at = now() + interval '1 hour'`);
  await rejects(toca(g, P.Gonzalo, P.Aina), 'outside_game');
  await g.close();
});

test('silencio de 24 h = confirmado', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  const id = await toca(g, P.Gonzalo, P.Aina);
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'pending');
  await g.sql(`update game_config set clock_offset = interval '23 hours'`);
  await g.rpc(P.Aina, 'heartbeat');
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'pending');
  await g.sql(`update game_config set clock_offset = interval '24 hours 1 minute'`);
  await g.rpc(P.Aina, 'heartbeat');
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'confirmed');
  await rejects(g.rpc(P.Aina, 'respond_touch', id, 'confirm'), 'already_resolved');
  await g.close();
});

test('el tocado puede confirmar; solo el tocado responde', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  const id = await toca(g, P.Gonzalo, P.Aina, 0, 'Metro');
  const aviso = (await g.rpc(P.Aina, 'me')).notice;
  assert.equal(aviso.from, 'Gonzalo');
  assert.equal(aviso.place, 'Metro');
  await rejects(g.rpc(P.Juanito, 'respond_touch', id, 'confirm'), 'not_found');
  await rejects(g.rpc(P.Gonzalo, 'respond_touch', id, 'confirm'), 'not_found');
  await g.rpc(P.Aina, 'respond_touch', id, 'confirm');
  assert.equal((await g.rpc(P.Aina, 'me')).notice, null);
  await g.close();
});

// --- Disputas y Junta -------------------------------------------------------------------------
async function disputa(g, P, n = 7) {
  await sortea(g, P, 'Gonzalo');
  const id = await toca(g, P.Gonzalo, P.Aina);
  const texto = 'No me tocó. Estaba en la otra punta del andén y solo me rozó la mochila, no la ropa.';
  await rejects(g.rpc(P.Aina, 'respond_touch', id, 'dispute', 'corto'), 'text_length');
  const cid = await g.rpc(P.Aina, 'respond_touch', id, 'dispute', texto);
  return { id, cid };
}

test('disputa: las dos partes no votan; votan los demás; mayoría simple anula el toque', async () => {
  const { g, P } = await partida(7);
  const { id, cid } = await disputa(g, P);
  await rejects(g.rpc(P.Aina, 'cast_vote', cid, 'nulo'), 'party_cannot_vote');
  await rejects(g.rpc(P.Gonzalo, 'cast_vote', cid, 'valido'), 'party_cannot_vote');
  await rejects(g.rpc(P.Juanito, 'cast_vote', cid, 'si'), 'invalid_choice');
  const v = (await g.rpc(P.Juanito, 'get_case', cid));
  assert.equal(v.voters, 5);
  assert.deepEqual(v.parties.sort(), ['Aina', 'Gonzalo']);
  await g.rpc(P.Juanito, 'cast_vote', cid, 'nulo');
  await g.rpc(P.Lola, 'cast_vote', cid, 'nulo');
  await g.rpc(P.Marta, 'cast_vote', cid, 'valido');
  await rejects(g.rpc(P.Juanito, 'cast_vote', cid, 'valido'), 'already_voted');
  await g.rpc(P.Paco, 'cast_vote', cid, 'abs');
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'disputed');
  await g.rpc(P.Pol, 'cast_vote', cid, 'nulo');          // todos han votado → se cierra
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'void');
  assert.equal(await holds(g, P.Gonzalo), true, 'el estatus vuelve a quien tocó');
  assert.equal(await holds(g, P.Aina), false);
  const caso = await g.rpc(P.Pol, 'get_case', cid);
  assert.match(caso.verdict, /Toque nulo por 3 votos a 1/);
  await g.close();
});

test('voto anónimo: ninguna tabla relaciona jugador y voto', async () => {
  const { g, P } = await partida(7);
  const { cid } = await disputa(g, P);
  await g.rpc(P.Juanito, 'cast_vote', cid, 'nulo');
  await g.rpc(P.Lola, 'cast_vote', cid, 'valido');
  const cols = (await g.sql(`select column_name from information_schema.columns where table_name='case_votes'`)).rows.map(r => r.column_name).sort();
  assert.deepEqual(cols, ['case_id', 'choice'], 'case_votes no lleva jugador, hora ni id');
  const voted = (await g.sql('select count(*)::int n from case_voted where case_id=$1', [cid])).rows[0].n;
  assert.equal(voted, 2);
  const c = await g.rpc(P.Juanito, 'get_case', cid);
  assert.equal(c.i_voted, true);
  assert.ok(!('my_vote' in c));
  await g.close();
});

test('empate: se repite una vez; si persiste, el toque se mantiene', async () => {
  const { g, P } = await partida(7);
  const { id, cid } = await disputa(g, P);
  const votar = async (a, b, c, d, e) => {
    await g.rpc(P.Juanito, 'cast_vote', cid, a); await g.rpc(P.Lola, 'cast_vote', cid, b);
    await g.rpc(P.Marta, 'cast_vote', cid, c);   await g.rpc(P.Paco, 'cast_vote', cid, d);
    await g.rpc(P.Pol, 'cast_vote', cid, e);
  };
  await votar('valido', 'valido', 'nulo', 'nulo', 'abs');          // 2-2 → repetir
  let c = await g.rpc(P.Juanito, 'get_case', cid);
  assert.equal(c.status, 'open'); assert.equal(c.round, 2); assert.equal(c.voted, 0);
  await votar('valido', 'valido', 'nulo', 'nulo', 'abs');          // 2-2 otra vez
  c = await g.rpc(P.Juanito, 'get_case', cid);
  assert.equal(c.status, 'closed');
  assert.match(c.verdict, /Empate a 2 tras repetir/);
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'confirmed');
  assert.equal(await holds(g, P.Aina), true);
  await g.close();
});

test('la parte que no disputa puede añadir su versión en 24 h, una sola vez', async () => {
  const { g, P } = await partida(7);
  const { cid } = await disputa(g, P);
  const t = 'Sí la toqué: le puse la mano en el hombro y dije «la llevas» delante de dos testigos.';
  await rejects(g.rpc(P.Juanito, 'add_version', cid, t), 'not_found');
  await g.rpc(P.Gonzalo, 'add_version', cid, t);
  await rejects(g.rpc(P.Gonzalo, 'add_version', cid, t), 'duplicate key');
  const c = await g.rpc(P.Juanito, 'get_case', cid);
  assert.equal(c.versions.length, 2);
  await g.close();
});

test('versión fuera de las 24 h: rechazada', async () => {
  const { g, P } = await partida(7);
  const { cid } = await disputa(g, P);
  await g.sql(`update game_config set clock_offset = interval '25 hours'`);
  await rejects(g.rpc(P.Gonzalo, 'add_version', cid, 'x'.repeat(50)), 'expired');
  await g.close();
});

test('un caso vencido se cierra solo con los votos emitidos', async () => {
  const { g, P } = await partida(7);
  const { id, cid } = await disputa(g, P);
  await g.rpc(P.Juanito, 'cast_vote', cid, 'nulo');
  await g.sql(`update game_config set clock_offset = interval '49 hours'`);
  await g.rpc(P.Pol, 'heartbeat');
  assert.equal((await g.sql('select status from touches where id=$1', [id])).rows[0].status, 'void');
  await g.close();
});

test('disputas abiertas al cierre: pueden resolverse hasta el 7 dic; luego, como estaba', async () => {
  const { g, P } = await partida(7);
  await sortea(g, P, 'Gonzalo');
  const id = await toca(g, P.Gonzalo, P.Aina);
  // Acaba la partida: el plazo de disputa sigue abierto.
  await g.sql(`update game_config set end_at = now() + interval '1 hour', dispute_end_at = now() + interval '3 days'`);
  const cid = await g.rpc(P.Aina, 'respond_touch', id, 'dispute', 'x'.repeat(45));
  await g.sql(`update game_config set clock_offset = interval '2 hours'`);   // ya cerrada la partida
  const f = await g.rpc(P.Juanito, 'final_result');
  assert.equal(f.provisional, true);
  await g.sql(`update game_config set clock_offset = interval '4 days'`);     // pasado el 7 dic
  const f2 = await g.rpc(P.Juanito, 'final_result');
  assert.equal(f2.provisional, false);
  assert.equal(f2.loser, 'Aina');                                              // queda como estaba
  await g.close();
});

test('cierre: perdedor = portador vigente, contando toques pendientes; cadena completa con anulados', async () => {
  const { g, P } = await partida(7);
  await sortea(g, P, 'Gonzalo');
  await toca(g, P.Gonzalo, P.Aina);
  await toca(g, P.Aina, P.Juanito);                          // pendiente al cierre
  await rejects(g.rpc(P.Pol, 'final_result'), 'not_finished');
  await g.sql(`update game_config set end_at = now() - interval '1 minute'`);
  const f = await g.rpc(P.Pol, 'final_result');
  assert.equal(f.loser, 'Juanito');
  assert.equal(f.chain.length, 3);
  assert.deepEqual(f.chain.map(x => x.to), ['Gonzalo', 'Aina', 'Juanito']);
  await g.close();
});

test('un toque tras el cierre no se acepta', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  await g.sql(`update game_config set end_at = now() - interval '1 second'`);
  await rejects(toca(g, P.Gonzalo, P.Aina), 'outside_game');
  await g.close();
});

test('si se anula un toque, los posteriores que dependían de él quedan sin efecto', async () => {
  const { g, P } = await partida(7);
  await sortea(g, P, 'Gonzalo');
  const t1 = await toca(g, P.Gonzalo, P.Aina);               // G → A
  const cid = await g.rpc(P.Aina, 'respond_touch', t1, 'dispute', 'x'.repeat(45));
  await toca(g, P.Aina, P.Juanito);                          // A → J (A todavía era portadora)
  for (const p of ['Lola', 'Marta', 'Paco', 'Pol', 'Juanito']) await g.rpc(P[p], 'cast_vote', cid, 'nulo');
  assert.equal(await holds(g, P.Gonzalo), true);
  assert.equal(await holds(g, P.Juanito), false);
  await g.close();
});

test('abandono: si sale el portador, es perdedor automático', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  assert.deepEqual(await g.rpc(P.Aina, 'leave_game'), { left: true, auto_loser: false });
  assert.deepEqual(await g.rpc(P.Gonzalo, 'leave_game'), { left: true, auto_loser: true });
  await g.sql(`update game_config set end_at = now() - interval '1 minute'`);
  assert.equal((await g.rpc(P.Juanito, 'final_result')).loser, 'Gonzalo');
  await rejects(g.rpc(P.Aina, 'get_targets'), 'not_admitted');
  await g.close();
});

test('pruebas: máximo 4 por toque; las ve quien las sube, el tocado y los votantes; todos al cierre', async () => {
  const { g, P } = await partida(7);
  await sortea(g, P, 'Gonzalo');
  const id = await toca(g, P.Gonzalo, P.Aina);
  const ruta = (u, f) => `${id}/${u.id}/${f}`;
  const up = (u, p) => g.as(u, 'select public.can_upload_media($1) r', [p]).then(r => r.rows[0].r);
  const view = (u, p) => g.as(u, 'select public.can_view_media($1) r', [p]).then(r => r.rows[0].r);
  assert.equal(await up(P.Gonzalo, ruta(P.Gonzalo, 'a.jpg')), true);
  assert.equal(await up(P.Gonzalo, ruta(P.Aina, 'a.jpg')), false, 'no se sube a nombre de otro');
  assert.equal(await up(P.Aina, ruta(P.Aina, 'a.jpg')), false, 'el tocado solo sube si disputa');
  assert.equal(await up(P.Juanito, ruta(P.Juanito, 'a.jpg')), false);
  for (let i = 0; i < 4; i++) await g.rpc(P.Gonzalo, 'add_media', id, ruta(P.Gonzalo, `${i}.jpg`), 'foto');
  await rejects(g.rpc(P.Gonzalo, 'add_media', id, ruta(P.Gonzalo, '5.jpg'), 'foto'), 'too_many_media');
  const p0 = ruta(P.Gonzalo, '0.jpg');
  assert.equal(await view(P.Gonzalo, p0), true);
  assert.equal(await view(P.Aina, p0), true);
  assert.equal(await view(P.Juanito, p0), false);
  const cid = await g.rpc(P.Aina, 'respond_touch', id, 'dispute', 'x'.repeat(45));
  assert.equal(await up(P.Aina, ruta(P.Aina, 'b.jpg')), true);
  assert.equal(await view(P.Juanito, p0), true, 'los votantes del caso la ven');
  assert.equal(await view(P.Juanito, 'zzz/abc'), false);
  await g.sql(`update game_config set end_at = now() - interval '1 minute'`);
  assert.equal(await view(P.Pol, p0), true, 'al cierre se publican');
  await g.close();
});

test('avisos: el texto de la cola es genérico y no lleva nombres', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  await toca(g, P.Gonzalo, P.Aina);
  const cols = (await g.sql(`select column_name from information_schema.columns where table_name='outbox'`)).rows.map(r => r.column_name);
  assert.ok(!cols.includes('body') && !cols.includes('title'));
  const q = (await g.sql(`select kind, player_id from outbox where kind='touch'`)).rows;
  assert.equal(q.length, 1); assert.equal(q[0].player_id, P.Aina.id);
  await g.close();
});

test('señal de vida: a las 48 h sin abrir la app, recordatorio genérico (a cualquiera, no solo al portador)', async () => {
  const { g, P } = await partida(4);
  await sortea(g, P, 'Gonzalo');
  await g.sql(`update game_config set clock_offset = interval '50 hours'`);
  await g.rpc(P.Gonzalo, 'heartbeat');                         // solo Gonzalo abre la app
  const q = (await g.sql(`select player_id from outbox where kind='reminder'`)).rows.map(r => r.player_id).sort();
  assert.deepEqual(q, [P.Aina.id, P.Juanito.id, P.Lola.id].sort());
  await g.rpc(P.Gonzalo, 'heartbeat');
  assert.equal((await g.sql(`select count(*)::int n from outbox where kind='reminder'`)).rows[0].n, 3, 'sin duplicados');
  await g.close();
});

test('reforma: mayoría simple; propone y vota cualquiera admitido', async () => {
  const { g, P } = await partida(4);
  const cid = await g.rpc(P.Lola, 'propose_reform', '¿Las pruebas en vídeo deben centrarse en el tocado?', 'Añadir a la Cláusula 4: las pruebas se centran en el tocado.');
  await g.rpc(P.Aina, 'cast_vote', cid, 'si'); await g.rpc(P.Gonzalo, 'cast_vote', cid, 'si');
  await g.rpc(P.Juanito, 'cast_vote', cid, 'no'); await g.rpc(P.Lola, 'cast_vote', cid, 'si');
  assert.match((await g.rpc(P.Aina, 'get_case', cid)).verdict, /Aprobada por 3 votos a 1/);
  await g.close();
});

test('alta: el nombre y el correo sintético deben coincidir; hacen falta las 3 casillas', async () => {
  const g = await freshDb();
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  await g.sql('insert into auth.users (id, email) values ($1, $2)', [id, 'otro@noviembrada.local']);
  await rejects(g.rpc(id, 'request_join', 'Marta', true, true, true), 'email_mismatch');
  await g.sql('update auth.users set email=$2 where id=$1', [id, 'marta@noviembrada.local']);
  await rejects(g.rpc(id, 'request_join', 'Marta', true, false, true), 'checks_required');
  await g.rpc(id, 'request_join', 'Marta', true, true, true);
  await g.close();
});

test('aceptado después del cierre: entra en la edición siguiente', async () => {
  const g = await freshDb();
  const a = await g.join('Aina'), b = await g.join('Gonzalo'), c = await g.join('Juanito');
  const d = await g.join('Lola');
  const id = (await g.rpc(a, 'list_cases'))[0].id;
  await g.sql(`update game_config set end_at = now() - interval '1 minute'`);
  await g.rpc(a, 'cast_vote', id, 'si'); await g.rpc(b, 'cast_vote', id, 'si'); await g.rpc(c, 'cast_vote', id, 'si');
  const me = await g.rpc(d, 'me');
  assert.equal(me.player.status, 'admitted');
  assert.equal(me.player.next_edition, true);
  assert.equal(me.holds, undefined);
  await g.close();
});
