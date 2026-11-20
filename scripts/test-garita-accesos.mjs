// Prueba de la garita en un navegador de verdad (Chrome sin ventana, contra los emuladores): un guardia verifica codigos y confirma
// ingresos y salidas de un vecino, de su vehiculo y de visitas, y cada movimiento queda en el registro de accesos (accesos.js) con sus
// campos propios; despues el administrador abre el reporte "Registro de ingresos y salidas" y lo ve.
// No corre con `npm test` porque necesita Chrome instalado:
//   cd scripts && npm run seed && node test-garita-accesos.mjs     (con los emuladores levantados; tambien en `npm run test:navegador`)
import { connect, parseArgs } from './admin.mjs';
import { launch, sleep } from './chrome.mjs';

const args = parseArgs();
const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CONDO = 'condo-villa-ferrer';
const db = connect('emulator');
const accessRef = db.collection(`condominios/${CONDO}/accesos`);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let passed = 0;
const failures = [];
function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
const equal = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
const all = async () => (await accessRef.orderBy('at', 'asc').get()).docs.map((d) => d.data());
// Lo que importa de un registro, sin las horas ni los ids
const brief = (x) => ({ direction: x.direction, kind: x.kind, via: x.via, outcome: x.outcome, userId: x.userId, name: x.name, casa: x.casa, plate: x.plate, vehicleId: x.vehicleId, visitId: x.visitId, visitorName: x.visitorName, visitType: x.visitType, moroso: x.moroso, guardId: x.guardId, guardName: x.guardName, source: x.source });

