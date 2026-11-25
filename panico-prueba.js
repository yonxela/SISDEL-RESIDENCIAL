/*
  PRUEBA DEL BOTON DE PANICO: "TODO SIN NOVEDAD" (pedido del usuario el 2026-11-25: "abajo del boton de panico agregar un boton de
  prueba, reportando todo sin novedad; enviara coordenadas y datos pero sin activar la sirena; se usara solo para que los vecinos
  hagan pruebas y vean que el sistema esta funcionando al 100 %").

  Por dentro es el simulacro de siempre (la alerta lleva simulacro: true): el servidor solo avisa por WhatsApp a la central, a las
  garitas y al propio vecino, con tope por dia (functions/src/rondas/avisos.js), nunca a la PNC, al personal ni a los familiares.
  Lo nuevo: no suena ninguna sirena (panico-alertas.js, RONDIN), la pantalla de la garita la recibe sola (attendPanic con la nota
  AUTO_RECEIVED_NOTE) y la cierra sola a los AUTO_CLOSE_MS, y el vecino ve, punto por punto, que funciono: llego al sistema, llevo su
  ubicacion, la pantalla de la garita la recibio y salio el aviso por WhatsApp. "Funciona al 100 %" solo cuando todo eso paso.

  Lo usan vecino.html (la alerta como esta en la base) y panico.html (la que resume panicDevice: hasLocation, receivedAt,
  receivedBy, whatsapp { done, sent, reason }). UMD: el navegador y las pruebas (scripts/test-panico-prueba.mjs).
  Todo se pinta con textContent: el nombre de quien la recibio lo escribio otra persona.
*/
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelPanicoPrueba = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const LABEL = 'Prueba: todo sin novedad';
    const NOTE = 'Envía su ubicación y sus datos a la garita como PRUEBA: no suena ninguna sirena y no avisa a sus contactos de emergencia ni a la PNC. Úsela para comprobar que su botón funciona.';
    const CONFIRM = 'PRUEBA DEL BOTÓN DE PÁNICO: TODO SIN NOVEDAD\n\n'
        + 'Se enviarán su ubicación y sus datos a la garita marcados como PRUEBA, y una copia a su propio WhatsApp.\n\n'
        + 'No suena ninguna sirena y NO se avisa a sus contactos de emergencia ni a la PNC.\n\n'
        + '¿Enviar la prueba?';
    // La nota que deja la pantalla de la garita al recibirla sola, y la de cuando la cierra
    const AUTO_RECEIVED_NOTE = 'Prueba recibida automáticamente por la pantalla de la garita: todo sin novedad.';
    const AUTO_CLOSE_NOTE = 'Prueba del vecino: la recibió la pantalla de la garita, todo sin novedad. Se cerró sola.';
    // La garita la cierra sola 2 minutos despues de recibirla (asi no se le amontonan las pruebas en la pantalla)
    const AUTO_CLOSE_MS = 120000;
    // Cuanto se espera antes de decir que la garita o el WhatsApp no respondieron
    const GARITA_WAIT_MS = 90000;
    const WHATSAPP_WAIT_MS = 90000;
    // Una ubicacion con mas error que esto se dice "aproximada"
    const ACCURACY_GOOD_M = 100;

    const isTest = (a) => !!a && a.simulacro === true;
    const time = (iso) => {
        const t = Date.parse(iso || '');
        if (!Number.isFinite(t)) return '';
        return new Date(t).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala' });
    };

    // Quien y cuando la recibio la garita: la alerta de la base (attendedAt / attendedByName se quedan aunque despues se cierre) o el
    // resumen del QR (receivedAt / receivedBy)
    function receipt(a) {
        const at = a.receivedAt || a.attendedAt || '';
        const by = a.receivedBy || a.attendedByName || '';
        if (at) return { at, by };
        if (a.status === 'ATTENDED') return { at: '', by };
        // Cerrada sin pasar por "recibida" (alguien la cerro directo): tambien la vio la garita
        if (a.status === 'RESOLVED') return { at: a.resolvedAt || '', by: a.resolvedByName || '' };
        return null;
    }

    // El WhatsApp de la prueba: la alerta de la base trae recipients; el resumen del QR, sent
    function whatsappOf(w) {
        if (!w) return null;
        const sent = Array.isArray(w.recipients) ? w.recipients.filter((r) => r && r.exito).length : Number(w.sent) || 0;
        return { sent, reason: String(w.reason || '') };
    }

    // { state: 'ok' | 'wait' | 'check', title, text, rows: [{ key, state: 'ok' | 'fail' | 'warn' | 'wait' | 'info', title, detail }] }
    function report(a, now = Date.now()) {
        const created = Date.parse(a.createdAt || '');
        const age = Number.isFinite(created) ? now - created : 0;
        const rows = [];
        rows.push({ key: 'envio', state: 'ok', title: 'Su prueba llegó al sistema', detail: time(a.createdAt) ? `Enviada a las ${time(a.createdAt)}` : '' });

        const hasGps = a.hasLocation === true || (typeof a.lat === 'number' && typeof a.lng === 'number');
        const acc = typeof a.accuracy === 'number' && Number.isFinite(a.accuracy) ? Math.round(a.accuracy) : null;
        if (!hasGps) {
            rows.push({ key: 'gps', state: 'fail', title: 'La prueba salió sin su ubicación', detail: 'Toque «Activar ubicación» y vuelva a probar: en una emergencia real la garita no sabría dónde está.' });
        } else if (acc != null && acc > ACCURACY_GOOD_M) {
            rows.push({ key: 'gps', state: 'warn', title: `Llevó su ubicación, pero aproximada (±${acc} m)`, detail: 'Active la ubicación precisa del teléfono o pruebe desde un lugar abierto.' });
        } else {
            rows.push({ key: 'gps', state: 'ok', title: `Llevó su ubicación GPS${acc != null ? ` (±${acc} m)` : ''}`, detail: 'La garita la ve en el mapa.' });
        }

        const got = receipt(a);
        if (got) {
            rows.push({ key: 'garita', state: 'ok', title: 'La pantalla de la garita la recibió', detail: [got.at ? `A las ${time(got.at)}` : '', got.by].filter(Boolean).join(' · ') });
        } else if (a.status === 'CANCELLED') {
            rows.push({ key: 'garita', state: 'fail', title: 'Terminó la prueba antes de que la garita la recibiera', detail: 'Vuelva a probar y espere un minuto.' });
        } else if (age < GARITA_WAIT_MS) {
            rows.push({ key: 'garita', state: 'wait', title: 'Esperando a la pantalla de la garita...', detail: '' });
        } else {
            rows.push({ key: 'garita', state: 'warn', title: 'La pantalla de la garita todavía no la recibe', detail: 'Puede que la pantalla de la garita esté cerrada. Avísele a la administración; su prueba sigue esperando.' });
        }

        const w = whatsappOf(a.whatsapp);
        if (!w) {
            rows.push(age < WHATSAPP_WAIT_MS
                ? { key: 'whatsapp', state: 'wait', title: 'Enviando el aviso de prueba por WhatsApp...', detail: '' }
                : { key: 'whatsapp', state: 'warn', title: 'No se sabe si salió el aviso por WhatsApp', detail: 'La garita igual la ve en su pantalla.' });
        } else if (w.sent > 0) {
            rows.push({ key: 'whatsapp', state: 'ok', title: `Aviso de prueba por WhatsApp: ${w.sent} ${w.sent === 1 ? 'enviado' : 'enviados'}`, detail: 'A la central, a la garita y a su propio número: revise que le llegó a su WhatsApp.' });
        } else if (/^Hoy ya /.test(w.reason)) {
            // El tope de pruebas con WhatsApp del dia no es una falla: esta prueba quedo solo en la pantalla de la garita
            rows.push({ key: 'whatsapp', state: 'info', title: 'Esta prueba no llevó WhatsApp', detail: w.reason });
        } else {
            rows.push({ key: 'whatsapp', state: 'warn', title: 'El aviso por WhatsApp no salió', detail: (w.reason ? w.reason + '. ' : '') + 'La garita igual la ve en su pantalla.' });
        }

        const states = rows.map((r) => r.state);
        const state = states.includes('wait') ? 'wait' : (states.includes('fail') || states.includes('warn')) ? 'check' : 'ok';
        const title = state === 'ok' ? 'TODO SIN NOVEDAD: SU BOTÓN DE PÁNICO FUNCIONA AL 100 %'
            : state === 'wait' ? 'PRUEBA ENVIADA: COMPROBANDO...'
                : 'PRUEBA ENVIADA: HAY ALGO POR REVISAR';
        return { state, title, text: 'Es una prueba: no sonó ninguna sirena y no se avisó a sus contactos de emergencia ni a la PNC.', rows };
    }

    // Iconos (SVG, sin emojis)
    const ICON = {
        ok: '<path d="M20 6 9 17l-5-5"/>',
        fail: '<path d="M18 6 6 18M6 6l12 12"/>',
        warn: '<path d="M12 8v5"/><path d="M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>',
        wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8v.01"/>'
    };
    const CSS = `
        .pp-report { text-align: left; }
        .pp-title { display: block; font-size: 1.02rem; font-weight: 800; letter-spacing: 0.03em; }
        .pp-report.ok .pp-title { color: #10b981; }
        .pp-report.check .pp-title { color: #f59e0b; }
        .pp-text { margin: 0.25rem 0 0.6rem; font-size: 0.85rem; opacity: 0.9; }
        .pp-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.45rem; }
        .pp-row { display: grid; grid-template-columns: 1.5rem 1fr; gap: 0.5rem; align-items: start; }
        .pp-ic { width: 1.5rem; height: 1.5rem; border-radius: 50%; display: grid; place-items: center; }
        .pp-ic svg { width: 0.95rem; height: 0.95rem; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
        .pp-row.ok .pp-ic { background: #10b981; color: #fff; }
        .pp-row.fail .pp-ic { background: #ef4444; color: #fff; }
        .pp-row.warn .pp-ic { background: #f59e0b; color: #1f2937; }
        .pp-row.info .pp-ic { background: #3b82f6; color: #fff; }
        .pp-row.wait .pp-ic { background: rgba(148,163,184,0.25); color: inherit; animation: pp-pulse 1.2s ease-in-out infinite; }
        .pp-row-title { font-weight: 700; font-size: 0.9rem; line-height: 1.3; }
        .pp-row-detail { font-size: 0.8rem; opacity: 0.85; line-height: 1.35; }
        .pp-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.7rem; }
        .pp-actions button { border: 1px solid currentColor; border-radius: 999px; padding: 0.45rem 1.1rem; font-weight: 700; }
        @keyframes pp-pulse { 50% { opacity: 0.45; } }
        @media (prefers-reduced-motion: reduce) { .pp-row.wait .pp-ic { animation: none; } }`;

    // Pinta el resultado en el contenedor. opts: { now, onCancel (si se puede terminar), onClose (boton Listo) }
    function render(el, a, opts = {}) {
        if (typeof document !== 'undefined' && !document.getElementById('pp-style')) {
            const style = document.createElement('style');
            style.id = 'pp-style';
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const r = report(a, opts.now || Date.now());
        el.textContent = '';
        const box = document.createElement('div');
        box.className = `pp-report ${r.state}`;
        const title = document.createElement('strong');
        title.className = 'pp-title';
        title.textContent = r.title;
        const text = document.createElement('p');
        text.className = 'pp-text';
        text.textContent = r.text;
        const list = document.createElement('ul');
        list.className = 'pp-rows';
        r.rows.forEach((row) => {
            const li = document.createElement('li');
            li.className = `pp-row ${row.state}`;
            li.dataset.check = row.key;
            const ic = document.createElement('span');
            ic.className = 'pp-ic';
            ic.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[row.state] || ICON.info}</svg>`; // fijo del sistema
            const body = document.createElement('div');
            const t = document.createElement('div');
            t.className = 'pp-row-title';
            t.textContent = row.title;
            body.appendChild(t);
            if (row.detail) {
                const d = document.createElement('div');
                d.className = 'pp-row-detail';
                d.textContent = row.detail;
                body.appendChild(d);
            }
            li.append(ic, body);
            list.appendChild(li);
        });
        box.append(title, text, list);
        const actions = document.createElement('div');
        actions.className = 'pp-actions';
        if (opts.onCancel && a.status === 'ACTIVE') {
            const end = document.createElement('button');
            end.type = 'button';
            end.className = 'btn btn-ghost btn-sm';
            end.textContent = 'Terminar la prueba';
            end.addEventListener('click', opts.onCancel);
            actions.appendChild(end);
        }
        if (opts.onClose && r.state !== 'wait') {
            const done = document.createElement('button');
            done.type = 'button';
            done.className = 'btn btn-ghost btn-sm';
            done.textContent = 'Listo';
            done.addEventListener('click', opts.onClose);
            actions.appendChild(done);
        }
        if (actions.childNodes.length) box.appendChild(actions);
        el.appendChild(box);
        return r;
    }

    return {
        LABEL, NOTE, CONFIRM, AUTO_RECEIVED_NOTE, AUTO_CLOSE_NOTE, AUTO_CLOSE_MS, GARITA_WAIT_MS, WHATSAPP_WAIT_MS, ACCURACY_GOOD_M,
        isTest, report, render
    };
});
