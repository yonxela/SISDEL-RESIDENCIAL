/* ═══════════════════════════════════════════════════════════════
   SISDEL - Audio de doble via entre la garita y el vecino que pidio ayuda (pedido del usuario el 2026-11-24)
   ───────────────────────────────────────────────────────────────
   La garita toca "Escuchar / Hablar" en la alerta (panico-alertas.js): su navegador llama al telefono del vecino, que CONTESTA
   SOLO mientras su alerta este abierta (vecino.html y panico.html): la garita escucha lo que pasa y, con "Hablar", le habla.
   El audio va directo entre los dos navegadores (WebRTC); la llamada la pasa el servidor (functions/src/panico-audio.js,
   panicAudio). Nada se graba.
   LIMITES: el telefono del vecino solo contesta con la pagina del boton abierta y la pantalla encendida (el iPhone corta el
   microfono al bloquearse o al pasar a otra app); en redes de celular hace falta un servidor de enlace (TURN) para que conecte
   siempre (scripts/set-audio-enlace.mjs).
   call(action, data): la pagina pone como llama a panicAudio (con el condominio, la alerta y, en el QR, la clave del telefono).
   MICROFONO DEL VECINO (2026-11-25: en la prueba el vecino oia a la central y la central no lo oia: el telefono no habia dado el
   microfono y la central decia "escucha lo que pasa"). El telefono del vecino SIEMPRE manda su linea de audio: con el microfono o,
   si todavia no lo dio, en silencio; en cuanto el vecino toca "PRESIONE PARA HABLAR" y lo permite, el microfono entra en esa
   misma linea (replaceTrack: no hay que volver a llamar). Por un canal de datos de la propia llamada el telefono le dice a la
   central si tiene microfono, y la central lo dice en pantalla. Si el telefono lo tiene bloqueado, se dice como desbloquearlo.
   PRUEBA EN UN IPHONE (2026-11-25, el mismo dia): no se oyo en ningun lado y "PRESIONE PARA HABLAR" no hacia nada. El telefono
   pedia el microfono SOLO al contestar la llamada (sin que nadie tocara nada); Safari recuerda un "No permitir" y ya no vuelve a
   preguntar en esa pagina, asi que cada toque fallaba al instante. Y sin microfono Safari no deja sonar el audio de la central sin
   un toque. Ahora: el microfono se pide SOLO al tocar el boton (al contestar se usa si ya se dio, o si el navegador dice que esta
   permitido y no va a preguntar); el toque tambien hace sonar a la central; si Safari ya lo nego, el boton ofrece recargar la
   pagina (asi vuelve a preguntar); y con el microfono abierto el boton se pone verde, "MICROFONO ACTIVO", con barras que se mueven
   al hablar.
   ═══════════════════════════════════════════════════════════════ */
