/* 오박사의 메모장 — 오프라인 실행용 서비스 워커
   앱 파일과 글꼴은 저장해두고(인터넷 없으면 저장본 사용), GitHub 통신은 건드리지 않음. */
const CACHE = 'obm-v2.1.0';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'api.github.com') return;            // 동기화는 항상 실제 서버로
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('pretendard'));
  if (!sameOrigin && !isFont) return;

  if (sameOrigin) {
    // 앱 파일: 인터넷 되면 최신(2.5초 안에), 안 되면 저장본
    const key = req.mode === 'navigate' ? './index.html' : req;
    e.respondWith(new Promise(resolve => {
      let settled = false;
      const fallback = () => caches.match(key).then(hit => { if (!settled && hit) { settled = true; resolve(hit); } return hit; });
      const timer = setTimeout(fallback, 2500);
      fetch(req).then(res => {
        clearTimeout(timer);
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
        if (!settled) { settled = true; resolve(res); }
      }).catch(() => { clearTimeout(timer); fallback().then(hit => { if (!settled) { settled = true; resolve(hit || Response.error()); } }); });
    }));
    return;
  }
  // 글꼴: 저장본을 바로 쓰고 뒤에서 새로 받아둠
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
