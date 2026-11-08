/* ═══════════════════════════════════════════════════════════════
   SISDEL - Aviso de alertas de panico en pantalla
   ───────────────────────────────────────────────────────────────
   Barra roja fija arriba con cada alerta sin resolver (vecinos y guardias),
   sonido al llegar una nueva y botones para atender y resolver.
   La usan garita.html, rondin.html y rondas.html.
   Requiere rondas-core.js (SisdelRondas ya inicializado).
   ═══════════════════════════════════════════════════════════════ */

const SisdelPanico = (() => {
    const ICON_ALERT = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    const CSS = `
        .pan-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 3000; display: flex; flex-direction: column; gap: 4px; padding: 6px; pointer-events: none; }
        .pan-item { pointer-events: auto; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.75rem 1rem;
            border-radius: 12px; background: #b91c1c; color: #fff; box-shadow: 0 10px 25px rgba(0,0,0,0.4); font-family: inherit; }
        .pan-item.active { animation: panPulse 1.2s ease-in-out infinite; }
        .pan-item.attended { background: #92400e; }
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
    `;

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function ago(iso) {
        const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
        if (minutes < 1) return 'ahora';
        if (minutes < 60) return `hace ${minutes} min`;
        return `hace ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    }

    // Sirena corta con WebAudio (sin archivos de sonido)
    let audioCtx = null;
    function beep() {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.connect(gain); gain.connect(audioCtx.destination);
            gain.gain.value = 0.08;
            const t = audioCtx.currentTime;
            [0, 0.35, 0.7].forEach((d) => { osc.frequency.setValueAtTime(880, t + d); osc.frequency.setValueAtTime(660, t + d + 0.17); });
            osc.start(t); osc.stop(t + 1.05);
        } catch { /* sin audio */ }
    }

    // Empieza a escuchar las alertas. options: { canResolve, readOnly, onChange(alerts) }
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
        let first = true;
        let minimized = false;

        function render() {
            bar.classList.toggle('min', minimized && alerts.length > 0);
            if (minimized && alerts.length) {
                const active = alerts.filter((a) => a.status === 'ACTIVE').length;
                bar.innerHTML = `<button class="pan-pill" data-expand="1">${alerts.length} alerta(s) de pánico${active ? ` · ${active} sin atender` : ''}</button>`;
                return;
            }
            bar.innerHTML = (alerts.length ? '<button class="pan-pill pan-min" data-minimize="1">Minimizar</button>' : '') + alerts.map((a) => {
                const who = a.source === 'guardia' ? `Guardia: ${esc(a.userName)}` : `Vecino: ${esc(a.userName)}${a.casa ? ' · ' + esc(a.casa) : ''}`;
                const phone = a.phone ? ` · Tel. <a href="tel:${esc(a.phone)}" style="border:none;padding:0;background:none;text-decoration:underline;">${esc(a.phone)}</a>` : '';
                const map = a.lat != null ? `<a href="${SisdelRondas.mapsLink(a.lat, a.lng)}" target="_blank" rel="noopener">Ver ubicación</a>` : '<span style="font-size:0.75rem;opacity:0.85;">Sin GPS</span>';
                const state = a.status === 'ATTENDED' ? ` · Atendida por ${esc(a.attendedByName || '')}` : '';
                return `
                <div class="pan-item ${a.status === 'ACTIVE' ? 'active' : 'attended'}" role="alert">
                    ${ICON_ALERT}
                    <div class="pan-text">
                        <div class="pan-title">ALERTA DE PÁNICO</div>
                        <div>${who}${phone}</div>
                        <div style="font-size:0.78rem;opacity:0.9;">${esc(ago(a.createdAt))}${state}</div>
                    </div>
                    ${map}
                    ${a.status === 'ACTIVE' && !options.readOnly ? `<button class="solid" data-attend="${esc(a.id)}">Atender</button>` : ''}
                    ${options.canResolve && !options.readOnly ? `<button data-resolve="${esc(a.id)}">Resolver</button>` : ''}
                </div>`;
            }).join('');
        }

        bar.addEventListener('click', async (e) => {
            if (e.target.closest('[data-minimize]')) { minimized = true; render(); return; }
            if (e.target.closest('[data-expand]')) { minimized = false; render(); return; }
            const attend = e.target.closest('[data-attend]');
            const resolve = e.target.closest('[data-resolve]');
            try {
                if (attend) { attend.disabled = true; await SisdelRondas.attendPanic(attend.dataset.attend); }
                if (resolve) {
                    const notes = prompt('¿Qué pasó? (queda en el registro)');
                    if (notes === null) return;
                    resolve.disabled = true;
                    await SisdelRondas.resolvePanic(resolve.dataset.resolve, notes);
                }
            } catch (error) {
                console.error('Alerta de panico:', error);
                SISDEL.showToast('No se pudo actualizar la alerta', 'error');
            }
        });

        const unsubscribe = SisdelRondas.subscribeActivePanics((list) => {
            const fresh = list.filter((a) => a.status === 'ACTIVE' && !seen.has(a.id));
            list.forEach((a) => seen.add(a.id));
            alerts = list;
            if (fresh.length) minimized = false; // una alerta nueva siempre se muestra completa
            render();
            // Vibrar solo despues de un toque real (Chrome lo bloquea antes)
            const canVibrate = navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);
            if (!first && fresh.length) { beep(); if (canVibrate) navigator.vibrate([400, 150, 400]); }
            // Al abrir la pagina con alertas activas tambien suena
            if (first && list.some((a) => a.status === 'ACTIVE')) beep();
            first = false;
            if (options.onChange) options.onChange(list);
        }, (error) => console.error('Alertas de panico:', error));

        // Refresca el "hace N min"
        const timer = setInterval(render, 30000);
        return () => { unsubscribe(); clearInterval(timer); bar.remove(); };
    }

    return { watch, beep };
})();
