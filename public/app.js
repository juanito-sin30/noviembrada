import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.100.0/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js';
import { CONTRACT, I as ICONS } from './contract.js';
const I = { ...ICONS, people: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 13.8c2.3.2 4 1.9 4 4.7"/></svg>' };

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'noviembrada-auth' }
});

/* ---------- reloj del servidor ---------- */
let skew = 0;                       // servidor - dispositivo
const now = () => Date.now() + skew;
let START = 0, END = 0;
const started = () => now() >= START;
const fmtTime = t => new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(t);
const fmtDay = t => new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short' }).format(t).replace('.', '');
const sameDay = (a, b) => fmtDay(a) === fmtDay(b);
const when = t => sameDay(t, now()) ? 'Hoy · ' + fmtTime(t) : fmtDay(t) + ' · ' + fmtTime(t);
function left(ms) { ms = Math.max(0, ms); return { d: Math.floor(ms / 864e5), h: Math.floor(ms % 864e5 / 36e5), m: Math.floor(ms % 36e5 / 6e4), s: Math.floor(ms % 6e4 / 1e3) }; }
const pad2 = n => String(n).padStart(2, '0');
const countdown = () => { const l = left((started() ? END : START) - now()); return `${l.d} d ${pad2(l.h)} h ${pad2(l.m)} m ${pad2(l.s)} s`; };
const eyebrowTxt = () => started()
  ? `Cierre · ${fmtDay(END)} · ${new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(END)} (Barcelona)`
  : `Empieza · ${fmtDay(START)} · ${new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(START)} (Barcelona)`;
const dayN = () => Math.min(30, Math.max(1, Math.floor((now() - START) / 864e5) + 1));
function ago(t) { const m = Math.max(0, Math.round((now() - t) / 6e4)); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); if (h < 48) return `${h} h ${m % 60} min`; return `${Math.floor(h / 24)} días`; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ts = v => (typeof v === 'number' ? v : Date.parse(v));

/* ---------- servidor ---------- */
const ERRORS = {
  no_session: 'Tu sesión ha caducado. Entra otra vez.',
  not_admitted: 'Todavía no eres jugador.',
  not_holder: 'Ahora mismo no la llevas.',
  too_late: 'Han pasado más de 30 minutos: ese toque es nulo.',
  outside_game: 'La partida no está en curso.',
  no_draw: 'Todavía no se ha hecho el sorteo.',
  invalid_target: 'No puedes tocar a ese jugador.',
  rule_of_three: 'Regla de Tres: no puedes devolvérsela a quien te la pasó.',
  before_previous_touch: 'Ese toque sería anterior al que te hizo portador. Prueba con «Ahora».',
  already_resolved: 'Este toque ya está resuelto.',
  expired: 'El plazo ha terminado.',
  text_length: 'El texto debe tener entre 40 y 600 caracteres.',
  not_found: 'No se ha encontrado.',
  party_cannot_vote: 'Eres parte en este caso: no votas.',
  not_eligible: 'No puedes votar en este caso.',
  already_voted: 'Ya has votado en este caso.',
  invalid_choice: 'Voto no válido.',
  too_many_media: 'Como mucho, cuatro pruebas por toque.',
  already_drawn: 'El sorteo ya está hecho.',
  not_admin: 'Solo para quien administra la partida.',
  name_taken: 'Ya hay alguien con ese nombre. Añade tu apellido o un apodo.',
  invalid_name: 'Escribe un nombre de al menos dos letras.',
  email_mismatch: 'El nombre no coincide con la cuenta. Prueba otra vez.',
  checks_required: 'Marca las tres casillas.',
  already_requested: 'Ya has enviado tu solicitud.',
  not_finished: 'La partida aún no ha terminado.',
  place_required: 'Indica dónde ha sido el toque.',
  truce: 'Hay una tregua en ese sitio y a esa hora: el toque no vale.',
  bad_dates: 'Fechas no válidas: la tregua debe empezar dentro de al menos 2 horas, acabar después y dentro del juego.',
  not_enough_players: 'Hacen falta al menos dos jugadores admitidos.',
  not_test_mode: 'Solo en modo de prueba.',
  'User already registered': 'Ya hay alguien con ese nombre. Añade tu apellido o un apodo.',
  'Invalid login credentials': 'Nombre o contraseña incorrectos.'
};
const errMsg = e => {
  const m = (e && (e.message || e.error_description)) || String(e);
  for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
  if (/fetch|network|Failed/i.test(m)) return 'Sin conexión. Prueba otra vez.';
  return 'Algo ha fallado. Prueba otra vez.';
};
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}
// Misma normalización que name_key_of() en la base de datos.
function nameKey(name) {
  const t = name.toLowerCase();
  const from = 'áàäâãéèëêíìïîóòöôõúùüûñç', to = 'aaaaaeeeeiiiiooooouuuunc';
  let o = '';
  for (const ch of t) { const i = from.indexOf(ch); o += i >= 0 ? to[i] : ch; }
  return o.replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}
const emailOf = name => nameKey(name) + '@noviembrada.local';

async function signAll(list) {
  const items = list.filter(m => m && m.path && !m.url);
  if (!items.length) return;
  const { data } = await sb.storage.from('proofs').createSignedUrls(items.map(m => m.path), 3600);
  (data || []).forEach((d, i) => { if (d && d.signedUrl) items[i].url = d.signedUrl; });
}

