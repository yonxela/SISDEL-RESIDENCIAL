// Prueba de Control Garita y su escaner manual (lector de codigos USB) en un navegador de verdad (Chrome sin ventana, contra los emuladores):
// un guardia pasa marbetes, pases de visita y claves por el "lector" (teclas REALES enviadas al navegador con Input.dispatchKeyEvent, a pocos
// milisegundos por letra y con Enter al final, como lo hace un lector USB), con y sin un boton o la casilla de codigo con el foco.
// Se comprueba: el escaner viene activado de entrada; la tarjeta del marbete (diseno 6: medallon AL DIA / EN MORA, nombre grande, placa) sale al
// instante, sin importar donde este el cursor y sin la pantalla de MOROSO; se cierra sola a los N segundos (Configuracion), con un clic o con
// Escape; otra lectura la reemplaza; el ingreso se registra solo (via "lector", aviso_mora si esta en mora) al cerrarse; "Era una salida" lo
// vuelve salida; lo que no alcanzo a guardarse (se recarga la pagina con la tarjeta abierta) se guarda al abrir otra vez; apagado no
// intercepta nada; una persona escribiendo despacio sigue yendo por el codigo escrito; y la ventana de prueba.
// No corre con `npm test` porque necesita Chrome instalado:
//   cd scripts && npm run seed && node test-garita-lector.mjs     (con los emuladores levantados; tambien en `npm run test:navegador`)
import { connect, parseArgs } from './admin.mjs';
import { FieldValue } from 'firebase-admin/firestore';
import { launch, sleep } from './chrome.mjs';

const args = parseArgs();
const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CONDO = 'condo-villa-ferrer';
const db = connect('emulator');
const accessRef = db.collection(`condominios/${CONDO}/accesos`);
const usersRef = db.collection(`condominios/${CONDO}/usuarios`);

let passed = 0;
const failures = [];
function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
const equal = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
const all = async () => (await accessRef.orderBy('at', 'asc').get()).docs.map((d) => d.data());

