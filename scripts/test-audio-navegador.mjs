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
    // "HABLAR A CENTRAL DE MONITOREO" (2026-11-25): el microfono se pide al tocarlo (aqui el permiso de prueba lo da solo)
    await waitFor('el telefono del vecino muestra "HABLAR A CENTRAL DE MONITOREO" mientras la alerta esta abierta', () => vecino.evaluate(`!document.getElementById('panicTalk').hidden && /HABLAR A CENTRAL DE MONITOREO/.test(document.getElementById('panicTalk').innerText)`));
    await vecino.evaluate(`document.getElementById('panicTalk').click()`);
    await waitFor('al tocarlo da el microfono y avisa a la central (el boton pasa a verde)', () => vecino.evaluate(`document.getElementById('panicTalk').dataset.state === 'sent' && /LA CENTRAL YA SABE/.test(document.getElementById('panicTalk').innerText) && /Cuando le llamen/.test(document.getElementById('panicTalkNote').textContent)`), 30000);
    await waitFor('la central ve "PIDE HABLAR" y su "Escuchar / Hablar" late en amarillo', () => garita.evaluate(`/PIDE HABLAR/.test(document.querySelector('.pan-bar').innerText) && document.querySelector('[data-call="${callBtn}"]').classList.contains('want')`), 30000);
    await garita.evaluate(`document.querySelector('[data-call="${callBtn}"]').click()`);
    equal('al llamar deja de decir "PIDE HABLAR"', await garita.evaluate(`!/PIDE HABLAR/.test(document.querySelector('.pan-bar').innerText)`), true);
    await waitFor('la garita llama: el telefono del vecino contesta solo y quedan en linea', () => vecino.evaluate(`/está en línea: le escucha/.test(document.getElementById('panicAudioText').textContent)`), 60000);
    await waitFor('la garita ve "Conectado" y puede hablar', () => garita.evaluate(`(() => { const b = document.querySelector('.pan-call'); return !!b && /Conectado/.test(b.innerText) && !b.querySelector('[data-talk]').disabled; })()`), 30000);
    equal('en linea, el boton del vecino se esconde (se ve la llamada)', await vecino.evaluate(`document.getElementById('panicTalk').hidden`), true);
    equal('los dos reciben el audio del otro', await Promise.all([garita.evaluate(`!!document.querySelector('.pan-call audio').srcObject`), vecino.evaluate(`!!document.getElementById('panicAudioEl').srcObject`)]), [true, true]);
    await garita.evaluate(`document.querySelector('.pan-call [data-talk]').click()`);
    equal('"Hablar" abre el microfono de la garita', await garita.evaluate(`/Dejar de hablar/.test(document.querySelector('.pan-call [data-talk]').textContent)`), true);
    await garita.evaluate(`document.querySelector('.pan-call [data-hang]').click()`);
    await waitFor('la garita cuelga y el telefono del vecino lo dice', () => vecino.evaluate(`/La garita colgó/.test(document.getElementById('panicAudioText').textContent)`), 20000);
    equal('la garita puede volver a llamar', await garita.evaluate(`!!document.querySelector('.pan-call [data-retry]')`), true);
    equal('y al colgar el vecino vuelve a tener "HABLAR A CENTRAL DE MONITOREO"', await vecino.evaluate(`!document.getElementById('panicTalk').hidden && document.getElementById('panicTalk').dataset.state === 'idle'`), true);
    console.log('errores en las paginas:', JSON.stringify([...garita.errors, ...vecino.errors].filter((e) => !/favicon|manifest/i.test(e)).slice(0, 5)));
} finally {
    await close();
}
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
