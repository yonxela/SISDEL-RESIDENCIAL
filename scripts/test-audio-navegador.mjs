// Prueba en navegadores de verdad (Chrome sin ventana, con microfonos de prueba) de la sirena de alerta maxima y del audio de
// doble via entre la garita y el vecino que pidio ayuda (2026-11-24). Contra los emuladores (antes: npm run seed).
// Uso: node test-audio-navegador.mjs   (no entra en npm test: necesita Chrome; como test-finanzas-navegador.mjs)
import { connect, parseArgs } from './admin.mjs';
import { launch, sleep } from './chrome.mjs';

const args = parseArgs();
const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CONDO = 'condo-villa-ferrer';
const db = connect('emulator');
let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
async function waitFor(name, fn, timeoutMs = 40000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        try { last = await fn(); if (last) { passed++; console.log(`  ok   ${name}`); return last; } } catch (e) { last = e.message; }
        await sleep(400);
    }
    failures.push(name);
    console.log(`  FALLA ${name} (no paso en ${timeoutMs / 1000} s; ultimo: ${JSON.stringify(last)})`);
    return null;
}

await db.doc(`condominios/${CONDO}/rondas_config/general`).set({ neighbor_panic_enabled: true }, { merge: true });
// Microfono y permiso de prueba; sin pedir un toque para el sonido (la sirena se prueba sonando)
const { newPage, close } = await launch(args.chrome, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']);
try {
    console.log('\nSirena de alerta maxima (Control Garita)');
    const garita = await newPage({ stepTimeoutMs: 120000 });
    await garita.login(BASE, 'VP103');
    await garita.goto(`${BASE}/garita.html`);
    await waitFor('la Central de Monitoreo abre con el aviso de panico', () => garita.evaluate(`typeof SisdelPanico !== 'undefined' && !!document.querySelector('.pan-bar')`));
    // Este Chrome deja sonar sin un toque (como la central instalada como aplicacion): la sirena queda activa sola al abrir
    await waitFor('sin tocar nada, el encabezado dice "Sirena activa" (sin el boton flotante)', () => garita.evaluate(`document.getElementById('chipSirenaText').textContent === 'Sirena activa' && !document.querySelector('.pan-sound')`));
    await sleep(1200);
    equal('y como ya suena, la pantalla obligatoria "ACTIVE LA SIRENA" ni aparece', await garita.evaluate(`document.getElementById('sirenGate').hidden`), true);
    // Cuenta los osciladores que se crean: con el sonido ya permitido, la version del 2026-11-24 entraba en un ciclo y creaba miles
    // de sirenas encimadas (el audio se trababa sin sonar en Control Garita)
    await garita.evaluate(`(() => { window.__osc = 0; const P = (window.AudioContext || window.webkitAudioContext).prototype; const f = P.createOscillator; P.createOscillator = function () { window.__osc++; return f.call(this); }; return true; })()`);
    const realRef = db.collection(`condominios/${CONDO}/alertas_panico`).doc();
    await realRef.set({ id: realRef.id, condominioId: CONDO, source: 'vecino', userId: 'u-ana', userName: 'Ana García', casa: 'Casa 12', phone: '5555-5678', lat: 14.54, lng: -90.45, status: 'ACTIVE', createdAt: new Date().toISOString() });
    await waitFor('llega una alerta real: suena la sirena sin parar y la pantalla destella en rojo', () => garita.evaluate(`SisdelSirena.playing() && !document.querySelector('.pan-flash').hidden && /ALERTA DE PÁNICO/.test(document.querySelector('.pan-bar').innerText)`));
    equal('una sola sirena: 4 osciladores (dos tonos y sus ondulaciones), no miles encimados', await garita.evaluate(`window.__osc`), 4);
    await sleep(5000);
    equal('a los 5 segundos sigue sonando (no es un pitido corto)', await garita.evaluate(`SisdelSirena.playing()`), true);
    await garita.evaluate(`document.querySelector('[data-mute="${realRef.id}"]').click()`);
    equal('"Silenciar" calla la sirena y la alerta sigue en pantalla', await garita.evaluate(`[SisdelSirena.playing(), document.querySelector('.pan-flash').hidden, !!document.querySelector('[data-attend="${realRef.id}"]')]`), [false, true, true]);
    await realRef.update({ status: 'RESOLVED', resolvedAt: new Date().toISOString() });
    await waitFor('resuelta, sale de la pantalla', () => garita.evaluate(`!document.querySelector('[data-attend="${realRef.id}"]')`));

    console.log('\nAudio de doble via: la garita llama y el telefono del vecino contesta solo');
    const vecino = await newPage({ stepTimeoutMs: 120000 });
    await vecino.send('Browser.grantPermissions', { permissions: ['geolocation', 'audioCapture'], origin: BASE }).catch(() => {});
    await vecino.send('Emulation.setGeolocationOverride', { latitude: 14.542, longitude: -90.453, accuracy: 15 });
    await vecino.login(BASE, 'VA101');
    await waitFor('el portal del vecino abre con el boton de panico listo', () => vecino.evaluate(`!!document.getElementById('btnPanicDrill') && getComputedStyle(document.getElementById('panicCard')).display !== 'none'`));
    await sleep(1500);
    await vecino.evaluate(`(() => { document.querySelectorAll('.modal-overlay').forEach((m) => { m.style.display = 'none'; }); window.confirm = () => true; document.getElementById('btnPanicDrill').click(); })()`);
    await waitFor('el vecino envia la prueba "todo sin novedad" (se puede probar el audio con ella)', () => vecino.evaluate(`/PRUEBA ENVIADA|TODO SIN NOVEDAD/.test(document.getElementById('panicStatus').innerText)`));
    // La prueba (2026-11-25): en la garita en verde y SIN sirena; la pantalla de la garita la recibe sola y el vecino lo ve punto por punto
    await waitFor('la garita ve la prueba en verde, sin sirena', () => garita.evaluate(`/PRUEBA DEL VECINO · TODO SIN NOVEDAD/.test(document.querySelector('.pan-bar').innerText) && !!document.querySelector('.pan-item.drill') && !SisdelSirena.playing() && document.querySelector('.pan-flash').hidden`));
    await waitFor('la pantalla de la garita la recibe sola y el vecino lo ve', () => vecino.evaluate(`(() => { const t = document.getElementById('panicStatus').innerText; return /La pantalla de la garita la recibió/.test(t) && /Llevó su ubicación GPS \\(±15 m\\)/.test(t) && /no sonó ninguna sirena/.test(t); })()`), 30000);
    equal('la garita la marca como recibida automaticamente', await garita.evaluate(`/Recibida automáticamente por la pantalla de/.test(document.querySelector('.pan-bar').innerText)`), true);
    equal('la prueba nunca hizo sonar la sirena de la garita', await garita.evaluate(`SisdelSirena.playing()`), false);
    const callBtn = await waitFor('en la garita aparece "Escuchar / Hablar" en la alerta del vecino', () => garita.evaluate(`(() => { const b = [...document.querySelectorAll('[data-call]')].pop(); return b ? b.dataset.call : null; })()`));
    // "PRESIONE PARA HABLAR" (2026-11-25, antes "HABLAR A CENTRAL DE MONITOREO"): el microfono se pide al tocarlo (aqui el permiso de prueba lo da solo)
    await waitFor('el telefono del vecino muestra "ACTIVAR PARA HABLAR" mientras la alerta esta abierta', () => vecino.evaluate(`!document.getElementById('panicTalk').hidden && /ACTIVAR PARA HABLAR/.test(document.getElementById('panicTalk').innerText)`));
    await vecino.evaluate(`document.getElementById('panicTalk').click()`);
    await waitFor('al tocarlo da el microfono y avisa a la central: el boton pasa a verde, MICROFONO ACTIVO', () => vecino.evaluate(`document.getElementById('panicTalk').dataset.state === 'live' && /MICRÓFONO ACTIVO/.test(document.getElementById('panicTalk').innerText) && /La central ya sabe que quiere hablar/.test(document.getElementById('panicTalk').innerText) && document.getElementById('panicTalkNote').hidden`), 30000);
    // Las barras del microfono se mueven con el sonido (el microfono de prueba de Chrome suena a ratos)
    await waitFor('las ondas del microfono crecen con la voz', () => vecino.evaluate(`Number(document.getElementById('panicTalk').dataset.level || 0) > 0.05 && Number(getComputedStyle(document.getElementById('panicTalk')).getPropertyValue('--lvl')) > 0.05`), 20000);
    // Con la alerta abierta solo queda el boton de panico, su estado y "PRESIONE PARA HABLAR" (2026-11-25: "para no confundir con tanto texto")
    equal('con la alerta abierta se esconden la prueba, los contactos, la ubicacion y la llamada en texto', await vecino.evaluate(`['btnPanicDrill', 'panicDrillNote', 'btnContacts', 'panicGps', 'panicAudio', 'vecTabs', 'panicTalkNote'].map((id) => getComputedStyle(document.getElementById(id)).display).concat(getComputedStyle(document.querySelector('.welcome-hero')).display)`), ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none']);
    equal('y el boton de hablar va justo debajo del boton de panico', await vecino.evaluate(`document.getElementById('panicBtnHost').nextElementSibling.id`), 'panicTalk');
    await waitFor('la central ve "PIDE HABLAR" y su "Escuchar / Hablar" late en amarillo', () => garita.evaluate(`/PIDE HABLAR/.test(document.querySelector('.pan-bar').innerText) && document.querySelector('[data-call="${callBtn}"]').classList.contains('want')`), 30000);
    await garita.evaluate(`document.querySelector('[data-call="${callBtn}"]').click()`);
    equal('al llamar deja de decir "PIDE HABLAR"', await garita.evaluate(`!/PIDE HABLAR/.test(document.querySelector('.pan-bar').innerText)`), true);
    await waitFor('la garita llama: el telefono del vecino contesta solo y quedan en linea', () => vecino.evaluate(`/está en línea: le escucha/.test(document.getElementById('panicAudioText').textContent)`), 60000);
    await waitFor('la garita ve "Conectado" y puede hablar', () => garita.evaluate(`(() => { const b = document.querySelector('.pan-call'); return !!b && /Conectado/.test(b.innerText) && !b.querySelector('[data-talk]').disabled; })()`), 30000);
    equal('en linea, el boton dice TRANSMITIENDO: la central le escucha', await vecino.evaluate(`!document.getElementById('panicTalk').hidden && document.getElementById('panicTalk').dataset.state === 'live' && /TRANSMITIENDO/.test(document.getElementById('panicTalk').innerText) && /La Central de Monitoreo le escucha/.test(document.getElementById('panicTalk').innerText)`), true);
    equal('los dos reciben el audio del otro', await Promise.all([garita.evaluate(`!!document.querySelector('.pan-call audio').srcObject`), vecino.evaluate(`!!document.getElementById('panicAudioEl').srcObject`)]), [true, true]);
    await garita.evaluate(`document.querySelector('.pan-call [data-talk]').click()`);
    equal('"Hablar" abre el microfono de la garita', await garita.evaluate(`/Dejar de hablar/.test(document.querySelector('.pan-call [data-talk]').textContent)`), true);
    await garita.evaluate(`document.querySelector('.pan-call [data-hang]').click()`);
    await waitFor('la garita cuelga y el telefono del vecino lo dice', () => vecino.evaluate(`/La garita colgó/.test(document.getElementById('panicAudioText').textContent)`), 20000);
    equal('la garita puede volver a llamar', await garita.evaluate(`!!document.querySelector('.pan-call [data-retry]')`), true);
    equal('al colgar el vecino conserva el microfono listo para la siguiente llamada', await vecino.evaluate(`!document.getElementById('panicTalk').hidden && document.getElementById('panicTalk').dataset.state === 'live' && /MICRÓFONO ACTIVO/.test(document.getElementById('panicTalk').innerText)`), true);

    // ── El telefono del vecino SIN microfono (2026-11-25: en la prueba la central no oia al vecino y decia "escucha lo que pasa") ──
    console.log('\nUn telefono que no dio el microfono: la central lo dice y, al permitirlo, lo escucha sin volver a llamar');
    await vecino.send('Page.close').catch(() => {});
    const sinMic = await newPage({ stepTimeoutMs: 120000 });
    await sinMic.send('Browser.grantPermissions', { permissions: ['geolocation'], origin: BASE }).catch(() => {});
    await sinMic.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: BASE }).catch(() => {});
    await sinMic.send('Emulation.setGeolocationOverride', { latitude: 14.542, longitude: -90.453, accuracy: 15 });
    // Chrome de prueba da el microfono sin preguntar: aqui el telefono lo niega (como un iPhone con el microfono bloqueado) hasta
    // que se "permite" mas abajo
    await sinMic.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { if (!navigator.mediaDevices) return; const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__pedidos = 0; window.__permitirMicrofono = () => { navigator.mediaDevices.getUserMedia = real; }; navigator.mediaDevices.getUserMedia = () => { window.__pedidos++; return Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); }; })()` });
    await sinMic.login(BASE, 'VA101');
    await waitFor('el telefono sin microfono abre con su alerta y "PRESIONE PARA HABLAR"', () => sinMic.evaluate(`!document.getElementById('panicTalk').hidden`), 60000);
    await sinMic.evaluate(`document.querySelectorAll('.modal-overlay').forEach((m) => { m.style.display = 'none'; }); true`);
    // Lo que llega a la garita: el nivel del audio del vecino (el microfono de prueba de Chrome suena; la linea en silencio no)
    const level = (page) => page.evaluate(`(async () => { const el = document.querySelector('.pan-call audio'); if (!el || !el.srcObject) return -1;
        const ctx = new AudioContext(); await ctx.resume(); const src = ctx.createMediaStreamSource(el.srcObject); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
        const buf = new Float32Array(an.fftSize); let max = 0; for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; max = Math.max(max, Math.sqrt(sum / buf.length)); }
        ctx.close(); return Math.round(max * 10000) / 10000; })()`);
    await garita.evaluate(`document.querySelector('.pan-call [data-retry]').click()`);
    await waitFor('la garita vuelve a llamar: el telefono contesta sin microfono y la garita lo dice en ambar', () => garita.evaluate(`(() => { const b = document.querySelector('.pan-call'); return !!b && b.classList.contains('nomic') && /NO dio permiso al micrófono/.test(b.innerText); })()`), 60000);
    await waitFor('el vecino ve que la central no le escucha y el boton sigue a la vista', () => sinMic.evaluate(`!document.getElementById('panicTalk').hidden && document.getElementById('panicTalk').dataset.state === 'oncall' && /NO le escucha/.test(document.getElementById('panicAudioText').textContent)`), 30000);
    equal('al contestar solo, el telefono NO pidio el microfono (sin un toque salia la ventana de sorpresa)', await sinMic.evaluate(`window.__pedidos`), 0);
    const quiet = await level(garita);
    equal('sin microfono no llega sonido del vecino a la garita (la linea va en silencio)', quiet >= 0 && quiet < 0.001, true);
    // Tocar con el microfono negado: el boton se pone rojo y la ayuda sale en una ventana (con el codigo del telefono), no como texto fijo
    await sinMic.evaluate(`document.getElementById('panicTalk').click(); true`);
    await waitFor('con el microfono negado, el boton se pone rojo y la ayuda sale en una ventana con el codigo', () => sinMic.evaluate(`document.getElementById('panicTalk').dataset.state === 'nomic' && !!document.querySelector('.ap-help') && /Código: NotAllowedError/.test(document.querySelector('.ap-help').innerText) && document.getElementById('panicTalkNote').hidden`), 20000);
    await sinMic.evaluate(`[...document.querySelectorAll('.ap-help button')].find((b) => /Entendido/.test(b.textContent)).click(); true`);
    await sinMic.evaluate(`window.__permitirMicrofono(); document.getElementById('panicTalk').click(); true`);
    await waitFor('al permitirlo, la garita lo dice: su microfono esta abierto (sin volver a llamar)', () => garita.evaluate(`(() => { const b = document.querySelector('.pan-call'); return !!b && !b.classList.contains('nomic') && /micrófono está abierto/.test(b.innerText); })()`), 30000);
    await waitFor('y el vecino ve que ya le escuchan: MICROFONO ACTIVO', () => sinMic.evaluate(`/le escucha\./.test(document.getElementById('panicAudioText').textContent) && document.getElementById('panicTalk').dataset.state === 'live'`), 30000);
    const loud = await level(garita);
    equal('ahora si llega el sonido del microfono del vecino a la garita', loud > 0.001, true);
    console.log('   nivel sin microfono:', quiet, '· con microfono:', loud);
    await garita.evaluate(`document.querySelector('.pan-call [data-hang]').click()`);
    // Un error en una pagina hace fallar la prueba (2026-11-25: "first is not defined" en la barra de la central solo se imprimia y la
    // prueba pasaba, porque la barra se repintaba en la siguiente novedad)
    equal('sin errores en las paginas (garita, telefono del vecino y telefono sin microfono)', [...garita.errors, ...vecino.errors, ...sinMic.errors].filter((e) => !/favicon|manifest/i.test(e)).slice(0, 5), []);
} finally {
    await close();
}
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
