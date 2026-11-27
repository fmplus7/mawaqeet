// v2: الشبكة أولاً للصفحات (تحديثات فورية)، والكاش أولاً للخطوط والبيانات الكبيرة
const C = 'mawaqeet-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url), same = u.origin === location.origin;
  const big = /\.(woff2?|json)$/i.test(u.pathname) || u.hostname.endsWith('jsdelivr.net');
  if (big) {
    e.respondWith(caches.match(r).then(c => c || fetch(r).then(res => { if (res.ok || res.type === 'opaque') { const cp = res.clone(); caches.open(C).then(x => x.put(r, cp)); } return res; })));
    return;
  }
  if (!same) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(x => x.put(r, cp)); } return res; })
    .catch(() => caches.match(r).then(c => c || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
