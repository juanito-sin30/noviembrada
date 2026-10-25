# Noviembrada

App del juego «La llevas»: PWA para iPhone, servidor en Supabase, alojamiento en GitHub Pages.
Todo es gratuito. El servidor es el árbitro: nadie puede leer quién la lleva salvo esa persona.

## Estructura
- `public/` → la app (HTML + JS en módulos, sin compilación): `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`.
- `supabase/migrations/` → esquema, reglas, RLS, almacenamiento de pruebas y avisos.
- `supabase/functions/send-push/` → función que envía los avisos push (siempre «Tienes un aviso.»).
- `supabase/admin/` → scripts de administración.
- `tests/` → 31 pruebas automáticas de las reglas.

## Pruebas de las reglas
```
cd tests && npm install && npm test
```
Usan un Postgres embebido (no hace falta Docker) con las mismas funciones y políticas.

## Desplegar
1. **Base de datos:** `npx supabase link --project-ref <ref>` y `npx supabase db push`.
2. **Avisos:** `npx supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… CRON_SECRET=…` y
   `npx supabase functions deploy send-push --no-verify-jwt --use-api`. Después, guarda en la tabla
   `app_secrets` las claves `send_push_url` y `cron_secret` (la migración 0003 ya programa el cron cada minuto).
3. **Web:** GitHub Pages publica `public/` con el workflow de `.github/workflows/pages.yml`.
4. **Claves públicas:** `public/config.js` (URL de Supabase, clave anon y clave VAPID pública). Nunca pongas la clave secreta ahí.

## Sorteo (automático)
A las 00:00 del 1 de noviembre (Europe/Madrid) el servidor hace solo el sorteo, elige a quien la lleva (aleatoriedad criptográfica,
resultado secreto) y manda a todos el aviso «¡Que empiece la Noviembrada, edición N!». Lo dispara el cron de cada minuto, así que
puede tardar hasta un minuto. Hacen falta al menos 2 jugadores admitidos; si no, lo intenta cada minuto hasta que los haya.
Reserva manual: **Admin → Hacer el sorteo ahora** (solo si el automático no se ha hecho). No se puede repetir.
**Solo la edición 1 se sortea.** Las siguientes empiezan llevándola el perdedor de la edición anterior (si sigue jugando; si no, sorteo).

## Cierre de edición (automático)
Cuando ha pasado el 30 de noviembre y no queda ninguna disputa abierta ni ningún toque pendiente de resolver (los toques se confirman a las 24 h),
el servidor cierra la edición solo: guarda el informe (perdedor, tiempos, todos los pillados con sus fotos y vídeos y el resultado de las disputas)
en el **Historial** (Jugadores → Historial), suma la edición al **ranking acumulado**, avisa a todos y prepara la siguiente
(1–30 nov del año siguiente, con arranque automático a las 00:00 y la lleva el perdedor). Los jugadores admitidos pasan solos a la nueva edición.
Si hay disputas, espera a que se resuelvan (como máximo el 7 dic). No actúa en modo de prueba.

## Lugar, votos y treguas
- Al registrar un pillado el **lugar es obligatorio** y es privado: solo lo ven tocador y tocado (Jugadores → Mis pilladas) y la Junta si hay disputa. No sale en el informe.
- Los **votos se pueden cambiar** mientras el caso esté abierto. Siguen siendo anónimos: el móvil guarda un testigo secreto y el servidor solo guarda su hash junto al voto.
  Si cambias de móvil o borras los datos, ya no podrás cambiar ese voto. Cuando han votado todos, el caso se cierra una hora después.
- **Treguas** (Junta → Propuesta → Una tregua): sitio y horas; votan todos menos quien la propone; un solo «no» la anula. Si se aprueba,
  el servidor rechaza pillados cuya hora caiga en la ventana y cuyo lugar coincida con el sitio de la tregua (comparación sin acentos ni mayúsculas;
  si alguien escribe otro nombre para el mismo sitio, se resuelve con una disputa en la Junta).

## Avisos de pillado
Al tocado le llega «Te han pillado. Ya la llevas…». A todos (incluidos tocador y tocado) les llega el anónimo «Ha habido un pillado».
Así nadie se delata por recibir o no el aviso.

## Resetear una contraseña
Edita `supabase/admin/reset_password.sql` (nombre en minúsculas, sin acentos, con puntos: «Marta Puig» → `marta.puig`) y ejecútalo.

## Modo de prueba (fechas falsas)
```
npx supabase db query --linked "update public.game_config set test_mode = true"
```
Con el modo activo, quien es administrador ve en **Admin**: partida de 1 hora, adelantar el reloj 24 h,
volver al reloj real y reiniciar la partida de prueba. **Antes del 31 de octubre, desactívalo y reinicia:**
```
update public.game_config set test_mode=false, draw_done=false, forced_loser=null, clock_offset='0',
  start_at='2026-10-31 23:00:00+00', end_at='2026-11-30 22:59:59+00', dispute_end_at='2026-12-07 22:59:59+00';
delete from public.cases; delete from public.touches; delete from public.outbox;
```

## Reglas aplicadas por defecto (pendientes de que las confirmes)
- Votaciones de admisión, disputa y reforma: 48 h, o antes si votan todos. Admisión sin votos al vencer: rechazada.
- Disputa con empate persistente: el toque se mantiene.
- Anular un toque deja sin efecto los posteriores que dependían de él.
- Quien sale siendo portador queda como Perdedor automático; el juego sigue para los demás.
- Treguas: aún no implementadas.
