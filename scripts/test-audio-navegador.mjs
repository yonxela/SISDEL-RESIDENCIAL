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
    await waitFor('Control Garita abre con el aviso de panico', () => garita.evaluate(`typeof SisdelPanico !== 'undefined' && !!document.querySelector('.pan-bar')`));
    const realRef = db.collection(`condominios/${CONDO}/alertas_panico`).doc();
    await realRef.set({ id: realRef.id, condominioId: CONDO, source: 'vecino', userId: 'u-ana', userName: 'Ana García', casa: 'Casa 12', phone: '5555-5678', lat: 14.54, lng: -90.45, status: 'ACTIVE', createdAt: new Date().toISOString() });
    await waitFor('llega una alerta real: suena la sirena sin parar y la pantalla destella en rojo', () => garita.evaluate(`SisdelSirena.playing() && !document.querySelector('.pan-flash').hidden && /ALERTA DE PÁNICO/.test(document.querySelector('.pan-bar').innerText)`));
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
    await waitFor('el vecino envia un simulacro (se puede probar el audio con el)', () => vecino.evaluate(`/SIMULACRO ENVIADO/.test(document.getElementById('panicStatus').innerText)`));
    const callBtn = await waitFor('en la garita aparece "Escuchar / Hablar" en la alerta del vecino', () => garita.evaluate(`(() => { const b = [...document.querySelectorAll('[data-call]')].pop(); return b ? b.dataset.call : null; })()`));
    await garita.evaluate(`document.querySelector('[data-call="${callBtn}"]').click()`);
    await waitFor('la garita llama: el telefono del vecino contesta solo y quedan en linea', () => vecino.evaluate(`/está en línea: le escucha/.test(document.getElementById('panicAudioText').textContent)`), 60000);
    await waitFor('la garita ve "Conectado" y puede hablar', () => garita.evaluate(`(() => { const b = document.querySelector('.pan-call'); return !!b && /Conectado/.test(b.innerText) && !b.querySelector('[data-talk]').disabled; })()`), 30000);
    equal('los dos reciben el audio del otro', await Promise.all([garita.evaluate(`!!document.querySelector('.pan-call audio').srcObject`), vecino.evaluate(`!!document.getElementById('panicAudioEl').srcObject`)]), [true, true]);
    await garita.evaluate(`document.querySelector('.pan-call [data-talk]').click()`);
    equal('"Hablar" abre el microfono de la garita', await garita.evaluate(`/Dejar de hablar/.test(document.querySelector('.pan-call [data-talk]').textContent)`), true);
    await garita.evaluate(`document.querySelector('.pan-call [data-hang]').click()`);
    await waitFor('la garita cuelga y el telefono del vecino lo dice', () => vecino.evaluate(`/La garita colgó/.test(document.getElementById('panicAudioText').textContent)`), 20000);
    equal('la garita puede volver a llamar', await garita.evaluate(`!!document.querySelector('.pan-call [data-retry]')`), true);
    console.log('errores en las paginas:', JSON.stringify([...garita.errors, ...vecino.errors].filter((e) => !/favicon|manifest/i.test(e)).slice(0, 5)));
} finally {
    await close();
}
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