/* ---------- estado ---------- */
const fresh = {
  tocar: () => ({ to: null, ago: 0, place: '', media: [], err: '', busy: false }),
  disputa: () => ({ text: '', media: [], err: '', busy: false }),
  sol: () => ({ name: '', pass: '', checks: [false, false, false], err: '', busy: false }),
  login: () => ({ name: '', pass: '', err: '', busy: false }),
  version: () => ({ text: '', err: '', busy: false }),
  reforma: () => ({ q: '', body: '', err: '', busy: false }),
  tregua: () => ({ place: '', start: '', end: '', note: '', err: '', busy: false })
};
const S = {
  me: null, view: 'cargando', reveal: false, targets: [], cases: [], detail: null, caseId: null, pick: null,
  final: null, players: [], clauseIdx: 1, replayKey: 0,
  tocar: fresh.tocar(), disputa: fresh.disputa(), sol: fresh.sol(), login: fresh.login(),
  version: fresh.version(), reforma: fresh.reforma(), tregua: fresh.tregua(), truces: [], mine: [], sheet: false, push: 'unknown'
};
const player = () => S.me && S.me.player;
const iHold = () => !!(S.me && S.me.holds);
const notice = () => S.me && S.me.notice;
const finished = () => !!(S.me && S.me.finished);
const showLast = () => !!(S.me && S.me.last_edition && !started() && S.final);
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/* ---------- utilidades de interfaz ---------- */
const app = document.getElementById('app');
let toastTimer, pushTimer, revealTimer;
function toast(msg) {
  clearTimeout(toastTimer);
  document.querySelectorAll('.toast').forEach(n => n.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; app.appendChild(t);
  toastTimer = setTimeout(() => t.remove(), 3400);
}
function pushNote() {
  clearTimeout(pushTimer);
  document.querySelectorAll('.push-note').forEach(n => n.remove());
  const b = document.createElement('button'); b.className = 'push-note'; b.dataset.act = 'open-aviso';
  b.innerHTML = '<span class="ic" aria-hidden="true">N</span><span><small>NOVIEMBRADA · ahora</small><b>Tienes un aviso.</b></span>';
  app.appendChild(b);
  pushTimer = setTimeout(() => b.remove(), 7000);
}
function go(view, extra) {
  clearTimeout(revealTimer);
  if (view !== 'estado') S.reveal = false;
  Object.assign(S, extra || {}); S.view = view; render();
  const m = app.querySelector('.main'); if (m) m.scrollTop = 0;
}
const S_tab_informe = () => (S.repFrom === 'jugadores' ? 'jugadores' : 'estado');
const tabOf = v => ({ estado: 'estado', aviso: 'estado', disputa: 'estado', tocar: 'estado', final: 'estado', informe: S_tab_informe(),  junta: 'junta', caso: 'junta', reforma: 'junta', propuesta: 'junta', tregua: 'junta', mias: 'jugadores', jugadores: 'jugadores', contrato: 'contrato', clausula: 'contrato' })[v];
const hoursLeft = c => Math.max(0, Math.ceil((ts(c.closes_at) - now()) / 36e5));

function header(opts) {
  opts = opts || {};
  const right = showLast() ? 'Hasta la próxima' : finished() || S.view === 'final' || S.view === 'informe' ? '1 dic · 00:00' : started() ? `Día ${dayN()} de 30` : 'Antes de empezar';
  const left = opts.back ? `<button class="back" data-act="${opts.back}">${I.left}${esc(opts.backLabel || 'Volver')}</button>`
    : opts.cancel ? `<button class="ghost" data-act="${opts.cancel}">Cancelar</button>`
    : '<span class="mark">NOVIEMBRADA</span>';
  const tools = S.me && S.me.test_mode || (player() && player().is_admin);
  return `<header class="top pad">${left}<div class="top-r"><span>${opts.hideDay || !START ? '' : right}</span>${tools ? '<button class="chip" data-act="admin" aria-haspopup="dialog">Admin</button>' : ''}</div></header>`;
}
function nav() {
  const t = tabOf(S.view), n = notice() ? '<span class="dot" aria-label="Aviso pendiente"></span>' : '', j = S.me && S.me.open_votes ? '<span class="dot" aria-label="Votación pendiente"></span>' : '';
  return `<nav class="nav" aria-label="Principal">
   <button data-act="tab" data-v="estado" ${t === 'estado' ? 'aria-current="page"' : ''}>${n}${I.clock}Estado</button>
   <button data-act="tab" data-v="junta" ${t === 'junta' ? 'aria-current="page"' : ''}>${j}${I.hall}Junta</button>
   <button data-act="tab" data-v="jugadores" ${t === 'jugadores' ? 'aria-current="page"' : ''}>${I.people}Jugadores</button>
   <button data-act="tab" data-v="contrato" ${t === 'contrato' ? 'aria-current="page"' : ''}>${I.doc}Contrato</button></nav>`;
}
function thumbs(media, removable, group) {
  if (!media || !media.length) return '';
  return `<div class="thumbs">${media.map((m, i) => {
    const inner = !m.url ? `<div class="ph" style="width:100%;height:100%">${m.kind === 'video' ? 'Vídeo' : 'Foto'}</div>`
      : m.kind === 'video' ? `<video src="${esc(m.url)}" muted playsinline preload="metadata" controls></video>` : `<img src="${esc(m.url)}" alt="Prueba ${i + 1}">`;
    return `<div class="thumb">${inner}${m.kind === 'video' && m.url && !removable ? '' : m.kind === 'video' ? '<span class="k">Vídeo</span>' : ''}${removable ? `<button class="x" type="button" data-act="rm-media" data-g="${group}" data-i="${i}" aria-label="Quitar prueba ${i + 1}">×</button>` : ''}</div>`;
  }).join('')}</div>`;
}
function mediaPicker(group, st, hint) {
  return `<label class="drop" for="file-${group}">${I.cam}Añadir foto o vídeo<input id="file-${group}" type="file" accept="image/*,video/*" multiple data-group="${group}"></label>
   ${thumbs(st.media, true, group)}${st.err ? `<p class="err" role="alert">${esc(st.err)}</p>` : ''}
   <p class="small sp-8">${hint}</p>`;
}

/* ---------- pantallas ---------- */
function vCargando() { return { html: '<div class="loading">NOVIEMBRADA</div>' }; }

function pushPrompt() {
  if (S.push === 'on') return '';
  if (!isStandalone()) return `<div class="card note sp-16" style="width:100%;text-align:left"><strong>No recibirás avisos.</strong> Para activarlos, abre este enlace en Safari, pulsa Compartir y «Añadir a pantalla de inicio», y ábrela desde el icono.</div>`;
  if (S.push === 'denied') return `<div class="card note sp-16" style="width:100%;text-align:left"><strong>Los avisos están bloqueados.</strong> Actívalos en Ajustes del iPhone, Notificaciones, Noviembrada.</div>`;
  if (S.push === 'unsupported') return `<div class="card note sp-16" style="width:100%;text-align:left">Este móvil no admite avisos. Necesitas iOS 16.4 o superior.</div>`;
  return `<button class="btn pulse sp-16" data-act="avisos">Activar avisos en este móvil</button>`;
}

function vEstado() {
  if (finished() || showLast()) return vFinal();
  const holding = iHold(), drawn = S.me.draw_done;
  if (S.reveal && holding) {
    const from = S.me.passed_from ? `<strong style="font-weight:600">Te la pasó ${esc(S.me.passed_from)}.</strong> Regla de Tres: no puedes devolvérsela hasta que el estatus haya pasado por un tercero.` : '<strong style="font-weight:600">Te tocó en el sorteo.</strong> Puedes pasársela a cualquiera.';
    return { seal: true, html: `${header()}<main class="main"><section class="screen center pad flood">
      <div class="eyebrow" style="color:var(--on-seal-muted)" data-live="eyebrow">${eyebrowTxt()}</div>
      <div class="count" data-live="count">${countdown()}</div>
      <button class="disc pop" data-act="hide" aria-label="Ocultar estado" style="animation-delay:.45s"><b>LA<br>LLEVAS</b><span class="small">desde hace ${ago(ts(S.me.hold_since))}</span></button>
      <div class="timer" style="--t:15s"><i></i></div>
      <div class="passed sp-20 rise" style="animation-delay:.8s">${from}</div>
      <div class="push" style="width:100%;padding-top:20px">
        <button class="btn paper" data-act="go-tocar">He tocado a alguien</button>
        <p class="small sp-12">Proclama «¡la llevas!» en voz alta al tocar. Tienes 30 minutos para registrarlo. Toca el círculo para ocultar.</p>
      </div></section></main>${nav()}` };
  }
  if (S.reveal) {
    return { html: `${header()}<main class="main"><section class="screen center pad fade">
      <div class="eyebrow" data-live="eyebrow">${eyebrowTxt()}</div>
      <div class="count" data-live="count">${countdown()}</div>
      <button class="disc pop" data-act="hide" aria-label="Ocultar estado">${I.eye}<b>NO LA<br>LLEVAS</b><span class="small">${drawn ? 'De momento.' : 'Aún no hay sorteo.'}</span></button>
      <div class="timer" style="--t:5s"><i></i></div>
      <p class="lead">Se oculta solo en 5 segundos.<br>Toca el círculo para ocultarlo ya.</p>
      <div class="card note push" style="width:100%;text-align:left">Que no la lleves hoy no quiere decir nada. Si te preguntan, tú también respondes <em>«no te lo digo»</em>: si dices «no», delatas a quien la lleva.</div></section></main>${nav()}` };
  }
  return { html: `${header()}<main class="main"><section class="screen center pad fade">
    <div class="eyebrow" data-live="eyebrow">${eyebrowTxt()}</div>
    <div class="count" data-live="count">${countdown()}</div>
    <button class="dial" id="dial" aria-label="Mantén pulsado para ver tu estado">
      <svg class="ring" viewBox="0 0 244 244" aria-hidden="true"><circle cx="122" cy="122" r="118" fill="none" stroke="var(--seal)" stroke-width="4" stroke-linecap="round" transform="rotate(-90 122 122)"/></svg>
      <span class="face">${I.lock}<b>Mantén pulsado</b><span>para ver tu estado</span></span>
    </button>
    <p class="lead">Solo lo ves tú.<br>Nadie más sabe quién la lleva.</p>
    <p class="small sp-8">${drawn ? 'Sorteo hecho.' : 'Sorteo pendiente.'}</p>
    ${notice() ? `<button class="btn pulse sp-16" data-act="open-aviso">Tienes un aviso pendiente</button>` : ''}
    <div class="card note push" style="width:100%;text-align:left;${notice() ? 'margin-top:16px' : ''}">Si te preguntan «¿la llevas?», todos responden lo mismo: <em>«no te lo digo»</em>. Si los demás dicen «no», quien calla queda delatado.</div>
    ${pushPrompt()}</section></main>${nav()}` };
}

function trucesCard() {
  if (!S.truces.length) return '';
  const f = t => `${fmtDay(ts(t))} ${fmtTime(ts(t))}`;
  return `<div class="card note sp-16" style="width:100%;text-align:left"><strong>Treguas aprobadas</strong><br>${S.truces.map(t => `${esc(t.place)}: ${f(t.start)} a ${f(t.end)}`).join('<br>')}<br><span class="small">En ese sitio y esas horas no vale pillar.</span></div>`;
}
function vTocar() {
  const t = S.tocar;
  const rows = S.targets.map(p => `<label class="opt"><input type="radio" name="to" value="${esc(p.id)}" ${t.to === p.id ? 'checked' : ''} ${p.blocked ? 'disabled' : ''}><span class="av" aria-hidden="true">${esc(p.name[0])}</span><span style="flex:1">${esc(p.name)}</span>${p.blocked ? '<span class="pill">Regla de Tres</span>' : ''}</label>`).join('');
  const agoBtns = [0, 10, 20, 30].map(m => `<button type="button" data-act="ago" data-m="${m}" aria-pressed="${t.ago === m}">${m ? ('Hace ' + m) : 'Ahora'}</button>`).join('');
  const who = (S.targets.find(p => p.id === t.to) || {}).name;
  return { html: `${header({ cancel: 'cancel-tocar', hideDay: true })}<main class="main"><form class="screen pad fade" id="f-tocar" novalidate>
    <h1>¿A quién has tocado?</h1>
    <fieldset class="stack sp-16" style="border:0;margin:0;padding:0"><legend class="label" style="margin-bottom:8px">Jugador</legend>${rows}</fieldset>
    <div class="sp-20"><div class="label">¿Cuándo ha sido?</div><div class="seg">${agoBtns}</div><p class="small sp-8">Minutos. Pasados 30, el toque es nulo.</p></div>
    ${trucesCard()}
    <div class="sp-16"><label class="label" for="lugar">¿Dónde ha sido?</label><input class="field" id="lugar" name="lugar" autocomplete="off" placeholder="Por ejemplo, Plaça Catalunya" value="${esc(t.place)}"><p class="small sp-8">Obligatorio. Solo lo veréis tú y el tocado (y la Junta si hay disputa). No sale en el informe.</p></div>
    <div class="sp-16"><div class="label">Pruebas (opcional)</div>${mediaPicker('tocar', t, `Quedan en el registro. Las verá ${who ? esc(who) : 'el tocado'} y, si hay disputa, la Junta. Al final del mes se publican para todos.`)}</div>
    ${t.err && !t.media.length ? `<p class="err" role="alert">${esc(t.err)}</p>` : ''}
    <div class="push" style="padding-top:22px"><button class="btn ${t.busy ? 'spin' : ''}" type="submit" data-live="tsend" ${t.to && t.place.trim().length >= 2 && !t.busy ? '' : 'disabled'}>${t.busy ? 'Registrando…' : 'Registrar toque'}</button>
    <p class="small sp-12" style="text-align:center">${t.to ? `Solo se avisará a ${esc(who || 'el tocado')}. El toque cuenta ya; ${esc(who || 'el tocado')} puede disputarlo durante 24 h.` : 'Elige a quién has tocado.'}</p></div>
  </form></main>` };
}

function vAviso() {
  const e = notice();
  if (!e) return vEstado();
  const deadline = ts(e.registered_at) + 864e5, rest = left(deadline - now()), pct = Math.max(0, Math.min(100, (deadline - now()) / 864e5 * 100));
  return { html: `${header()}<main class="main"><section class="screen pad fade">
    <span class="pill solid drop-in" style="align-self:flex-start">Aviso</span>
    <h1 class="sp-12" style="font-size:32px;line-height:1.12">${esc(e.from)} te ha pillado.</h1>
    <p class="lede">Ya la llevas. Si no estás de acuerdo, puedes disputarlo.</p>
    <dl class="card dl"><div><dt>Cuándo</dt><dd>${when(ts(e.touched_at))}</dd></div><div><dt>Dónde</dt><dd>${esc(e.place || 'Sin indicar')}</dd></div><div><dt>Registrado</dt><dd>${fmtTime(ts(e.registered_at))} · a ${Math.round((ts(e.registered_at) - ts(e.touched_at)) / 6e4)} min del toque</dd></div></dl>
    ${e.media.length ? `<div class="sp-16"><div class="label">Pruebas de ${esc(e.from)}</div>${thumbs(e.media, false)}</div>` : ''}
    <div class="sp-20"><div class="row"><span style="color:var(--muted)">Tiempo para disputar</span><strong style="font-variant-numeric:tabular-nums">${rest.h + rest.d * 24} h ${pad2(rest.m)} min</strong></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="small sp-8" style="font-size:13px">Pasado ese plazo, el toque queda firme.</p></div>
    <div class="stack push" style="gap:10px;padding-top:20px"><button class="btn line" data-act="go-disputa">Disputar</button><button class="btn" data-act="tab-estado">Entendido</button></div>
    <p class="small sp-12">Para disputar tendrás que escribir qué pasó. Tu versión llega a la Junta de Sabios y se sabrá que hubo un toque entre ${esc(e.from)} y tú. Nada más.</p>
  </section></main>${nav()}` };
}

function vDisputa() {
  const e = notice(), d = S.disputa, n = d.text.trim().length;
  if (!e) return vEstado();
  return { html: `${header({ cancel: 'cancel-disputa', hideDay: true })}<main class="main"><form class="screen pad fade" id="f-disputa" novalidate>
    <h1>Cuenta qué pasó.</h1>
    <p class="lede">Disputas el toque de ${esc(e.from)}${e.place ? ' en ' + esc(e.place) : ''}, ${when(ts(e.touched_at)).toLowerCase()}. La Junta lo juzgará con tu versión y la suya.</p>
    <div class="sp-20"><label class="label" for="relato">Tu versión</label>
      <textarea class="field" id="relato" maxlength="600" placeholder="Qué pasó, dónde, qué contacto hubo y con qué fuerza.">${esc(d.text)}</textarea>
      <div class="row small sp-8"><span>Mínimo 40 caracteres</span><span data-live="chars" style="font-variant-numeric:tabular-nums">${n} / 600</span></div></div>
    <div class="sp-16"><div class="label">Tus pruebas (opcional)</div>${mediaPicker('disputa', d, 'Las verá la Junta. Al final del mes se publican con el registro.')}</div>
    <div class="card note sp-16">Cuenta hechos. No digas quién la llevaba antes ni después: eso delata a otros. Mentir aquí es mentir a la Junta.</div>
    <div class="push" style="padding-top:20px"><button class="btn ${d.busy ? 'spin' : ''}" type="submit" data-live="send" ${n >= 40 && !d.busy ? '' : 'disabled'}>${d.busy ? 'Enviando…' : 'Enviar a la Junta'}</button>
    <p class="small sp-12" style="text-align:center">Una vez enviado no se puede editar. ${esc(e.from)} escribirá también su versión.</p></div>
  </form></main>` };
}

const voteKey = c => `nov-vote:${c.id}:${c.round || 1}`;
const myVote = c => { try { return JSON.parse(localStorage.getItem(voteKey(c)) || 'null'); } catch (_) { return null; } };
const saveVote = (c, t, choice) => { try { localStorage.setItem(voteKey(c), JSON.stringify({ t, c: choice })); } catch (_) { } };
const newToken = () => { try { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, x => x.toString(16).padStart(2, '0')).join(''); } catch (_) { return String(Math.random()).slice(2) + String(Date.now()) + String(Math.random()).slice(2); } };
const KIND_TEXT = { dispute: 'Disputa de un toque.', admission: 'Solicitud para entrar.', reform: 'Propuesta de reforma.', truce: 'Propuesta de tregua.' };
function vJunta() {
  const cards = S.cases.map(c => {
    const status = c.status === 'closed' ? '<span class="pill muted">Cerrado</span>' : `<span class="pill muted">Cierra en ${hoursLeft(c)} h</span>`;
    const mine = c.party ? '<span class="pill">Eres parte</span>' : c.voted ? '<span class="pill">Has votado</span>' : c.status === 'open' ? '<span class="pill solid">Vota</span>' : '';
    return `<button class="case" data-act="open-case" data-id="${c.id}"><div class="meta"><span class="pill dark">Caso ${c.id}</span>${status}${mine}</div><h2>${esc(c.question)}</h2><p>${c.verdict ? esc(c.verdict) : esc(KIND_TEXT[c.kind] || '')}</p></button>`;
  }).join('');
  return { html: `${header()}<main class="main"><section class="screen pad fade">
    <h1>Junta de Sabios</h1>
    <p class="lede">La forman todos los jugadores. Voto anónimo y mayoría simple. Quien es parte en un caso no vota.</p>
    <div class="stack sp-20" style="gap:10px">${cards || '<div class="card note">No hay casos abiertos.</div>'}</div>
    ${S.truces.length ? `<div class="card note sp-16" style="width:100%;text-align:left"><strong>Treguas aprobadas</strong><br>${S.truces.map(t => `${esc(t.place)}: ${fmtDay(ts(t.start))} ${fmtTime(ts(t.start))} a ${fmtDay(ts(t.end))} ${fmtTime(ts(t.end))}`).join('<br>')}</div>` : ''}
    <div class="push" style="padding-top:18px"><button class="btn line" data-act="go-propuesta">Propuesta</button></div>
  </section></main>${nav()}` };
}