const SisdelAudioPanico = (() => {
    const GATHER_MS = 4000;     // tiempo para juntar las direcciones de red antes de mandar la oferta o la respuesta
    const WAIT_EVERY_MS = 1500; // la garita pregunta si ya contestaron
    const POLL_EVERY_MS = 3000; // el telefono del vecino pregunta si lo llaman
    const POLL_FOR_MS = 30 * 60 * 1000;
    const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
    const supported = () => !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function gathered(pc) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timer = setTimeout(resolve, GATHER_MS);
            pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
        });
    }
    async function servers(call) {
        try { const r = await call('ice', {}); if (r && Array.isArray(r.iceServers) && r.iceServers.length) return r.iceServers; } catch { /* solo STUN */ }
        return FALLBACK_ICE;
    }
    // onBlocked: el navegador no dejo sonar el audio sin un toque (Safari del iPhone sin el microfono abierto)
    function playRemote(pc, audioEl, onBlocked) {
        pc.addEventListener('track', (e) => {
            audioEl.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
            const p = audioEl.play();
            if (p && p.catch) p.catch((err) => { if (onBlocked && err && err.name === 'NotAllowedError') onBlocked(); });
        });
    }
    const micConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

    // ── GARITA: llama al telefono del vecino. onState(estado, texto): pidiendo_microfono, llamando, conectado, sin_respuesta,
    // colgado, error. Devuelve { setTalk(on), hangup() } de inmediato (se puede colgar mientras conecta) ──
    function callNeighbor({ call, onState, audioEl }) {
        let done = false;
        let callId = null;
        let pc = null;
        let stream = null;
        const finish = (state, text, tellServer = true) => {
            if (done) return;
            done = true;
            try { if (pc) pc.close(); } catch { /* ya cerrada */ }
            if (stream) stream.getTracks().forEach((t) => t.stop());
            audioEl.srcObject = null;
            if (tellServer && callId) call('hangup', { callId }).catch(() => {});
            onState(state, text || '');
        };
        const ctl = {
            talking: false,
            setTalk(on) {
                ctl.talking = !!on;
                if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = ctl.talking; });
            },
            hangup() { finish('colgado', 'Llamada terminada.'); }
        };
        (async () => {
            try {
                if (!supported()) return finish('error', 'Este navegador no puede hacer llamadas de audio.', false);
                onState('pidiendo_microfono', 'Permita el micrófono de esta computadora para poder hablarle al vecino.');
                stream = await navigator.mediaDevices.getUserMedia(micConstraints);
                stream.getAudioTracks().forEach((t) => { t.enabled = false; }); // primero solo se escucha; "Hablar" abre el microfono
                if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
                pc = new RTCPeerConnection({ iceServers: await servers(call) });
                stream.getTracks().forEach((t) => pc.addTrack(t, stream));
                playRemote(pc, audioEl);
                // El telefono del vecino dice por aqui si su microfono esta dando sonido (un telefono con la version anterior no dice nada)
                let neighborMic = null;
                const connectedText = () => neighborMic === false
                    ? 'Conectado, pero el teléfono del vecino NO dio permiso al micrófono: él le oye a usted, usted todavía no lo escucha. Toque "Hablar" y pídale que toque «PRESIONE PARA HABLAR» y permita el micrófono: en cuanto lo haga, lo escuchará aquí sin volver a llamar.'
                    : neighborMic === true
                        ? 'Conectado: escucha lo que pasa en el teléfono del vecino (su micrófono está abierto). Toque "Hablar" para que le oiga.'
                        : 'Conectado: escucha lo que pasa en el teléfono del vecino. Toque "Hablar" para que le oiga.';
                try {
                    const dc = pc.createDataChannel('sisdel-audio');
                    dc.addEventListener('message', (e) => {
                        let m = null;
                        try { m = JSON.parse(e.data); } catch { return; }
                        if (!m || typeof m.mic !== 'boolean' || done) return;
                        neighborMic = m.mic;
                        if (pc.connectionState === 'connected') onState('conectado', connectedText(), { neighborMic });
                    });
                } catch { /* sin canal de datos: la llamada sigue igual */ }
                pc.addEventListener('connectionstatechange', () => {
                    if (done) return;
                    if (pc.connectionState === 'connected') onState('conectado', connectedText(), { neighborMic });
                    if (pc.connectionState === 'failed') finish('error', 'No se pudo conectar el audio: la red del teléfono del vecino no lo dejó pasar. Llámelo por teléfono.');
                });
                await pc.setLocalDescription(await pc.createOffer());
                await gathered(pc);
                if (done) return;
                const r = await call('offer', { sdp: pc.localDescription.sdp });
                if (!r || !r.ok) return finish('error', (r && r.error) || 'No se pudo llamar.', false);
                callId = r.callId;
                onState('llamando', 'Llamando al teléfono del vecino... (contesta solo si tiene abierta la página del botón)');
                let answered = false;
                while (!done) {
                    await sleep(answered ? 3000 : WAIT_EVERY_MS);
                    if (done) return;
                    const w = await call('wait', { callId }).catch(() => null);
                    if (!w) continue;
                    if (w.state === 'conectado' && w.answer && !answered) {
                        answered = true;
                        await pc.setRemoteDescription({ type: 'answer', sdp: w.answer });
                    } else if (w.state === 'sin_respuesta') return finish('sin_respuesta', 'El teléfono del vecino no contestó: tiene cerrada la página del botón o la pantalla apagada. Llámelo por teléfono.');
                    else if (w.state === 'colgado') return finish('colgado', 'El vecino colgó.', false);
                }
            } catch (e) {
                console.error('audio panico (garita)', e);
                finish('error', e && e.name === 'NotAllowedError' ? 'La computadora no dio permiso al micrófono.' : 'No se pudo hacer la llamada de audio.');
            }
        })();
        return ctl;
    }

    // ── VECINO: el microfono se pide al tocar "HABLAR A CENTRAL DE MONITOREO" (talkButton) o, si no lo toco, al contestar la llamada;
    // se guarda mientras dure la alerta (asi una segunda llamada no vuelve a preguntar) ──
    let micPromise = null;
    let micStream = null;
    let micError = '';
    const micListeners = new Set(); // las llamadas abiertas sin microfono: lo meten en su linea en cuanto llega
    const micLive = () => !!micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live');
    function prepareMic() {
        if (!supported()) { micError = 'NoSoportado'; return Promise.resolve(null); }
        if (micLive()) return Promise.resolve(micStream);
        if (!micPromise) {
            micPromise = navigator.mediaDevices.getUserMedia(micConstraints)
                .then((s) => { micStream = s; micError = ''; micListeners.forEach((fn) => { try { fn(s); } catch { /* esa llamada ya termino */ } }); return s; })
                .catch((e) => { micPromise = null; micError = (e && e.name) || 'Error'; console.warn('microfono', micError); return null; });
        }
        return micPromise;
    }
    // Al CONTESTAR sola, sin que el vecino toque nada, el microfono se usa solo si ya lo dio en esta pagina o si el navegador dice que
    // esta permitido (entonces no pregunta). Pedirlo sin un toque sacaba la ventana del telefono de sorpresa y, si se respondia "No",
    // Safari ya no volvia a preguntar: cada toque de "PRESIONE PARA HABLAR" fallaba al instante (prueba del 2026-11-25)
    async function micIfAllowed() {
        if (micLive()) return micStream;
        if (micPromise) return micPromise;
        try {
            if (navigator.permissions && navigator.permissions.query) {
                const st = await navigator.permissions.query({ name: 'microphone' });
                if (st && st.state === 'granted') return prepareMic();
            }
        } catch { /* el navegador no dice: no se pregunta */ }
        return null;
    }
    function releaseMic() {
        if (micPromise) micPromise.then((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
        micPromise = null;
        micStream = null;
    }
    // Una linea de audio en silencio para la llamada mientras el vecino no da el microfono: asi la llamada ya lleva su canal de ida
    // y el microfono entra despues con replaceTrack, sin volver a llamar
    function silentLine() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctx();
            const dst = ctx.createMediaStreamDestination();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(dst);
            osc.start();
            const track = dst.stream.getAudioTracks()[0];
            return track ? { track, stream: dst.stream, close: () => { try { osc.stop(); ctx.close(); } catch { /* ya cerrado */ } } } : null;
        } catch { return null; }
    }

    // Mientras la alerta este abierta, pregunta si la garita lo llama y CONTESTA SOLO. onState(estado, texto): esperando, conectado,
    // colgado, error, cerrada. Devuelve { stop(), hangup() }
    function answerCalls({ call, onState, audioEl }) {
        let stopped = false;
        let pc = null;
        let current = null;
        let sender = null;
        let silent = null;
        let dc = null;
        let hasMic = false;
        let audioBlocked = false;
        let byName = '';
        const started = Date.now();
        const tellMic = () => { try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ mic: hasMic })); } catch { /* canal cerrado */ } };
        const liveText = () => (audioBlocked
            ? `${byName} está en línea: toque «PRESIONE PARA HABLAR» para oírla${hasMic ? '' : ' y permita el micrófono para que le escuche'}.`
            : hasMic
                ? `${byName} está en línea: le escucha.`
                : `${byName} está en línea y usted le oye, pero NO le escucha: toque «PRESIONE PARA HABLAR» y permita el micrófono.`);
        const info = () => ({ mic: hasMic, audioBlocked });
        // El vecino dio el microfono con la llamada abierta: entra en la linea que ya va a la central
        const onMic = (stream) => {
            const track = stream && stream.getAudioTracks()[0];
            if (!pc || !sender || hasMic || !track) return;
            track.enabled = true;
            sender.replaceTrack(track).then(() => {
                hasMic = true;
                if (silent) { silent.close(); silent = null; }
                tellMic();
                // Con el microfono abierto (lo dio con un toque) el audio de la central ya puede sonar
                if (audioBlocked && audioEl.srcObject) { const pl = audioEl.play(); if (pl && pl.then) pl.then(() => { audioBlocked = false; if (pc && pc.connectionState === 'connected') onState('conectado', liveText(), info()); }).catch(() => {}); }
                if (pc && pc.connectionState === 'connected') onState('conectado', liveText(), info());
            }).catch((e) => console.warn('audio panico: no se pudo abrir el microfono en la llamada', e && e.name));
        };
        micListeners.add(onMic);
        const endCall = (state, text, tellServer) => {
            if (pc) { try { pc.close(); } catch { /* ya cerrada */ } pc = null; }
            if (silent) { silent.close(); silent = null; }
            sender = null; dc = null; hasMic = false; audioBlocked = false;
            audioEl.srcObject = null;
            if (tellServer && current) call('hangup', { callId: current }).catch(() => {});
            onState(state, text || '', { mic: false, audioBlocked: false });
        };
        const ctl = {
            stop() { stopped = true; micListeners.delete(onMic); endCall('cerrada', '', !!pc); current = null; releaseMic(); },
            hangup() { endCall('colgado', 'Usted colgó.', true); },
            // Un toque del vecino (el boton): si el telefono no dejo sonar a la central, ahora si suena
            unlock() {
                if (!audioEl.srcObject || !audioEl.paused) return;
                const pl = audioEl.play();
                if (pl && pl.then) pl.then(() => { if (audioBlocked) { audioBlocked = false; if (pc && pc.connectionState === 'connected') onState('conectado', liveText(), info()); } }).catch(() => {});
            }
        };
        (async () => {
            if (!supported()) return;
            onState('esperando', '');
            while (!stopped && Date.now() - started < POLL_FOR_MS) {
                await sleep(POLL_EVERY_MS);
                if (stopped) return;
                if (document.hidden) continue; // con la pantalla apagada no se puede contestar
                const r = await call('poll', {}).catch(() => null);
                if (!r || !r.ok) continue;
                if (r.open === false) { ctl.stop(); return; }
                if (r.call && r.call.callId !== current) {
                    try {
                        current = r.call.callId;
                        byName = r.call.byName || 'La Central de Monitoreo';
                        const stream = await micIfAllowed();
                        pc = new RTCPeerConnection({ iceServers: await servers(call) });
                        hasMic = !!stream;
                        if (stream) stream.getTracks().forEach((t) => { t.enabled = true; sender = pc.addTrack(t, stream); });
                        else {
                            // Sin microfono todavia: una linea en silencio (el microfono entra despues, al tocar el boton); si ni eso se
                            // puede, al menos oye a la garita
                            silent = silentLine();
                            if (silent) sender = pc.addTrack(silent.track, silent.stream);
                            else pc.addTransceiver('audio', { direction: 'recvonly' });
                        }
                        pc.addEventListener('datachannel', (e) => {
                            dc = e.channel;
                            dc.addEventListener('open', tellMic);
                            if (dc.readyState === 'open') tellMic();
                        });
                        playRemote(pc, audioEl, () => { audioBlocked = true; if (pc && pc.connectionState === 'connected') onState('conectado', liveText(), info()); });
                        pc.addEventListener('connectionstatechange', () => {
                            if (!pc) return;
                            if (pc.connectionState === 'connected') { onState('conectado', liveText(), info()); tellMic(); }
                            if (pc.connectionState === 'failed') endCall('error', 'Se cortó el audio con la garita.', true);
                        });
                        await pc.setRemoteDescription({ type: 'offer', sdp: r.call.offer });
                        await pc.setLocalDescription(await pc.createAnswer());
                        await gathered(pc);
                        const a = await call('answer', { callId: current, sdp: pc.localDescription.sdp });
                        if (!a || !a.ok) endCall('colgado', '', false);
                        else onState('conectando', `${byName} le está llamando...`, info());
                    } catch (e) {
                        console.error('audio panico (vecino)', e);
                        endCall('error', 'No se pudo contestar la llamada de la garita.', true);
                    }
                } else if (pc && r.state === 'colgado' && r.callId === current) {
                    endCall('colgado', 'La garita colgó.', false);
                }
            }
        })();
        return ctl;
    }

    // ── VECINO: el boton "PRESIONE PARA HABLAR" (pedido del usuario el 2026-11-25; antes "HABLAR A CENTRAL DE MONITOREO") ──
    // Antes el microfono se pedia solo al enviar la alerta y salia la ventana del telefono "garita.app solicita autorizacion para
    // usar el microfono" sin que el vecino supiera para que (esa ventana es del telefono: una pagina no puede cambiar su texto).
    // Ahora se pide al tocar este boton, que es la forma de autorizarlo: la ventana sale cuando el vecino ya sabe para que es. Al
    // tocarlo, la central ve "PIDE HABLAR" y, cuando llama, el telefono contesta solo con el microfono ya permitido. Si la llamada ya
    // esta en linea sin microfono, el boton sigue a la vista y, al permitirlo, la central lo escucha en esa misma llamada.
    // button lleva [data-talk-label] y [data-talk-sub]; note es donde se explica que paso. Devuelve { show(call), hide(), callState(estado, info) }
    // Como desbloquear el microfono, segun el telefono y el navegador (una pagina no puede abrir los Ajustes del telefono)
    function micHelp(error) {
        const ua = navigator.userAgent || '';
        const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
        const android = /Android/i.test(ua);
        const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|wv\)/i.test(ua);
        if (error === 'NotFoundError') return 'Este teléfono no tiene un micrófono disponible.';
        if (error === 'NotReadableError') return 'El micrófono lo está usando otra aplicación (una llamada, una nota de voz): ciérrela y toque de nuevo.';
        if (error === 'NoSoportado' || inApp) return 'Este navegador no deja usar el micrófono: abra garita.app en Safari (iPhone) o en Chrome (Android) y toque de nuevo.';
        if (ios && /CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)) return 'En el iPhone: Ajustes > (su navegador, por ejemplo Chrome) > active «Micrófono»; vuelva a esta página y toque de nuevo. O abra garita.app en Safari.';
        if (ios) return 'En el iPhone: toque «aA» (junto a la dirección, arriba o abajo) > Configuración del sitio web > Micrófono > Permitir; o recargue la página. Después toque de nuevo y, cuando el teléfono pregunte, toque «Permitir».';
        if (android) return 'En Android: toque el candado (o el ícono de ajustes) junto a la dirección > Permisos > Micrófono > Permitir; después toque de nuevo.';
        return 'Permita el micrófono para garita.app en los ajustes del navegador (el candado junto a la dirección) y toque de nuevo.';
    }
    // El indicador del microfono: barras dentro del boton que se mueven con la voz (pedido del usuario el 2026-11-25: "que muestre un
    // microfono que da senales al hablar, que se note bien cuando ya se activo"). Los estilos son de aqui (los dos paginas los usan)
    function talkStyles() {
        if (typeof document === 'undefined' || document.getElementById('ap-talk-style')) return;
        const st = document.createElement('style');
        st.id = 'ap-talk-style';
        st.textContent = `
            .ap-meter { display: none; align-items: center; gap: 4px; height: 30px; margin-left: auto; flex: none; }
            .panic-talk[data-state="live"] .ap-meter { display: inline-flex; }
            .ap-bar { width: 6px; height: 100%; border-radius: 3px; background: currentColor; transform: scaleY(0.18); transition: transform 70ms linear; }
            .panic-talk[data-state="live"] { background: #15803d; border-color: #86efac; box-shadow: 0 0 0 4px rgba(34,197,94,0.35); }
            .panic-talk[data-state="live"] svg { animation: ap-pulse 1.4s ease-in-out infinite; }
            .panic-talk[data-state="nomic"] { border-color: #f87171; }
            .panic-talk-note .ap-reload { display: block; width: 100%; margin-top: 0.55rem; padding: 0.6rem 0.8rem; border-radius: 10px; border: 1px solid #f59e0b; background: #b45309; color: #fff; font: inherit; font-weight: 800; cursor: pointer; }
            @keyframes ap-pulse { 50% { opacity: 0.55; } }
            @media (prefers-reduced-motion: reduce) { .panic-talk[data-state="live"] svg { animation: none; } .ap-bar { transition: none; } }`;
        document.head.appendChild(st);
    }
    // opts.unlock(): lo que la pagina hace con cada toque para que suene la central (answerCalls.unlock)
    function talkButton({ button, note, unlock }) {
        talkStyles();
        let call = null;
        let inCall = false;
        let callMic = false;
        let audioBlocked = false;
        let told = false;   // la central ya sabe que quiere hablar (want)
        let meterCtx = null;
        let meter = null;
        const label = button.querySelector('[data-talk-label]');
        const sub = button.querySelector('[data-talk-sub]');
        let bars = [...button.querySelectorAll('.ap-bar')];
        if (!bars.length) {
            const m = document.createElement('span');
            m.className = 'ap-meter';
            m.setAttribute('aria-hidden', 'true');
            m.innerHTML = '<i class="ap-bar"></i><i class="ap-bar"></i><i class="ap-bar"></i><i class="ap-bar"></i><i class="ap-bar"></i>';
            button.appendChild(m);
            bars = [...m.querySelectorAll('.ap-bar')];
        }
        const TEXT = {
            idle: ['PRESIONE PARA HABLAR', 'Toque y permita el micrófono: la Central de Monitoreo le escuchará'],
            asking: ['PERMITA EL MICRÓFONO...', 'Toque «Permitir» en la ventana del teléfono'],
            nomic: ['PRESIONE PARA HABLAR', 'Su teléfono no dio el micrófono: vea abajo cómo permitirlo'],
            oncall: ['PRESIONE PARA HABLAR', 'Está en línea: la central le oye solo si permite el micrófono'],
            hear: ['PRESIONE PARA HABLAR', 'Toque para oír a la central y permitir el micrófono']
        };
        const liveSub = () => (inCall
            ? 'La Central de Monitoreo le escucha: hable con normalidad'
            : (told ? 'La central ya sabe que quiere hablar: cuando le llame, le escuchará' : 'Micrófono listo: cuando la central le llame, le escuchará'));
        function startMeter() {
            if (meter || !micLive()) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                const ctx = meterCtx || new Ctx();
                meterCtx = ctx;
                if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
                const an = ctx.createAnalyser();
                an.fftSize = 512;
                ctx.createMediaStreamSource(micStream).connect(an);
                const buf = new Uint8Array(an.fftSize);
                const tick = () => {
                    if (!meter) return;
                    an.getByteTimeDomainData(buf);
                    let peak = 0;
                    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
                    const lvl = Math.min(1, peak / 48);
                    button.dataset.level = lvl.toFixed(2);
                    const t = Date.now() / 110;
                    bars.forEach((b, i) => { b.style.transform = `scaleY(${(0.18 + 0.82 * lvl * (0.55 + 0.45 * Math.abs(Math.sin(t + i * 1.3)))).toFixed(3)})`; });
                    meter.raf = requestAnimationFrame(tick);
                };
                meter = { an, raf: requestAnimationFrame(tick) };
            } catch (e) { console.warn('audio panico: indicador del microfono', e && e.name); }
        }
        function stopMeter() {
            if (meter) cancelAnimationFrame(meter.raf);
            meter = null;
            bars.forEach((b) => { b.style.transform = ''; });
            delete button.dataset.level;
        }
        function setNote(text, reload) {
            note.textContent = text || '';
            if (reload) {
                // Safari del iPhone recuerda el "No" de esta pagina y no vuelve a preguntar hasta recargarla
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'ap-reload';
                b.textContent = 'Recargar la página y volver a intentar';
                b.addEventListener('click', () => location.reload());
                note.appendChild(b);
            }
        }
        function set(state, text, reload) {
            button.dataset.state = state;
            button.disabled = state === 'asking';
            const t = state === 'live' ? ['MICRÓFONO ACTIVO', liveSub()] : TEXT[state];
            label.textContent = t[0];
            sub.textContent = t[1];
            setNote(text, reload);
            if (state === 'live') startMeter(); else stopMeter();
            paint();
        }
        function paint() {
            button.hidden = !call;
            note.hidden = !call || !note.textContent;
        }
        // El estado que toca segun la llamada y el microfono (sin pisar "preguntando" ni el aviso de microfono negado)
        function refresh() {
            if (!call || button.dataset.state === 'asking') return;
            if (micLive()) { set('live', ''); return; }
            if (button.dataset.state === 'nomic') { paint(); return; }
            if (inCall) set(audioBlocked ? 'hear' : 'oncall', '');
            else set('idle', '');
        }
        button.addEventListener('click', async () => {
            const mine = call;
            if (!mine || button.disabled) return;
            // En el mismo toque: que suene la central (Safari no lo deja sin un toque) y el indicador del microfono
            if (unlock) { try { unlock(); } catch { /* sin llamada */ } }
            if (!meterCtx) { try { const Ctx = window.AudioContext || window.webkitAudioContext; meterCtx = new Ctx(); if (meterCtx.resume) meterCtx.resume().catch(() => {}); } catch { meterCtx = null; } }
            if (micLive()) { refresh(); return; }
            set('asking', 'Su teléfono le pregunta si deja usar el micrófono: toque «Permitir». Así la Central de Monitoreo podrá escucharle.');
            const stream = await prepareMic();
            if (mine !== call) return;
            if (!stream) {
                const ua = navigator.userAgent || '';
                const iosSafari = /iPhone|iPad|iPod/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
                set('nomic', `Su teléfono no dio permiso al micrófono, así que la central no le escucha. ${micHelp(micError)}`, iosSafari && micError === 'NotAllowedError');
                mine('want', { mic: false }).catch(() => {});
                return;
            }
            set('live', '');
            if (inCall) return; // en linea, el microfono ya entro en la llamada (answerCalls)
            let ok = false;
            try { const r = await mine('want', { mic: true }); ok = !!(r && r.ok); } catch { ok = false; }
            if (mine !== call) return;
            told = ok;
            // Sin recuadro de texto cuando salio bien: el boton ya lo dice (pedido del usuario: poco texto con la alerta abierta)
            set('live', ok ? '' : 'Su micrófono está listo, pero no se pudo avisar a la central: revise su conexión y toque de nuevo. Si es urgente, llame a la garita por teléfono.');
        });
        return {
            show(fn) { if (call === fn) return; call = fn; inCall = false; callMic = false; audioBlocked = false; told = false; set(micLive() ? 'live' : 'idle', ''); },
            hide() { call = null; inCall = false; callMic = false; stopMeter(); paint(); },
            // El estado de la llamada (answerCalls): en linea con microfono, MICROFONO ACTIVO; sin microfono, pide tocarlo; si el
            // telefono no dejo sonar a la central, pide un toque para oirla
            callState(state, info) {
                if (!call) return;
                inCall = state === 'conectado' || state === 'conectando';
                callMic = !!(info && info.mic);
                audioBlocked = !!(info && info.audioBlocked);
                refresh();
            }
        };
    }

    return { supported, callNeighbor, prepareMic, releaseMic, answerCalls, talkButton };
})();
