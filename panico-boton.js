/* ═══════════════════════════════════════════════════════════════
   SISDEL - Boton de panico de mantener presionado (portal del vecino y QR de panico)
   ───────────────────────────────────────────────────────────────
   Un solo boton para las dos pantallas (vecino.html y panico.html), asi se ven y funcionan igual (pedido del usuario el
   2026-11-20: "usar exactamente el mismo procedimiento": el circulo se va llenando y, al terminar, dice ALERTA ENVIADA):

     ready     PANICO                  "Mantenga presionado 2 segundos"
     holding   el circulo se llena     "Siga presionando hasta llenar el circulo..." (el aro y el relleno suben juntos)
     sending   ENVIANDO...             el circulo ya esta lleno: se busca la ubicacion y se manda la alerta
     sent      ALERTA ENVIADA          el circulo pasa a verde con una palomita (la alerta YA esta guardada en el servidor)
     attended  ALERTA ATENDIDA         alguien de la garita o la administracion la atendio
     error     NO SE ENVIO             no se pudo: se puede volver a intentar

   Soltar antes de llenar el circulo NO envia nada y lo dice. Mientras la alerta esta enviada o atendida el boton queda
   bloqueado 30 SEGUNDOS (no se mandan alertas repetidas por tocar dos veces; pedido del usuario el 2026-11-20: "30 segundos
   despues del aviso ALERTA ENVIADA el boton estara de nuevo listo para mandar otra alerta") y el aviso cuenta los segundos;
   pasado ese tiempo vuelve a "ready" aunque la alerta siga abierta (se puede mandar otra), y vuelve antes si la alerta se
   cancela o se resuelve. Una alerta que ya libero el boton no lo vuelve a bloquear cuando llega una novedad de ella (por
   ejemplo, que la atendieron).
   El boton solo avisa (onFire): quien lo usa busca la ubicacion, crea la alerta y llama a setState. Todo el texto es fijo
   del sistema (nunca datos de la base).
   ═══════════════════════════════════════════════════════════════ */