function vPropuesta() {
  return { html: `${header({ cancel: 'tab-junta', hideDay: true })}<main class="main"><section class="screen pad fade">
    <h1>¿Qué propones?</h1>
    <p class="lede">La Junta lo votará de forma anónima.</p>
    <div class="stack sp-20" style="gap:10px">
      <button class="case" data-act="go-reforma"><h2>Una reforma</h2><p>Cambiar o aclarar una regla. Se aprueba por mayoría simple.</p></button>
      <button class="case" data-act="go-tregua"><h2>Una tregua</h2><p>Un sitio y unas horas en los que no vale pillar. Un solo voto en contra la anula.</p></button>
    </div></section></main>${nav()}` };
}

function vTregua() {
  const r = S.tregua;
  return { html: `${header({ cancel: 'tab-junta', hideDay: true })}<main class="main"><form class="screen pad fade" id="f-tregua" novalidate>
    <h1>Proponer una tregua.</h1>
    <p class="lede">Votan todos menos tú. Un solo voto en contra la anula. En ese sitio y esas horas no valdrá pillar a nadie.</p>
    <div class="sp-20"><label class="label" for="t-place">Sitio</label><input class="field" id="t-place" maxlength="120" placeholder="Cantina de la ETSEIB" value="${esc(r.place)}"></div>
    <div class="sp-16"><label class="label" for="t-start">Desde</label><input class="field" id="t-start" type="datetime-local" value="${esc(r.start)}"></div>
    <div class="sp-16"><label class="label" for="t-end">Hasta</label><input class="field" id="t-end" type="datetime-local" value="${esc(r.end)}"></div>
    <div class="sp-16"><label class="label" for="t-note">Motivo (opcional)</label><textarea class="field" id="t-note" maxlength="300" placeholder="Cena de grupo, examen, boda…">${esc(r.note)}</textarea></div>
    <p class="small sp-8">Tiene que empezar dentro de al menos 2 horas. La votación dura como mucho 12 h y se cierra 1 h antes de que empiece.</p>
    ${r.err ? `<p class="err" role="alert">${esc(r.err)}</p>` : ''}
    <div class="push" style="padding-top:20px"><button class="btn ${r.busy ? 'spin' : ''}" type="submit" ${r.busy ? 'disabled' : ''}>Enviar a la Junta</button></div>
  </form></main>` };
}

function vReforma() {
  const r = S.reforma;
  return { html: `${header({ cancel: 'tab-junta', hideDay: true })}<main class="main"><form class="screen pad fade" id="f-reforma" novalidate>
    <h1>Proponer una reforma.</h1>
    <p class="lede">La Junta la votará por mayoría simple. Si se aprueba, queda anotada como veredicto.</p>
    <div class="sp-20"><label class="label" for="r-q">La pregunta</label><input class="field" id="r-q" maxlength="200" placeholder="¿Las pruebas en vídeo deben centrarse en el tocado?" value="${esc(r.q)}"></div>
    <div class="sp-16"><label class="label" for="r-b">Qué cambiaría</label><textarea class="field" id="r-b" maxlength="1000" placeholder="Qué cláusula tocarías y cómo quedaría.">${esc(r.body)}</textarea></div>
    ${r.err ? `<p class="err" role="alert">${esc(r.err)}</p>` : ''}
    <div class="push" style="padding-top:20px"><button class="btn ${r.busy ? 'spin' : ''}" type="submit" ${r.busy ? 'disabled' : ''}>Enviar a la Junta</button></div>
  </form></main>` };
}

