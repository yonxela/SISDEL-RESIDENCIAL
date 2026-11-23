// Avisos en el celular (notificaciones push) del lado del navegador: SisdelAvisos.create({ call }) pide el permiso, instala
// sw-avisos.js, se suscribe con la llave publica del servidor y le entrega la suscripcion (functions/src/avisos-push.js, callable
// pushDevice). UMD: lo carga vecino.html y las pruebas (scripts/test-avisos-push.mjs) con un navegador de mentira.
//
// Automatico (pedido del usuario el 2026-11-23: "el vecino lo unico que hara es abrir garita.app ... al ingresar la clave debe
// quedar todo listo"): auto() lo usa el ingreso (index.html, justo al tocar Ingresar: el telefono solo muestra la pregunta del
// permiso en respuesta a un toque) y el portal (sync al abrir; con el permiso ya dado no pregunta nada y registra el telefono para
// quien entro). Nunca si la persona toco "Desactivar en este telefono" (off), hasta que los vuelva a activar.
//
// iPhone: los avisos de una pagina solo funcionan desde iOS 16.4 y SOLO si garita.app se agrego a la pantalla de inicio y se abre
// desde ese icono (en una pestana de Safari o Chrome no existen). Por eso support() dice 'ios-instalar' y la pantalla explica
// como agregarla. Android y las computadoras: en el navegador, sin instalar nada.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelAvisos = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const SYNC_KEY = 'sisdel_avisos_tel';
    const RESYNC_MS = 3 * 24 * 60 * 60 * 1000;

    function b64ToBytes(b64) {
        const s = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
        const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
        const bin = atob(s + pad);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToB64(buf) {
        if (!buf) return '';
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // Datos del equipo: iPhone (tambien el iPad que dice ser Mac), version de iOS y si se abrio desde el icono de la pantalla de inicio
    function device(nav, win) {
        const ua = String((nav && nav.userAgent) || '');
        const ios = /iPhone|iPad|iPod/.test(ua) || (nav && nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
        const m = ua.match(/OS (\d+)[_.](\d+)/);
        const iosVersion = ios && m ? Number(m[1]) + Number(m[2]) / 100 : null;
        let standalone = !!(nav && nav.standalone === true);
        try { standalone = standalone || !!(win && win.matchMedia && win.matchMedia('(display-mode: standalone)').matches); } catch (e) { /* sin matchMedia */ }
        return { ios: !!ios, iosVersion, standalone, android: /Android/i.test(ua) };
    }

    function create(opts) {
        const o = opts || {};
        const nav = o.navigator || (typeof navigator !== 'undefined' ? navigator : null);
        const win = o.window || (typeof window !== 'undefined' ? window : null);
        const storage = o.storage || (function () { try { return win && win.localStorage; } catch (e) { return null; } }());
        const call = o.call; // (data) => Promise<respuesta de pushDevice>
        const swUrl = o.swUrl || '/sw-avisos.js';
        const dev = device(nav, win);

        function readSync() { try { return JSON.parse((storage && storage.getItem(SYNC_KEY)) || 'null'); } catch (e) { return null; } }
        function writeSync(v) { try { if (!storage) return; if (v) storage.setItem(SYNC_KEY, JSON.stringify(v)); else storage.removeItem(SYNC_KEY); } catch (e) { /* sin storage */ } }

        // ok: se pueden activar aqui. reason: 'ok' | 'ios-instalar' (falta abrir garita.app desde la pantalla de inicio) |
        // 'ios-viejo' (iOS anterior a 16.4) | 'sin-soporte' (este navegador no tiene avisos) | 'inseguro' (sin https)
        function support() {
            const base = { ios: dev.ios, android: dev.android, standalone: dev.standalone, iosVersion: dev.iosVersion };
            if (win && win.isSecureContext === false) return { ...base, ok: false, reason: 'inseguro' };
            if (dev.ios && dev.iosVersion && dev.iosVersion < 16.04) return { ...base, ok: false, reason: 'ios-viejo' };
            const hasPush = !!(nav && 'serviceWorker' in nav && win && 'PushManager' in win && 'Notification' in win);
            if (!hasPush) return { ...base, ok: false, reason: dev.ios && !dev.standalone ? 'ios-instalar' : 'sin-soporte' };
            return { ...base, ok: true, reason: 'ok' };
        }

        function permission() {
            if (!win || !('Notification' in win)) return 'unsupported';
            return win.Notification.permission || 'default';
        }

        async function registration(install) {
            if (!nav || !nav.serviceWorker) return null;
            if (install) {
                await nav.serviceWorker.register(swUrl, { scope: '/' });
                return nav.serviceWorker.ready;
            }
            return (await nav.serviceWorker.getRegistration('/')) || null;
        }

        async function currentSubscription() {
            const reg = await registration(false);
            return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
        }

        // Estado de este telefono: 'activo' | 'inactivo' | 'bloqueado' (el permiso se nego: se cambia en los ajustes) |
        // 'otro-usuario' (este telefono recibe los avisos de otra persona que entro aqui con su clave) | el reason de support()
        async function status() {
            const sup = support();
            if (!sup.ok) return { state: sup.reason, support: sup };
            const perm = permission();
            if (perm === 'denied') return { state: 'bloqueado', support: sup };
            const sub = perm === 'granted' ? await currentSubscription() : null;
            if (!sub) return { state: 'inactivo', support: sup };
            try {
                const r = await call({ action: 'state', endpoint: sub.endpoint });
                if (r && r.active) return { state: 'activo', support: sup };
                return { state: r && r.otherUser ? 'otro-usuario' : 'inactivo', support: sup };
            } catch (e) {
                // Sin conexion: el telefono esta suscrito; se confirma la proxima vez
                return { state: 'activo', unconfirmed: true, support: sup };
            }
        }

        // Activar: se llama desde el toque del boton (el iPhone solo muestra la pregunta del permiso si viene de un toque)
        async function enable(userId) {
            const sup = support();
            if (!sup.ok) return { ok: false, state: sup.reason };
            const perm = await win.Notification.requestPermission();
            if (perm !== 'granted') return { ok: false, state: perm === 'denied' ? 'bloqueado' : 'inactivo' };
            const reg = await registration(true);
            const cfg = await call({ action: 'config' });
            const publicKey = cfg && cfg.publicKey;
            if (!publicKey) throw new Error('El servidor no entregó la llave de avisos.');
            let sub = await reg.pushManager.getSubscription();
            // Una suscripcion hecha con otra llave no sirve con la del servidor: se rehace
            if (sub && sub.options && sub.options.applicationServerKey && bytesToB64(sub.options.applicationServerKey) !== String(publicKey).replace(/=+$/, '')) {
                try { await sub.unsubscribe(); } catch (e) { /* se suscribe de nuevo abajo */ }
                sub = null;
            }
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
            const json = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
            await call({ action: 'register', subscription: { endpoint: json.endpoint, keys: json.keys }, standalone: dev.standalone });
            writeSync({ userId: userId || null, endpoint: json.endpoint, at: Date.now() });
            return { ok: true, state: 'activo' };
        }

        // La persona los desactivo en este telefono: lo automatico no los vuelve a encender
        function isOff() { const saved = readSync(); return !!(saved && saved.off); }

        // Lo automatico. ask: true = puede mostrar la pregunta del permiso (solo justo despues de un toque: Ingresar o el primer
        // toque en el portal); sin ask solo completa lo que ya se permitio. Si ya esta registrado para esta persona hace poco, nada.
        async function auto(userId, opts) {
            const sup = support();
            if (!sup.ok) return { ok: false, state: sup.reason };
            if (isOff()) return { ok: false, state: 'apagado' };
            const perm = permission();
            if (perm === 'denied') return { ok: false, state: 'bloqueado' };
            if (perm !== 'granted' && !(opts && opts.ask)) return { ok: false, state: 'inactivo' };
            if (perm === 'granted') {
                const saved = readSync();
                const sub = await currentSubscription();
                if (saved && sub && saved.userId === (userId || null) && saved.endpoint === sub.endpoint && Date.now() - (saved.at || 0) < RESYNC_MS) {
                    return { ok: true, state: 'activo', already: true };
                }
            }
            return enable(userId);
        }

        async function disable() {
            const sub = await currentSubscription();
            if (sub) {
                try { await call({ action: 'unregister', endpoint: sub.endpoint }); } finally {
                    try { await sub.unsubscribe(); } catch (e) { /* ya no estaba */ }
                }
            }
            // Se recuerda que la persona los apago (lo automatico lo respeta); "Activar avisos" lo borra
            writeSync({ off: true, at: Date.now() });
            return { ok: true, state: 'inactivo' };
        }

        async function test() {
            const sub = await currentSubscription();
            if (!sub) return { ok: false, state: 'inactivo' };
            return call({ action: 'test', endpoint: sub.endpoint });
        }

        // Al abrir el portal: con el permiso ya dado, deja el telefono listo para quien entro (crea la suscripcion si falta, la vuelve a
        // entregar cada pocos dias o si el navegador la cambio, y pasa el telefono a esta persona). Nunca pregunta ni enciende lo apagado.
        async function sync(userId) {
            try {
                const r = await auto(userId, { ask: false });
                return !!(r && r.ok && !r.already);
            } catch (e) {
                return false;
            }
        }

        return { support, permission, status, enable, disable, test, sync, auto, isOff, device: dev };
    }

    return { create, device, b64ToBytes, bytesToB64, SYNC_KEY };
}));
