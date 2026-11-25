/* ═══════════════════════════════════════════════════════════════
   SISDEL - Aviso de alertas de panico en pantalla
   ───────────────────────────────────────────────────────────────
   Barra roja fija arriba con cada alerta sin resolver (vecinos y guardias),
   SIRENA DE ALERTA MAXIMA (pedido del usuario el 2026-11-24): suena sin parar,
   con la pantalla destellando en rojo, mientras haya una alerta real sin atender;
   se calla al atenderla (o con "Silenciar").
   PRUEBA DEL VECINO, "TODO SIN NOVEDAD" (la alerta con simulacro: true; pedido del usuario el
   2026-11-25): en verde, SIN sirena ni destello, y con { autoReceiveTests } (la garita) esta
   pantalla la recibe sola y la cierra sola a los 2 minutos (panico-prueba.js: lo que ve el vecino).
   La usan garita.html (Control Garita), admin.html y finanzas.html (OIKOS);
   RONDIN tiene su propia alarma de panico.
   AUDIO (2026-11-24): "Escuchar / Hablar" en cada alerta de un vecino llama al
   telefono del vecino, que contesta solo mientras tenga abierta la pagina del boton
   (audio-panico.js); la garita escucha y, con "Hablar", le habla.
   Requiere rondas-core.js (SisdelRondas ya inicializado), sirena.js y audio-panico.js.
   ═══════════════════════════════════════════════════════════════ */