function vCaso() {
  const c = S.detail; if (!c) return vJunta();
  const party = c.party, mv = myVote(c), canVote = !party && c.status === 'open' && (!c.i_voted || !!mv);
  const opts = (c.kind === 'dispute'
    ? [{ id: 'valido', t: 'Toque válido', d: 'Se mantiene.' }, { id: 'nulo', t: 'Toque nulo', d: 'El estatus vuelve a quien tocó.' }, { id: 'abs', t: 'Abstenerme', d: '' }]
    : c.kind === 'admission'
      ? [{ id: 'si', t: 'Admitir', d: 'Entra en la Junta y en el juego.' }, { id: 'no', t: 'Rechazar', d: 'Se queda fuera de esta edición.' }, { id: 'abs', t: 'Abstenerme', d: '' }]
      : [{ id: 'si', t: 'A favor', d: '' }, { id: 'no', t: 'En contra', d: '' }, { id: 'abs', t: 'Abstenerme', d: '' }]
  ).map(o => `<label class="opt ${o.d ? 'top-align' : ''}"><input type="radio" name="voto" value="${o.id}" ${S.pick === o.id ? 'checked' : ''} ${canVote ? '' : 'disabled'}><span><span style="display:block;font-weight:600">${esc(o.t)}</span>${o.d ? `<span class="small" style="display:block;margin-top:2px;font-size:13px">${esc(o.d)}</span>` : ''}</span></label>`).join('');
  const me = player().name;
  const versions = c.kind === 'dispute' ? c.versions.map(v => {
    if (v.text) return `<div class="card version"><div class="label">Versión de ${esc(v.who)}</div><p>${esc(v.text)}</p>${thumbs(v.media)}</div>`;
    if (v.who === me && c.status === 'open') {
      const n = S.version.text.trim().length;
      return `<form class="card version" id="f-version" novalidate><div class="label">Tu versión</div>
        <textarea class="field" id="v-text" maxlength="600" placeholder="Qué pasó, dónde, qué contacto hubo.">${esc(S.version.text)}</textarea>
        <div class="row small sp-8"><span>Mínimo 40 caracteres</span><span data-live="vchars">${n} / 600</span></div>
        ${S.version.err ? `<p class="err" role="alert">${esc(S.version.err)}</p>` : ''}
        <button class="btn sp-12 small-btn" type="submit" data-live="vsend" ${n >= 40 && !S.version.busy ? '' : 'disabled'}>Enviar mi versión</button></form>`;
    }
    return `<div class="card version"><div class="label">Versión de ${esc(v.who)}</div><p class="small" style="font-size:13.5px">Aún no la ha escrito. Tiene 24 h.</p></div>`;
  }).join('') : `<div class="card note">${esc(c.body)}</div>`;
  const pct = c.voters ? Math.round(c.voted / c.voters * 100) : 0;
  return { html: `${header({ back: 'tab-junta', backLabel: 'Junta', hideDay: true })}<main class="main"><section class="screen pad fade">
    <div class="case meta" style="display:flex;gap:8px;align-items:center;border:0;background:none;padding:0"><span class="pill dark">Caso ${c.id}</span><span class="small" style="font-weight:600">${c.status === 'closed' ? 'Cerrado' : 'Cierra en ' + hoursLeft(c) + ' h'}</span></div>
    <h1 class="sp-12" style="font-size:28px">${esc(c.question)}</h1>
    ${c.parties.length ? `<div class="life" style="color:var(--gold);font-weight:600">${I.info}${esc(c.parties.join(' y '))} no votan en este caso.</div>` : ''}
    ${c.touch_place ? `<div class="card note sp-16" style="width:100%;text-align:left">Lugar del toque: <strong>${esc(c.touch_place)}</strong></div>` : ''}
    <div class="stack sp-16">${versions}</div>
    ${c.verdict ? `<div class="verdict sp-16"><div class="eyebrow">Veredicto</div><p>${esc(c.verdict)}</p></div>` : ''}
    <fieldset class="stack sp-16" style="border:0;margin:0;padding:0"><legend class="label" style="margin-bottom:8px">${party ? 'Eres parte: no votas' : 'Tu voto'}</legend>${opts}</fieldset>
    <div class="sp-16"><div class="row"><span style="color:var(--muted)">Han votado</span><strong style="font-variant-numeric:tabular-nums">${c.voted} de ${c.voters}</strong></div><div class="bar ink"><i style="width:${pct}%"></i></div>
      <p class="small sp-8">${c.round > 1 ? 'Segunda votación por empate. ' : ''}${c.kind === 'truce' ? 'Basta un voto en contra para anular la tregua.' : 'Gana la mayoría simple de los votos emitidos. Si hay empate, se repite una vez.'}</p></div>
    <div class="push" style="padding-top:20px">
      <div class="life" style="margin:0 0 10px">${I.smallLock}Tu voto es anónimo: se guarda sin tu nombre.</div>
      ${c.i_voted && !mv && c.status === 'open' ? '<p class="small" style="margin-bottom:10px">Ya has votado. Solo puedes cambiar el voto desde el móvil con el que votaste.</p>' : ''}
      ${canVote ? `<button class="btn" data-act="vote" ${S.pick && !(mv && mv.c === S.pick) ? '' : 'disabled'}>${c.i_voted ? 'Cambiar voto' : 'Emitir voto'}</button>${c.i_voted ? '<p class="small sp-8">Puedes cambiarlo hasta que se cierre la votación.</p>' : ''}` : `<button class="btn" disabled>${party ? 'No votas en tu propio caso' : c.status === 'closed' ? 'Votación cerrada' : 'Voto emitido'}</button>`}
    </div></section></main>${nav()}` };
}

const hms = secs => { const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60); return d ? `${d} d ${h} h ${pad2(m)} min` : h ? `${h} h ${pad2(m)} min` : `${m} min`; };
async function loadPlayers() {
  S.players = await rpc('list_players');
  try { S.ranking = await rpc('ranking'); S.editions = await rpc('list_editions'); } catch (_) { S.ranking = S.ranking || []; S.editions = S.editions || []; }
}
const avgTxt = secs => secs ? hms(secs) : '—';
function vMias() {
  const label = { confirmed: 'Confirmado', pending: 'Pendiente', disputed: 'En disputa', void: 'Anulado' };
  const items = (S.mine || []).map(e => `<div class="card entry"><div class="head"><b>${e.role === 'from' ? 'Pillaste a ' : ''}${esc(e.other)}${e.role === 'to' ? ' te pilló' : ''}</b><span class="pill ${e.status === 'void' ? '' : 'muted'}">${label[e.status] || ''}</span></div>
    <p>${fmtDay(ts(e.touched_at))} · ${fmtTime(ts(e.touched_at))} · <strong>${esc(e.place || 'Sin lugar')}</strong>${e.verdict ? '<br>' + esc(e.verdict) : ''}</p>${thumbs(e.media)}</div>`).join('');
  return { html: `${header({ back: 'tab-jugadores', backLabel: 'Jugadores', hideDay: true })}<main class="main"><section class="screen pad fade">
    <h1>Mis pilladas</h1>
    <p class="lede">Solo las ves tú y la otra persona de cada pillada. El lugar no se publica.</p>
    <div class="stack sp-20" style="gap:10px">${items || '<div class="card note">Aún no has pillado ni te han pillado.</div>'}</div>
  </section></main>${nav()}` };
}

function vJugadores() {
  const rows = S.players.map(p => `<li><span class="av" aria-hidden="true">${esc(p.name[0])}</span><span class="nm">${esc(p.name)}</span>${p.me ? '<span class="pill">Tú</span>' : ''}</li>`).join('');
  const rk = S.ranking || [], eds = S.editions || [];
  const rkRows = rk.map(p => `<li><span class="pos">${p.pos}</span><span class="nm">${esc(p.name)}${p.me ? ' <span class="pill">Tú</span>' : ''}${p.left ? ' <span class="small">· ya no juega</span>' : ''}<span class="sub">${p.editions} ${p.editions === 1 ? 'edición' : 'ediciones'} · total ${avgTxt(p.total)}</span></span><span class="tm">${avgTxt(p.avg)}</span></li>`).join('');
  const hist = eds.map(e => `<li><button class="histbtn" data-act="open-hist" data-e="${e.edition}"><span class="t"><b>Edición ${e.edition} · ${e.year}</b><span>Perdedor: ${esc(e.loser)} · ${e.players} jugadores · ${e.touches} pillados</span></span>${I.right}</button></li>`).join('');
  return { html: `${header()}<main class="main"><section class="screen pad fade">
    <h1>Jugadores</h1>
    <p class="lede">${S.players.length} ${S.players.length === 1 ? 'jugador' : 'jugadores'} en esta edición. Quién la lleva solo lo sabe quien la lleva.</p>
    <ol class="card plist">${rows || '<li>Aún no hay jugadores.</li>'}</ol>
    <ul class="card hist sp-16"><li><button class="histbtn" data-act="go-mias"><span class="t"><b>Mis pilladas</b><span>Las que he hecho y las que me han hecho, con el lugar. Privado.</span></span>${I.right}</button></li></ul>
    <h2 class="sp-24" style="font-size:22px;margin-bottom:0">Ranking</h2>
    ${rk.length ? `<p class="lede">Acumulado de todas las ediciones cerradas: tiempo medio que cada jugador la ha llevado por edición. Cuanto menos, mejor.</p><ol class="card plist rank">${rkRows}</ol>`
      : `<p class="lede">Aparecerá cuando se cierre la primera edición. Suma el tiempo que cada jugador la ha llevado en todas las ediciones y ordena por la media: cuanto menos, mejor. Durante la edición en curso no se enseña, para que no se pueda deducir quién la lleva.</p>`}
    <h2 class="sp-24" style="font-size:22px;margin-bottom:0">Historial</h2>
    ${eds.length ? `<p class="lede">Una ficha por edición, con su informe completo.</p><ul class="card hist">${hist}</ul>` : `<p class="lede">Aún no hay ediciones cerradas. Al terminar cada una, su informe queda aquí.</p>`}
  </section></main>${nav()}` };
}

function vContrato() {
  const items = CONTRACT.map((c, i) => `<li><button data-act="open-clause" data-i="${i}"><span class="n ${c.k.length > 1 || c.k === 'I' ? 's' : ''}">${c.k}</span><span class="t"><b>${esc(c.title)}</b><span>${esc(c.short)}</span></span>${I.right}</button></li>`).join('');
  const p = player();
  const admitted = p && p.status === 'admitted';
  const signed = admitted ? `<div class="life" style="margin:0">${I.check}Contrato firmado en papel · ${esc(p.name)}, aceptado por la Junta</div>` : `<button class="btn" data-act="go-solicitud">Solicitar unirme</button>`;
  return { html: `${header()}<main class="main"><section class="screen pad fade">
    <h1>El contrato</h1>
    <p class="lede">Ocho cláusulas, en vigor desde el 1 de noviembre. Léelas enteras: nadie podrá decir que no lo sabía.</p>
    <ol class="card index">${items}</ol>
    <div class="push" style="padding-top:16px">${p ? signed : ''}
      ${p ? `<div style="display:flex;justify-content:space-between;margin-top:6px"><button class="ghost" data-act="logout">Cerrar sesión</button>${admitted && !finished() ? '<button class="linkdanger" data-act="ask-leave">Salir del juego</button>' : ''}</div>` : ''}</div>
  </section></main>${p ? nav() : ''}` };
}

function vClausula() {
  const i = S.clauseIdx, c = CONTRACT[i];
  const name = c.k === 'I' ? 'Sección I' : c.k === 'III' ? 'Sección III' : 'Cláusula ' + c.k;
  const body = c.body.map(b => b[0] === 'p' ? `<p>${b[1]}</p>` : `<ul>${b[1].map(x => `<li>${x}</li>`).join('')}</ul>`).join('');
  return { html: `${header({ back: 'tab-contrato', backLabel: 'Contrato', hideDay: true })}<main class="main"><article class="screen pad fade">
    <div class="eyebrow gold">${name}</div>
    <h1 class="sp-8" style="font-size:28px">${esc(c.title)}</h1>
    <div class="card note sp-16" style="font-size:13.5px;color:var(--ink)"><span style="font-weight:600;color:var(--seal)">En una línea:</span> ${esc(c.line)}</div>
    <div class="legal">${body}</div>
    <div class="pager push"><button data-act="clause" data-d="-1" ${i === 0 ? 'disabled' : ''}>Anterior</button><button data-act="clause" data-d="1" ${i === CONTRACT.length - 1 ? 'disabled' : ''}>Siguiente</button></div>
  </article></main>${player() ? nav() : ''}` };
}

