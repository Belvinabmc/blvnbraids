/* Service worker : permet d’installer le site et de l’ouvrir sans connexion.
   À CHAQUE MISE EN LIGNE, changez le numéro de VERSION ci-dessous pour que les visiteuses reçoivent la nouvelle version. */
const VERSION = 'blvn-v31';
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon-48.png"];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, {cache: 'reload'})))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'blvn-badge').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin || new URL(r.url).pathname.startsWith('/api/') || new URL(r.url).pathname.startsWith('/.netlify/')) return;
  if (r.mode === 'navigate') {   // pages : réseau d’abord (mises à jour), cache en secours (hors connexion)
    const key = /\/gestion(\.html)?\/?$/.test(new URL(r.url).pathname) ? 'gestion.html' : 'index.html';
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(VERSION).then(c => c.put(key, cp)); return res; })
      .catch(() => caches.match(key).then(m => m || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { const cp = res.clone(); caches.open(VERSION).then(c => c.put(r, cp)); return res; })));
});

/* Notifications de l’appli Blvn Gestion */
/* Pastille sur l’icône : nombre de notifications non lues, remis à zéro à l’ouverture de la gestion */
async function bumpBadge() {
  try {
    const c = await caches.open('blvn-badge'), r = await c.match('/__badge'), n = (r ? +(await r.text()) || 0 : 0) + 1;
    await c.put('/__badge', new Response(String(n)));
    if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
  } catch (e) {}
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Blvn Gestion', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Blvn Gestion', { body: d.body || '', icon: 'icon-gestion-192.png', badge: 'icon-gestion-192.png', tag: d.tag, renotify: true, data: { url: d.url || '/gestion' } }),
    bumpBadge()]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/gestion', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate ? c.navigate(url).catch(() => {}) : 0; return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
