// Service worker: caché básica de la app y recepción de avisos push.
// El texto del aviso es SIEMPRE genérico: nunca se lee nada del contenido del push.
const CACHE = 'noviembrada-v1';
const SHELL = ['./', 'index.html', 'app.js', 'contract.js', 'config.js', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Red primero, caché de reserva: así una actualización llega siempre, y sin conexión sigue abriendo.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./')))
  );
});

self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('NOVIEMBRADA', {
    body: 'Tienes un aviso.', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'noviembrada', renotify: true
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
