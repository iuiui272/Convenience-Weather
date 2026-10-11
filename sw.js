/* Quorum service worker.
 * - App shell: precached, then served cache-first with background revalidation (works fully offline).
 * - Weather data is NOT cached here: the app keeps its own timestamped copy in IndexedDB so it can show
 *   "updated 2 h ago" honestly. API calls always go straight to the network.
 * - Map tiles (basemap only): small runtime cache so the last-viewed area still draws offline.
 * Bump VERSION whenever you deploy changes to any shell file.
 */
const VERSION = 'v1.0.0';
const SHELL = `quorum-shell-${VERSION}`;
const TILES = 'quorum-tiles-v1';
const TILE_LIMIT = 160;

const ASSETS = [
  './', './index.html', './manifest.json', './css/styles.css',
  './js/app.js', './js/api.js', './js/chart.js', './js/consensus.js', './js/fx.js', './js/icons.js',
  './js/model.js', './js/radar.js', './js/store.js', './js/ui.js', './js/util.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // add one by one so a single missing file can't block the install
    await Promise.all(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('quorum-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

const TILE_HOSTS = /(^|\.)basemaps\.cartocdn\.com$/;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) { e.respondWith(shell(req)); return; }
  if (TILE_HOSTS.test(url.hostname)) { e.respondWith(tile(req)); return; }
  // everything else (weather APIs, radar frames) → network only, handled by the app
});

async function shell(req) {
  const cache = await caches.open(SHELL);
  const isNav = req.mode === 'navigate';
  const hit = await cache.match(req, { ignoreSearch: true }) || (isNav ? await cache.match('./index.html') : null);
  const refresh = fetch(req).then(res => {
    if (res.ok && res.type === 'basic') cache.put(isNav ? './index.html' : req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) { refresh; return hit; }                 // serve instantly, update in the background
  const res = await refresh;
  return res || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  const net = fetch(req).then(async res => {
    if (res.ok || res.type === 'opaque') {
      cache.put(req, res.clone());
      const keys = await cache.keys();
      if (keys.length > TILE_LIMIT) await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => cache.delete(k)));
    }
    return res;
  }).catch(() => hit || Response.error());
  return hit || net;
}
