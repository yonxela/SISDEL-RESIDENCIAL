// Avisos en el celular: la pantalla del vecino (vecino.html). Pedido del usuario el 2026-11-23: que el mensaje de la administracion
// le salte en el celular al vecino aunque haya cerrado garita.app.
//
// Pone en el portal:
//  - una campana en el encabezado ("Mensajes y avisos", con un punto si hay mensajes nuevos) que abre la ventana de mensajes;
//  - una invitacion debajo de la bienvenida para activar los avisos en ese telefono (con "Ahora no", que la guarda una semana);
//  - la ventana #modalAvisos: arriba, los avisos de ESTE telefono (activar, aviso de prueba, desactivar o, en el iPhone, como
//    agregar garita.app a la pantalla de inicio); abajo, los mensajes de la administracion de los ultimos 60 dias.
// Reemplaza la ventana de "Mensajes de Administracion" que salia al entrar: aquella usaba la marca `read` del mensaje, que es una
// sola para todos (el primer vecino que lo leia lo ocultaba para los demas). Ahora "nuevo" es por vecino y por equipo
// (localStorage) y se sigue marcando `read` para que la administracion vea que alguien lo leyo.
// Se abre sola si hay mensajes nuevos, si la pagina llega con #mensajes (despues de entrar desde un aviso) o si se toca un aviso
// con garita.app abierto (sw-avisos.js le avisa a la pagina).
(function (root) {
    'use strict';

    const SEEN_PREFIX = 'sisdel_msg_vistos_';
    const LATER_PREFIX = 'sisdel_avisos_luego_';
    const LATER_MS = 7 * 24 * 60 * 60 * 1000;
    const RECENT_DAYS = 60;
    const MAX_LIST = 20;
    const MAX_SEEN = 300;

    const ICON_BELL = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
    const ICON_PHONE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
    const ICON_SHARE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';

    const CSS = `
        .av-bell { position: relative; }
        .av-bell .av-bell-dot { position: absolute; top: 0.25rem; right: 0.25rem; min-width: 1.05rem; height: 1.05rem; padding: 0 0.25rem; border-radius: 999px; background: var(--danger); color: #fff; font-size: 0.68rem; font-weight: 800; line-height: 1.05rem; text-align: center; }
        .av-bell .av-bell-dot[hidden] { display: none; }
        .av-invite { display: flex; gap: 0.85rem; align-items: flex-start; padding: 0.95rem 1.1rem; margin: 0 0 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--primary-light); background: rgba(37, 99, 235, 0.1); font-size: 0.95rem; line-height: 1.45; }
        .av-invite[hidden] { display: none; }
        .av-invite .av-ico { color: var(--primary-light); flex-shrink: 0; margin-top: 0.1rem; }
        .av-invite strong { display: block; margin-bottom: 0.15rem; }
        .av-invite .av-btns { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.65rem; }
        #modalAvisos .modal { max-width: 520px; padding: 1.25rem 1.25rem 0; overflow-x: hidden; }
        .av-phone { padding: 1rem 1.1rem; margin: 0.25rem 0 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-strong); background: var(--bg-item); font-size: 0.93rem; line-height: 1.5; }
        .av-phone.ok { border-color: var(--success); background: rgba(16, 185, 129, 0.1); }
        .av-phone.bad { border-color: var(--danger); background: var(--danger-bg); }
        .av-phone h4 { margin: 0 0 0.35rem; font-size: 1.02rem; }
        .av-phone p { margin: 0 0 0.5rem; color: var(--text-secondary); }
        .av-phone ol { margin: 0.35rem 0 0.5rem; padding-left: 1.35rem; color: var(--text-secondary); }
        .av-phone ol li { margin-bottom: 0.35rem; }
        .av-phone .av-btns { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
        .av-btns .btn { max-width: 100%; white-space: normal; text-align: center; line-height: 1.3; }
        .av-phone .av-msg { margin-top: 0.6rem; font-weight: 600; }
        .av-phone .av-msg.err { color: var(--danger); }
        .av-sub { margin: 0 0 0.75rem; font-size: 1.05rem; }
        .av-item { padding: 0.9rem 1rem; border-radius: var(--radius-md); background: var(--bg-item); margin-bottom: 0.7rem; border-left: 4px solid var(--border-strong); }
        .av-item.nuevo { border-left-color: var(--primary-light); }
        .av-item-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 0.75rem; align-items: baseline; margin-bottom: 0.4rem; }
        .av-item-head .text-xs { white-space: nowrap; }
        .av-item-head strong { color: var(--primary-light); font-size: 1rem; }
        .av-item p { margin: 0 0 0.5rem; color: var(--text-secondary); line-height: 1.5; white-space: pre-line; word-break: break-word; }
        .av-new { display: inline-block; margin-left: 0.4rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--primary); color: #fff; font-size: 0.68rem; font-weight: 800; vertical-align: 2px; }
        .av-empty { padding: 1.25rem; text-align: center; color: var(--text-muted); }
        .av-actions { position: sticky; bottom: 0; padding: 0.85rem 0 1.25rem; background: var(--bg-surface-solid); }
        .av-actions .btn { width: 100%; }
    `;

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function readJson(key, fallback) {
        try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; }
    }
    function writeJson(key, value) {
        try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* sin storage */ }
    }

    // Lo que dice el recuadro de ESTE telefono segun su estado (SisdelAvisos.status().state)
    function phoneView(state, device) {
        const d = device || {};
        const ios = !!d.ios;
        const android = !!d.android;
        switch (state) {
            case 'activo':
                return { cls: 'ok', title: 'Avisos activados en este teléfono', text: 'Le llegarán los mensajes de la administración aunque tenga garita.app cerrado.', buttons: [['test', 'Enviar aviso de prueba', 'btn-primary'], ['disable', 'Desactivar en este teléfono', 'btn-ghost']] };
            case 'inactivo':
                return { cls: '', title: 'Reciba los mensajes en su celular', text: 'Active los avisos y los mensajes de la administración le aparecerán en el teléfono aunque tenga garita.app cerrado. Su teléfono le preguntará si permite las notificaciones: toque «Permitir».', buttons: [['enable', 'Activar avisos', 'btn-primary']] };
            case 'otro-usuario':
                return { cls: '', title: 'Este teléfono recibe los avisos de otra persona', text: 'Alguien más entró aquí con su clave y activó los avisos. Si este es su teléfono, tóquelo para recibir aquí los suyos.', buttons: [['enable', 'Recibir aquí mis avisos', 'btn-primary']] };
            case 'bloqueado':
                return {
                    cls: 'bad', title: 'Las notificaciones están bloqueadas', text: 'Este teléfono tiene bloqueadas las notificaciones de garita.app. Una página no puede volver a preguntar: hay que permitirlas en los ajustes.',
                    steps: ios
                        ? ['Abra Ajustes del iPhone > Notificaciones.', 'Busque garita.app y active «Permitir notificaciones».', 'Vuelva aquí y toque «Activar avisos».']
                        : android
                            ? ['Toque el candado (o los ajustes del sitio) junto a la dirección garita.app.', 'Entre a Permisos > Notificaciones y elija «Permitir».', 'Vuelva aquí y toque «Activar avisos».']
                            : ['Toque el candado junto a la dirección garita.app.', 'En Notificaciones elija «Permitir».', 'Recargue la página y toque «Activar avisos».'],
                    buttons: [['enable', 'Ya las permití: activar avisos', 'btn-primary']]
                };
            case 'ios-instalar':
                return {
                    cls: '', title: 'En el iPhone: agregue garita.app a su pantalla de inicio',
                    text: 'Apple solo deja recibir avisos si garita.app se abre desde un ícono en la pantalla de inicio (en una pestaña de Safari o Chrome no llegan). Se hace una sola vez:',
                    steps: [
                        `En Safari toque Compartir ${ICON_SHARE} (el cuadro con la flecha hacia arriba). En Chrome, Compartir está junto a la dirección.`,
                        'Elija «Agregar a inicio» y toque «Agregar».',
                        'Abra garita.app desde el ícono nuevo, entre con su clave y toque «Activar avisos» aquí mismo.'
                    ],
                    buttons: []
                };
            case 'ios-viejo':
                return { cls: 'bad', title: 'Su iPhone necesita una versión más nueva', text: 'Los avisos de garita.app funcionan desde iOS 16.4. Actualice en Ajustes > General > Actualización de software y vuelva a intentarlo.', buttons: [] };
            case 'inseguro':
                return { cls: 'bad', title: 'Avisos no disponibles', text: 'Abra garita.app con la dirección segura (https://garita.app) para activar los avisos.', buttons: [] };
            default:
                return { cls: 'bad', title: 'Este navegador no recibe avisos', text: android ? 'Abra garita.app en Chrome para activar los avisos.' : 'Abra garita.app en Chrome, Edge, Firefox o Safari actualizados. En el iPhone, agregue garita.app a su pantalla de inicio.', buttons: [] };
        }
    }

    // sisdel-core.js declara SISDEL con const: es global pero NO es window.SISDEL (por eso vecino.html lo pasa en opts)
    function coreApi(o) {
        if (o.SISDEL) return o.SISDEL;
        try { return SISDEL; } catch (e) { return root.SISDEL; }
    }

    function mount(opts) {
        const o = opts || {};
        const SISDEL = coreApi(o);
        const session = o.session;
        const avisos = o.avisos;
        if (!SISDEL || !session || !avisos) return null;
        const doc = root.document;
        const canReceive = SISDEL.can('mensajes.recibir');
        if (!canReceive) return null;

        const style = doc.createElement('style');
        style.id = 'avisos-ui-css';
        style.textContent = CSS;
        doc.head.appendChild(style);

        // Campana del encabezado
        const bell = doc.createElement('button');
        bell.type = 'button';
        bell.id = 'btnAvisos';
        bell.className = 'btn btn-ghost btn-icon av-bell';
        bell.title = 'Mensajes y avisos';
        bell.setAttribute('aria-label', 'Mensajes y avisos');
        bell.innerHTML = ICON_BELL + '<span class="av-bell-dot" id="avBellDot" hidden></span>';
        const actions = doc.querySelector('.top-bar-actions');
        if (actions) actions.insertBefore(bell, actions.firstChild);

        // Invitacion debajo de la bienvenida
        const invite = doc.createElement('div');
        invite.className = 'av-invite';
        invite.id = 'avisosInvite';
        invite.hidden = true;
        const hero = doc.querySelector('.welcome-hero');
        if (hero && hero.parentNode) hero.parentNode.insertBefore(invite, hero.nextSibling);

        // Ventana
        const overlay = doc.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modalAvisos';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" aria-labelledby="avTitle">
                <div class="modal-header">
                    <h3 id="avTitle">Mensajes y avisos</h3>
                    <button class="btn btn-ghost btn-icon modal-close" type="button" id="avClose" aria-label="Cerrar">&times;</button>
                </div>
                <section class="av-phone" id="avPhone"><p>Revisando este teléfono...</p></section>
                <h4 class="av-sub">Mensajes de la administración</h4>
                <div id="avList"><p class="av-empty">Cargando...</p></div>
                <div class="av-actions"><button type="button" class="btn btn-primary" id="avOk">Entendido</button></div>
            </div>`;
        doc.body.appendChild(overlay);
        const $ = (id) => doc.getElementById(id);

        const seenKey = SEEN_PREFIX + session.userId;
        const laterKey = LATER_PREFIX + session.userId;
        let messages = [];
        let state = 'cargando';
        let note = null; // { text, err }
        let busy = false;

        const seenSet = () => new Set(readJson(seenKey, []));
        const isNew = (m) => !seenSet().has(m.id);

        async function loadMessages() {
            const all = await SISDEL.getMessages(session.condominioId);
            const since = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
            messages = (all || [])
                .filter((m) => m && (m.toRole === 'all' || m.toRole === session.role || (m.toRole === 'usuario' && m.toUserId === session.userId)))
                .filter((m) => { const t = Date.parse(m.createdAt || ''); return !isNaN(t) && t >= since; })
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                .slice(0, MAX_LIST);
            paintBell();
            return messages;
        }

        function newCount() { const seen = seenSet(); return messages.filter((m) => !seen.has(m.id)).length; }

        function paintBell() {
            const n = newCount();
            const dot = $('avBellDot');
            dot.hidden = n === 0;
            dot.textContent = n > 9 ? '9+' : String(n);
            bell.title = n ? `Mensajes y avisos (${n} nuevo${n === 1 ? '' : 's'})` : 'Mensajes y avisos';
        }

        function paintList() {
            const list = $('avList');
            if (!messages.length) { list.innerHTML = '<p class="av-empty">No hay mensajes de la administración en los últimos 60 días.</p>'; return; }
            const seen = seenSet();
            list.innerHTML = messages.map((m) => `
                <div class="av-item${seen.has(m.id) ? '' : ' nuevo'}">
                    <div class="av-item-head">
                        <strong>${esc(m.subject || 'Mensaje')}${seen.has(m.id) ? '' : '<span class="av-new">Nuevo</span>'}</strong>
                        <span class="text-xs text-muted">${esc(SISDEL.formatDateTime(m.createdAt))}</span>
                    </div>
                    <p>${esc(m.body)}</p>
                    <span class="text-xs text-muted">De: ${esc(m.fromName || 'Administración')}</span>
                </div>`).join('');
        }

        function paintPhone() {
            const box = $('avPhone');
            if (state === 'cargando') { box.className = 'av-phone'; box.innerHTML = '<p>Revisando este teléfono...</p>'; return; }
            const v = phoneView(state, avisos.device);
            box.className = 'av-phone' + (v.cls ? ' ' + v.cls : '');
            box.innerHTML = `
                <h4>${ICON_PHONE.replace('width="22" height="22"', 'width="18" height="18" style="vertical-align:-3px;margin-right:0.35rem;"')}${esc(v.title)}</h4>
                <p>${esc(v.text)}</p>
                ${v.steps ? `<ol>${v.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}
                ${v.buttons.length ? `<div class="av-btns">${v.buttons.map(([act, label, cls]) => `<button type="button" class="btn ${cls} btn-sm" data-av="${act}"${busy ? ' disabled' : ''}>${esc(label)}</button>`).join('')}</div>` : ''}
                ${note ? `<p class="av-msg${note.err ? ' err' : ''}" role="status">${esc(note.text)}</p>` : ''}`;
        }

        function paintInvite() {
            const later = readJson(laterKey, 0);
            const show = ['inactivo', 'ios-instalar', 'otro-usuario'].includes(state) && !(later && Date.now() - later < LATER_MS);
            invite.hidden = !show;
            if (!show) return;
            const v = phoneView(state, avisos.device);
            const main = state === 'ios-instalar' ? ['open', 'Ver cómo activarlos'] : ['enable', state === 'otro-usuario' ? 'Recibir aquí mis avisos' : 'Activar avisos'];
            const text = state === 'ios-instalar'
                ? 'En el iPhone llegan si agrega garita.app a su pantalla de inicio. Le mostramos cómo.'
                : state === 'otro-usuario' ? v.text : 'Los mensajes de la administración le aparecerán en el teléfono aunque tenga garita.app cerrado.';
            invite.innerHTML = `
                <span class="av-ico">${ICON_BELL}</span>
                <div>
                    <strong>${esc(state === 'ios-instalar' ? 'Reciba los avisos en su iPhone' : state === 'otro-usuario' ? v.title : 'Reciba los mensajes en su celular')}</strong>
                    ${esc(text)}
                    <div class="av-btns">
                        <button type="button" class="btn btn-primary btn-sm" data-av="${main[0]}"${busy ? ' disabled' : ''}>${esc(main[1])}</button>
                        <button type="button" class="btn btn-ghost btn-sm" data-av="later">Ahora no</button>
                    </div>
                    ${note && !overlayOpen() ? `<p class="av-msg${note.err ? ' err' : ''}" role="status" style="margin:0.5rem 0 0;font-weight:600;">${esc(note.text)}</p>` : ''}
                </div>`;
        }

        function paint() { paintPhone(); paintInvite(); paintBell(); }
        const overlayOpen = () => overlay.style.display !== 'none';

        async function refreshState() {
            try { state = (await avisos.status()).state; } catch (e) { state = 'inactivo'; }
            paint();
        }

        function errorText(e) {
            const code = String((e && e.code) || '');
            if (/not-found|unimplemented/.test(code)) return 'Los avisos todavía no están listos en el servidor. Intente más tarde.';
            if (/unavailable|deadline/.test(code)) return 'Sin conexión. Revise su internet e intente de nuevo.';
            if (e && e.name === 'NotAllowedError') return 'El teléfono no dejó activar los avisos. Revise que las notificaciones de garita.app estén permitidas.';
            return (e && e.message) || 'No se pudo completar. Intente de nuevo.';
        }

        async function act(action) {
            if (busy) return;
            if (action === 'later') { writeJson(laterKey, Date.now()); invite.hidden = true; return; }
            if (action === 'open') { open(); return; }
            if (action === 'disable' && !root.confirm('¿Dejar de recibir los avisos de garita.app en este teléfono?')) return;
            busy = true; note = null; paint();
            try {
                if (action === 'enable') {
                    const r = await avisos.enable(session.userId);
                    state = r.state;
                    note = r.ok ? { text: 'Listo: los avisos quedaron activados. Toque «Enviar aviso de prueba» para comprobarlo.' }
                        : r.state === 'bloqueado' ? { text: 'Las notificaciones quedaron bloqueadas. Siga los pasos para permitirlas.', err: true }
                            : r.state === 'inactivo' ? { text: 'No se activaron: el teléfono no dio el permiso.', err: true } : null;
                    if (r.ok) SISDEL.showToast('Avisos activados en este teléfono', 'success');
                    // Desde la invitacion: se abre la ventana para que pruebe en el momento que si le llegan
                    if (r.ok && !overlayOpen()) { busy = false; open(); }
                } else if (action === 'test') {
                    const r = await avisos.test();
                    if (r && r.ok) note = { text: 'Aviso de prueba enviado: en unos segundos le aparece en el teléfono. Si no llega, revise que las notificaciones de garita.app estén permitidas y que el teléfono no esté en «No molestar».' };
                    else if (r && r.gone) { state = 'inactivo'; note = { text: 'Este teléfono ya no recibía avisos. Toque «Activar avisos» otra vez.', err: true }; }
                    else note = { text: 'El aviso de prueba no salió. Intente de nuevo en un momento.', err: true };
                } else if (action === 'disable') {
                    const r = await avisos.disable();
                    state = r.state;
                    note = { text: 'Avisos desactivados en este teléfono.' };
                }
            } catch (e) {
                note = { text: errorText(e), err: true };
                if (action === 'enable') { try { state = (await avisos.status()).state; } catch (e2) { /* se queda como estaba */ } }
            } finally {
                busy = false;
                paint();
            }
        }

        function markSeen() {
            const seen = seenSet();
            const fresh = messages.filter((m) => !seen.has(m.id));
            fresh.forEach((m) => seen.add(m.id));
            writeJson(seenKey, [...seen].slice(-MAX_SEEN));
            // La marca `read` del mensaje es la que ve la administracion ("LEIDO"): se pone al primer vecino que lo ve
            fresh.filter((m) => !m.read && m.condominioId === session.condominioId).forEach((m) => { SISDEL.markMessageRead(m.id).catch(() => {}); });
            paintBell();
        }

        function open() {
            note = state === 'cargando' ? null : note;
            paintList();
            paint();
            overlay.style.display = 'flex';
        }
        function close() {
            overlay.style.display = 'none';
            markSeen();
            note = null;
            paint();
        }

        doc.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-av]');
            if (btn && (overlay.contains(btn) || invite.contains(btn))) act(btn.dataset.av);
        });
        bell.addEventListener('click', () => { loadMessages().then(open).catch(open); });
        $('avClose').addEventListener('click', close);
        $('avOk').addEventListener('click', close);
        overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
        doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && overlayOpen()) close(); });

        // Tocar un aviso con garita.app abierto: sw-avisos.js le avisa a esta pagina
        if (root.navigator && root.navigator.serviceWorker && root.navigator.serviceWorker.addEventListener) {
            root.navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'sisdel-aviso') loadMessages().then(open).catch(open);
            });
        }

        // Si al entrar ya hay otra ventana abierta (la de "Confirme sus datos" del primer ingreso), los mensajes esperan a que se cierre
        const otherModalOpen = () => [...doc.querySelectorAll('.modal-overlay')].some((m) => m !== overlay && m.style.display && m.style.display !== 'none');
        function openWhenFree(tries) {
            if (overlayOpen()) return;
            if (otherModalOpen() && tries < 600) { setTimeout(() => openWhenFree(tries + 1), 1000); return; }
            open();
        }
        const fromNotice = root.location && root.location.hash === '#mensajes';
        avisos.sync(session.userId);
        refreshState();
        loadMessages().then(() => {
            if (fromNotice || newCount() > 0) openWhenFree(0);
        }).catch(() => { if (fromNotice) openWhenFree(0); });

        return { open, close, refresh: refreshState, reload: loadMessages, get state() { return state; } };
    }

    root.SisdelAvisosUI = { mount, phoneView, coreApi };
}(typeof window !== 'undefined' ? window : this));
