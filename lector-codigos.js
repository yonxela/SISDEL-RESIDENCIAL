/* ═══════════════════════════════════════════════════════════════
   SISDEL - Lector de codigos USB (de pistola) para la garita
   ───────────────────────────────────────────────────────────────
   Pedido del usuario el 2026-11-23: "ese lector de codigo QR para leer el marbete es marca BROCS... me muestra el codigo en
   una hoja en blanco, pero necesito que agregues esa opcion para usuario garita, para que cuando el vecino pase con su
   marbete con QR se pueda leer con este lector".

   Un lector USB (cable o receptor inalambrico) se comporta como un TECLADO: "escribe" el codigo muy rapido y casi siempre
   termina con Enter (a veces Tab). No hay nada que instalar. Este modulo reconoce esa rafaga de teclas en CUALQUIER parte de
   la pagina (sin tener que tocar un campo), la separa de alguien que escribe a mano y entrega el codigo.

   Dos partes (UMD: navegador y Node):
     - createDetector(opts): la logica pura. Se le dan las teclas con su hora y dice que hacer con cada una. Se prueba en Node.
     - attach(doc, opts): lo conecta a la pagina (keydown en fase de captura, Enter y Tab que no deben activar un boton ni
       enviar un formulario, y el cierre por silencio cuando el lector no manda Enter).
     - normalize(texto): el codigo como lo entiende el sistema (mayusculas, sin espacios ni caracteres de control, sin el
       prefijo de simbologia que algunos lectores agregan) y, si trae simbolos que un teclado de otro idioma cambia, las
       lecturas alternativas.

   Como distingue al lector de una persona: el lector escribe a 2-40 ms por letra; una persona a 100 ms o mas. Se pide una
   rafaga de 4 o mas letras con menos de 90 ms entre una y otra (y 50 ms de promedio) y despues Enter o Tab. Una lectura que se
   confunda con alguien que escribe a mano en el campo de codigo es inofensiva: hace lo mismo que enviarlo.
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelLector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULTS = {
        maxGap: 90,          // ms: mas que esto entre dos letras y la rafaga se corta (era una persona)
        maxAvgGap: 50,       // ms por letra, en promedio: el lector va muy por debajo; una persona, no
        endGap: 300,         // ms: lo que puede tardar el Enter despues de la ultima letra
        minLength: 4,        // letras: menos que esto no es un codigo
        maxLength: 64,       // letras: mas que esto no es un codigo de este sistema
        idleMs: 220,         // ms de silencio para cerrar una lectura sin Enter
        idleMinLength: 8,    // letras: sin Enter solo se acepta una lectura larga...
        idleMaxAvgGap: 30    // ... y muy rapida
    };
    // Teclas que no cortan una rafaga (el lector manda Shift entre las mayusculas y las minusculas)
    const NEUTRAL = ['Shift', 'CapsLock', 'Control', 'Alt', 'AltGraph', 'Meta', 'Dead', 'Unidentified', 'NumLock', 'ScrollLock'];

    // ── Logica pura ──
    function createDetector(options) {
        const o = Object.assign({}, DEFAULTS, options || {});
        let chars = [];
        let times = [];

        function reset() { chars = []; times = []; }
        function stats() {
            const n = chars.length;
            if (n < 2) return { n, avg: 0, max: 0 };
            let max = 0;
            for (let i = 1; i < n; i++) max = Math.max(max, times[i] - times[i - 1]);
            return { n, avg: (times[n - 1] - times[0]) / (n - 1), max };
        }
        function build(endedBy) {
            const s = stats();
            return {
                text: chars.join(''), length: chars.length, endedBy,
                startedAt: times[0], endedAt: times[times.length - 1],
                avgGap: Math.round(s.avg * 10) / 10, maxGap: Math.round(s.max * 10) / 10
            };
        }

        // Una tecla: { key, repeat, ctrl, alt, meta, composing }, a la hora t (ms).
        // Devuelve { action: 'ignore' | 'buffer' | 'swallow' | 'scan', scan? }:
        //   buffer  = parece parte de una lectura (todavia no se sabe)
        //   swallow = ya es una lectura en curso: la pagina no debe hacer nada con la tecla (un espacio no activa un boton)
        //   scan    = lectura completa (Enter o Tab): la pagina no debe activar un boton ni enviar un formulario con esa tecla
        function key(e, t) {
            if (!e || e.composing || e.repeat) { reset(); return { action: 'ignore' }; }
            const k = e.key;
            if (typeof k === 'string' && k.length === 1) {
                // AltGr llega como Ctrl + Alt: es una letra normal. Ctrl, Alt o Meta solos son atajos
                const shortcut = e.meta || (e.ctrl && !e.alt) || (e.alt && !e.ctrl);
                if (shortcut) { reset(); return { action: 'ignore' }; }
                if (chars.length && (t - times[times.length - 1] > o.maxGap || chars.length >= o.maxLength)) reset();
                chars.push(k);
                times.push(t);
                return { action: chars.length >= 3 ? 'swallow' : 'buffer' };
            }
            if (k === 'Enter' || k === 'Tab') {
                const s = stats();
                const lastGap = chars.length ? t - times[times.length - 1] : Infinity;
                if (chars.length >= o.minLength && lastGap <= o.endGap && s.max <= o.maxGap && s.avg <= o.maxAvgGap) {
                    const scan = build(k);
                    reset();
                    return { action: 'scan', scan };
                }
                reset();
                return { action: 'ignore' };
            }
            if (NEUTRAL.indexOf(k) >= 0) return { action: 'ignore' };
            reset();   // Retroceso, Escape, flechas...: es una persona
            return { action: 'ignore' };
        }

        // Pasado un silencio (opts.idleMs) sin teclas: una lectura larga y rapidisima se cierra sola (lectores sin Enter)
        function idle(t) {
            const s = stats();
            const last = chars.length ? t - times[times.length - 1] : 0;
            if (chars.length >= o.idleMinLength && last >= o.idleMs && s.avg <= o.idleMaxAvgGap && s.max <= o.maxGap) {
                const scan = build('ninguno');
                reset();
                return scan;
            }
            if (chars.length && last >= o.idleMs) reset();
            return null;
        }

        return { key, idle, reset, size: () => chars.length, options: o };
    }

    // ── El codigo como lo entiende el sistema ──
    // Lo que un teclado en espanol escribe cuando el lector esta configurado como teclado en ingles (la tecla fisica es la misma):
    // "'" en lugar de "-", "-" en lugar de "/", "Ñ" en lugar de ":", "ñ" en lugar de ";", "?" en lugar de "_" y "_" en lugar de "?"
    const LAYOUT_FIX = { "'": '-', '-': '/', 'Ñ': ':', 'ñ': ';', '?': '_', '_': '?', '¿': '+', '¡': '=' };

    function clean(text) {
        let t = String(text == null ? '' : text);
        t = t.replace(/[\u0000-\u001f\u007f]/g, '');          // caracteres de control (STX, ETX, CR...)
        t = t.replace(/^\][A-Za-z][0-9A-Za-z]/, '');           // prefijo de simbologia AIM (]Q1, ]C0...) si el lector lo manda
        return t.replace(/\s+/g, '').toUpperCase();
    }
    // { code, alternatives, odd }: code es la lectura limpia; alternatives, las lecturas posibles si trae simbolos que un teclado
    // de otro idioma cambia (solo si los trae: un codigo de letras y numeros no tiene alternativas)
    function normalize(text) {
        const code = clean(text);
        const odd = /[^A-Z0-9\-.]/.test(code);
        const alternatives = [];
        if (odd) {
            const fixed = code.split('').map((c) => (Object.prototype.hasOwnProperty.call(LAYOUT_FIX, c) ? LAYOUT_FIX[c] : c)).join('');
            if (fixed !== code) alternatives.push(fixed);
        }
        return { code, alternatives, odd };
    }

    // ── Conexion con la pagina ──
    const EDITABLE_TYPES = ['text', 'search', 'tel', 'url', 'email', 'password', 'number', ''];
    function isEditable(el) {
        if (!el || !el.tagName) return false;
        const tag = String(el.tagName).toLowerCase();
        if (tag === 'textarea' || tag === 'select') return true;
        if (tag === 'input') return EDITABLE_TYPES.indexOf(String(el.type || '').toLowerCase()) >= 0;
        return !!el.isContentEditable;
    }

    // opts: { onScan(scan), enabled() (opcional: false = no escuchar), allowIn(el) (campos donde si se acepta una lectura, p. ej.
    // el de "codigo" de la garita; en los demas campos se asume que una persona escribe) y los de createDetector }
    // Devuelve { detach, state(), test(fn | null), pause(), resume() }.
    function attach(doc, opts) {
        const options = opts || {};
        const det = createDetector(options);
        const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
        let timer = null;
        let paused = false;
        let tester = null;
        let last = null;
        let swallowSpace = false;

        const nowOf = (ev) => (ev && typeof ev.timeStamp === 'number' && ev.timeStamp > 0 ? ev.timeStamp : (win && win.performance ? win.performance.now() : Date.now()));
        const active = () => !paused && (typeof options.enabled !== 'function' || options.enabled());

        function deliver(scan, el, typedHere) {
            // Lo que alcanzo a escribirse en el campo mientras se leia, se borra: la lectura no es texto para esa casilla
            if (typedHere && el && typeof el.value === 'string') {
                const idx = el.value.lastIndexOf(scan.text);
                if (idx >= 0) el.value = el.value.slice(0, idx) + el.value.slice(idx + scan.text.length);
                else el.value = '';
            }
            const n = normalize(scan.text);
            const full = Object.assign({}, scan, { raw: scan.text, code: n.code, alternatives: n.alternatives, odd: n.odd, at: Date.now() });
            last = full;
            if (typeof tester === 'function') { try { tester(full); } catch (e) { /* la prueba no frena la pagina */ } return; }
            if (typeof options.onScan === 'function') {
                try { const r = options.onScan(full); if (r && typeof r.catch === 'function') r.catch((e) => console.error('Lector: error al procesar la lectura', e)); }
                catch (e) { console.error('Lector: error al procesar la lectura', e); }
            }
        }

        function arm(el, typedHere) {
            if (timer) win.clearTimeout(timer);
            timer = win.setTimeout(() => {
                timer = null;
                const scan = det.idle(win.performance ? win.performance.now() : Date.now());
                if (scan) deliver(scan, el, typedHere);
            }, (det.options.idleMs || DEFAULTS.idleMs) + 30);
        }

        function onKeyDown(ev) {
            if (!active()) { det.reset(); return; }
            const el = ev.target;
            const editable = isEditable(el);
            const mine = editable && typeof options.allowIn === 'function' && options.allowIn(el);
            if (editable && !mine) { det.reset(); return; }   // una persona escribe en otro campo
            const r = det.key({ key: ev.key, repeat: ev.repeat, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, composing: ev.isComposing }, nowOf(ev));
            if (r.action === 'scan') {
                // El Enter o el Tab final no deben activar un boton con el foco, enviar el formulario ni cambiar de campo
                ev.preventDefault();
                ev.stopImmediatePropagation();
                if (timer) { win.clearTimeout(timer); timer = null; }
                deliver(r.scan, el, mine);
                return;
            }
            if (r.action === 'swallow') {
                // Una rafaga en curso: en la pagina (fuera de los campos) no se escribe nada; en el campo de codigo se deja escribir
                // (se ve lo que llega) y se borra al terminar la lectura
                if (!mine) { ev.preventDefault(); if (ev.key === ' ') swallowSpace = true; }
                arm(el, mine);
            } else if (r.action === 'buffer') {
                arm(el, mine);
            }
        }
        function onKeyUp(ev) {
            // En un boton con el foco, el espacio actua al soltarse: si era parte de una lectura, no
            if (swallowSpace && ev.key === ' ') { ev.preventDefault(); swallowSpace = false; }
        }

        doc.addEventListener('keydown', onKeyDown, true);
        doc.addEventListener('keyup', onKeyUp, true);
        return {
            detach() { doc.removeEventListener('keydown', onKeyDown, true); doc.removeEventListener('keyup', onKeyUp, true); if (timer) win.clearTimeout(timer); },
            state() { return { paused, testing: typeof tester === 'function', last }; },
            // En modo prueba las lecturas llegan a fn y no a onScan (para ver si el lector funciona sin tocar la garita)
            test(fn) { tester = typeof fn === 'function' ? fn : null; },
            pause() { paused = true; det.reset(); },
            resume() { paused = false; det.reset(); }
        };
    }

    return { DEFAULTS, createDetector, normalize, clean, attach, isEditable, LAYOUT_FIX };
});
