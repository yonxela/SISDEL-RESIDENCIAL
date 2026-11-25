// Pruebas de la sirena de alerta maxima (sirena.js, SisdelSirena) sin navegador: con un AudioContext de mentira que cuenta los
// osciladores. El 2026-11-24 el usuario activo el sonido en Control Garita, llego una alerta y la sirena NO sono: con el sonido ya
// activado, start() llamaba a wake(), wake() avisaba a la pagina y la pagina volvia a pedir start() antes de que existiera la
// sirena; el ciclo creaba cientos de sirenas encimadas y el audio se trababa sin sonar. Estas pruebas lo atrapan.
// Uso: node test-sirena.mjs (tambien corre con npm test). SIRENA_FILE=<ruta> prueba otra version del archivo.
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.env.SIRENA_FILE || new URL('../sirena.js', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Carga una sirena nueva con su propio AudioContext de mentira. gesture: si el navegador deja reanudar el audio (hubo un toque)
// ios: un iPhone de mentira (navigator.userAgent, audioSession y un <audio> que cuenta sus play())
function load({ ios = false } = {}) {
    const counts = { created: 0, started: 0, stopped: 0, contexts: 0, keeperPlays: 0, keepers: 0 };
    const env = { gesture: false };
    class FakeContext {
        constructor() { counts.contexts++; counts.ctx = this; this.state = env.gesture ? 'running' : 'suspended'; this.currentTime = 0; this.destination = {}; this.onstatechange = null; }
        setState(state) { if (this.state === state) return; this.state = state; if (this.onstatechange) this.onstatechange(); }
        resume() {
            if (!env.gesture) return new Promise(() => {}); // sin un toque el navegador no lo deja sonar (queda pendiente)
            this.setState('running');
            return Promise.resolve();
        }
        createDynamicsCompressor() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
        createOscillator() {
            counts.created++;
            return { type: '', frequency: { value: 0, setValueAtTime() {} }, connect() {}, start() { counts.started++; }, stop() { counts.stopped++; } };
        }
    }
    const context = {
        window: { AudioContext: FakeContext, addEventListener() {} },
        document: {
            hidden: false, addEventListener() {},
            createElement: () => { counts.keepers++; const a = { paused: true, loop: false, src: '', setAttribute() {}, play() { counts.keeperPlays++; a.paused = !env.gesture; return env.gesture ? Promise.resolve() : Promise.reject(new Error('sin toque')); } }; counts.keeper = a; return a; }
        },
        navigator: ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) CriOS/131.0', audioSession: { type: 'auto' } } : {},
        URL: { createObjectURL: () => 'blob:silencio' }, Blob: class { constructor(parts, opts) { counts.wavBytes = parts[0].byteLength; counts.wavType = opts.type; } }, ArrayBuffer, DataView,
        // La revision cada 4 s no se corre aqui (dejaria el proceso abierto): se prueba aparte, en Chrome
        setInterval: () => 0, clearTimeout,
        Promise, setTimeout, console
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.SisdelSirena = SisdelSirena;`, context);
    context.window.RTCPeerConnection = function RTCPeerConnection() {};
    const S = context.SisdelSirena;
    // Para cargar audio-panico.js en la misma "pagina" (el QR de panico carga los dos)
    Object.defineProperty(S, '__run', { value: (code) => vm.runInContext(code, context) });
    Object.defineProperty(S, '__get', { value: (name) => context[name] });
    return { S, counts, env, nav: context.navigator };
}
// Lo que hace la pagina (panico-alertas.js): cuando el sonido queda listo, vuelve a revisar si debe sonar y llama start()
function page(S) {
    const state = { alert: false, calls: 0 };
    S.onReady((isReady) => { state.calls++; if (isReady && state.alert) S.start(); });
    return state;
}
const active = (counts) => counts.started - counts.stopped;

console.log('Sirena: el sonido ya estaba activado y llega una alerta (lo que paso en Control Garita)');
{
    const { S, counts, env } = load();
    const p = page(S);
    env.gesture = true;
    S.wake(); // el guardia toca "Toque aqui para activar la sirena"
    await tick();
    equal('al tocar, el sonido queda listo y la pagina lo sabe una vez', [S.ready(), p.calls], [true, 1]);
    p.alert = true;
    S.start(); // llega la alerta
    await tick();
    equal('una sola sirena: 4 osciladores (dos tonos y sus ondulaciones), no cientos', [counts.created, active(counts)], [4, 4]);
    equal('suena', S.playing(), true);
    S.start();
    equal('pedirla otra vez no crea otra sirena', counts.created, 4);
    S.stop();
    equal('Silenciar la calla por completo', [S.playing(), active(counts)], [false, 0]);
    S.start();
    equal('vuelve a sonar con una sola sirena', active(counts), 4);
    S.stop();
}

console.log('Sirena: la alerta llega antes de que alguien toque la pagina');
{
    const { S, counts, env } = load();
    const p = page(S);
    p.alert = true;
    S.start(); // sin toque: el navegador no deja sonar todavia
    await tick();
    equal('la sirena queda lista para sonar pero el navegador aun no la deja', [S.ready(), S.playing(), counts.created], [false, true, 4]);
    env.gesture = true;
    S.wake(); // el primer toque
    await tick();
    equal('al tocar suena la MISMA sirena (no se crea otra)', [S.ready(), counts.created, active(counts), p.calls], [true, 4, 4, 1]);
    S.stop();
}

console.log('Sirena: el telefono suspende el audio y lo reanuda');
{
    const { S, counts, env } = load();
    const p = page(S);
    env.gesture = true;
    S.wake();
    await tick();
    p.alert = true;
    S.start();
    const before = p.calls;
    counts.ctx.setState('interrupted'); // una llamada telefonica: el sistema suspende el audio (iOS dice "interrupted")
    equal('la pagina sabe que el sonido ya no esta listo (vuelve a ofrecer el boton)', [S.ready(), p.calls], [false, before + 1]);
    S.wake(); // al volver o tocar, se reanuda
    await tick();
    equal('al reanudarse sigue la MISMA sirena', [S.ready(), p.calls, counts.created, active(counts)], [true, before + 2, 4, 4]);
    S.wake();
    await tick();
    equal('tocar otra vez con el sonido listo no avisa de nuevo ni crea otra sirena', [p.calls, counts.created], [before + 2, 4]);
    S.stop();
}

console.log('Sirena: "Probar la sirena" de la Central de Monitoreo (2026-11-25)');
{
    const { S, counts, env } = load();
    env.gesture = true;
    S.wake();
    await tick();
    equal('la prueba suena', [S.test(40), S.playing(), active(counts)], [true, true, 4]);
    equal('si ya esta sonando no se prueba otra vez', S.test(40), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    equal('y se calla sola', [S.playing(), active(counts)], [false, 0]);
    S.test(40);
    S.start(); // llega una alerta mientras se prueba
    await new Promise((resolve) => setTimeout(resolve, 80));
    equal('si llega una alerta mientras se prueba, la sirena sigue sonando', [S.playing(), active(counts)], [true, 4]);
    S.stop();
    equal('arm() deja lista la sirena sin crear ninguna (solo el audio)', (() => { const x = load(); x.env.gesture = true; x.S.arm(); return [x.S.ready(), x.counts.created, x.S.playing()]; })(), [true, 0, false]);
}

console.log('Sirena: en el iPhone suena aunque este en silencio (2026-11-25)');
{
    const { S, counts, env, nav } = load({ ios: true });
    S.arm(); // al abrir, sin toque: no suena todavia
    await tick();
    equal('al abrir sin toque, el audio casi mudo no arranca (el iPhone exige el toque) y la sirena no esta lista', [S.ready(), counts.keeper ? counts.keeper.paused : true], [false, true]);
    env.gesture = true;
    S.wake(); // el toque de "ACTIVAR LA SIRENA"
    await tick();
    equal('con el toque pide la sesion de reproduccion (iOS 17) y deja sonando un audio casi mudo en bucle', [nav.audioSession.type, counts.keeper.loop, counts.keeper.paused, counts.wavType], ['playback', true, false, 'audio/wav']);
    equal('un solo audio casi mudo (no uno por toque) y la sirena queda lista', [counts.keepers, S.ready()], [1, true]);
    S.wake();
    equal('tocar otra vez no lo vuelve a arrancar si ya suena', counts.keeperPlays, 2);
    const desk = load();
    desk.env.gesture = true;
    desk.S.wake();
    equal('en una computadora no hace falta el audio casi mudo', desk.counts.keepers, 0);
}

console.log('Microfono del vecino en el iPhone con la sirena cargada (QR de panico, 2026-11-25)');
{
    // El 2026-11-25 el vecino ya tenia el microfono permitido en Safari y la central no lo oia: el servidor anoto InvalidStateError en
    // 0 ms. Safari (iOS 17 o mas) NO abre el microfono si la sesion de audio de la pagina es de solo reproduccion, y la sirena la ponia
    // en 'playback' con cada toque. Aqui un getUserMedia de mentira hace lo mismo que Safari y audio-panico.js se carga junto a la sirena
    const audioSource = fs.readFileSync(process.env.AUDIO_FILE || new URL('../audio-panico.js', import.meta.url), 'utf8');
    const { S, env, nav } = load({ ios: true });
    const mic = { asked: 0, stopped: 0, deny: false };
    const track = () => ({ readyState: 'live', enabled: true, stop() { mic.stopped++; this.readyState = 'ended'; } });
    nav.mediaDevices = {
        getUserMedia() {
            mic.asked++;
            const t = nav.audioSession.type;
            if (t === 'playback' || t === 'ambient' || t === 'transient' || t === 'transient-solo') return Promise.reject(Object.assign(new Error('AudioSession category is not compatible with audio capture.'), { name: 'InvalidStateError' }));
            if (mic.deny) return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
            const tr = track();
            return Promise.resolve({ getAudioTracks: () => [tr], getTracks: () => [tr] });
        }
    };
    env.gesture = true;
    S.wake(); // un toque en la pagina: la sirena pone la sesion de reproduccion
    await tick();
    equal('con el primer toque la sirena deja la sesion en "playback" (para sonar con el telefono en silencio)', nav.audioSession.type, 'playback');
    const direct = await nav.mediaDevices.getUserMedia().then(() => 'abrio', (e) => e.name);
    equal('el getUserMedia de mentira hace lo que Safari: en "playback" rechaza al instante con InvalidStateError', direct, 'InvalidStateError');
    const A = loadAudio(audioSource);
    S.wake(); // el toque de "ACTIVAR PARA HABLAR" pasa primero por la sirena (pointerdown) y despues llega al boton
    const stream = await A.prepareMic();
    equal('"ACTIVAR PARA HABLAR" abre el microfono aunque la sirena este cargada', !!stream, true);
    equal('para abrirlo la sesion pasa a "play-and-record" (reproducir y grabar: tambien suena en silencio)', nav.audioSession.type, 'play-and-record');
    S.wake(); // mas toques mientras habla con la central
    await tick();
    equal('otro toque en la pagina NO la devuelve a "playback" (cortaria el microfono)', nav.audioSession.type, 'play-and-record');
    A.releaseMic(); // la alerta se cerro
    equal('al soltar el microfono la sesion vuelve a "playback" y el microfono se apaga', [nav.audioSession.type, mic.stopped], ['playback', 1]);
    mic.deny = true;
    const none = await A.prepareMic();
    equal('si el telefono niega el microfono, la sesion tambien vuelve a "playback"', [none, nav.audioSession.type], [null, 'playback']);
    mic.deny = false;
    const again = await A.prepareMic();
    equal('y al permitirlo despues, se abre (otra vez "play-and-record")', [!!again, nav.audioSession.type], [true, 'play-and-record']);
    A.releaseMic();
    function loadAudio(src) {
        nav.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1';
        S.__run(`${src}\nthis.SisdelAudioPanico = SisdelAudioPanico;`);
        return S.__get('SisdelAudioPanico');
    }
}

console.log(`\nSirena: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) process.exit(1);
