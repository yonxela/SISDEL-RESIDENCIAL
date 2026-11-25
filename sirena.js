/* ═══════════════════════════════════════════════════════════════
   SISDEL - Sirena de alerta maxima (pedido del usuario el 2026-11-24)
   ───────────────────────────────────────────────────────────────
   Dos sirenas que suben y bajan (como una patrulla), fuertes y sin parar hasta stop(). Solo WebAudio: sin archivos de
   sonido. La usan panico-alertas.js (Control Garita, panel de administracion y OIKOS) y panico.html (los telefonos de la
   casa que tienen el boton de panico: suena cuando otro de la casa pide ayuda).
   El navegador no deja sonar nada hasta el primer toque o tecla en la pagina: wake() se llama en cada toque y onReady avisa
   cuando ya se puede (para esconder el boton que lo pide).
   ═══════════════════════════════════════════════════════════════ */
const SisdelSirena = (() => {
    let ctx = null;
    let siren = null;
    let starting = false;
    let lastReady = false;
    const listeners = new Set();

    function ready() { return !!ctx && ctx.state === 'running'; }
    // Avisa SOLO cuando cambia (listo / no listo). Antes avisaba en cada wake() y, con el sonido ya activado, start() -> wake() ->
    // aviso -> la pagina volvia a llamar start() antes de que hubiera sirena: se metia en un ciclo, creaba cientos de sirenas
    // encimadas y el audio se trababa sin sonar (lo vio el usuario el 2026-11-24 en Control Garita)
    function notify() {
        const now = ready();
        if (now === lastReady) return;
        lastReady = now;
        listeners.forEach((f) => { try { f(now); } catch { /* nada */ } });
    }
    function wake() {
        try {
            if (!ctx) {
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                ctx.onstatechange = notify; // el telefono lo suspende o lo reanuda solo (llamada, pantalla)
            }
            if (ctx.state !== 'running') ctx.resume().then(notify, () => {});
            else notify();
        } catch { /* sin audio */ }
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, wake, { capture: true, passive: true }));
    // Si el telefono suspende el audio (llamada, pantalla), al volver se reanuda
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running') wake(); });

    function start() {
        if (siren || starting) return; // una sola sirena: wake() puede avisar a la pagina y la pagina volver a pedir start()
        starting = true;
        try {
            wake();
            const out = ctx.createDynamicsCompressor(); // fuerte sin que se rompa el sonido
            out.connect(ctx.destination);
            const master = ctx.createGain();
            master.gain.value = 0.9;
            master.connect(out);
            const make = (type, base, depth, rate) => {
                const osc = ctx.createOscillator();
                osc.type = type;
                osc.frequency.value = base;
                const lfo = ctx.createOscillator();
                lfo.type = 'triangle';
                lfo.frequency.value = rate;
                const lfoGain = ctx.createGain();
                lfoGain.gain.value = depth;
                lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
                osc.connect(master);
                osc.start(); lfo.start();
                return [osc, lfo];
            };
            siren = { nodes: [...make('sawtooth', 950, 420, 0.55), ...make('square', 1300, 300, 4.5)], master, out };
        } catch { siren = null; } finally { starting = false; }
    }
    function stop() {
        if (!siren) return;
        try { siren.nodes.forEach((n) => n.stop()); siren.master.disconnect(); siren.out.disconnect(); } catch { /* ya parada */ }
        siren = null;
    }
    function playing() { return !!siren; }
    function onReady(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    // Unos tonos cortos (la sirena de antes): para avisos menores
    function beep() {
        try {
            wake();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.connect(gain); gain.connect(ctx.destination);
            gain.gain.value = 0.08;
            const t = ctx.currentTime;
            [0, 0.35, 0.7].forEach((d) => { osc.frequency.setValueAtTime(880, t + d); osc.frequency.setValueAtTime(660, t + d + 0.17); });
            osc.start(t);
            osc.stop(t + 1.05);
        } catch { /* sin audio */ }
    }
    return { wake, ready, start, stop, playing, onReady, beep };
})();
