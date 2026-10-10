// Service worker : fonctionnement hors ligne de l'appli et affichage des notifications de rappel.
const CACHE = 'astreintes-202610100840';
const FICHIERS = [
  './', 'index.html', 'app.js', 'styles.css', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/badge-96.png', 'icons/favicon-32.png',
  'fonts/barlow-400.woff2', 'fonts/barlow-500.woff2', 'fonts/barlow-600.woff2',
  'fonts/barlow-condensed-600.woff2', 'fonts/barlow-condensed-700.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).catch(() => null).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k !== CACHE && k !== 'astreintes-donnees').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (pour toujours avoir la dernière version), cache si pas de réseau.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((rep) => {
        if (rep.ok) { const copie = rep.clone(); caches.open(CACHE).then((c) => c.put(req, copie)); }
        return rep;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});

// Notification envoyée par le programme de rappel (Firebase Cloud Messaging, message « data »).
self.addEventListener('push', (e) => {
  let brut = {};
  try { brut = e.data ? e.data.json() : {}; } catch { brut = { data: { body: e.data && e.data.text() } }; }
  const d = brut.data || brut.notification || brut;
  const titre = d.title || 'Astreintes';
  // Planning général joint à la notification de publication : gardé pour que l'appli l'affiche.
  const garder = d.planning
    ? caches.open('astreintes-donnees').then((c) => c.put('planning-general.json', new Response(d.planning, { headers: { 'Content-Type': 'application/json' } }))).catch(() => null)
    : Promise.resolve();
  e.waitUntil(garder.then(() => self.registration.showNotification(titre, {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' },
  })));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const cible = new URL(e.notification.data?.url || './', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenetres) => {
    for (const f of fenetres) if (f.url.startsWith(self.registration.scope) && 'focus' in f) { f.navigate(cible).catch(() => null); return f.focus(); }
    return self.clients.openWindow(cible);
  }));
});