const SisdelPanico = (() => {
    // La prueba del vecino lleva un escudo con palomita (no el triangulo de alerta): no es una emergencia
    const ICON_TEST = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';
    const ICON_ALERT = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    const CSS = `
        .pan-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 3000; display: flex; flex-direction: column; gap: 4px; padding: 6px; pointer-events: none; }
        .pan-item { pointer-events: auto; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.75rem 1rem;
            border-radius: 12px; background: #b91c1c; color: #fff; box-shadow: 0 10px 25px rgba(0,0,0,0.4); font-family: inherit; }
        .pan-item.active { animation: panPulse 1.2s ease-in-out infinite; }
        .pan-item.attended { background: #92400e; }
        /* Prueba del vecino, "todo sin novedad" (2026-11-25; antes simulacro en azul): en verde y sin latir; dice que NO es una emergencia */
        .pan-item.drill { background: #047857; animation: none; }
        .pan-item.drill.attended { background: #065f46; }
        .pan-item.drill button.solid { color: #047857; }
        .pan-item .pan-text { flex: 1; min-width: 200px; font-size: 0.9rem; line-height: 1.35; }
        .pan-item .pan-title { font-weight: 800; letter-spacing: 0.04em; font-size: 0.95rem; }
        .pan-item a, .pan-item button { font: inherit; font-size: 0.8rem; font-weight: 700; color: #fff; text-decoration: none; cursor: pointer;
            border: 1px solid rgba(255,255,255,0.6); background: rgba(255,255,255,0.12); border-radius: 8px; padding: 0.45rem 0.75rem; }
        .pan-item button.solid { background: #fff; color: #b91c1c; border-color: #fff; }
        .pan-bar.min { left: auto; }
        .pan-pill { pointer-events: auto; align-self: flex-end; border: none; border-radius: 999px; padding: 0.5rem 0.9rem; font: inherit; font-size: 0.8rem;
            font-weight: 800; color: #fff; background: #b91c1c; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,0.35); }
        .pan-min { align-self: flex-end; pointer-events: auto; }
        @keyframes panPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.7); } 50% { box-shadow: 0 0 0 10px rgba(239,68,68,0); } }
        /* Mientras suena la sirena: toda la pantalla destella en rojo (no tapa los clics) */
        .pan-flash { position: fixed; inset: 0; z-index: 2999; pointer-events: none; background: rgba(220,38,38,0.38); animation: panFlash 0.9s steps(2, jump-none) infinite; }
        @keyframes panFlash { 0% { opacity: 1; } 100% { opacity: 0; } }
        .pan-item button.pan-mute { background: #fde047; color: #7f1d1d; border-color: #fde047; }
        /* El vecino toco "HABLAR A CENTRAL DE MONITOREO": su "Escuchar / Hablar" late en amarillo (2026-11-25) */
        .pan-want { display: inline-block; margin-left: 0.4rem; padding: 0.05rem 0.5rem; border-radius: 999px; background: #facc15; color: #1f2937; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.3px; vertical-align: middle; }
        .pan-item button.want { background: #facc15; color: #1f2937; border-color: #facc15; font-weight: 800; animation: panWant 1s ease-in-out infinite; }
        @keyframes panWant { 50% { box-shadow: 0 0 0 6px rgba(250, 204, 21, 0.35); } }
        /* El navegador no deja sonar nada hasta el primer toque: este boton lo pide (y se va solo) */
        /* La llamada de audio con el vecino */
        .pan-call { position: fixed; left: 12px; bottom: 12px; z-index: 3002; width: min(400px, calc(100vw - 24px)); box-sizing: border-box; padding: 0.9rem 1rem;
            border-radius: 14px; background: #0f172a; color: #f8fafc; border: 2px solid #60a5fa; box-shadow: 0 12px 30px rgba(0,0,0,0.5); font-family: inherit; }
        .pan-call .pan-call-title { font-weight: 800; font-size: 0.95rem; margin: 0 0 0.25rem; }
        .pan-call .pan-call-state { font-size: 0.85rem; line-height: 1.4; margin: 0 0 0.7rem; color: #cbd5e1; }
        .pan-call .pan-call-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .pan-call button { font: inherit; font-size: 0.85rem; font-weight: 800; cursor: pointer; border-radius: 10px; padding: 0.6rem 0.9rem; border: 1px solid #475569; background: #1e293b; color: #fff; }
        .pan-call button.talk-on { background: #16a34a; border-color: #16a34a; }
        .pan-call button.hang { background: #b91c1c; border-color: #b91c1c; }
        .pan-call.nomic { border-color: #f59e0b; }
        .pan-call.nomic .pan-call-state { color: #fde68a; font-weight: 700; }
        .pan-sound { position: fixed; right: 12px; bottom: 12px; z-index: 3001; border: 2px solid #fca5a5; border-radius: 999px; padding: 0.6rem 1rem;
            font: inherit; font-size: 0.85rem; font-weight: 800; color: #fff; background: #b91c1c; cursor: pointer; box-shadow: 0 8px 22px rgba(0,0,0,0.45); }
    `;

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function ago(iso) {
        const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
        if (minutes < 1) return 'ahora';
        if (minutes < 60) return `hace ${minutes} min`;
        return `hace ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    }

    // La sirena (sirena.js, SisdelSirena): la misma en Control Garita, el panel, OIKOS y los telefonos de la casa (panico.html)
    const S = SisdelSirena;
    const audioReady = () => S.ready();
    const wakeAudio = () => S.wake();
    const startSiren = () => S.start();
    const stopSiren = () => S.stop();
    const beep = () => S.beep();

    // Prueba del vecino: la nota que deja esta pantalla al recibirla sola y la de cuando la cierra. Son las de panico-prueba.js (una
    // prueba exige que sean iguales: el vecino ve "automatico" por esa nota)
    const AUTO_RECEIVED_NOTE = 'Prueba recibida automáticamente por la pantalla de la garita: todo sin novedad.';
    const AUTO_CLOSE_NOTE = 'Prueba del vecino: la recibió la pantalla de la garita, todo sin novedad. Se cerró sola.';
    const AUTO_CLOSE_MS = 120000;

    // Empieza a escuchar las alertas. options: { canResolve, readOnly, autoReceiveTests (la garita: recibe y cierra sola cada prueba
    // del vecino), onChange(alerts) }
    function watch(options = {}) {
        if (!document.getElementById('pan-style')) {
            const style = document.createElement('style');
            style.id = 'pan-style';
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const bar = document.createElement('div');
        bar.className = 'pan-bar';
        document.body.appendChild(bar);
        const seen = new Set();
        let alerts = [];
        let minimized = false;
        // La primera lectura de las alertas (al abrir la pagina): un "PIDE HABLAR" que ya estaba no hace sonar los tonos. Se habia
        // quitado con la prueba "todo sin novedad" y el aviso de PIDE HABLAR (que se escribio a la par) lo seguia usando: la lectura
        // fallaba con "first is not defined" y la barra no se repintaba hasta la siguiente
        let first = true;

        // ── Sirena de alerta maxima ──
        // Suena mientras haya una alerta REAL sin atender que no se silencio; una prueba del vecino (simulacro) NUNCA suena (antes 4
        // segundos). Con la sirena, la pantalla destella en rojo, el titulo de la pestana parpadea (se ve aunque la pestana no este al
        // frente) y vibra (Android)
        const silenced = new Set();
        let ownSiren = false;
        // "HABLAR A CENTRAL DE MONITOREO" (audioWant, lo escribe panicAudio 'want'): se ve hasta que se le llama despues de pedirlo
        const calledWant = new Map(); // alerta -> el audioWant.at que ya se atendio con una llamada desde esta pagina
        const wantSeen = new Map();   // alerta -> el ultimo audioWant.at que ya sono
        function wantsToTalk(a) {
            const w = a.audioWant;
            return !!w && !w.calledAt && ['ACTIVE', 'ATTENDED'].includes(a.status) && calledWant.get(a.id) !== w.at;
        }
        const flash = document.createElement('div');
        flash.className = 'pan-flash';
        flash.hidden = true;
        document.body.appendChild(flash);
        const baseTitle = document.title;
        let blink = null;
        let shake = null;
        function sirenWanted() {
            const real = alerts.some((a) => a.simulacro !== true && a.status === 'ACTIVE' && !silenced.has(a.id));
            return { real };
        }
        function updateSiren() {
            const want = sirenWanted();
            // Solo calla la sirena que encendio el aviso (no la de "Probar la sirena" de la Central de Monitoreo). La prueba del vecino nunca suena
            if (want.real) { startSiren(); ownSiren = true; } else if (ownSiren) { stopSiren(); ownSiren = false; }
            flash.hidden = !want.real;
            if (want.real && !blink) {
                let on = false;
                blink = setInterval(() => { on = !on; document.title = on ? '¡ALERTA DE PÁNICO!' : baseTitle; }, 700);
                const canVibrate = navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);
                if (canVibrate) { navigator.vibrate([600, 200, 600]); shake = setInterval(() => navigator.vibrate([600, 200, 600]), 2500); }
            }
            if (!want.real && blink) {
                clearInterval(blink); blink = null; document.title = baseTitle;
                if (shake) { clearInterval(shake); shake = null; if (navigator.vibrate) navigator.vibrate(0); }
            }
        }
        // ── Audio con el vecino (audio-panico.js): una llamada a la vez ──
        const canCall = !options.readOnly && typeof SisdelAudioPanico !== 'undefined' && SisdelAudioPanico.supported() && !!(window.sisdelFirebase && window.sisdelFirebase.functions);
        let callCtl = null;
        let callBox = null;
        function closeCall() {
            if (callCtl) { callCtl.hangup(); callCtl = null; }
            if (callBox) { callBox.remove(); callBox = null; }
        }
        function openCall(a) {
            closeCall();
            if (a.audioWant) calledWant.set(a.id, a.audioWant.at); // ya se le llamo: deja de decir "PIDE HABLAR"
            silenced.add(a.id); // la sirena taparia el audio
            updateSiren(); render();
            callBox = document.createElement('div');
            callBox.className = 'pan-call';
            callBox.setAttribute('role', 'dialog');
            callBox.innerHTML = `<p class="pan-call-title">Audio con ${esc(a.userName)}${a.casa ? ' · ' + esc(a.casa) : ''}</p>
                <p class="pan-call-state">Preparando la llamada...</p>
                <div class="pan-call-row"><button type="button" data-talk="1" disabled>Hablar</button><button type="button" class="hang" data-hang="1">Colgar</button></div>`;
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.setAttribute('playsinline', '');
            callBox.appendChild(audio);
            document.body.appendChild(callBox);
            const box = callBox;
            const fn = window.sisdelFirebase.functions.httpsCallable('panicAudio');
            const call = (action, data) => fn({ action, c: a.condominioId || options.condoId || '', alertId: a.id, ...data }).then((r) => r.data);
            const ctl = SisdelAudioPanico.callNeighbor({
                call, audioEl: audio,
                onState: (state, text, info) => {
                    if (!box.isConnected) return;
                    box.querySelector('.pan-call-state').textContent = text || '';
                    // El telefono del vecino dice si dio el microfono (audio-panico.js): sin el, la central no lo escucha y se ve en ambar
                    box.classList.toggle('nomic', !!(info && info.neighborMic === false) && state === 'conectado');
                    const talk = box.querySelector('[data-talk]');
                    talk.disabled = state !== 'conectado';
                    if (['sin_respuesta', 'colgado', 'error'].includes(state)) {
                        if (callCtl === ctl) callCtl = null;
                        box.querySelector('.pan-call-row').innerHTML = `<button type="button" data-retry="1">Volver a llamar</button><button type="button" data-close="1">Cerrar</button>`;
                    }
                }
            });
            callCtl = ctl;
            box.addEventListener('click', (e) => {
                if (e.target.closest('[data-talk]')) {
                    ctl.setTalk(!ctl.talking);
                    const b = e.target.closest('[data-talk]');
                    b.textContent = ctl.talking ? 'Dejar de hablar (le está oyendo)' : 'Hablar';
                    b.classList.toggle('talk-on', ctl.talking);
                }
                if (e.target.closest('[data-hang]')) ctl.hangup();
                if (e.target.closest('[data-close]')) { if (callBox === box) closeCall(); else box.remove(); }
                if (e.target.closest('[data-retry]')) openCall(alerts.find((x) => x.id === a.id) || a);
            });
        }

        // El boton que pide activar el sonido (el navegador no deja sonar nada hasta el primer toque o tecla en la pagina).
        // options.soundButton === false: la pagina tiene su propio indicador de la sirena (la Central de Monitoreo, en su encabezado)
        const soundBtn = options.soundButton === false ? null : document.createElement('button');
        if (soundBtn) {
            soundBtn.type = 'button';
            soundBtn.className = 'pan-sound';
            soundBtn.textContent = 'Toque aquí para activar la sirena de alertas de pánico';
            document.body.appendChild(soundBtn);
            soundBtn.addEventListener('click', () => { wakeAudio(); setTimeout(paintSoundBtn, 300); });
        }
        function paintSoundBtn() { if (soundBtn) soundBtn.hidden = audioReady(); if (audioReady()) updateSiren(); }
        const offReady = S.onReady(paintSoundBtn);
        S.arm(); // sin esperar un toque, si el navegador lo deja (la central instalada como aplicacion)
        setTimeout(paintSoundBtn, 1500);

        function render() {
            bar.classList.toggle('min', minimized && alerts.length > 0);
            if (minimized && alerts.length) {
                const real = alerts.filter((a) => a.simulacro !== true);
                const drills = alerts.length - real.length;
                const active = real.filter((a) => a.status === 'ACTIVE').length;
                bar.innerHTML = `<button class="pan-pill" data-expand="1">${real.length ? `${real.length} alerta(s) de pánico${active ? ` · ${active} sin atender` : ''}` : ''}${real.length && drills ? ' · ' : ''}${drills ? `${drills} prueba(s) sin novedad` : ''}</button>`;
                return;
            }
            bar.innerHTML = (alerts.length ? '<button class="pan-pill pan-min" data-minimize="1">Minimizar</button>' : '') + alerts.map((a) => {
                const who = a.source === 'guardia' ? `Guardia: ${esc(a.userName)}` : `Vecino: ${esc(a.userName)}${a.casa ? ' · ' + esc(a.casa) : ''}`;
                const phone = a.phone ? ` · Tel. <a href="tel:${esc(a.phone)}" style="border:none;padding:0;background:none;text-decoration:underline;">${esc(a.phone)}</a>` : '';
                const map = (typeof a.lat === 'number' && typeof a.lng === 'number') ? `<a href="${esc(SisdelRondas.mapsLink(a.lat, a.lng))}" target="_blank" rel="noopener">Ver ubicación</a>` : '<span style="font-size:0.75rem;opacity:0.85;">Sin GPS</span>';
                const drill = a.simulacro === true;
                const state = a.status === 'ATTENDED' ? ` · ${drill ? (a.notes === AUTO_RECEIVED_NOTE ? 'Recibida automáticamente por la pantalla de' : 'Recibida por') : 'Atendida por'} ${esc(a.attendedByName || '')}` : '';
                // El vecino pidio hablar (y todavia no se le llamo despues de pedirlo)
                const wants = a.source === 'vecino' && wantsToTalk(a);
                const wantBadge = wants ? `<span class="pan-want">${a.audioWant.mic === false ? 'PIDE HABLAR · SIN MICRÓFONO' : 'PIDE HABLAR'}</span>` : '';
                return `
                <div class="pan-item ${a.status === 'ACTIVE' ? 'active' : 'attended'}${drill ? ' drill' : ''}" role="${drill ? 'status' : 'alert'}">
                    ${drill ? ICON_TEST : ICON_ALERT}
                    <div class="pan-text">
                        <div class="pan-title">${drill ? 'PRUEBA DEL VECINO · TODO SIN NOVEDAD' : 'ALERTA DE PÁNICO'}</div>
                        <div>${who}${phone}${wantBadge}</div>
                        <div style="font-size:0.78rem;opacity:0.9;">${esc(ago(a.createdAt))}${state}${drill ? ' · No es una emergencia: no hay que ir al lugar. El vecino está comprobando que su botón funciona.' : ''}</div>
                    </div>
                    ${map}
                    ${a.status === 'ACTIVE' && !drill && !silenced.has(a.id) ? `<button class="pan-mute" data-mute="${esc(a.id)}" title="Calla la sirena de esta alerta (la alerta sigue en pantalla)">Silenciar</button>` : ''}
                    ${canCall && a.source === 'vecino' ? `<button data-call="${esc(a.id)}"${wants ? ' class="want"' : ''} title="Llama al teléfono del vecino por internet: escucha lo que pasa y puede hablarle (contesta solo si tiene abierta la página del botón)">Escuchar / Hablar</button>` : ''}
                    ${a.status === 'ACTIVE' && !options.readOnly ? `<button class="solid" data-attend="${esc(a.id)}">${drill ? 'Marcar recibida' : 'Atender'}</button>` : ''}
                    ${options.canResolve && !options.readOnly ? `<button data-resolve="${esc(a.id)}" data-drill="${drill ? '1' : ''}">${drill ? 'Cerrar prueba' : 'Resolver'}</button>` : ''}
                </div>`;
            }).join('');
        }

        bar.addEventListener('click', async (e) => {
            if (e.target.closest('[data-minimize]')) { minimized = true; render(); return; }
            if (e.target.closest('[data-expand]')) { minimized = false; render(); return; }
            const mute = e.target.closest('[data-mute]');
            if (mute) { silenced.add(mute.dataset.mute); updateSiren(); render(); return; }
            const callBtn = e.target.closest('[data-call]');
            if (callBtn) { const a = alerts.find((x) => x.id === callBtn.dataset.call); if (a) openCall(a); return; }
            const attend = e.target.closest('[data-attend]');
            const resolve = e.target.closest('[data-resolve]');
            try {
                if (attend) { attend.disabled = true; await SisdelRondas.attendPanic(attend.dataset.attend); }
                if (resolve) {
                    const notes = prompt('¿Qué pasó? (queda en el registro)', resolve.dataset.drill ? 'Prueba del vecino: todo sin novedad' : '');
                    if (notes === null) return;
                    resolve.disabled = true;
                    await SisdelRondas.resolvePanic(resolve.dataset.resolve, notes);
                }
            } catch (error) {
                console.error('Alerta de panico:', error);
                SISDEL.showToast('No se pudo actualizar la alerta', 'error');
            }
        });

        // ── Prueba del vecino en la garita: esta pantalla la recibe sola (el vecino ve que llego) y la cierra sola a los 2 minutos ──
        const autoTests = !!options.autoReceiveTests && !options.readOnly;
        const autoTried = new Set();
        const closeTimers = new Map();
        function handleTests(list) {
            if (!autoTests) return;
            list.filter((a) => a.simulacro === true).forEach((a) => {
                if (a.status === 'ACTIVE' && !autoTried.has(a.id)) {
                    autoTried.add(a.id);
                    SisdelRondas.attendPanic(a.id, AUTO_RECEIVED_NOTE).catch((e) => console.warn('prueba del vecino', e && (e.code || e.message)));
                }
                if (a.status === 'ATTENDED' && options.canResolve && !closeTimers.has(a.id)) {
                    const wait = Math.max(0, (Date.parse(a.attendedAt || '') || Date.now()) + AUTO_CLOSE_MS - Date.now());
                    closeTimers.set(a.id, setTimeout(() => {
                        const cur = alerts.find((x) => x.id === a.id);
                        if (cur && cur.status === 'ATTENDED' && cur.simulacro === true) {
                            SisdelRondas.resolvePanic(a.id, AUTO_CLOSE_NOTE).catch((e) => console.warn('prueba del vecino', e && (e.code || e.message)));
                        }
                    }, wait));
                }
            });
        }

        const unsubscribe = SisdelRondas.subscribeActivePanics((list) => {
            // Una prueba del vecino no abre la barra minimizada (no es una emergencia); una alerta real nueva, siempre
            const fresh = list.filter((a) => a.status === 'ACTIVE' && !seen.has(a.id) && a.simulacro !== true);
            list.forEach((a) => seen.add(a.id));
            alerts = list;
            if (fresh.length) minimized = false; // una alerta nueva siempre se muestra completa
            // El vecino acaba de pedir hablar: se muestra completa y, si la sirena no esta sonando, unos tonos para que se note
            const wantNew = list.filter((a) => wantsToTalk(a) && wantSeen.get(a.id) !== a.audioWant.at);
            wantNew.forEach((a) => wantSeen.set(a.id, a.audioWant.at));
            if (wantNew.length) { minimized = false; if (!first && !S.playing()) beep(); }
            // Una alerta real suena hasta que se atienda (updateSiren); una prueba del vecino nunca suena. Al abrir la pagina con
            // alertas reales activas tambien suena (las que se silenciaron en esta pagina siguen calladas)
            render();
            updateSiren();
            handleTests(list);
            first = false;
            if (options.onChange) options.onChange(list);
        }, (error) => console.error('Alertas de panico:', error));

        // Refresca el "hace N min"
        const timer = setInterval(render, 30000);
        return () => {
            unsubscribe(); clearInterval(timer); alerts = []; closeTimers.forEach((t) => clearTimeout(t)); closeTimers.clear(); updateSiren(); stopSiren(); closeCall();
            offReady(); bar.remove(); flash.remove(); if (soundBtn) soundBtn.remove();
        };
    }

    return { watch, beep };
})();
