// Avisos en el celular (notificaciones push) de garita.app. Este archivo lo instala avisos-push.js cuando el vecino toca
// "Activar avisos". Solo muestra los avisos que manda el servidor (functions/src/avisos-push.js) y, al tocarlos, abre garita.app:
// NO guarda paginas ni intercepta pedidos (no hay 'fetch'), asi una version nueva de la pagina siempre llega al momento.
/* eslint-env serviceworker */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function readPayload(event) {
    if (!event.data) return {};
    try { return event.data.json() || {}; } catch (e) {
        try { return { body: event.data.text() }; } catch (e2) { return {}; }
    }
}

// Solo rutas de este mismo sitio (un aviso nunca lleva a otra pagina)
function safeUrl(url) {
    try {
        const u = new URL(url || '/index.html', self.location.origin);
        return u.origin === self.location.origin ? u.href : new URL('/index.html', self.location.origin).href;
    } catch (e) {
        return new URL('/index.html', self.location.origin).href;
    }
}

self.addEventListener('push', (event) => {
    const p = readPayload(event);
    const title = String(p.title || 'garita.app').slice(0, 120);
    const options = {
        body: String(p.body || 'Tiene un mensaje nuevo de la administración.').slice(0, 500),
        icon: '/icono-app-192.png',
        badge: '/icono-aviso-badge.png',
        tag: String(p.tag || 'garita-aviso').slice(0, 80),
        renotify: true,
        data: { url: safeUrl(p.url), kind: String(p.kind || '') }
    };
    // iPhone y Chrome exigen que cada aviso se muestre: siempre se llama showNotification
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || safeUrl('/index.html');
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // Si el vecino tiene garita.app abierto con su sesion, se usa esa pestana (la sesion vive en ella) y se abren los mensajes
        const portal = windows.find((w) => new URL(w.url).pathname.endsWith('/vecino.html'));
        if (portal) {
            portal.postMessage({ type: 'sisdel-aviso', kind: (event.notification.data && event.notification.data.kind) || '' });
            if ('focus' in portal) return portal.focus();
            return null;
        }
        // Si no, una ventana nueva: la sesion se cerro, pide la clave y despues lleva a los mensajes
        return self.clients.openWindow(target);
    })());
});