function vInstalar() {
  const step = (n, t, d) => `<li class="card" style="display:flex;gap:14px;padding:14px"><span style="flex:none;width:32px;height:32px;border-radius:50%;background:var(--seal);color:var(--on-seal);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px">${n}</span><div><div style="font-weight:600;line-height:1.3">${t}</div><div class="small" style="margin-top:3px;font-size:13px">${d}</div></div></li>`;
  return { html: `${header({ hideDay: true })}<main class="main"><section class="screen pad fade">
    <h1>Instala la app y activa los avisos.</h1>
    <p class="lede">Sin avisos no te enteras de que te han tocado. Son tres pasos y menos de un minuto.</p>
    <ol class="stack sp-20" style="list-style:none;margin-bottom:0;padding:0;gap:10px">
      ${step(1, 'Ábrela en Safari', 'No desde el navegador interno de WhatsApp: ahí no deja instalar.')}
      ${step(2, 'Compartir, y «Añadir a pantalla de inicio»', 'Es el cuadrado con la flecha hacia arriba.')}
      ${step(3, 'Ábrela desde el icono y activa los avisos', 'El permiso solo se pide desde la app instalada, nunca desde la pestaña.')}
    </ol>
    <button class="btn line sp-20" data-act="skip-install">Continuar sin instalar</button>
    <div class="sp-24"><div class="eyebrow">Así llegará un aviso</div>
      <div class="sp-8" style="display:flex;gap:12px;align-items:center;padding:12px 14px;background:var(--night);color:var(--paper);border-radius:16px"><span style="flex:none;width:36px;height:36px;border-radius:9px;background:var(--seal);display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-weight:700;font-size:18px;color:var(--on-seal)">N</span><div><div style="font-size:12px;color:var(--night-muted)">NOVIEMBRADA · ahora</div><div style="font-weight:500">Tienes un aviso.</div></div></div>
      <p class="small sp-8">Nunca dice qué pasa: ni quién la lleva ni a quién han tocado. Una pantalla bloqueada no debe delatar a nadie.</p></div>
  </section></main>` };
}

function vEntrar() {
  const l = S.login;
  return { html: `${header({ hideDay: true })}<main class="main"><form class="screen pad fade" id="f-entrar" novalidate>
    <h1>Entra en la partida.</h1>
    <p class="lede">Tu nombre y tu contraseña. Solo se pide una vez: el móvil recuerda la sesión.</p>
    <div class="sp-20"><label class="label" for="l-name">Nombre</label><input class="field" id="l-name" autocomplete="username" autocapitalize="words" value="${esc(l.name)}"></div>
    <div class="sp-16"><label class="label" for="l-pass">Contraseña</label><input class="field" id="l-pass" type="password" autocomplete="current-password" value="${esc(l.pass)}"></div>
    ${l.err ? `<p class="err" role="alert">${esc(l.err)}</p>` : ''}
    <button class="btn sp-20 ${l.busy ? 'spin' : ''}" type="submit" ${l.busy ? 'disabled' : ''}>Entrar</button>
    <p class="small sp-12">¿Has olvidado la contraseña? Pídesela a quien administra la partida: te pondrá una nueva.</p>
    <div class="sp-24" style="text-align:center"><p class="small">¿Aún no juegas?</p><button type="button" class="btn line sp-8" data-act="go-solicitud">Solicitar unirme</button></div>
  </form></main>` };
}

