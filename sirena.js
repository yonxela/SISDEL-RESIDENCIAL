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
    const supported = () => !!(window.AudioContext || window.webkitAudioContext);
    // iPhone y iPad (tambien Chrome en iPhone: es el mismo motor). El sonido de una pagina (Web Audio) obedece al interruptor de
    // SILENCIO del telefono: el usuario lo tenia en silencio el 2026-11-25 y la sirena no sono. Se pide la sesion de audio de
    // "reproduccion" (navigator.audioSession, iOS 17) y, por si no existe, se deja sonando un audio casi mudo: con un audio de la
    // pagina en curso, iOS pone toda la pagina en modo reproduccion y la sirena suena aunque el telefono este en silencio
    const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let keeper = null;
    function silentWavUrl() {
        const n = 8000; // 1 s a 8 kHz, 8 bits: valores 128/129 (no se oye)
        const buf = new ArrayBuffer(44 + n);
        const v = new DataView(buf);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
        v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
        for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + (i & 1));
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }
    function playbackSession() {
        try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch { /* sin la API */ }
        if (!IS_IOS) return;
        try {
            if (!keeper) {
                keeper = document.createElement('audio');
                keeper.loop = true;
                keeper.setAttribute('playsinline', '');
                keeper.src = silentWavUrl();
            }
            if (keeper.paused) { const p = keeper.play(); if (p && p.catch) p.catch(() => {}); }
        } catch { /* sin audio */ }
    }
    function wake() {
        try {
            playbackSession();
            if (!ctx) {
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                ctx.onstatechange = notify; // el telefono lo suspende o lo reanuda solo (llamada, pantalla)
            }
            if (ctx.state !== 'running') ctx.resume().then(notify, () => {});
            else notify();
        } catch { /* sin audio */ }
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, wake, { capture: true, passive: true }));
    // Que quede ENCENDIDA (pedido del usuario el 2026-11-25): si el equipo suspende el audio (llamada, pantalla, otra app, la
    // computadora se durmio), al volver se reanuda solo; y cada 4 s se revisa, una vez que la pagina ya recibio un toque (despues
    // de eso el navegador deja reanudar sin otro toque)
    const revive = () => { if (ctx && ctx.state !== 'running' && !document.hidden) wake(); };
    document.addEventListener('visibilitychange', revive);
    window.addEventListener('focus', revive);
    window.addEventListener('pageshow', revive);
    setInterval(() => {
        const act = navigator.userActivation;
        if (ctx && ctx.state !== 'running' && !document.hidden && (!act || act.hasBeenActive)) wake();
    }, 4000);
    // Al abrir la pagina se intenta armarla sin esperar un toque: el navegador lo deja cuando la central esta instalada como
    // aplicacion (o el sitio ya tiene permiso de sonido); si no, queda lista para el primer toque o tecla
    function arm() { wake(); }

    let testTimer = null;
    function start() {
        if (siren) { clearTimeout(testTimer); testTimer = null; return; } // si estaba en prueba, una alerta la deja sonando
        if (starting) return; // una sola sirena: wake() puede avisar a la pagina y la pagina volver a pedir start()
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
    // "Probar la sirena": suena ms y se calla sola. Si mientras tanto llega una alerta (start()), sigue sonando. false si ya sonaba
    function test(ms = 2000) {
        if (siren) return false;
        start();
        if (!siren) return false;
        testTimer = setTimeout(() => { testTimer = null; stop(); }, ms);
        return true;
    }
    function stop() {
        clearTimeout(testTimer);
        testTimer = null;
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
    return { supported, wake, arm, ready, start, stop, test, playing, onReady, beep };
})();