const SisdelPanicoBoton = (() => {
    const HOLD_MS = 2000;
    const REARM_MS = 30000; // tiempo que el boton queda en "alerta enviada" antes de poder mandar otra
    const RING_LENGTH = 292.2; // perimetro del aro (radio 46.5 en un cuadro de 100)

    const STATES = {
        ready: { label: 'PÁNICO', icon: 'alert', hint: 'Mantenga presionado 2 segundos' },
        holding: { label: 'PÁNICO', icon: 'alert', hint: 'Siga presionando hasta llenar el círculo...' },
        sending: { label: 'ENVIANDO...', icon: 'spin', hint: 'Enviando su alerta: no cierre esta página.' },
        sent: { label: 'ALERTA ENVIADA', icon: 'check', hint: 'La garita y la administración ya fueron avisadas.' },
        attended: { label: 'ALERTA ATENDIDA', icon: 'check', hint: 'Su alerta ya fue atendida.' },
        error: { label: 'NO SE ENVIÓ', icon: 'alert', hint: 'No se pudo enviar. Intente de nuevo o llame a la garita por teléfono.' }
    };
    const LOCKED = ['sending', 'sent', 'attended']; // en estos estados el boton no recibe pulsaciones
    const EARLY_RELEASE_HINT = 'No se envió: mantenga presionado hasta llenar el círculo.';
    const REARMED_HINT = 'Ya puede enviar otra alerta si la necesita.';
    const isConfirmed = (state) => state === 'sent' || state === 'attended';

    // Que estado le toca al boton segun el estado de la alerta del vecino (ACTIVE, ATTENDED, RESOLVED, CANCELLED...)
    function stateForAlert(status) {
        if (status === 'ACTIVE') return 'sent';
        if (status === 'ATTENDED') return 'attended';
        return 'ready'; // sin alerta, cancelada o resuelta: otra vez disponible
    }
    // Espera una promesa, pero no mas de `ms`: sin internet un envio puede quedarse esperando para siempre y el boton se
    // quedaria en "ENVIANDO..." sin decir nada. Con el limite se avisa y se puede volver a intentar o llamar
    function withTimeout(promise, ms, message) {
        let timer;
        const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message || 'tiempo agotado')), ms); });
        return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
    }

    const ICONS = {
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
        spin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true" class="pb-spin"><path d="M12 3a9 9 0 1 0 9 9" /></svg>'
    };

    const CSS = `
        .pb-host { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; }
        .pb-wrap { position: relative; width: var(--pb-size, 12rem); height: var(--pb-size, 12rem); flex: none; }
        /* El aro: se llena como un reloj (de arriba hacia la derecha) mientras se mantiene presionado */
        .pb-ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); pointer-events: none; overflow: visible; }
        .pb-ring circle { fill: none; stroke-width: 5; }
        .pb-track { stroke: rgba(220, 38, 38, 0.3); transition: stroke 0.4s; }
        .pb-prog { stroke: #fecaca; stroke-linecap: round; stroke-dasharray: ${RING_LENGTH}; stroke-dashoffset: ${RING_LENGTH}; transition: stroke-dashoffset 0.25s ease-out, stroke 0.4s; }
        .pb-btn { position: absolute; inset: 7%; width: 86%; height: 86%; border-radius: 50%; border: none; padding: 0; overflow: hidden; color: #fff; cursor: pointer;
            background: radial-gradient(circle at 50% 38%, #ef4444, #b91c1c 70%); box-shadow: 0 12px 30px rgba(220, 38, 38, 0.45);
            touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
            font: inherit; transition: box-shadow 0.4s, transform 0.15s; }
        .pb-btn:active { transform: scale(0.98); }
        .pb-btn:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
        /* El relleno sube de abajo hacia arriba y tarda lo mismo que el aro */
        .pb-fill { position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: rgba(255, 255, 255, 0.3); transition: height 0.25s ease-out; }
        /* La capa verde de "enviada": aparece encima cuando la alerta ya quedo guardada */
        .pb-done { position: absolute; inset: 0; opacity: 0; background: radial-gradient(circle at 50% 38%, #22c55e, #15803d 70%); transition: opacity 0.4s; }
        .pb-face { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(var(--pb-size, 12rem) * 0.03);
            text-align: center; padding: 0 12%; box-sizing: border-box; }
        .pb-ico { width: calc(var(--pb-size, 12rem) * 0.26); height: calc(var(--pb-size, 12rem) * 0.26); display: flex; }
        .pb-ico svg { width: 100%; height: 100%; }
        .pb-label { font-weight: 900; font-size: calc(var(--pb-size, 12rem) * 0.095); line-height: 1.1; letter-spacing: 0.06em; }
        .pb-spin { animation: pbSpin 0.9s linear infinite; }
        @keyframes pbSpin { to { transform: rotate(360deg); } }
        .pb-hint { margin: 0; max-width: calc(var(--pb-size, 12rem) * 1.3); text-align: center; font-weight: 700; font-size: 0.85rem; line-height: 1.3; color: var(--text-secondary, #cbd5e1); }
        .pb-hint.warn { color: #d97706; }

        /* holding: el aro y el relleno suben juntos durante todo el tiempo que hay que mantener presionado */
        .pb-wrap[data-state="holding"] .pb-prog { stroke-dashoffset: 0; transition: stroke-dashoffset var(--pb-hold, 2000ms) linear; }
        .pb-wrap[data-state="holding"] .pb-fill { height: 100%; transition: height var(--pb-hold, 2000ms) linear; }
        /* sending: ya esta lleno */
        .pb-wrap[data-state="sending"] .pb-prog, .pb-wrap[data-state="sent"] .pb-prog, .pb-wrap[data-state="attended"] .pb-prog { stroke-dashoffset: 0; }
        .pb-wrap[data-state="sending"] .pb-fill { height: 100%; transition: none; }
        .pb-wrap[data-state="sending"] .pb-btn { cursor: progress; }
        /* sent y attended: verde y con palomita */
        .pb-wrap[data-state="sent"] .pb-done, .pb-wrap[data-state="attended"] .pb-done { opacity: 1; }
        .pb-wrap[data-state="sent"] .pb-btn, .pb-wrap[data-state="attended"] .pb-btn { box-shadow: 0 12px 30px rgba(22, 163, 74, 0.45); cursor: default; }
        .pb-wrap[data-state="sent"] .pb-prog, .pb-wrap[data-state="attended"] .pb-prog { stroke: #bbf7d0; }
        .pb-wrap[data-state="sent"] .pb-track, .pb-wrap[data-state="attended"] .pb-track { stroke: rgba(22, 163, 74, 0.35); }
        .pb-wrap[data-state="sent"] .pb-fill, .pb-wrap[data-state="attended"] .pb-fill { height: 0; transition: none; }
        @media (prefers-reduced-motion: reduce) { .pb-spin { animation-duration: 2.4s; } }`;

    // Monta el boton dentro de `host`. opts: { size: '12rem' (cualquier medida CSS), holdMs, rearmMs (30000; 0 = nunca vuelve solo),
    // onHoldStart(), onFire() }. Devuelve { setState(estado, alerta, desde), state(), flashHint(texto) }
    function mount(host, opts = {}) {
        if (!document.getElementById('pbStyles')) {
            const style = document.createElement('style');
            style.id = 'pbStyles';
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const holdMs = opts.holdMs || HOLD_MS;
        const rearmMs = opts.rearmMs === undefined ? REARM_MS : opts.rearmMs;
        host.classList.add('pb-host');
        host.innerHTML = `
            <div class="pb-wrap" data-state="ready">
                <svg class="pb-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="pb-track" cx="50" cy="50" r="46.5"/><circle class="pb-prog" cx="50" cy="50" r="46.5"/></svg>
                <button class="pb-btn" type="button">
                    <span class="pb-fill"></span><span class="pb-done"></span>
                    <span class="pb-face"><span class="pb-ico"></span><span class="pb-label"></span></span>
                </button>
            </div>
            <p class="pb-hint" role="status" aria-live="polite"></p>`;
        const wrap = host.querySelector('.pb-wrap');
        const btn = host.querySelector('.pb-btn');
        const ico = host.querySelector('.pb-ico');
        const label = host.querySelector('.pb-label');
        const hint = host.querySelector('.pb-hint');
        wrap.style.setProperty('--pb-size', opts.size || '12rem');
        wrap.style.setProperty('--pb-hold', `${holdMs}ms`);

        let state = 'ready';
        let holdTimer = null;
        let hintTimer = null;
        let rearmTimer = null;  // repinta la cuenta de segundos de "alerta enviada"
        let rearmEndTimer = null; // y libera el boton justo cuando se cumple el tiempo
        let rearmEnd = 0;
        let rearmKey = null;    // la alerta (su id) que tiene bloqueado el boton
        const released = new Set(); // alertas que ya liberaron el boton: una novedad suya no lo vuelve a bloquear

        const secondsLeft = () => Math.max(0, Math.ceil((rearmEnd - Date.now()) / 1000));
        // El texto bajo el boton; con la alerta enviada o atendida dice cuantos segundos faltan para poder mandar otra
        function paintHint() {
            const s = STATES[state];
            hint.classList.toggle('warn', state === 'error');
            hint.textContent = rearmTimer ? `${s.hint} Otra alerta en ${secondsLeft()} s.` : s.hint;
        }
        function stopRearm() { clearInterval(rearmTimer); clearTimeout(rearmEndTimer); rearmTimer = null; rearmEndTimer = null; }
        function startRearm(key, remaining) {
            stopRearm();
            rearmKey = key;
            rearmEnd = Date.now() + remaining;
            rearmTimer = setInterval(paintHint, 250);
            rearmEndTimer = setTimeout(release, remaining);
        }
        // Pasaron los 30 segundos: el boton vuelve a estar listo aunque la alerta siga abierta
        function release() {
            stopRearm();
            if (rearmKey != null) released.add(rearmKey);
            rearmKey = null;
            setState('ready');
            flashHint(REARMED_HINT, 4000, false);
        }

        // alerta: el id de la alerta a la que corresponde el estado (para no bloquear dos veces por la misma);
        // desde: cuando se creo la alerta (ms), solo al volver a abrir la pagina con una alerta de hace rato: descuenta el tiempo ya pasado
        function setState(next, alerta, desde) {
            if (!STATES[next]) return;
            const wasConfirmed = isConfirmed(state);
            if (isConfirmed(next)) {
                if (alerta != null && released.has(alerta)) return; // esa alerta ya libero el boton
                if (!wasConfirmed && rearmMs > 0) {
                    let remaining = rearmMs;
                    if (desde) remaining = Math.min(rearmMs, rearmMs - (Date.now() - desde));
                    if (remaining <= 0) { if (alerta != null) released.add(alerta); return; } // una alerta de hace rato: el boton queda listo
                    startRearm(alerta == null ? null : alerta, remaining);
                } else if (alerta != null && rearmKey == null) rearmKey = alerta;
            } else stopRearm();
            state = next;
            const s = STATES[next];
            wrap.dataset.state = next;
            ico.innerHTML = ICONS[s.icon];
            label.textContent = s.label;
            btn.setAttribute('aria-label', next === 'ready' || next === 'holding' ? 'Botón de pánico: mantener presionado 2 segundos' : `${s.label}. ${s.hint}`);
            clearTimeout(hintTimer);
            paintHint();
        }
        // Un aviso corto bajo el boton (por ejemplo, al soltar antes de tiempo); despues vuelve el texto del estado
        function flashHint(text, ms = 3500, warn = true) {
            clearTimeout(hintTimer);
            hint.classList.toggle('warn', warn);
            hint.textContent = text;
            hintTimer = setTimeout(paintHint, ms);
        }

        function fire() {
            holdTimer = null;
            setState('sending');
            Promise.resolve().then(() => (opts.onFire ? opts.onFire() : null)).catch((e) => { console.error(e); setState('error'); });
        }
        function holdStart(e) {
            if (LOCKED.includes(state) || holdTimer) return;
            e.preventDefault();
            if (opts.onHoldStart) opts.onHoldStart(); // por ejemplo, pedir y calentar el GPS mientras pasan los 2 segundos
            setState('holding');
            holdTimer = setTimeout(fire, holdMs);
        }
        function holdEnd() {
            if (!holdTimer) return;
            clearTimeout(holdTimer);
            holdTimer = null;
            setState('ready'); // el aro y el relleno bajan solos
            flashHint(EARLY_RELEASE_HINT);
        }
        btn.addEventListener('pointerdown', holdStart);
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, holdEnd));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        // Teclado: una confirmacion en lugar de mantener presionado
        btn.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !LOCKED.includes(state)) {
                e.preventDefault();
                if (confirm('¿Activar la alerta de pánico?')) { if (opts.onHoldStart) opts.onHoldStart(); fire(); }
            }
        });

        setState('ready');
        return { setState, state: () => state, flashHint };
    }

    return { HOLD_MS, REARM_MS, STATES, LOCKED, EARLY_RELEASE_HINT, REARMED_HINT, stateForAlert, withTimeout, mount };
})();

if (typeof module === 'object' && module.exports) module.exports = SisdelPanicoBoton;
