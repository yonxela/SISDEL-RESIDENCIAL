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
    function playRemote(pc, audioEl) {
        pc.addEventListener('track', (e) => {
            audioEl.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
            const p = audioEl.play();
            if (p && p.catch) p.catch(() => {});
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
                pc.addEventListener('connectionstatechange', () => {
                    if (done) return;
                    if (pc.connectionState === 'connected') onState('conectado', 'Conectado: escucha lo que pasa en el teléfono del vecino. Toque "Hablar" para que le oiga.');
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
    function prepareMic() {
        if (!supported()) return Promise.resolve(null);
        if (!micPromise) micPromise = navigator.mediaDevices.getUserMedia(micConstraints).catch((e) => { micPromise = null; console.warn('microfono', e && e.name); return null; });
        return micPromise;
    }
    function releaseMic() {
        if (!micPromise) return;
        micPromise.then((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
        micPromise = null;
    }

    // Mientras la alerta este abierta, pregunta si la garita lo llama y CONTESTA SOLO. onState(estado, texto): esperando, conectado,
    // colgado, error, cerrada. Devuelve { stop(), hangup() }
    function answerCalls({ call, onState, audioEl }) {
        let stopped = false;
        let pc = null;
        let current = null;
        const started = Date.now();
        const endCall = (state, text, tellServer) => {
            if (pc) { try { pc.close(); } catch { /* ya cerrada */ } pc = null; }
            audioEl.srcObject = null;
            if (tellServer && current) call('hangup', { callId: current }).catch(() => {});
            onState(state, text || '');
        };
        const ctl = {
            stop() { stopped = true; endCall('cerrada', '', !!pc); current = null; releaseMic(); },
            hangup() { endCall('colgado', 'Usted colgó.', true); }
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
                        const stream = await prepareMic();
                        pc = new RTCPeerConnection({ iceServers: await servers(call) });
                        if (stream) stream.getTracks().forEach((t) => { t.enabled = true; pc.addTrack(t, stream); });
                        else pc.addTransceiver('audio', { direction: 'recvonly' }); // sin microfono: al menos oye a la garita
                        playRemote(pc, audioEl);
                        pc.addEventListener('connectionstatechange', () => {
                            if (!pc) return;
                            if (pc.connectionState === 'connected') onState('conectado', `${r.call.byName} está en línea: le escucha${stream ? '' : ' (su teléfono no dio permiso al micrófono: solo usted le oye)'}.`);
                            if (pc.connectionState === 'failed') endCall('error', 'Se cortó el audio con la garita.', true);
                        });
                        await pc.setRemoteDescription({ type: 'offer', sdp: r.call.offer });
                        await pc.setLocalDescription(await pc.createAnswer());
                        await gathered(pc);
                        const a = await call('answer', { callId: current, sdp: pc.localDescription.sdp });
                        if (!a || !a.ok) endCall('colgado', '', false);
                        else onState('conectando', `${r.call.byName} le está llamando...`);
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

    // ── VECINO: el boton "HABLAR A CENTRAL DE MONITOREO" (pedido del usuario el 2026-11-25) ──
    // Antes el microfono se pedia solo al enviar la alerta y salia la ventana del telefono "garita.app solicita autorizacion para
    // usar el microfono" sin que el vecino supiera para que (esa ventana es del telefono: una pagina no puede cambiar su texto).
    // Ahora se pide al tocar este boton, que es la forma de autorizarlo: la ventana sale cuando el vecino ya sabe para que es. Al
    // tocarlo, la central ve "PIDE HABLAR" y, cuando llama, el telefono contesta solo con el microfono ya permitido.
    // button lleva [data-talk-label] y [data-talk-sub]; note es donde se explica que paso. Devuelve { show(call), hide(), callState(estado) }
    const MIC_HELP = 'en el iPhone, Ajustes > Safari (o el navegador que use) > Micrófono > Preguntar; en Android, el candado junto a la dirección > Permisos > Micrófono.';
    function talkButton({ button, note }) {
        let call = null;
        let inCall = false;
        let timer = null;
        const label = button.querySelector('[data-talk-label]');
        const sub = button.querySelector('[data-talk-sub]');
        const TEXT = {
            idle: ['HABLAR A CENTRAL DE MONITOREO', 'Toque y permita el micrófono'],
            asking: ['PERMITA EL MICRÓFONO...', 'Toque «Permitir» en la ventana del teléfono'],
            sent: ['LA CENTRAL YA SABE QUE QUIERE HABLAR', 'Cuando le llamen, su teléfono contesta solo'],
            again: ['AVISAR OTRA VEZ A LA CENTRAL', 'La central ya sabe que quiere hablar'],
            nomic: ['HABLAR A CENTRAL DE MONITOREO', 'Su teléfono no dio el micrófono: toque de nuevo']
        };
        function set(state, text) {
            clearTimeout(timer);
            button.dataset.state = state;
            button.disabled = state === 'asking' || state === 'sent';
            label.textContent = TEXT[state][0];
            sub.textContent = TEXT[state][1];
            note.textContent = text || '';
            paint();
        }
        function paint() {
            button.hidden = !call || inCall;
            note.hidden = button.hidden || !note.textContent;
        }
        button.addEventListener('click', async () => {
            const mine = call;
            if (!mine || button.disabled) return;
            set('asking', 'Su teléfono le pregunta si deja usar el micrófono: toque «Permitir». Así la Central de Monitoreo podrá escucharle.');
            const stream = await prepareMic();
            if (mine !== call) return;
            let ok = false;
            try { const r = await mine('want', { mic: !!stream }); ok = !!(r && r.ok); } catch { ok = false; }
            if (mine !== call) return;
            if (!ok) { set('idle', 'No se pudo avisar a la central: revise su conexión y toque de nuevo. Si es urgente, llame a la garita por teléfono.'); return; }
            if (!stream) { set('nomic', `La central ya sabe que quiere hablar, pero su teléfono no dio permiso al micrófono: podrá oír a la central, no hablarle. Para permitirlo: ${MIC_HELP} Después toque de nuevo.`); return; }
            set('sent', 'Listo: la Central de Monitoreo ve que quiere hablar. Cuando le llamen, su teléfono contesta solo. Deje esta página abierta y la pantalla encendida.');
            timer = setTimeout(() => { if (button.dataset.state === 'sent') { button.disabled = false; button.dataset.state = 'again'; label.textContent = TEXT.again[0]; sub.textContent = TEXT.again[1]; } }, 30000);
        });
        return {
            show(fn) { if (call === fn) return; call = fn; inCall = false; set('idle', ''); },
            hide() { call = null; inCall = false; clearTimeout(timer); paint(); },
            // El estado de la llamada (answerCalls): en linea se esconde el boton; al colgar vuelve para pedir otra vez
            callState(state) {
                if (!call) return;
                const was = inCall;
                inCall = state === 'conectado' || state === 'conectando';
                if (was && !inCall) set('idle', '');
                else paint();
            }
        };
    }

    return { supported, callNeighbor, prepareMic, releaseMic, answerCalls, talkButton };
})();
