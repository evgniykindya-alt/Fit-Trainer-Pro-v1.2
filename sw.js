const CACHE_VERSION = 'ft-v1.2.5';
const CACHE_NAME = 'fit-trainer-' + CACHE_VERSION;
const PRECACHE_URLS = ['./', './index.html'];
const NAV_NETWORK_TIMEOUT_MS = 1800;

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.all(
                PRECACHE_URLS.map((url) =>
                    cache.add(url).catch((e) => console.warn('[SW] precache skip', url, e))
                )
            );
        }).catch((e) => console.warn('[SW] precache failed', e))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

function isNavigationRequest(req) {
    if (req.mode === 'navigate') return true;
    const accept = req.headers.get('accept') || '';
    return accept.includes('text/html');
}

function cachePut(req, res) {
    if (!res || !res.ok) return;
    const copy = res.clone();
    caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
}

async function matchCachedAppShell(req) {
    return (
        (await caches.match(req)) ||
        (await caches.match('./index.html')) ||
        (await caches.match('./')) ||
        (await caches.match('/index.html')) ||
        null
    );
}

/** Сеть с таймаутом — при «полуживом» интернете не висим до белого экрана */
function fetchWithTimeout(req, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(req, { signal: controller.signal })
        .then((res) => {
            clearTimeout(timer);
            return res;
        })
        .catch((err) => {
            clearTimeout(timer);
            throw err;
        });
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.origin !== location.origin) return;

    // HTML / навигация
    if (isNavigationRequest(req)) {
        event.respondWith((async () => {
            const cached = await matchCachedAppShell(req);

            // 1) Быстрый ответ из кэша — нет белого экрана
            // 2) Параллельно пробуем сеть с коротким таймаутом и обновляем кэш
            const networkPromise = fetchWithTimeout(req, NAV_NETWORK_TIMEOUT_MS)
                .then((res) => {
                    if (res && res.ok) {
                        cachePut(req, res);
                        // Также кладём как index.html shell
                        try {
                            const shellReq = new Request('./index.html');
                            cachePut(shellReq, res.clone());
                        } catch (e) {}
                    }
                    return res;
                })
                .catch(() => null);

            if (cached) {
                // Отдаём кэш сразу; сеть лишь обновляет кэш в фоне
                event.waitUntil(networkPromise);
                return cached;
            }

            // Кэша ещё нет (первый визит) — ждём сеть, но с таймаутом
            const net = await networkPromise;
            if (net && net.ok) return net;
            if (net) return net; // даже 404 лучше, чем зависание

            return new Response(
                '<!doctype html><meta charset="utf-8"><title>Офлайн</title><body style="font-family:system-ui;padding:24px;background:#12121a;color:#f0f0f5"><h1>Нет сети</h1><p>Откройте приложение ещё раз при стабильном интернете, чтобы сохранить офлайн-копию.</p></body>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
        })());
        return;
    }

    // Остальные GET — cache-first
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) {
                // Фоново обновить
                fetch(req).then((res) => {
                    if (res && res.status === 200 && res.type === 'basic') cachePut(req, res);
                }).catch(() => {});
                return cached;
            }
            return fetch(req).then((res) => {
                if (res && res.status === 200 && res.type === 'basic') cachePut(req, res);
                return res;
            }).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('./');
        })
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