async function run() {
    for (const d of (await accessRef.get()).docs) await d.ref.delete();
    // Ana al dia y Maria morosa: el seed lo deja asi, pero otra prueba pudo cambiarlo
    await usersRef.doc('u-ana').update({ paymentStatus: 'al_dia' });
    await usersRef.doc('u-maria').update({ paymentStatus: 'moroso' });

    const { newPage, close } = await launch(args.chrome);
    try {
        const page = await newPage({ stepTimeoutMs: 60000 });
        await page.login(BASE, 'VP103');
        const openGarita = async () => {
            await page.goto(`${BASE}/garita.html`);
            await page.waitFor(`document.getElementById('condoName') && document.getElementById('condoName').textContent === 'Villa Ferrer' && typeof SISDEL.createAccess === 'function' && document.getElementById('lectorTitle')`, 'la garita', 30000);
            try { await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) { /* version vieja de Chrome */ }
            await sleep(800);
        };
        await openGarita();

        // Teclas reales, como las manda un lector: pocos ms entre letras y Enter al final
        const key = async (ch, type = 'char') => {
            const special = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 } }[ch];
            const base = special || { key: ch, code: /[A-Za-z]/.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : undefined, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), text: ch, unmodifiedText: ch };
            await page.send('Input.dispatchKeyEvent', { type: special && !special.text ? 'rawKeyDown' : 'keyDown', ...base });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode });
        };
        const burst = async (text, gap = 0, end = 'Enter') => {
            for (const ch of text) { await key(ch); if (gap) await sleep(gap); }
            if (end) await key(end);
        };
        const overlayOpen = `getComputedStyle(document.getElementById('lectorOverlay')).display !== 'none'`;
        const overlay = () => page.evaluate(`(() => { const c = document.getElementById('lovCard'); const q = (id) => document.getElementById(id); return { open: ${overlayOpen}, tone: c.className.replace('lov-card ', ''), word: q('lovWord').textContent, name: q('lovName').textContent, plate: q('lovPlate').style.display === 'none' ? '' : q('lovPlate').textContent, info: q('lovInfo').textContent, foot: q('lovFoot').textContent, exit: q('lovExit').style.display !== 'none', exitText: q('lovExit').textContent, exitDisabled: q('lovExit').disabled, modalResult: getComputedStyle(q('modalResult')).display !== 'none', bigStatus: !q('bigStatusScreen').classList.contains('hide-splash') }; })()`);
        const waitName = (name) => page.waitFor(`${overlayOpen} && document.getElementById('lovName').textContent === ${JSON.stringify(name)}`, `la tarjeta de ${name}`, 20000);
        const waitClosed = () => page.waitFor(`!(${overlayOpen})`, 'que se cierre la tarjeta', 20000);
        const waitRecords = async (n, ms = 20000) => { const t = Date.now(); while ((await all()).length < n && Date.now() - t < ms) await sleep(200); return all(); };
        const unfocus = () => page.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
        const cardInfo = () => page.evaluate(`(() => { const q = (id) => document.getElementById(id); return { shown: getComputedStyle(q('sectionLector')).display !== 'none', ring: q('cgRing').className, ringTitle: q('ringTitle').textContent, title: q('lectorTitle').textContent, chip: q('chipLectorText').textContent, hint: q('lectorHint').textContent, sw: q('gcfgScanner').getAttribute('aria-checked'), cfgBtn: getComputedStyle(q('btnGaritaConfig')).display !== 'none', pref: localStorage.getItem('sisdel_escaner_manual_${CONDO}'), cfg: localStorage.getItem('sisdel_garita_config_${CONDO}'), pend: localStorage.getItem('sisdel_lector_pend_${CONDO}') }; })()`);

        console.log('\nControl Garita: encabezado y escaner activado de entrada');
        const head = await page.evaluate(`({ title: document.title, h1: document.querySelector('.cg-top h1').textContent, condo: document.getElementById('condoName').textContent, guard: document.getElementById('guardName').textContent, clock: document.getElementById('cgClock').textContent, date: document.getElementById('cgDate').textContent, buttons: [...document.querySelectorAll('.top-bar-actions .btn-sm')].map((b) => b.textContent.trim()).filter(Boolean) })`);
        record('el encabezado dice CONTROL GARITA, el condominio, el guardia de la sesion, un reloj en vivo con la fecha y los botones Configuración y Salir', head.title === 'SISDEL - Control Garita' && head.h1 === 'CONTROL GARITA' && head.condo === 'Villa Ferrer' && /\w/.test(head.guard) && head.guard !== '-' && /^\d\d:\d\d:\d\d$/.test(head.clock) && /\d{4}/.test(head.date) && head.buttons.includes('Configuración') && head.buttons.includes('Salir'), JSON.stringify(head));
        await sleep(1200);
        record('y el reloj avanza solo', (await page.evaluate(`document.getElementById('cgClock').textContent`)) !== head.clock);
        let card = await cardInfo();
        record('el anillo dice LISTO PARA LEER, el escaner esta ACTIVO y la barra de arriba dice "Lector listo", sin nada guardado todavia',
            card.shown && card.ringTitle === 'LISTO PARA LEER' && !/\b(off|nofocus)\b/.test(card.ring) && card.title === 'Escáner manual ACTIVO' && card.chip === 'Lector listo' && /sin tocar ninguna casilla/.test(card.hint) && card.cfgBtn && card.sw === 'true' && card.pref === null, JSON.stringify(card));
        const chips = await page.evaluate(`({ lastReads: document.getElementById('lastReads').innerText, tablaVacia: getComputedStyle(document.getElementById('historyEmptyState')).display !== 'none', camara: getComputedStyle(document.getElementById('chipCamara')).display !== 'none' ? document.getElementById('chipCamaraText').textContent : '' })`);
        record('antes de leer: sin lecturas, sin accesos y la camara dice lo que sabe (no inventa que esta en linea)', /Todavía no hay lecturas/.test(chips.lastReads) && chips.tablaVacia && !/en línea/i.test(chips.camara), JSON.stringify(chips));

        console.log('\nConfiguracion: tiempo del marbete en pantalla');
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.waitFor(`getComputedStyle(document.getElementById('modalGaritaConfig')).display !== 'none'`, 'la configuracion', 10000);
        const cfg = await page.evaluate(`({ seconds: document.getElementById('gcfgSeconds').value, seg: [...document.querySelectorAll('#gcfgSeg button.on')].map((b) => b.textContent), scanner: document.getElementById('gcfgScanner').getAttribute('aria-checked'), sound: document.getElementById('gcfgSound').getAttribute('aria-checked'), full: document.getElementById('gcfgFull').getAttribute('aria-checked'), text: document.getElementById('gcfgScannerText').textContent })`);
        record('la configuracion abre con 6 segundos, el escaner y el sonido encendidos y la pantalla completa apagada', cfg.seconds === '6' && cfg.seg.join() === '6 s' && cfg.scanner === 'true' && cfg.sound === 'true' && cfg.full === 'false' && /Activo/.test(cfg.text), JSON.stringify(cfg));
        await page.evaluate(`document.querySelector('#gcfgSeg button[data-s="10"]').click()`);
        equal('los botones rapidos (4, 6, 8, 10 o 15 s) cambian el tiempo', await page.evaluate(`document.getElementById('gcfgSeconds').value`), '10');
        const setSeconds = async (v) => { await page.evaluate(`(() => { const i = document.getElementById('gcfgSeconds'); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('change')); })()`); return page.evaluate(`document.getElementById('gcfgSeconds').value`); };
        equal('un tiempo de 1 segundo sube a 3 y uno de 99 baja a 30 (de 3 a 30)', [await setSeconds(1), await setSeconds(99)], ['3', '30']);
        equal('el tiempo elegido se guarda en este equipo junto con el sonido y la pantalla completa', [await setSeconds(3), (await cardInfo()).cfg], ['3', '{"seconds":3,"sound":true,"full":false}']);
        await page.evaluate(`document.getElementById('btnCloseGaritaConfig').click()`);

        console.log('\nUn marbete por el lector, sin tocar nada');
        await unfocus();
        const t0 = Date.now();
        await burst('MARTEST1', 0);
        await waitName('Ana García');
        const shown = Date.now() - t0;
        let ov = await overlay();
        record('la tarjeta del marbete sale al instante: medallon AL DIA en verde, nombre grande y la placa', ov.tone === 'ok' && ov.word === 'AL DÍA' && ov.plate === 'P-987XYZ' && /Ingreso registrado/.test(ov.foot) && /se cierra en [123] s/.test(ov.foot), JSON.stringify(ov));
        record('sin la ventana de verificacion ni la pantalla grande de MOROSO / AL DIA de antes', !ov.modalResult && !ov.bigStatus, JSON.stringify(ov));
        record('y salio en menos de 3 segundos desde que el lector termino', shown < 3000, String(shown));
        record('el Enter del lector no activo ningun boton y el ingreso aun no se escribe (se escribe al cerrar la tarjeta)', (await all()).length === 0 && /^\[/.test((await cardInfo()).pend || ''), JSON.stringify(await cardInfo()));
        await waitClosed();
        let rows = await waitRecords(1);
        equal('la tarjeta se cerro sola a los 3 segundos y el ingreso quedo registrado como "lector", del vehiculo de Ana, sin tocar nada', [rows.length, rows[0] && rows[0].via, rows[0] && rows[0].kind, rows[0] && rows[0].direction, rows[0] && rows[0].outcome, rows[0] && rows[0].plate, rows[0] && rows[0].userId, rows[0] && rows[0].guardId], [1, 'lector', 'vehiculo', 'entrada', 'autorizado', 'P-987XYZ', 'u-ana', 'u-pedro']);
        equal('y ya no queda nada pendiente en el equipo', (await cardInfo()).pend, null);
        equal('sono un tono agudo (al dia)', await page.evaluate(`window.__garitaTones`), ['ok']);
        const reads1 = await page.evaluate(`[...document.querySelectorAll('#lastReads .cg-last')].map((r) => r.querySelector('.nm').textContent + '|' + r.querySelector('.cg-medal').textContent + '|' + r.querySelector('.cg-plate').textContent)`);
        equal('la lectura queda en "Últimas lecturas" con su medallon, nombre y placa', reads1, ['Ana García|AL DÍA|P-987XYZ']);
        await page.waitFor(`document.querySelectorAll('#historyLogsList tr').length === 1`, 'los ultimos accesos', 20000);
        const acc = await page.evaluate(`({ rows: [...document.querySelectorAll('#historyLogsList tr')].map((r) => [...r.children].map((c) => c.textContent.trim())), entered: document.getElementById('enteredCount').textContent, exited: document.getElementById('exitedCount').textContent })`);
        record('y en "Últimos accesos" sale con su hora, ENTRADA, nombre, lote, placa, "Escáner manual" y AL DÍA; las cifras del dia cuentan 1 ingreso y 0 salidas', acc.rows.length === 1 && acc.rows[0][1] === 'ENTRADA' && acc.rows[0][2] === 'Ana García' && acc.rows[0][4] === 'P-987XYZ' && acc.rows[0][5] === 'Escáner manual' && acc.rows[0][6] === 'AL DÍA' && acc.entered === '1' && acc.exited === '0', JSON.stringify(acc));

        console.log('\nUn marbete en mora');
        await burst('MARTEST3', 0);
        await waitName('María Rodríguez');
        ov = await overlay();
        record('el medallon dice EN MORA (rojo), pide informar al vecino y no hay pantalla de moroso aparte', ov.tone === 'late' && ov.word === 'EN MORA' && /Informar al vecino/.test(ov.info) && !ov.modalResult && !ov.bigStatus, JSON.stringify(ov));
        await page.evaluate(`document.getElementById('lectorOverlay').click()`);
        await page.waitFor(`!(${overlayOpen})`, 'cerrar con un clic', 5000);
        rows = await waitRecords(2);
        equal('un clic la cierra antes y el ingreso queda con el aviso de mora', [rows.length, rows[1] && rows[1].via, rows[1] && rows[1].outcome, rows[1] && rows[1].moroso, rows[1] && rows[1].userId], [2, 'lector', 'aviso_mora', true, 'u-maria']);
        await sleep(2500);
        equal('sonaron dos tonos (en mora): uno al dia y dos en mora', await page.evaluate(`window.__garitaTones`), ['ok', 'late']);
        equal('y despues de guardarse no sale la pantalla grande de MOROSO ni el aviso de moroso de la camara (es la propia garita quien lo escribio)', await page.evaluate(`({ big: !document.getElementById('bigStatusScreen').classList.contains('hide-splash'), alert: !!document.getElementById('reminderAlertOverlay') && getComputedStyle(document.getElementById('reminderAlertOverlay')).display !== 'none' })`), { big: false, alert: false });

        console.log('\nOtra lectura reemplaza la que esta a la vista');
        await sleep(3300);
        await page.evaluate(`document.getElementById('gcfgSeconds').value = '30'; document.getElementById('gcfgSeconds').dispatchEvent(new Event('change')); true`);
        await burst('MARTEST1', 0);
        await waitName('Ana García');
        await sleep(400);
        await burst('MARTEST3', 0);
        await waitName('María Rodríguez');
        rows = await waitRecords(3);
        equal('el siguiente carro reemplaza a la tarjeta al instante y el de antes ya quedo registrado', [rows.length, rows[2] && rows[2].userId, (await overlay()).word], [3, 'u-ana', 'EN MORA']);
        await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await page.waitFor(`!(${overlayOpen})`, 'cerrar con Escape', 5000);
        rows = await waitRecords(4);
        equal('Escape cierra la tarjeta y registra el ingreso de la ultima lectura', [rows.length, rows[3] && rows[3].userId], [4, 'u-maria']);

        console.log('\nEl mismo marbete que sigue en pantalla');
        await sleep(3300);
        await burst('MARTEST1', 0);
        await waitName('Ana García');
        await sleep(3500);
        await burst('MARTEST1', 0);
        await sleep(600);
        equal('pasarlo otra vez mientras se ve solo renueva el tiempo (no se registra otro ingreso)', [(await overlay()).open, (await all()).length], [true, 4]);
        await page.evaluate(`document.getElementById('lectorOverlay').click()`);
        rows = await waitRecords(5);
        equal('y al cerrar queda un solo ingreso mas', rows.length, 5);
        await page.evaluate(`document.getElementById('gcfgSeconds').value = '3'; document.getElementById('gcfgSeconds').dispatchEvent(new Event('change')); true`);

        console.log('\n"Era una salida"');
        await sleep(3300);
        await burst('MARTEST1', 0);
        await waitName('Ana García');
        ov = await overlay();
        record('la tarjeta ofrece el boton "Era una salida"', ov.exit && ov.exitText === 'Era una salida' && !ov.exitDisabled, JSON.stringify(ov));
        await page.evaluate(`document.getElementById('lovExit').click()`);
        ov = await overlay();
        record('al pulsarlo la tarjeta dice Salida registrada y no se cierra por el clic', ov.open && ov.exitDisabled && ov.exitText === 'Marcada como salida' && /Salida registrada/.test(ov.foot), JSON.stringify(ov));
        await waitClosed();
        rows = await waitRecords(6);
        equal('el registro queda como salida (no como ingreso)', [rows.length, rows[5] && rows[5].direction, rows[5] && rows[5].via, rows[5] && rows[5].kind], [6, 'salida', 'lector', 'vehiculo']);
        const exits = (await db.collection(`condominios/${CONDO}/salidas`).get()).docs.map((d) => d.data()).filter((x) => x.plate === 'P-987XYZ');
        record('y la salida del vehiculo tambien queda en el historial del dia', exits.length >= 1, String(exits.length));

        console.log('\nPases de visita y claves');
        await sleep(3300);
        await burst('VISTEST1', 0);
        await waitName('Roberto Herrera');
        ov = await overlay();
        record('un pase QR de visita sale con VISITA AUTORIZADA', ov.tone === 'ok' && ov.word === 'VISITA AUTORIZADA' && !ov.modalResult, JSON.stringify(ov));
        await waitClosed();
        rows = await waitRecords(7);
        equal('y la visita queda como ingreso del lector', [rows.length, rows[6] && rows[6].kind, rows[6] && rows[6].direction, rows[6] && rows[6].via], [7, 'visita', 'entrada', 'lector']);
        await sleep(3300);
        await burst('VISTEST1', 0);
        await waitName('Roberto Herrera');
        ov = await overlay();
        record('al pasar el pase de una visita que esta dentro, la tarjeta dice SALIDA', ov.word === 'SALIDA' && !ov.exit, JSON.stringify(ov));
        await waitClosed();
        rows = await waitRecords(8);
        equal('y registra su salida', [rows.length, rows[7] && rows[7].kind, rows[7] && rows[7].direction], [8, 'visita', 'salida']);
        await sleep(3300);
        await burst('VA101', 0);
        await waitName('Ana García');
        ov = await overlay();
        record('la clave de un vecino sale con el mismo estilo', ov.tone === 'ok' && ov.word === 'AL DÍA' && /Clave de vecino/.test(ov.info) && ov.plate === '', JSON.stringify(ov));
        await page.evaluate(`document.getElementById('lectorOverlay').click()`);
        rows = await waitRecords(9);
        equal('y queda como ingreso de residente por el lector', [rows.length, rows[8] && rows[8].kind, rows[8] && rows[8].via], [9, 'residente', 'lector']);
        await sleep(3300);
        await burst('ZZZZ9999', 0);
        await waitName('Código no registrado');
        ov = await overlay();
        record('un codigo que no existe sale como NO REGISTRADO con lo que se leyo (para diagnosticar) y no registra nada', ov.tone === 'bad' && ov.word === 'NO REGISTRADO' && ov.plate === 'ZZZZ9999' && /No se registró nada/.test(ov.foot), JSON.stringify(ov));
        await page.evaluate(`document.getElementById('lectorOverlay').click()`);
        await sleep(800);
        equal('sin registro de acceso', (await all()).length, 9);

        console.log('\nEl lector escribe en el campo de codigo');
        await sleep(3300);
        await page.evaluate(`(() => { const i = document.getElementById('manualCode'); i.value = ''; i.focus(); return true; })()`);
        await burst('MARTEST3', 0);
        await waitName('María Rodríguez');
        equal('con el campo de codigo con el foco: la lectura se hace una vez y el campo queda vacio', [await page.evaluate(`document.getElementById('manualCode').value`), (await overlay()).open], ['', true]);
        await page.evaluate(`document.getElementById('lectorOverlay').click()`);
        rows = await waitRecords(10);
        equal('y queda registrada', rows.length, 10);

        console.log('\nUna persona escribiendo');
        await sleep(3300);
        await page.evaluate(`document.getElementById('manualCode').focus()`);
        await burst('VA101', 160);
        await page.waitFor(`getComputedStyle(document.getElementById('modalResult')).display !== 'none' && /ACCESO RESIDENTE/.test(document.getElementById('resultTitle').textContent)`, 'la clave escrita a mano', 20000);
        equal('escribir la clave despacio (160 ms por letra) y Enter sigue siendo "codigo escrito": la ventana de siempre, sin la tarjeta del escaner', [(await overlay()).open, (await all()).length], [false, 10]);
        await page.evaluate(`document.getElementById('btnCloseResult').click()`);
        await page.evaluate(`document.getElementById('bigStatusScreen').classList.add('hide-splash'); true`);

        console.log('\nLo que no alcanzo a guardarse se guarda al abrir la garita otra vez');
        await sleep(3300);
        await unfocus();
        await page.evaluate(`document.getElementById('gcfgSeconds').value = '30'; document.getElementById('gcfgSeconds').dispatchEvent(new Event('change')); true`);
        await burst('MARTEST1', 0);
        await waitName('Ana García');
        record('con la tarjeta abierta el ingreso espera en este equipo', (await all()).length === 10 && /^\[/.test((await cardInfo()).pend || ''));
        await openGarita();
        rows = await waitRecords(11);
        equal('se recarga la pagina con la tarjeta abierta y el ingreso se guarda (una sola vez) al volver', [rows.length, rows[10] && rows[10].userId, rows[10] && rows[10].via], [11, 'u-ana', 'lector']);
        await sleep(1200);
        equal('y ya no queda pendiente', [(await all()).length, (await cardInfo()).pend], [11, null]);

        console.log('\nVentana que no esta al frente');
        await page.evaluate(`window.__hf = document.hasFocus; document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); true`);
        await sleep(300);
        card = await cardInfo();
        record('si garita.app no esta al frente avisa que el lector escribiria en otra ventana (anillo, tarjeta y barra de arriba)', card.title === 'Escáner activo, ventana sin foco' && /\bnofocus\b/.test(card.ring) && card.chip === 'Lector sin foco' && card.ringTitle === 'HAGA CLIC AQUÍ', JSON.stringify(card));
        await page.evaluate(`document.hasFocus = window.__hf; window.dispatchEvent(new Event('focus')); true`);
        await sleep(300);

        console.log('\nSe apaga desde Configuracion y no intercepta nada');
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('gcfgScanner').click()`);
        await sleep(300);
        card = await cardInfo();
        record('al desactivarlo la tarjeta, el anillo y la barra de arriba dicen apagado y se recuerda en este equipo', /apagado/.test(card.title) && card.chip === 'Escáner apagado' && card.ringTitle === 'ESCÁNER APAGADO' && /\boff\b/.test(card.ring) && card.pref === 'off' && card.sw === 'false', JSON.stringify(card));
        await page.evaluate(`document.getElementById('btnCloseGaritaConfig').click()`);
        await unfocus();
        await burst('MARTEST3', 0);
        await sleep(1500);
        equal('apagado, una lectura rapida no abre nada ni registra nada', [(await overlay()).open, (await all()).length], [false, 11]);
        await openGarita();
        equal('despues de recargar sigue apagado', (await cardInfo()).title, 'Escáner manual apagado');

        console.log('\nProbar el lector (aunque este apagado)');
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('btnGcfgTest').click()`);
        equal('al abrir la prueba se cierra la configuracion', await page.evaluate(`getComputedStyle(document.getElementById('modalGaritaConfig')).display`), 'none');
        await page.waitFor(`getComputedStyle(document.getElementById('modalLector')).display !== 'none'`, 'la ventana de prueba', 10000);
        await burst('MARMWPKCY3TCC', 0);
        await page.waitFor(`document.querySelectorAll('#lectorRows .lector-row').length === 1`, 'la lectura en la prueba', 10000);
        const probe = await page.evaluate(`({ row: document.querySelector('#lectorRows .lector-row').innerText, title: document.getElementById('lectorWaitTitle').textContent, overlay: ${overlayOpen}, card: document.getElementById('lectorTitle').textContent })`);
        record('la prueba muestra el codigo crudo, sus letras, la velocidad y que termina con Enter, y dice que el lector funciona', /MARMWPKCY3TCC/.test(probe.row) && /13 letras/.test(probe.row) && /ms por letra/.test(probe.row) && /Enter/.test(probe.row) && probe.title === 'El lector funciona', JSON.stringify(probe));
        await page.evaluate(`document.getElementById('btnCloseLector').click()`);
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        const lastProbe = await page.evaluate(`document.getElementById('gcfgLastProbe').textContent`);
        record('la configuracion recuerda la ultima prueba: lo que llego, cuantos caracteres, en cuantos milisegundos y si traia Enter', /MARMWPKCY3TCC/.test(lastProbe) && /13 caracteres/.test(lastProbe) && /llegó en ~\d+ ms/.test(lastProbe) && /Enter/.test(lastProbe), lastProbe);
        await page.evaluate(`document.getElementById('btnCloseGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('btnGcfgTest').click()`);
        await sleep(300);
        record('y no muestra la tarjeta del marbete ni registra nada (solo prueba)', !probe.overlay && (await all()).length === 11 && /Probando/.test(probe.card), JSON.stringify(probe));
        await sleep(300);
        await burst('ABCDE', 160, null);
        await page.waitFor(`document.querySelectorAll('#lectorRows .lector-row').length === 1`, 'el aviso de teclas lentas', 10000);
        const slow = await page.evaluate(`document.querySelector('#lectorRows .lector-row').innerText`);
        record('teclas muy despacio no son un lector: la prueba avisa por que (cuantas llegaron y a que velocidad)', /Llegaron 5 teclas/.test(slow) && /no se tomaron como una lectura/.test(slow), slow);
        await page.evaluate(`document.getElementById('btnCloseLector').click()`);
        await sleep(300);
        // Se vuelve a activar para dejar el equipo como de entrada
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('gcfgScanner').click()`);
        await sleep(300);
        equal('se vuelve a activar desde Configuracion y la preferencia vuelve a "activado de entrada"', [(await cardInfo()).title, (await cardInfo()).pref], ['Escáner manual ACTIVO', null]);
        await page.evaluate(`document.getElementById('btnCloseGaritaConfig').click()`);

        console.log('\nPantalla completa y sonido apagado');
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('gcfgFull').click()`);
        await page.evaluate(`document.getElementById('gcfgSound').click()`);
        equal('la configuracion guarda pantalla completa encendida y sonido apagado', (await cardInfo()).cfg, '{"seconds":30,"sound":false,"full":true}');
        await page.evaluate(`document.getElementById('btnCloseGaritaConfig').click(); window.__garitaTones = []; true`);
        await sleep(3300);
        await burst('MARTEST1', 0);
        await waitName('Ana García');
        equal('con la pantalla completa la tarjeta ocupa todo el monitor y sin sonido no suena nada', await page.evaluate(`({ full: document.getElementById('lectorOverlay').classList.contains('full'), tones: window.__garitaTones, w: Math.round(document.getElementById('lovCard').getBoundingClientRect().width) >= document.documentElement.clientWidth - 2 && Math.round(document.getElementById('lovCard').getBoundingClientRect().height) >= window.innerHeight - 2 })`), { full: true, tones: [], w: true });
        await page.evaluate(`document.getElementById('lectorOverlay').click()`);
        rows = await waitRecords(12);
        await page.evaluate(`document.getElementById('btnGaritaConfig').click()`);
        await page.evaluate(`document.getElementById('gcfgFull').click()`);
        await page.evaluate(`document.getElementById('gcfgSound').click()`);
        await page.evaluate(`document.getElementById('btnCloseGaritaConfig').click()`);

        console.log('\nUn guardia con menos privilegios');
        const keysOn = async (p2, text) => {
            for (const ch of text) {
                const base = { key: ch, code: /[A-Za-z]/.test(ch) ? 'Key' + ch.toUpperCase() : 'Digit' + ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), text: ch, unmodifiedText: ch };
                await p2.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
                await p2.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode });
            }
            await p2.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
            await p2.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        };
        const vis = (id) => `(() => { const e = document.getElementById('${id}'); return !!e && getComputedStyle(e).display !== 'none'; })()`;
        const asGuard = async (privilegios, fn) => {
            await usersRef.doc('u-pedro').update({ privilegios });
            const lim = await newPage({ stepTimeoutMs: 60000 });
            try {
                await lim.login(BASE, 'VP103');
                await lim.goto(`${BASE}/garita.html`);
                await lim.waitFor(`document.getElementById('condoName') && document.getElementById('condoName').textContent === 'Villa Ferrer' && typeof SISDEL.createAccess === 'function'`, 'la garita del guardia', 30000);
                await sleep(1200);
                return await fn(lim);
            } finally {
                await lim.close?.();
                await usersRef.doc('u-pedro').update({ privilegios: FieldValue.delete() });
            }
        };
        const noLector = await asGuard({ 'garita.lector': false, 'garita.configurar': false, 'garita.morosos': false, 'garita.historial': false, 'garita.visitas_dia': false, 'garita.salida': false }, async (lim) => {
            const seen = await lim.evaluate(`({ lector: ${vis('sectionLector')}, chip: ${vis('chipLector')}, config: ${vis('btnGaritaConfig')}, morosos: ${vis('kpiMorosos')}, strip: !!document.querySelector('#urgentWarnings .cg-alert'), visitas: ${vis('visitsCard')}, historial: ${vis('historyMonitorContainer')}, salidas: ${vis('kpiExited')}, dentro: ${vis('insideCard')}, camara: ${vis('sectionQR')}, manual: ${vis('sectionManual')} })`);
            await keysOn(lim, 'MARTEST1');
            await sleep(1500);
            const after = await lim.evaluate(`({ overlay: ${vis('lectorOverlay')}, modal: ${vis('modalResult')}, big: !document.getElementById('bigStatusScreen').classList.contains('hide-splash') })`);
            return { seen, after };
        });
        record('sin garita.lector, garita.configurar, garita.morosos, garita.historial, garita.visitas_dia y garita.salida: no sale el lector, ni Configuracion, ni la cifra y la franja de mora, ni las visitas, ni los ultimos accesos, ni salidas ni visitas dentro; la camara y la busqueda manual siguen (son otros privilegios)',
            noLector.seen.lector === false && noLector.seen.chip === false && noLector.seen.config === false && noLector.seen.morosos === false && noLector.seen.strip === false && noLector.seen.visitas === false && noLector.seen.historial === false && noLector.seen.salidas === false && noLector.seen.dentro === false && noLector.seen.camara === true && noLector.seen.manual === true, JSON.stringify(noLector.seen));
        record('y una lectura rapida no abre la tarjeta ni nada: el lector esta apagado para ese guardia', !noLector.after.overlay && !noLector.after.modal && !noLector.after.big, JSON.stringify(noLector.after));
        const before = (await all()).length;
        const soloLee = await asGuard({ 'garita.ingreso': false, 'garita.configurar': false }, async (lim) => {
            const seen = await lim.evaluate(`({ lector: ${vis('sectionLector')}, config: ${vis('btnGaritaConfig')} })`);
            await keysOn(lim, 'MARTEST1');
            await lim.waitFor(`${overlayOpen} && document.getElementById('lovName').textContent === 'Ana García'`, 'la tarjeta de solo consulta', 20000);
            const card2 = await lim.evaluate(`({ foot: document.getElementById('lovFoot').textContent, exit: document.getElementById('lovExit').style.display !== 'none' })`);
            await lim.evaluate(`document.getElementById('lectorOverlay').click()`);
            await sleep(1500);
            return { seen, card2 };
        });
        record('un guardia con el lector pero sin garita.ingreso ni garita.configurar: lee y ve la tarjeta, pero dice que no se registro nada, sin "Era una salida" y sin boton de Configuracion', soloLee.seen.lector === true && soloLee.seen.config === false && /No se registró nada/.test(soloLee.card2.foot) && soloLee.card2.exit === false, JSON.stringify(soloLee));
        equal('y no se escribio ningun acceso', (await all()).length, before);

        console.log('\nEl administrador lo ve en su reporte');
        const lectorRows = (await all()).filter((r) => r.via === 'lector').length;
        const admin = await newPage({ stepTimeoutMs: 60000 });
        await admin.login(BASE, 'VF100');
        await admin.goto(`${BASE}/admin.html#reportes/garita-accesos`);
        await admin.waitFor(`!!document.querySelector('#rpOut .rp-table tbody tr')`, 'el reporte de ingresos y salidas', 40000);
        const medios = await admin.evaluate(`(() => { const t = document.querySelector('#rpOut .rp-table'); const i = [...t.querySelectorAll('thead th')].findIndex((x) => /Medio/.test(x.textContent)); return [...t.querySelectorAll('tbody tr')].map((r) => r.children[i].textContent.trim()); })()`);
        equal('el reporte de ingresos y salidas dice "Lector USB" en cada movimiento del lector', medios.filter((m) => m === 'Lector USB').length, lectorRows);
        record('la garita no tiene errores de JavaScript', page.errors.length === 0, JSON.stringify([...new Set(page.errors)].slice(0, 4)));
    } finally {
        await close();
        for (const d of (await accessRef.get()).docs) await d.ref.delete();
    }
}

try { await run(); } catch (error) { failures.push('la prueba se detuvo'); console.log(`  FALLA la prueba se detuvo: ${error.message}`); }
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