function vSolicitud() {
  const f = S.sol, hasSession = !!S.session;
  const texts = ['He firmado el contrato en papel.', 'He leído las ocho cláusulas y acepto el Código de Honor.', 'Acepto que las fotos y vídeos que se suban se publiquen en el registro final, a la vista de todos los jugadores.'];
  const ready = f.checks.every(Boolean) && f.name.trim().length >= 2 && (hasSession || f.pass.length >= 6);
  return { html: `${header({ back: hasSession ? undefined : 'go-entrar', backLabel: 'Entrar', hideDay: true })}<main class="main"><form class="screen pad fade" id="f-sol" novalidate>
    <h1>Solicita unirte.</h1>
    <p class="lede">Los tres primeros en registrarse son fundadores. Del cuarto en adelante, la Junta de Sabios vota si entras. Hasta que te acepten no ves el estado, no tocas ni te pueden tocar.</p>
    <div class="sp-20"><label class="label" for="s-name">Nombre</label><input class="field" id="s-name" autocomplete="username" autocapitalize="words" placeholder="Como te conoce el grupo" value="${esc(f.name)}"></div>
    ${hasSession ? '' : `<div class="sp-16"><label class="label" for="s-pass">Contraseña</label><input class="field" id="s-pass" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" value="${esc(f.pass)}"></div>`}
    <div class="stack sp-20">${texts.map((t, i) => `<label class="card check"><input type="checkbox" data-act="chk" data-i="${i}" ${f.checks[i] ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
    ${f.err ? `<p class="err" role="alert">${esc(f.err)}</p>` : ''}
    <div class="push" style="padding-top:22px"><button class="btn ${f.busy ? 'spin' : ''}" type="submit" data-live="solbtn" ${ready && !f.busy ? '' : 'disabled'}>Solicitar unirme</button>
    <p class="small sp-12" style="text-align:center" data-live="solhint">${ready ? 'Tu solicitud llegará a la Junta en cuanto la envíes.' : `Escribe ${hasSession ? 'tu nombre' : 'nombre y contraseña'}, y marca las tres casillas.`}</p></div>
  </form></main>` };
}

function vEspera() {
  const p = player() || {};
  if (p.status === 'rejected') return { html: `${header({ hideDay: true })}<main class="main"><section class="screen center pad fade">
    <div class="disc pop" style="border-color:var(--seal);color:var(--seal)"><b>FUERA</b><span class="small">de esta edición</span></div>
    <h1 class="sp-24" style="font-size:26px">La Junta no te ha aceptado.</h1>
    <p class="lede">Votaron todos los jugadores, de forma anónima. Sus fallos son inapelables.</p>
    <div class="push" style="width:100%;padding-top:20px"><button class="btn line" data-act="go-contrato-free">Leer el contrato</button><button class="ghost sp-8" style="width:100%" data-act="logout">Cerrar sesión</button></div>
  </section></main>` };
  if (p.status === 'left') return { html: `${header({ hideDay: true })}<main class="main"><section class="screen center pad fade">
    <div class="disc pop" style="border-color:var(--ink)"><b>FUERA</b><span class="small">has salido del juego</span></div>
    <h1 class="sp-24" style="font-size:26px">Ya no juegas.</h1>
    <p class="lede">Recuerda la multa de la Cláusula 7 para cada jugador restante.</p>
    <div class="push" style="width:100%;padding-top:20px"><button class="btn line" data-act="go-contrato-free">Leer el contrato</button><button class="ghost sp-8" style="width:100%" data-act="logout">Cerrar sesión</button></div>
  </section></main>` };
  const next = p.status === 'admitted';
  return { html: `${header({ hideDay: true })}<main class="main"><section class="screen center pad fade">
    <div class="eyebrow gold">${next ? 'Aceptado' : 'Solicitud enviada'}</div>
    <div class="dial" style="margin-top:20px;cursor:default;touch-action:auto" aria-hidden="true"><span class="face"><svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9s8 4 8 9"/></svg><b>${next ? 'Edición siguiente' : 'A la espera'}</b><span>${next ? 'esta ya ha terminado' : 'de la Junta de Sabios'}</span></span></div>
    <h1 class="sp-24" style="font-size:26px">${esc(p.name || '')}, ${next ? 'entras en la próxima edición.' : 'la Junta está votando.'}</h1>
    <p class="lede">${next ? 'La Junta te ha aceptado después del cierre.' : 'Votan todos los jugadores aceptados, de forma anónima. Te avisaremos con el resultado.'}</p>
    <div class="card note sp-20" style="width:100%;text-align:left">Mientras tanto no ves el estado, no tocas ni te pueden tocar, y no votas en la Junta.</div>
    <div class="push" style="width:100%;padding-top:20px"><button class="btn line" data-act="go-contrato-free">Leer el contrato</button><button class="ghost sp-8" style="width:100%" data-act="logout">Cerrar sesión</button></div>
  </section></main>` };
}

function vFinal() {
  const f = S.final;
  if (!f) return { html: `${header()}<main class="main"><section class="screen center pad"><div class="loading">…</div></section></main>${nav()}` };
  const chain = f.chain.filter(e => e.counts), loser = f.loser;
  const rows = chain.map((e, i) => `<li class="rise" style="animation-delay:${3.6 + i * .22}s"><span class="when">${fmtDay(ts(e.touched_at))} · ${fmtTime(ts(e.touched_at))}</span><span class="who">${e.from ? esc(e.from) : 'Sorteo'} <span class="arrow">→</span> <strong style="font-weight:600">${esc(e.to)}</strong></span>${e.media.length ? `<span class="tag">${e.media.some(m => m.kind === 'video') ? 'Vídeo' : 'Foto'}</span>` : ''}</li>`).join('');
  const base = 3.6 + chain.length * .22;
  return { html: `${header()}<main class="main"><section class="screen pad" data-key="${S.replayKey}">
    <div style="text-align:center">
      <div class="eyebrow gold">${f.provisional ? 'El perdedor, de momento, es' : `El perdedor de la edición ${f.edition} es`}</div>
      <div class="loser-ring ring-in"><span class="cd" aria-hidden="true" style="animation-delay:.2s">3</span><span class="cd" aria-hidden="true" style="animation-delay:1s">2</span><span class="cd" aria-hidden="true" style="animation-delay:1.8s">1</span><span class="loser">${esc(loser)}</span></div>
      <p class="rise small sp-12" style="font-size:14px;animation-delay:3.1s">Tenía «La llevas» a las 23:59:59 del 30 de noviembre.${f.provisional ? ' Hay disputas abiertas hasta el 7 de diciembre: el resultado puede cambiar.' : ''}</p>
    </div>
    ${showLast() ? `<div class="sp-20 rise" style="text-align:center;animation-delay:3.2s"><div class="eyebrow" data-live="eyebrow">${eyebrowTxt()}</div><div class="count" data-live="count">${countdown()}</div><p class="small sp-8">Edición ${S.me.edition}: la lleva el perdedor del año pasado.</p></div>` : ''}
    <div class="sp-20"><div class="row rise" style="animation-delay:3.4s"><span class="label">Así fue la partida</span><button class="linkbtn" data-act="go-informe">Informe completo</button></div>
      <ol class="card chain">${rows}</ol>
      <p class="small sp-8 rise" style="animation-delay:${base + .1}s">Se publica entero, con las fotos y los vídeos que haya, para todos los jugadores.</p></div>
    <div class="punish push rise sp-20" style="animation-delay:${base + .3}s"><div class="eyebrow">Castigo</div><p>Cena formal en diciembre, a cargo de ${esc(loser)}. Propone cuatro fechas y gana la más votada. Quedan prohibidos el 24 y el 31.</p></div>
    <button class="linkbtn sp-12 rise" style="align-self:center;animation-delay:${base + .5}s" data-act="replay">Volver a ver la revelación</button>
  </section></main>${nav()}` };
}

function vInforme() {
  const f = S.repFrom === 'jugadores' ? S.rep : S.final; if (!f) return vEstado();
  const st = f.stats || {}, flt = S.repFilter || '';
  const label = { confirmed: 'Confirmado', pending: 'Pendiente', disputed: 'En disputa', void: 'Anulado por la Junta' };
  const names = [...new Set(f.chain.flatMap(e => [e.from, e.to]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const chips = ['', ...names].map(n => `<button type="button" class="fchip" data-act="rep-filter" data-n="${esc(n)}" aria-pressed="${flt === n}">${n ? esc(n) : 'Todos'}</button>`).join('');
  const open = S.repOpen || (S.repOpen = new Set());
  const entries = f.chain.filter(e => !flt || e.from === flt || e.to === flt).map(e => {
    const o = open.has(e.id), tag = e.status === 'void' ? 'Anulado' : !e.counts ? 'Sin efecto' : e.disputed ? 'Disputado' : '';
    return `<div class="card entry"><button class="ehead" data-act="rep-toggle" data-id="${e.id}" aria-expanded="${o}"><span class="head"><b>${e.from ? esc(e.from) : 'Sorteo'} → ${esc(e.to)}</b>${tag ? `<span class="pill ${e.status === 'void' ? '' : 'muted'}">${tag}</span>` : ''}</span><span class="sub">${fmtDay(ts(e.touched_at))} · ${fmtTime(ts(e.touched_at))}${e.place ? ' · ' + esc(e.place) : ''}${e.media.length ? ` · ${e.media.length} ${e.media.some(m => m.kind === 'video') ? 'prueba(s)' : e.media.length === 1 ? 'foto' : 'fotos'}` : ''}</span></button>
      ${o ? `<div class="ebody"><p>${label[e.status] || ''}${e.verdict ? ' · ' + esc(e.verdict) : ''}</p>${e.media.length ? thumbs(e.media) : '<p class="small">Sin fotos ni vídeos.</p>'}</div>` : ''}</div>`;
  }).join('');
  const stat = (k, v) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`;
  const rk = f.players.map(p => `<li><span class="pos">${p.pos}</span><span class="nm">${esc(p.name)}</span><span class="tm">${avgTxt(p.secs)}</span></li>`).join('');
  const back = S.repFrom === 'jugadores' ? { back: 'tab-jugadores', backLabel: 'Jugadores' } : { back: 'tab-estado', backLabel: 'Resultado' };
  return { html: `${header({ ...back, hideDay: true })}<main class="main"><section class="screen pad fade">
    <div class="eyebrow">Informe · Edición ${f.edition} · ${f.year}${f.provisional ? ' · provisional' : ''}</div>
    <h1 class="sp-12">Perdedor: ${esc(f.loser)}</h1>
    <div class="stats sp-16">${stat('Pillados', st.touches ?? 0)}${stat('Disputas', st.disputes ?? 0)}${stat('Anulados', st.voided ?? 0)}${stat('Jugadores', st.players ?? 0)}
      ${st.longest && st.longest.secs ? stat('Más tiempo la llevó ' + esc(st.longest.name), hms(st.longest.secs)) : ''}${st.shortest ? stat('Pase más rápido: ' + esc(st.shortest.name), hms(st.shortest.secs)) : ''}</div>
    <h2 class="sp-24" style="font-size:20px;margin:0">Tiempo llevándola</h2>
    <ol class="card plist rank">${rk}</ol>
    <h2 class="sp-24" style="font-size:20px;margin:0">Pillados</h2>
    <div class="fchips sp-12">${chips}</div>
    <div class="stack sp-12" style="gap:10px">${entries || '<p class="small">Sin pillados.</p>'}</div>
  </section></main>${nav()}` };
}

function sheetHtml() {
  const item = (act, t, d) => `<button class="item" data-act="${act}"><b>${t}</b><span>${d}</span></button>`;
  const p = player() || {};
  if (S.sheet === 'leave') return `<div class="sheet-bg" data-act="close-sheet"></div><div class="sheet pad" role="dialog" aria-modal="true" aria-labelledby="sh-t">
    <h2 id="sh-t">¿Salir del juego?</h2>
    <p class="small sp-8" style="font-size:13.5px">Según la Cláusula 7, quien abandona paga una multa a cada jugador restante: 1 € en la edición fundacional. <strong>Si la llevas tú, serás declarado Perdedor del Año</strong> y además tendrás que pagar la cena. Huir es libre, pero no es gratis.</p>
    <div class="stack sp-16"><button class="btn" data-act="leave-confirm">Sí, salir del juego</button><button class="btn line" data-act="close-sheet">Me quedo</button></div></div>`;
  if (S.sheet === 'draw') return `<div class="sheet-bg" data-act="close-sheet"></div><div class="sheet pad" role="dialog" aria-modal="true" aria-labelledby="sh-t">
    <h2 id="sh-t">Sorteo del portador inicial</h2>
    <p class="small sp-8" style="font-size:13.5px">Elige al azar, con aleatoriedad criptográfica, entre los jugadores admitidos. <strong>El resultado es secreto</strong>: solo lo verá el elegido. No se puede repetir.</p>
    <div class="stack sp-16"><button class="btn" data-act="draw-confirm">Hacer el sorteo ahora</button><button class="btn line" data-act="close-sheet">Cancelar</button></div></div>`;
  const test = S.me && S.me.test_mode;
  return `<div class="sheet-bg" data-act="close-sheet"></div><div class="sheet pad" role="dialog" aria-modal="true" aria-labelledby="sh-t">
   <h2 id="sh-t">${test ? 'Administración · modo de prueba' : 'Administración'}</h2>
   <p class="small sp-8">Eres ${esc(p.name)}.${test ? ' Las fechas y el reloj se pueden falsear.' : ''}</p>
   <div class="stack sp-16">
    ${p.is_admin ? item('ask-draw', S.me.draw_done ? 'Sorteo hecho' : 'Hacer el sorteo', S.me.draw_done ? 'Ya no se puede repetir.' : 'Elige al portador inicial. Resultado secreto.') : ''}
    ${p.is_admin && test ? item('test-hour', 'Partida de 1 hora', 'Empieza ahora y acaba dentro de 1 hora. Disputas hasta 2 horas.') + item('test-clock', 'Adelantar el reloj 24 h', 'Para probar el silencio de 24 h y los cierres.') + item('test-clock0', 'Volver al reloj real', '') + item('test-reset', 'Reiniciar la partida de prueba', 'Borra toques, casos y el sorteo.') : ''}
    ${item('refresh', 'Actualizar', 'Vuelve a pedir tu estado al servidor.')}
   </div></div>`;
}

/* ---------- render ---------- */
const VIEWS = { cargando: vCargando, estado: vEstado, tocar: vTocar, aviso: vAviso, disputa: vDisputa, junta: vJunta, caso: vCaso, reforma: vReforma, propuesta: vPropuesta, tregua: vTregua, mias: vMias, jugadores: vJugadores, contrato: vContrato, clausula: vClausula, instalar: vInstalar, entrar: vEntrar, solicitud: vSolicitud, espera: vEspera, final: vFinal, informe: vInforme };
function render() {
  const out = (VIEWS[S.view] || vEstado)();
  const keep = [...app.querySelectorAll('.toast,.push-note')];
  app.className = 'app' + (out.seal ? ' seal' : '');
  app.innerHTML = out.html + (S.sheet ? sheetHtml() : '');
  keep.forEach(n => app.appendChild(n));
  wire();
}
function wire() {
  const dial = document.getElementById('dial');
  if (dial) hold(dial, 1200, async () => {
    await refresh();                       // el estado se pide al servidor en el momento
    S.reveal = true; render(); clearTimeout(revealTimer);
    revealTimer = setTimeout(() => { if (S.view === 'estado' && S.reveal) { S.reveal = false; render(); } }, iHold() ? 15000 : 5000);
  });
  [['f-tregua', submitTregua], ['f-entrar', submitEntrar], ['f-sol', submitSol], ['f-tocar', submitTocar], ['f-disputa', submitDisputa], ['f-reforma', submitReforma], ['f-version', submitVersion]]
    .forEach(([id, fn]) => { const f = document.getElementById(id); if (f) f.addEventListener('submit', fn); });
}
function hold(el, ms, done) {
  let timer = null;
  el.style.setProperty('--hold', ms + 'ms');
  const start = e => {
    if (e.type === 'pointerdown' && e.button > 0) return;
    if (timer) return;
    if (e.pointerId !== undefined) { try { el.setPointerCapture(e.pointerId); } catch (_) { } }
    el.classList.add('holding');
    timer = setTimeout(() => { timer = null; el.classList.remove('holding'); done(); }, ms);
  };
  const end = () => { if (timer) { clearTimeout(timer); timer = null; } el.classList.remove('holding'); };
  el.addEventListener('pointerdown', start);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => el.addEventListener(t, end));
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => e.preventDefault());
  el.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(e); } });
  el.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') end(); });
}

/* ---------- datos ---------- */
let lastSig = '';
async function refresh(initial) {
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  if (!session) { S.me = null; return false; }
  const me = await rpc('me');
  S.me = me;
  if (me.now) skew = ts(me.now) - Date.now();
  if (me.start_at) { START = ts(me.start_at); END = ts(me.end_at); }
  if (me.notice) await signAll(me.notice.media);
  const p = me.player;
  const pre = ['cargando', 'entrar', 'instalar', 'solicitud', 'espera'];
  if (!p) { if (!['solicitud', 'espera'].includes(S.view)) S.view = 'solicitud'; }
  else if (p.status !== 'admitted' || p.next_edition) { if (!['contrato', 'clausula'].includes(S.view)) S.view = 'espera'; }
  else {
    if (pre.includes(S.view)) S.view = 'estado';
    const target = me.finished ? me.edition : (!started() && me.last_edition ? me.last_edition : null);
    if (!target) S.final = null;
    else if (!S.final || S.final.edition !== target || S.final.provisional) { try { S.final = await rpc('edition_report', { p_edition: target }); await signAll(S.final.chain.flatMap(e => e.media)); } catch (_) { } }
  }
  const sig = JSON.stringify([me.player, me.holds, me.notice && me.notice.touch_id, me.open_votes, me.draw_done, me.finished, me.start_at, me.end_at, me.edition, me.last_edition]);
  const changed = sig !== lastSig; lastSig = sig;
  return changed;
}
async function loadCases() { S.cases = await rpc('list_cases'); try { S.truces = await rpc('list_truces'); } catch (_) { } }
async function loadCase(id) {
  S.detail = await rpc('get_case', { p_case: id });
  if (S.detail.versions) await signAll(S.detail.versions.flatMap(v => v.media));
}

async function poll() {
  if (!S.session && !S.me) return;
  try {
    const hadNotice = notice() && notice().touch_id;
    const changed = await refresh();
    if (!changed) return;
    const newNotice = notice() && notice().touch_id !== hadNotice;
    if (newNotice) pushNote();
    if (S.view === 'estado' && !S.reveal) render();
    else if (S.view === 'espera' && player() && player().status === 'admitted' && !player().next_edition) { go('estado'); toast('La Junta te ha aceptado. Ya eres jugador.'); }
    else if (['espera', 'junta'].includes(S.view)) { if (S.view === 'junta') await loadCases(); render(); }
    else if (S.view === 'jugadores') { await loadPlayers(); render(); }
    else if (['contrato'].includes(S.view)) render();
  } catch (_) { /* sin red: se reintenta */ }
}

/* ---------- avisos push ---------- */
const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return S.push = 'unsupported';
  if (Notification.permission === 'denied') return S.push = 'denied';
  if (Notification.permission !== 'granted') return S.push = 'off';
  try {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    S.push = sub ? 'on' : 'off';
    if (sub && S.session) { const j = sub.toJSON(); await rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }); }
  } catch (_) { S.push = 'off'; }
}
async function enablePush() {
  if (!VAPID_PUBLIC_KEY) throw new Error('Los avisos aún no están configurados.');
  const perm = await Notification.requestPermission();   // debe llamarse desde un toque del usuario
  if (perm !== 'granted') { S.push = perm === 'denied' ? 'denied' : 'off'; throw new Error('Sin permiso para los avisos. Puedes activarlos en Ajustes.'); }
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  await rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  S.push = 'on';
}

/* ---------- acciones ---------- */
async function submitEntrar(e) {
  e.preventDefault();
  const l = S.login;
  if (l.name.trim().length < 2 || !l.pass) { l.err = 'Escribe tu nombre y tu contraseña.'; render(); return; }
  l.busy = true; l.err = ''; render();
  try {
    const { error } = await sb.auth.signInWithPassword({ email: emailOf(l.name.trim()), password: l.pass });
    if (error) throw error;
    S.login = fresh.login(); S.view = 'cargando'; render();
    await refresh(); go(S.view === 'cargando' ? 'estado' : S.view);
    if (S.view === 'estado') await pushState();
  } catch (err) { l.busy = false; l.err = errMsg(err); render(); }
}
async function submitSol(e) {
  e.preventDefault();
  const f = S.sol, name = f.name.trim().replace(/\s+/g, ' ');
  if (!f.checks.every(Boolean) || name.length < 2 || (!S.session && f.pass.length < 6)) return;
  f.busy = true; f.err = ''; render();
  try {
    if (!S.session) {
      const { data, error } = await sb.auth.signUp({ email: emailOf(name), password: f.pass });
      if (error) throw error;
      if (!data.session) throw new Error('Algo ha fallado. Prueba otra vez.');
    }
    const r = await rpc('request_join', { p_name: name, p_contract: true, p_honor: true, p_media: true });
    S.sol = fresh.sol();
    await refresh();
    go(r.status === 'admitted' ? 'estado' : 'espera');
    toast(r.status === 'admitted' ? 'Eres jugador fundador. Bienvenido.' : 'Solicitud enviada a la Junta de Sabios.');
  } catch (err) {
    f.busy = false; f.err = errMsg(err);
    if (/name_taken|already registered/i.test(err.message || '')) f.err = ERRORS.name_taken;
    render();
  }
}
async function openTocar() {
  try { S.targets = await rpc('get_targets'); S.truces = await rpc('list_truces'); S.tocar = fresh.tocar(); go('tocar'); }
  catch (err) { toast(errMsg(err)); }
}
async function submitTocar(e) {
  e.preventDefault();
  const t = S.tocar; if (!t.to || t.busy) return;
  if (t.place.trim().length < 2) { t.err = ERRORS.place_required; render(); return; }
  t.busy = true; t.err = ''; render();
  try {
    const tid = await rpc('register_touch', { p_to: t.to, p_ago: t.ago, p_place: t.place.trim() });
    const who = (S.targets.find(p => p.id === t.to) || {}).name;
    const failed = await uploadMedia(tid, t.media);
    S.tocar = fresh.tocar();
    await refresh(); go('estado');
    toast(failed ? `Toque registrado. ${failed} prueba(s) no se han podido subir.` : `Toque registrado. Avisamos a ${who}; tiene 24 h para responder.`);
  } catch (err) { t.busy = false; t.err = errMsg(err); render(); }
}
async function submitDisputa(e) {
  e.preventDefault();
  const d = S.disputa, n = notice(); if (!n || d.text.trim().length < 40 || d.busy) return;
  d.busy = true; d.err = ''; render();
  try {
    const cid = await rpc('respond_touch', { p_touch: n.touch_id, p_action: 'dispute', p_text: d.text.trim() });
    const failed = await uploadMedia(n.touch_id, d.media);
    S.disputa = fresh.disputa();
    await refresh(); await loadCases(); await loadCase(cid);
    S.caseId = cid; S.pick = null; go('caso');
    toast(failed ? `Enviado a la Junta. ${failed} prueba(s) no se han podido subir.` : 'Enviado a la Junta de Sabios.');
  } catch (err) { d.busy = false; d.err = errMsg(err); toast(d.err); render(); }
}
async function submitVersion(e) {
  e.preventDefault();
  const v = S.version; if (v.text.trim().length < 40 || v.busy) return;
  v.busy = true; v.err = ''; render();
  try {
    await rpc('add_version', { p_case: S.caseId, p_text: v.text.trim() });
    S.version = fresh.version(); await loadCase(S.caseId); render(); toast('Tu versión está en el caso.');
  } catch (err) { v.busy = false; v.err = errMsg(err); render(); }
}
async function submitTregua(e) {
  e.preventDefault();
  const r = S.tregua; if (r.busy) return;
  if (r.place.trim().length < 2 || !r.start || !r.end) { r.err = 'Indica el sitio y las dos horas.'; render(); return; }
  r.busy = true; r.err = ''; render();
  try {
    const cid = await rpc('propose_truce', { p_place: r.place.trim(), p_start: new Date(r.start).toISOString(), p_end: new Date(r.end).toISOString(), p_note: r.note.trim() });
    S.tregua = fresh.tregua(); await loadCases(); await loadCase(cid); S.caseId = cid; S.pick = null;
    go('caso'); toast('Tregua enviada a la Junta.');
  } catch (err) { r.busy = false; r.err = errMsg(err); render(); }
}
async function submitReforma(e) {
  e.preventDefault();
  const r = S.reforma; if (r.busy) return;
  if (r.q.trim().length < 5 || r.body.trim().length < 10) { r.err = 'Escribe la pregunta y qué cambiaría.'; render(); return; }
  r.busy = true; r.err = ''; render();
  try {
    const cid = await rpc('propose_reform', { p_question: r.q.trim(), p_body: r.body.trim() });
    S.reforma = fresh.reforma(); await loadCases(); await loadCase(cid); S.caseId = cid; S.pick = null;
    go('caso'); toast('Propuesta enviada a la Junta.');
  } catch (err) { r.busy = false; r.err = errMsg(err); render(); }
}

/* ---------- pruebas: compresión y subida ---------- */
async function compress(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch (_) { return file; }
}
async function addMedia(input) {
  const g = input.dataset.group, st = g === 'tocar' ? S.tocar : S.disputa;
  st.err = '';
  for (const f of [...input.files]) {
    const kind = f.type.startsWith('video') ? 'video' : f.type.startsWith('image') ? 'foto' : null;
    if (!kind) { st.err = `«${f.name}» no es una foto ni un vídeo.`; continue; }
    if (st.media.length >= 4) { st.err = 'Como mucho, cuatro pruebas por toque.'; break; }
    const file = kind === 'foto' ? await compress(f) : f;
    const max = kind === 'video' ? 40 : 12;
    if (file.size > max * 1048576) { st.err = `«${f.name}» pesa ${(file.size / 1048576).toFixed(0)} MB. El máximo es ${max} MB${kind === 'video' ? ' (unos 10 segundos)' : ''}.`; continue; }
    st.media.push({ kind, name: f.name, url: URL.createObjectURL(file), file });
  }
  render();
}
async function uploadMedia(touchId, media) {
  let failed = 0; const uid = player().id;
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    try {
      const ext = (m.file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
      const path = `${touchId}/${uid}/${Date.now()}-${i}.${ext}`;
      const { error } = await sb.storage.from('proofs').upload(path, m.file, { contentType: m.file.type, upsert: false });
      if (error) throw error;
      await rpc('add_media', { p_touch: touchId, p_path: path, p_kind: m.kind });
    } catch (_) { failed++; }
  }
  return failed;
}

/* ---------- eventos ---------- */
const timeParts = ms => `${Math.floor(ms / 1000)} seconds`;
async function adminCfg(start, end, dend, offsetMs) {
  await rpc('admin_test_config', { p_start: new Date(start).toISOString(), p_end: new Date(end).toISOString(), p_dispute_end: new Date(dend).toISOString(), p_offset: timeParts(offsetMs) });
}
const serverOffsetMs = () => Math.round(skew / 1000) * 1000;

app.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  try {
    switch (a) {
      case 'tab': S.sheet = false; if (b.dataset.v === 'junta') { await loadCases(); } if (b.dataset.v === 'jugadores') { await loadPlayers(); } go(b.dataset.v); break;
      case 'tab-junta': await loadCases(); go('junta'); break;
      case 'tab-contrato': go('contrato'); break;
      case 'tab-estado': go('estado'); break;
      case 'hide': S.reveal = false; clearTimeout(revealTimer); render(); break;
      case 'go-tocar': await openTocar(); break;
      case 'cancel-tocar': S.tocar = fresh.tocar(); go('estado'); break;
      case 'ago': S.tocar.ago = +b.dataset.m; render(); break;
      case 'rm-media': { const st = b.dataset.g === 'tocar' ? S.tocar : S.disputa; st.media.splice(+b.dataset.i, 1); render(); break; }
      case 'open-aviso': document.querySelectorAll('.push-note').forEach(n => n.remove()); await refresh(); if (notice()) go('aviso'); else go('estado'); break;
      case 'go-disputa': S.disputa = fresh.disputa(); go('disputa'); break;
      case 'cancel-disputa': go('aviso'); break;
      case 'open-case': S.version = fresh.version(); S.caseId = +b.dataset.id; await loadCase(S.caseId); { const mv = myVote(S.detail); S.pick = mv ? mv.c : null; } go('caso'); break;
      case 'vote': if (S.pick) { const d = S.detail, prev = myVote(d), tok = prev ? prev.t : newToken(), choice = S.pick; await rpc('cast_vote', { p_case: S.caseId, p_choice: choice, p_token: tok }); saveVote(d, tok, choice); await loadCase(S.caseId); await refresh(); render(); toast(prev ? 'Voto cambiado.' : 'Voto emitido. Nadie sabrá qué has votado.'); } break;
      case 'go-propuesta': go('propuesta'); break;
      case 'go-tregua': S.tregua = fresh.tregua(); go('tregua'); break;
      case 'go-mias': S.mine = await rpc('my_touches'); await signAll(S.mine.flatMap(e => e.media)); go('mias'); break;
      case 'go-reforma': S.reforma = fresh.reforma(); go('reforma'); break;
      case 'open-clause': go('clausula', { clauseIdx: +b.dataset.i }); break;
      case 'clause': go('clausula', { clauseIdx: Math.max(0, Math.min(CONTRACT.length - 1, S.clauseIdx + +b.dataset.d)) }); break;
      case 'go-solicitud': go('solicitud'); break;
      case 'go-entrar': go('entrar'); break;
      case 'go-contrato-free': go('contrato'); break;
      case 'skip-install': try { localStorage.setItem('nov-skip-install', '1'); } catch (_) { } go('entrar'); break;
      case 'avisos':
        try { await enablePush(); toast('Avisos activados en este móvil.'); } catch (err) { toast(err.message || errMsg(err)); }
        render(); break;
      case 'go-informe': S.repFrom = 'estado'; S.repFilter = ''; S.repOpen = new Set(); go('informe'); break;
      case 'tab-jugadores': await loadPlayers(); go('jugadores'); break;
      case 'open-hist': { const r = await rpc('edition_report', { p_edition: +b.dataset.e }); await signAll(r.chain.flatMap(e => e.media)); S.rep = r; S.repFrom = 'jugadores'; S.repFilter = ''; S.repOpen = new Set(); go('informe'); break; }
      case 'rep-filter': S.repFilter = b.dataset.n; render(); break;
      case 'rep-toggle': { const id = +b.dataset.id; S.repOpen.has(id) ? S.repOpen.delete(id) : S.repOpen.add(id); render(); break; }
      case 'replay': S.replayKey++; render(); app.querySelector('.main').scrollTop = 0; break;
      case 'logout': await sb.auth.signOut(); S.me = null; S.session = null; S.final = null; lastSig = ''; go('entrar'); break;
      case 'ask-leave': S.sheet = 'leave'; render(); break;
      case 'leave-confirm': { S.sheet = false; const r = await rpc('leave_game'); await refresh(); go('espera'); toast(r.auto_loser ? 'Has salido. Eres el Perdedor del Año.' : 'Has salido del juego.'); break; }
      case 'admin': S.sheet = 'admin'; render(); app.querySelector('.sheet .item')?.focus(); break;
      case 'close-sheet': S.sheet = false; render(); break;
      case 'ask-draw': S.sheet = S.me.draw_done ? 'admin' : 'draw'; render(); break;
      case 'draw-confirm': S.sheet = false; await rpc('admin_draw'); await refresh(); render(); toast('Sorteo hecho. Solo lo sabe el elegido.'); break;
      case 'test-hour': { S.sheet = false; const t = Date.now(); await adminCfg(t - 60000, t + 3600e3, t + 7200e3, 0); await refresh(); render(); toast('Partida de prueba de 1 hora.'); break; }
      case 'test-clock': { S.sheet = false; await adminCfg(START, END, ts(S.me.dispute_end_at), serverOffsetMs() + 864e5); await refresh(); render(); toast('Reloj adelantado 24 h.'); break; }
      case 'test-clock0': { S.sheet = false; await adminCfg(START, END, ts(S.me.dispute_end_at), 0); await refresh(); render(); toast('Reloj real.'); break; }
      case 'test-reset': { S.sheet = false; await rpc('admin_test_reset'); S.final = null; await refresh(); go('estado'); toast('Partida de prueba reiniciada.'); break; }
      case 'refresh': S.sheet = false; await refresh(); render(); break;
    }
  } catch (err) { toast(errMsg(err)); }
});
app.addEventListener('change', e => {
  const t = e.target;
  if (t.name === 'to') { S.tocar.to = t.value; render(); }
  else if (t.name === 'voto') { S.pick = t.value; render(); }
  else if (t.dataset.act === 'chk') { S.sol.checks[+t.dataset.i] = t.checked; solLive(); }
  else if (t.type === 'file') { addMedia(t); }
});
app.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'lugar') { S.tocar.place = t.value; const b = app.querySelector('[data-live="tsend"]'); if (b) b.disabled = !(S.tocar.to && t.value.trim().length >= 2 && !S.tocar.busy); }
  else if (t.id === 'relato') {
    S.disputa.text = t.value; const n = t.value.trim().length;
    const c = app.querySelector('[data-live="chars"]'); if (c) c.textContent = `${n} / 600`;
    const s = app.querySelector('[data-live="send"]'); if (s) s.disabled = n < 40;
  }
  else if (t.id === 'v-text') {
    S.version.text = t.value; const n = t.value.trim().length;
    const c = app.querySelector('[data-live="vchars"]'); if (c) c.textContent = `${n} / 600`;
    const s = app.querySelector('[data-live="vsend"]'); if (s) s.disabled = n < 40;
  }
  else if (t.id === 't-place') S.tregua.place = t.value;
  else if (t.id === 't-start') S.tregua.start = t.value;
  else if (t.id === 't-end') S.tregua.end = t.value;
  else if (t.id === 't-note') S.tregua.note = t.value;
  else if (t.id === 'r-q') S.reforma.q = t.value;
  else if (t.id === 'r-b') S.reforma.body = t.value;
  else if (t.id === 's-name') { S.sol.name = t.value; solLive(); }
  else if (t.id === 's-pass') { S.sol.pass = t.value; solLive(); }
  else if (t.id === 'l-name') S.login.name = t.value;
  else if (t.id === 'l-pass') S.login.pass = t.value;
});
function solLive() {
  const f = S.sol, ready = f.checks.every(Boolean) && f.name.trim().length >= 2 && (!!S.session || f.pass.length >= 6);
  const b = app.querySelector('[data-live="solbtn"]'); if (b) b.disabled = !ready;
  const h = app.querySelector('[data-live="solhint"]'); if (h) h.textContent = ready ? 'Tu solicitud llegará a la Junta en cuanto la envíes.' : `Escribe ${S.session ? 'tu nombre' : 'nombre y contraseña'}, y marca las tres casillas.`;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) { S.sheet = false; render(); } });
setInterval(() => {
  const c = app.querySelector('[data-live="count"]'); if (c) c.textContent = countdown();
  const el = app.querySelector('[data-live="eyebrow"]'); if (el) el.textContent = eyebrowTxt();
}, 1000);
setInterval(poll, 20000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.session) { sb.rpc('heartbeat').then(() => poll()); } });

/* ---------- arranque ---------- */
// Actualización automática: si hay versión nueva, se instala sola y la app se recarga en un momento seguro.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller; let updated = false;
  const safe = () => !['tocar', 'disputa', 'reforma', 'tregua', 'entrar'].includes(S.view) && !S.sheet;
  const reloadIfReady = () => { if (updated && safe()) location.reload(); };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) { updated = true; reloadIfReady(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const check = () => reg.update().catch(() => { });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reloadIfReady(); check(); } });
    setInterval(() => { check(); reloadIfReady(); }, 5 * 60 * 1000);
    check();
  }).catch(() => { });
}
sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && S.me) { S.me = null; S.session = null; go('entrar'); } });
(async function boot() {
  render();
  try {
    const { data: { session } } = await sb.auth.getSession();
    S.session = session;
    if (!session) {
      let skip = false; try { skip = localStorage.getItem('nov-skip-install') === '1'; } catch (_) { }
      S.view = isIOS() && !isStandalone() && !skip ? 'instalar' : 'entrar'; render(); return;
    }
    await sb.rpc('heartbeat');
    await refresh();
    if (S.view === 'cargando') S.view = 'estado';
    render();
    pushState().then(() => { if (S.view === 'estado' && !S.reveal) render(); });
  } catch (err) {
    S.view = 'entrar'; S.login.err = errMsg(err); render();
  }
})();