async function run() {
    // Sin registros de corridas anteriores
    for (const d of (await accessRef.get()).docs) await d.ref.delete();

    const { newPage, close } = await launch(args.chrome);
    try {
        const page = await newPage({ stepTimeoutMs: 60000 });
        await page.login(BASE, 'VP103');
        await page.goto(`${BASE}/garita.html`);
        await page.waitFor(`document.getElementById('condoName') && document.getElementById('condoName').textContent === 'Villa Ferrer' && typeof SISDEL.createAccess === 'function'`, 'la garita', 30000);
        const modalOpen = `getComputedStyle(document.getElementById('modalResult')).display !== 'none'`;
        const modalClosed = `getComputedStyle(document.getElementById('modalResult')).display === 'none'`;
        // Escribe un codigo, lo verifica y espera la ventana del resultado
        const verify = async (code, title) => {
            await page.evaluate(`(() => { document.getElementById('manualCode').value = ${JSON.stringify(code)}; document.getElementById('formManual').requestSubmit(); })()`);
            await page.waitFor(`${modalOpen} && /${title}/.test(document.getElementById('resultTitle').textContent + document.getElementById('resultInfo').textContent)`, `la ventana de ${code}`, 15000);
        };
        const click = async (id) => { await page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await page.waitFor(modalClosed, `cerrar la ventana tras ${id}`, 15000); };
        const waitCount = async (n, label) => { const t0 = Date.now(); while (Date.now() - t0 < 15000) { if ((await all()).length >= n) return; await sleep(200); } record(label, false, `no llegaron ${n} registros`); };

        console.log('\nVecino por su codigo (escrito a mano)');
        await verify('VA101', 'ACCESO RESIDENTE');
        await click('btnConfirmEntry');
        await waitCount(1, 'el ingreso del vecino queda registrado');
        let rows = await all();
        equal('el ingreso del vecino queda con quien es, su casa, el medio y el guardia que lo registro',
            brief(rows[0]), { direction: 'entrada', kind: 'residente', via: 'codigo', outcome: 'autorizado', userId: 'u-ana', name: 'Ana García', casa: 'Casa 12', moroso: false, guardId: 'u-pedro', guardName: 'Pedro Ramírez', source: 'garita' });
        record('con su dia (hora de Guatemala) y su hora exacta', rows[0].day === today && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(rows[0].at) && rows[0].id.length > 5 && rows[0].condominioId === CONDO, JSON.stringify([rows[0].day, rows[0].at]));
        await verify('VA101', 'ACCESO RESIDENTE');
        await click('btnRegisterExit');
        await waitCount(2, 'la salida del vecino queda registrada');
        rows = await all();
        equal('su salida es otro registro, de salida', [rows[1].direction, rows[1].kind, rows[1].userId, rows[1].guardId, rows[1].outcome], ['salida', 'residente', 'u-ana', 'u-pedro', 'autorizado']);
        equal('y lo de siempre se sigue guardando: la salida en `salidas` y el ingreso en el historial de la camara',
            [(await db.collection(`condominios/${CONDO}/salidas`).where('userId', '==', 'u-ana').get()).size >= 1, (await db.collection(`condominios/${CONDO}/camera_logs`).where('reason', '>=', 'Acceso QR: Ana').where('reason', '<', 'Acceso QR: Anb').get()).size >= 1], [true, true]);

        console.log('\nVehiculo por su marbete');
        await verify('MARTEST1', 'Placa');
        await click('btnConfirmEntry');
        await waitCount(3, 'el ingreso del vehiculo queda registrado');
        await verify('MARTEST1', 'Placa');
        await click('btnRegisterExit');
        await waitCount(4, 'la salida del vehiculo queda registrada');
        rows = await all();
        equal('un ingreso y una salida del vehiculo, con su placa, su vehiculo y su dueño',
            [rows[2], rows[3]].map((x) => [x.direction, x.kind, x.plate, x.vehicleId, x.userId, x.casa, x.name]), [['entrada', 'vehiculo', 'P-987XYZ', 'veh-ana-1', 'u-ana', 'Casa 12', 'Ana García'], ['salida', 'vehiculo', 'P-987XYZ', 'veh-ana-1', 'u-ana', 'Casa 12', 'Ana García']]);

        console.log('\nVehiculo de un vecino moroso');
        await verify('MARTEST3', 'MOROSO');
        await click('btnConfirmEntry');
        await waitCount(5, 'el ingreso del moroso queda registrado');
        rows = await all();
        equal('queda con aviso de mora y marcado como moroso', [rows[4].outcome, rows[4].moroso, rows[4].userId, rows[4].casa], ['aviso_mora', true, 'u-maria', 'Casa 23']);

        console.log('\nVisita por su pase (QR escrito) y por la lista del dia');
        await verify('VISTEST1', 'Roberto');
        await click('btnConfirmEntry');
        await waitCount(6, 'el ingreso de la visita queda registrado');
        await verify('VISTEST1', 'Roberto');
        await click('btnRegisterExit');
        await waitCount(7, 'la salida de la visita queda registrada');
        rows = await all();
        equal('un ingreso y una salida de la visita, con su visitante, su placa, quien la autoriza y su casa',
            [rows[5], rows[6]].map((x) => [x.direction, x.kind, x.visitId, x.visitorName, x.plate, x.userId, x.name, x.casa, x.via]),
            [['entrada', 'visita', 'vis-hoy', 'Roberto Herrera', 'P-123ABC', 'u-ana', 'Ana García', 'Casa 12', 'codigo'], ['salida', 'visita', 'vis-hoy', 'Roberto Herrera', 'P-123ABC', 'u-ana', 'Ana García', 'Casa 12', 'codigo']]);
        // El acceso temporal vuelve a entrar: cada entrada es un registro (antes la visita solo guardaba la ultima hora)
        await verify('VISTEST2', 'Luis');
        await click('btnConfirmEntry');
        await waitCount(8, 'la primera entrada del acceso temporal');
        await verify('VISTEST2', 'Luis');
        await click('btnRegisterExit');
        await waitCount(9, 'la salida del acceso temporal');
        await verify('VISTEST2', 'Luis');
        await click('btnConfirmEntry');
        await waitCount(10, 'la segunda entrada del acceso temporal');
        rows = await all();
        equal('el acceso temporal: dos entradas y una salida, las tres guardadas (la visita en si solo recuerda la ultima)',
            rows.filter((x) => x.visitId === 'vis-temporal').map((x) => [x.direction, x.visitType, x.visitorName]), [['entrada', 'temporal', 'Luis Pérez'], ['salida', 'temporal', 'Luis Pérez'], ['entrada', 'temporal', 'Luis Pérez']]);
        // La lista de visitas del dia
        await page.evaluate(`window.processVisit('vis-maria')`);
        await page.waitFor(`${modalOpen}`, 'la ventana de la visita elegida de la lista', 15000);
        await click('btnConfirmEntry');
        await waitCount(11, 'el ingreso desde la lista');
        rows = await all();
        equal('desde la lista del dia el medio es "lista" y la visita de un vecino moroso lleva su aviso',
            [rows[10].via, rows[10].kind, rows[10].visitorName, rows[10].userId, rows[10].outcome, rows[10].moroso], ['lista', 'visita', 'Invitado de María', 'u-maria', 'aviso_mora', true]);

        console.log('\nTodos los registros');
        rows = await all();
        record('cada uno trae su hora, su dia, su guardia y su origen, y solo campos conocidos', rows.every((x) => x.at && x.day === today && x.guardId === 'u-pedro' && x.source === 'garita' && Object.keys(x).every((k) => ['id', 'condominioId', 'at', 'day', 'direction', 'kind', 'via', 'outcome', 'userId', 'name', 'casa', 'fase', 'plate', 'vehicleId', 'visitId', 'visitorName', 'visitType', 'moroso', 'reason', 'guardId', 'guardName', 'source'].includes(k))));
        equal('11 movimientos en total: 7 entradas y 4 salidas', [rows.filter((x) => x.direction === 'entrada').length, rows.filter((x) => x.direction === 'salida').length], [7, 4]);
        record('sin avisos de error en la garita y sin errores de JavaScript', page.errors.length === 0 && !(await page.evaluate(`/no se pudo guardar en el registro/i.test(document.body.innerText)`)), JSON.stringify(page.errors.slice(0, 3)));

        console.log('\nEl reporte del administrador');
        const admin = await newPage({ stepTimeoutMs: 60000 });
        await admin.login(BASE, 'VF100');
        await admin.goto(`${BASE}/admin.html#reportes/garita-accesos`);
        await admin.waitFor(`!!document.querySelector('#rpOut .rp-table tbody tr')`, 'el reporte de ingresos y salidas', 40000);
        const rep = await admin.evaluate(`(() => { const t = document.querySelector('#rpOut .rp-table'); return { heads: [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim()), rows: [...t.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent.trim())), title: document.querySelector('#rpOut h3, #rpOut .rp-head h3') ? document.querySelector('#rpOut h3').textContent.trim() : '', text: document.getElementById('rpOut').innerText }; })()`);
        equal('las columnas del reporte', rep.heads, ['Fecha y hora', 'Movimiento', 'Tipo', 'Nombre', 'Casa', 'Placa', 'Autoriza (visitas)', 'Medio', 'Resultado', 'Registró']);
        equal('una fila por movimiento (11), el mas nuevo primero', [rep.rows.length, rep.rows[0][3], rep.rows[0][1]], [11, 'Invitado de María', 'Entrada']);
        const find = (fn) => rep.rows.find(fn);
        equal('el ingreso del vecino: tipo, nombre, casa, medio, resultado y guardia', find((r) => r[2] === 'Vecino' && r[1] === 'Entrada').slice(1), ['Entrada', 'Vecino', 'Ana García', 'Casa 12', '', '', 'Código escrito', 'Autorizado', 'Pedro Ramírez']);
        equal('la visita muestra el visitante en Nombre y a quien la autoriza aparte', find((r) => r[3] === 'Roberto Herrera' && r[1] === 'Entrada').slice(1), ['Entrada', 'Visita', 'Roberto Herrera', 'Casa 12', 'P-123ABC', 'Ana García', 'Código escrito', 'Autorizado', 'Pedro Ramírez']);
        equal('el moroso sale con su aviso y la lista como medio', find((r) => r[3] === 'Invitado de María').slice(7, 9), ['Lista de visitas', 'Con aviso de mora']);
        record('las cifras grandes: 7 ingresos, 4 salidas, 1 con aviso de mora', /Ingresos\s*7|7\s*Ingresos/i.test(rep.text) && /Salidas\s*4|4\s*Salidas/i.test(rep.text), rep.text.slice(0, 300));
        record('trae la nota de desde cuando existe el registro', /Este registro tiene los movimientos desde el/.test(rep.text), rep.text.slice(0, 400));
        record('el reporte no tiene errores de JavaScript', admin.errors.length === 0, JSON.stringify(admin.errors.slice(0, 3)));
    } finally {
        await close();
    }
}

try { await run(); } catch (error) { failures.push('la prueba se detuvo'); console.log(`  FALLA la prueba se detuvo: ${error.message}`); }
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
