// Prueba del Sistema Financiero en un navegador de verdad (Chrome sin ventana, contra los emuladores): OIKOS con sus
// formularios, la memoria compartida, la copia en IndexedDB, deshacer, la cuota del mes, cambios sin conexion, la
// copia de la version anterior y el borrado al cerrar sesion. Completa a test-finanzas-nube.mjs (que prueba la
// sincronizacion sin navegador) y a test-finanzas-datos.mjs.
// No corre con `npm test` porque necesita Chrome instalado:
//   cd scripts && npm run seed && npm run test:navegador     (con los emuladores levantados)
import { connect, parseArgs, emulatorTriggersRespond } from './admin.mjs';
import { FieldValue } from 'firebase-admin/firestore';
import { launch, sleep } from './chrome.mjs';

const args = parseArgs();
const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CONDO = 'condo-villa-ferrer';
const CODE = 'VF100';
const db = connect('emulator');
const condoRef = db.doc(`condominios/${CONDO}`);
const txRef = (id) => condoRef.collection('finanzas_movimientos').doc(String(id));

let passed = 0;
const failures = [];
function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}
async function waitFor(name, fn, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        try { last = await fn(); if (last) { record(name, true); return last; } } catch (e) { last = e.message; }
        await sleep(250);
    }
    record(name, false, `-> no se cumplio en ${timeoutMs / 1000}s (${JSON.stringify(last)})`);
    return null;
}

const OPENED = `(() => {
    const frame = document.querySelector('#frameBox iframe');
    if (document.querySelector('#frameMessage button')) return 'error';
    return frame && !frame.classList.contains('pendiente') ? 'ok' : null;
})()`;
const IDLE = `(() => { const s = document.getElementById('syncPill').dataset.state; return s !== 'saving' && s !== 'loading' ? s : null; })()`;
// Lo que hay en la copia de este equipo (IndexedDB)
const COPY = `(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('sisdel-finanzas-'));
    const out = { bases: names, registro: localStorage.getItem('sisdel_fin_bases'), viejas: Object.keys(localStorage).filter((k) => k.startsWith('oikos_multisys-')), respaldo: Object.keys(localStorage).filter((k) => k.startsWith('sisdel_fin_sin_subir_')).flatMap((k) => Object.keys(JSON.parse(localStorage.getItem(k)))) };
    if (!names.length) return out;
    const open = await new Promise((res, rej) => { const r = indexedDB.open(names[0]); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (store) => new Promise((res, rej) => { const r = open.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    out.pendientes = (await all('pending')).map((p) => p.kind + ':' + p.id);
    out.enBloques = (await all('base')).reduce((n, c) => n + c.length, 0);
    out.sueltos = (await all('delta')).length;
    out.info = (await all('meta'))[0];
    open.close();
    return out;
})()`;

async function run() {
    if (!(await emulatorTriggersRespond(db, 10000))) throw new Error('los disparadores de functions no responden: reinicie los emuladores');
    // Cuota configurada, para poder cobrar la cuota del mes
    await condoRef.collection('finanzas_config').doc('oikos_settings').set({ currency: 'GTQ', lang: 'es', name: 'Villa Ferrer', fee: 500, chargeDay: 1, graceDays: 5, feeMode: 'manual', updated_at: new Date(Date.now() - 60000).toISOString() });

    const { newPage, close } = await launch(args.chrome);
    try {
        const page = await newPage({ stepTimeoutMs: 120000 });
        const inside = (code) => page.evaluate(`(async () => { const w = document.querySelector('#frameBox iframe').contentWindow; ${code} })()`);
        const oikos = (js) => inside(`return w.eval(${JSON.stringify(js)});`);
        const openFinance = async () => {
            await page.goto(`${BASE}/finanzas.html`);
            const state = await page.waitFor(OPENED, 'el Sistema Financiero', 60000);
            if (state === 'ok') await page.waitFor(IDLE, 'que termine de sincronizar', 30000);
            return state;
        };
        const idle = async () => { await sleep(500); return page.waitFor(IDLE, 'que termine de guardar', 30000); };

        console.log('\nAbrir');
        await page.login(BASE, CODE);
        equal('el Sistema Financiero abre', await openFinance(), 'ok');
        equal('OIKOS usa la memoria de la pagina, no localStorage', await oikos(`[!!sisdelMem(), Object.keys(localStorage).filter(k => k.startsWith('oikos_multisys-')).length]`), [true, 0]);
        let copy = await page.evaluate(COPY);
        equal('la copia del equipo existe y esta completa', [copy.bases, copy.registro, copy.info && copy.info.complete], [['sisdel-finanzas-' + CONDO], JSON.stringify([CONDO]), true]);
        const residents = await oikos(`Store.get('residents').map(r => r.id)`);
        record('trae a los vecinos de SISDEL como residentes', residents.includes('u-ana') && residents.includes('u-maria'), JSON.stringify(residents));

        console.log('\nRegistrar un pago con el formulario de OIKOS');
        const before = await oikos(`Store.get('residents').find(r => r.id === 'u-ana').balance`);
        await inside(`w.eval("navigate('accounting'); openModal('modal-income')");
            w.document.getElementById('inc-resident').value = 'u-ana'; w.eval('updateIncomeConcepts()');
            w.document.getElementById('inc-concept-type').value = 'fee'; w.document.getElementById('inc-amount').value = '500';
            w.document.getElementById('inc-receipt-num').value = 'TRF-0001';
            w.eval("handleTransactionSubmit({ preventDefault() {} }, 'income')");`);
        const payment = await oikos(`(() => { const t = Store.get('transactions').filter(x => x.type === 'income' && x.docNum === 'TRF-0001').pop(); return t ? { id: t.id, amount: t.amount, resiId: t.resiId, receiptNum: t.receiptNum, updated_at: t.updated_at, created_at: t.created_at } : null; })()`);
        record('el pago queda en OIKOS con su numero de recibo y sus fechas', !!payment && payment.amount === 500 && payment.resiId === 'u-ana' && /^[A-Z]{2}\d{4,}$/.test(payment.receiptNum) && !!payment.updated_at && !!payment.created_at, JSON.stringify(payment));
        equal('el saldo del residente sube en ese monto', await oikos(`Store.get('residents').find(r => r.id === 'u-ana').balance`), before + 500);
        equal('se guarda en la nube', await idle(), 'ok');
        const cloud = (await txRef(payment.id).get()).data();
        equal('con los mismos datos', [cloud.amount, cloud.resiId, cloud.receiptNum, cloud.docNum, cloud.updated_at], [500, 'u-ana', payment.receiptNum, 'TRF-0001', payment.updated_at]);
        await waitFor('el servidor le pone su sello', async () => !!(await txRef(payment.id).get()).get('server_at'));
        copy = await page.evaluate(COPY);
        equal('y no queda nada pendiente en el equipo', copy.pendientes, []);
        // Contabilidad ya no tiene la lista (2026-11-20): el pago esta en Reportes > Estado de cuenta general, con su boton de detalle
        equal('el Estado de cuenta general (Reportes) lo muestra y abre su detalle', await oikos(`(() => { navigate('accounting'); const noList = !document.getElementById('accounting-table-body'); openMovementsReport(); const btn = [...document.querySelectorAll('#view-reports button[onclick^="openTxDetail("]')].find((b) => b.getAttribute('onclick').includes(${JSON.stringify(payment.id)})); return [noList, currentView, !!btn]; })()`), [true, 'reports', true]);

        console.log('\nAnular, deshacer y rehacer');
        await oikos(`deleteTransaction(${JSON.stringify(payment.id)})`);
        equal('anulado en OIKOS (no borrado)', await oikos(`(() => { const t = Store.getRaw('transactions').find(x => x.id === ${JSON.stringify(payment.id)}); return [t.deleted, Store.get('transactions').some(x => x.id === t.id)]; })()`), [true, false]);
        await idle();
        equal('anulado en la nube, con su motivo', await (async () => { const d = (await txRef(payment.id).get()).data(); return [d.deleted, d.deleted_reason, d.amount]; })(), [true, 'prueba', 500]);
        equal('deshacer lo devuelve', await oikos(`(() => { History.undo(); return Store.get('transactions').some(x => x.id === ${JSON.stringify(payment.id)}); })()`), true);
        await idle();
        equal('y en la nube deja de estar anulado, con el rastro de la anulacion', await (async () => { const d = (await txRef(payment.id).get()).data(); return [d.deleted, d.deleted_reason, typeof d.restored_at]; })(), [false, 'prueba', 'string']);
        equal('rehacer lo anula otra vez', await oikos(`(() => { History.redo(); return Store.get('transactions').some(x => x.id === ${JSON.stringify(payment.id)}); })()`), false);
        await idle();
        equal('y la nube lo refleja, con el motivo original', await (async () => { const d = (await txRef(payment.id).get()).data(); return [d.deleted, d.deleted_reason]; })(), [true, 'prueba']);
        equal('las fotos para deshacer no copian la lista (son la lista guardada)', await oikos(`(() => { History.push(); return History.stack[History.stack.length - 1].transactions === window.parent.sisdelFinanzasStore.read('transactions'); })()`), true);

        console.log('\nCuota del mes');
        const active = await oikos(`(() => { navigate('residents'); openFeeRun(); return feeRunTargets().pending.length; })()`);
        const txBefore = await oikos(`Store.getRaw('transactions').length`);
        await oikos(`applyFeeRun()`);
        // Cobro manual: aplicar la cuota del mes pide la clave de quien la aplica (la verifica el servidor: confirmOwnCode)
        equal('en cobro manual pide la clave y todavia no crea nada', [await oikos(`!document.getElementById('modal-fee-confirm').classList.contains('hidden-section')`), (await oikos(`Store.getRaw('transactions').length`)) - txBefore], [true, 0]);
        await oikos(`(() => { document.getElementById('fc-code').value = 'CLAVE-MALA'; submitFeeConfirm(); })()`);
        await waitFor('una clave incorrecta se rechaza con aviso', async () => oikos(`document.getElementById('fc-error').classList.contains('hidden') ? '' : document.getElementById('fc-error').textContent`));
        equal('y no se aplica ninguna cuota ni se cierra la ventana', [(await oikos(`Store.getRaw('transactions').length`)) - txBefore, await oikos(`!document.getElementById('modal-fee-confirm').classList.contains('hidden-section')`)], [0, true]);
        await oikos(`(() => { document.getElementById('fc-code').value = ${JSON.stringify(CODE)}; submitFeeConfirm(); })()`);
        await waitFor('con la clave propia se aplica la cuota', async () => (await oikos(`Store.getRaw('transactions').length`)) - txBefore === active);
        equal('crea una cuota por residente activo', (await oikos(`Store.getRaw('transactions').length`)) - txBefore, active);
        equal('se guardan en la nube', await idle(), 'ok');
        const period = await oikos(`currentFeePeriod()`);
        const fee = (await txRef(`fee_u-ana_${period}`).get()).data();
        equal('con el id de siempre y su periodo', [fee && fee.kind, fee && fee.period, fee && fee.amount, fee && fee.manual], ['fee', period, 500, true]);
        equal('repetirla no duplica nada', await oikos(`(() => { openFeeRun(); return feeRunTargets().pending.length; })()`), 0);
        await oikos(`closeModal('modal-fee-run')`);

        console.log('\nEstado de cuenta: lo que debe el residente');
        // Un vecino con 227 cuotas sin pagar desde 2008 (como C070 de La Perla) y su mora (un cargo el dia 6 de cada mes): la pantalla, la impresion,
        // el PDF, el Excel y WhatsApp dicen lo mismo y las tres cifras suman. El estado de mora se arma con el modulo de verdad
        // (a un dia fijo) y se le entrega a la pantalla; lo demas es el codigo de OIKOS tal cual.
        const feesCount = await oikos(`(() => {
            const txs = [];
            for (let y = 2008; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 11) break; const p = y + '-' + String(m).padStart(2, '0'); txs.push({ id: 'fee_x_' + p, type: 'charge', kind: 'fee', period: p, amount: 300, resiId: 'u-ana', date: p + '-05T18:00:00.000Z' }); }
            const state = SisdelMora.stateOf('u-ana', txs, { fee: 300, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] }, '2026-11-16');
            const ledger = -300 * txs.length;
            window.__real = { ecMora, sisdelMoraRuleText, open: window.open, jsPdfSave: window.jspdf && window.jspdf.jsPDF.API.save };
            ecMora = () => Object.assign({}, state, { total: Math.round((ledger - state.moraDaily) * 100) / 100 });
            sisdelMoraRuleText = () => '3 % al mes de lo que falta de cada cuota vencida, cargado el día 6 de cada mes';
            openEstadoCuenta('u-ana');
            return txs.length;
        })()`);
        const money = (text) => Number(String(text).replace(/[^0-9.-]/g, ''));
        const cents = (n) => Math.round(n * 100) / 100;
        const [pending, overdue, upcoming, mora, due] = (await oikos(`['ec-pending', 'ec-overdue', 'ec-upcoming', 'ec-mora', 'ec-total-due'].map(id => document.getElementById(id).textContent)`)).map(money);
        equal('pantalla: cuotas y cargos pendientes + mora = total que debe', cents(pending + mora), due);
        equal('pantalla: lo pendiente es lo cargado (227 cuotas de Q300) y lo vencido + lo que no vence es lo pendiente', [feesCount, pending, cents(overdue + upcoming), upcoming], [227, 227 * 300, pending, 300]);
        equal('pantalla: la caja se ve y el saldo simple avisa que no incluye la mora', await oikos(`[!document.getElementById('ec-mora-box').classList.contains('hidden'), document.getElementById('ec-balance-label').textContent]`), [true, 'Saldo sin mora']);
        const listed = await oikos(`[...document.querySelectorAll('#ec-pending-body tr')].map(tr => tr.children[0].textContent)`);
        equal('pantalla: la tabla lista las 227 cuotas, de la mas antigua a la mas nueva', [listed.length, listed[0], listed[226]], [227, 'Ene 2008', 'Nov 2026']);
        const foot = (await oikos(`[...document.querySelectorAll('#ec-pending-foot td')].map(td => td.textContent)`)).map(money);
        equal('pantalla: el total de la tabla es el total que debe (pendiente, mora y total)', [foot[1], foot[3], foot[4]], [pending, mora, due]);
        equal('pantalla: las filas que aun no vencen se distinguen', await oikos(`[...document.querySelectorAll('#ec-pending-body tr')].pop().children[2].textContent.includes('aún no vence')`), true);

        // Lo de siempre (con el libro de movimientos) es la vista "Con movimientos"; al abrir se ve "Cuotas pendientes"
        equal('abre en la vista Cuotas pendientes', await oikos(`[ecView, document.getElementById('ec-pane-pending').classList.contains('hidden'), document.getElementById('ec-pane-movs').classList.contains('hidden')]`), ['pending', false, true]);
        await oikos(`ecSetView('movs')`);
        const printed = await oikos(`(() => { let html = ''; window.open = () => ({ document: { write(h) { html = h; }, close() {} }, print() {} }); printEstadoCuenta(); return html; })()`);
        record('impresion: trae primero el total que debe, la tabla de cuotas pendientes y su total', /= Total que debe/.test(printed) && printed.includes('Cuotas pendientes y su mora') && printed.includes(`Q${due.toLocaleString('en-US', { minimumFractionDigits: 2 })}`) && (printed.match(/<tbody>/g) || []).length === 2, printed.slice(0, 80));
        equal('impresion: una fila por cuota pendiente mas las del periodo', (printed.match(/<tr/g) || []).length >= 227 + 1, true);
        equal('impresion: ningun monto ni saldo puede partirse en dos lineas (todos con nowrap)', (printed.match(/<td style="[^"]*text-align:right[^"]*"/g) || []).filter((cell) => !cell.includes('white-space:nowrap')).length, 0);

        const waUrl = await oikos(`(() => { let url = ''; window.open = (u) => { url = u; return null; }; shareEstadoCuentaWhatsApp(); return url; })()`);
        const waText = decodeURIComponent(String(waUrl).split('text=')[1] || '');
        record('WhatsApp: el total que debe, la mora, el conteo de cuotas y los pendientes', /TOTAL QUE DEBE: \*Q[\d,.]+\*/.test(waText) && /Mora a hoy: \*Q[\d,.]+\*/.test(waText) && /Cuotas pendientes: \*227 \(desde Ene 2008\)\*/.test(waText) && waText.length <= 3400, waText.slice(0, 200));

        const model = await oikos(`ecReportModel(false)`);
        const lastRow = model.tables[0].rows[model.tables[0].rows.length - 1];
        equal('Excel: la primera hoja son las cuotas pendientes y su ultima fila es el total, con numeros', [model.tables[0].title, model.tables[0].rows.length, lastRow[0], lastRow[1], lastRow[3], lastRow[4]], ['Cuotas pendientes y su mora', 228, 'TOTAL', pending, mora, due]);
        equal('Excel: las cifras de arriba son las mismas y van primero', model.kpis.slice(0, 5).map((k) => k.label).concat([model.kpis.find((k) => k.label === 'TOTAL QUE DEBE').value]), ['Cuotas y cargos pendientes', 'De ellas, vencidas', 'De ellas, por vencer', 'Mora a hoy', 'TOTAL QUE DEBE', due]);

        const pdf = await oikos(`(() => { const api = window.jspdf.jsPDF.API; let out = { pages: 0, name: '' }; api.save = function (n) { out = { pages: this.getNumberOfPages(), name: n }; return this; }; downloadEstadoCuentaPDF(); return out; })()`);
        record('PDF: se genera sin errores, con varias paginas por las 227 cuotas', pdf.pages >= 4 && /^Estado_Cuenta_/.test(pdf.name), JSON.stringify(pdf));

        console.log('\nEstado de cuenta: solo las cuotas pendientes, la mora si aplica y el total');
        await oikos(`ecSetView('pending')`);
        const dueScreen = await oikos(`(() => ({
            capital: document.getElementById('ec-due-capital').textContent, mora: document.getElementById('ec-due-mora').textContent, total: document.getElementById('ec-due-total').textContent,
            label: document.getElementById('ec-due-total-label').textContent, moraShown: !document.getElementById('ec-due-mora-card').classList.contains('hidden'),
            head: [...document.querySelectorAll('#ec-due-head th')].map(th => th.textContent), rows: [...document.querySelectorAll('#ec-due-body tr')].map(tr => tr.children[0].textContent),
            foot: [...document.querySelectorAll('#ec-due-foot td')].map(td => td.textContent), clickable: !!document.querySelector('#ec-due-body tr[data-tx][onclick="openTxDetail(this.dataset.tx)"]'),
            ledgerHidden: document.getElementById('ec-pane-movs').classList.contains('hidden') }))()`);
        equal('con mora: las cifras son las de siempre (pendiente + mora = total)', [money(dueScreen.capital), money(dueScreen.mora), money(dueScreen.total), dueScreen.label, dueScreen.moraShown], [pending, mora, due, '= Total que debe', true]);
        equal('con mora: la tabla trae Cuota, Vence, Pendiente, Mora y Total y una fila por cuota, con el mes completo', [dueScreen.head, dueScreen.rows.length, dueScreen.rows[0], dueScreen.rows[226]], [['Cuota', 'Vence', 'Pendiente', 'Mora', 'Total'], 227, 'Enero 2008', 'Noviembre 2026']);
        equal('con mora: el total de la tabla es el total que debe y no se ve el libro de movimientos', [dueScreen.foot[1], money(dueScreen.foot[2]), money(dueScreen.foot[3]), money(dueScreen.foot[4]), dueScreen.ledgerHidden, dueScreen.clickable], ['227 cuotas por pagar', pending, mora, due, true, true]);
        const duePrinted = await oikos(`(() => { let html = ''; window.open = () => ({ document: { write(h) { html = h; }, close() {} }, print() {} }); printEstadoCuenta(); return html; })()`);
        record('impresion: solo las cuotas pendientes con su mora y el total (sin pagos, cargos ni movimientos)', duePrinted.includes('Cuotas pendientes de pago al') && /= Total que debe/.test(duePrinted) && !/Movimientos del per/.test(duePrinted) && !/>PAGOS</.test(duePrinted) && !/Saldo anterior/.test(duePrinted) && (duePrinted.match(/<tbody>/g) || []).length === 1 && (duePrinted.match(/<tr/g) || []).length === 227 + 2, duePrinted.slice(0, 120));
        equal('impresion: ningun monto puede partirse en dos lineas', (duePrinted.match(/<td style="[^"]*text-align:right[^"]*"/g) || []).filter((cell) => !cell.includes('white-space:nowrap')).length, 0);
        const dueWa = decodeURIComponent(String(await oikos(`(() => { let url = ''; window.open = (u) => { url = u; return null; }; shareEstadoCuentaWhatsApp(); return url; })()`)).split('text=')[1] || '');
        record('WhatsApp: el total que debe, la mora y las cuotas juntas por ano en a lo mas 12 lineas (sin movimientos)', /TOTAL QUE DEBE: \*Q[\d,.]+\*/.test(dueWa) && /Mora a hoy: \*Q[\d,.]+\*/.test(dueWa) && /Cuotas pendientes por año/.test(dueWa) && /Cuotas de 2008 a 2016 \(108\)/.test(dueWa) && !/movimientos/i.test(dueWa) && !/fila\(s\) más/.test(dueWa) && dueWa.length <= 3400, dueWa.slice(0, 300));
        const dueModel = await oikos(`ecDueModel(false)`);
        const dueLast = dueModel.tables[0].rows[dueModel.tables[0].rows.length - 1];
        equal('Excel: una sola hoja con las cuotas pendientes y su total, con numeros', [dueModel.tables.length, dueModel.tables[0].title, dueModel.tables[0].rows.length, dueLast[0], dueLast[2], dueLast[3], dueLast[4]], [1, 'Cuotas pendientes de pago', 228, 'TOTAL', pending, mora, due]);
        const duePdf = await oikos(`(() => { const api = window.jspdf.jsPDF.API; let out = { pages: 0, name: '' }; api.save = function (n) { out = { pages: this.getNumberOfPages(), name: n }; return this; }; downloadEstadoCuentaPDF(); return out; })()`);
        record('PDF: se genera sin errores, con las 227 cuotas', duePdf.pages >= 4 && /^Estado_Cuenta_/.test(duePdf.name), JSON.stringify(duePdf));
        // Un pago que cubre la cuota pero no la mora (primero la cuota, como en La Perla): esa cuota ya vencio y solo debe la mora
        const moraOnly = await oikos(`(() => {
            const txs = ['2026-01', '2026-02', '2026-03'].map(p => ({ id: 'fee_y_' + p, type: 'charge', kind: 'fee', period: p, amount: 300, resiId: 'u-ana', date: p + '-05T18:00:00.000Z' }));
            txs.push({ id: 'pay_y', type: 'income', amount: 600, resiId: 'u-ana', date: '2026-11-10T18:00:00.000Z' });
            const state = SisdelMora.stateOf('u-ana', txs, { fee: 300, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] }, '2026-11-16');
            ecMora = () => Object.assign({}, state, { total: Math.round((-300 - state.moraDaily) * 100) / 100 });
            renderEstadoCuenta();
            const rows = [...document.querySelectorAll('#ec-due-body tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
            return { foot: document.querySelectorAll('#ec-due-foot td')[1].textContent, rows };
        })()`);
        equal('una cuota pagada a la que solo le queda la mora dice eso, ya vencio y no cuenta como cuota por pagar', [moraOnly.foot, moraOnly.rows.length, moraOnly.rows[0][0], /aún no vence/.test(moraOnly.rows[0][1]), moraOnly.rows[0][2], moraOnly.rows[2][0]],
            ['1 cuota por pagar · 2 solo con mora', 3, 'Enero 2026cuota pagada: solo debe la mora', false, 'Q0.00', 'Marzo 2026']);
        // Devuelve todo como estaba
        await oikos(`(() => { ecMora = __real.ecMora; sisdelMoraRuleText = __real.sisdelMoraRuleText; window.open = __real.open; if (__real.jsPdfSave) window.jspdf.jsPDF.API.save = __real.jsPdfSave; closeModal('modal-estado-cuenta'); })()`);

        // Sin regla de mora (como Delco II): antes solo se veia el libro; ahora las cuotas que faltan, sin columna de mora
        const plainDue = await oikos(`(() => {
            openEstadoCuenta('u-ana');
            const r = Store.get('residents').find(x => x.id === 'u-ana');
            const rows = [...document.querySelectorAll('#ec-due-body tr')];
            return { noRule: !SisdelMora.enabled(Store.get('settings')), owed: sisdelOwedOf(r).total, total: document.getElementById('ec-due-total').textContent,
                moraShown: !document.getElementById('ec-due-mora-card').classList.contains('hidden'), head: [...document.querySelectorAll('#ec-due-head th')].map(th => th.textContent),
                last: rows.length ? rows[rows.length - 1].children[1].textContent : '', sum: Math.round(rows.reduce((s, tr) => s + Number(tr.children[2].textContent.replace(/[^0-9.-]/g, '')), 0) * 100) / 100,
                period: feePeriodLongLabel(currentFeePeriod()), labels: rows.map(tr => tr.children[0].textContent) };
        })()`);
        equal('sin regla de mora: el total es lo que debe en Residentes y la tabla no trae mora', [plainDue.noRule, money(plainDue.total), plainDue.sum, plainDue.moraShown, plainDue.head], [true, plainDue.owed, plainDue.owed, false, ['Cuota', 'Vence', 'Pendiente']]);
        record('sin regla de mora: la cuota del mes sale pendiente y aun en su plazo (vence el dia 5 del mes siguiente)', plainDue.labels.includes(plainDue.period) && /^5\/\d{1,2}\/\d{4} \(aún no vence\)$/.test(plainDue.last), JSON.stringify(plainDue));
        await oikos(`closeModal('modal-estado-cuenta')`);

        console.log('\nRecordatorios: elegir a quienes se envia (por ejemplo 20 para una prueba)');
        // WhatsApp de mentira (no sale nada): se ve a quien le tocaria. A los residentes de prueba se les pone un telefono solo en pantalla.
        await page.evaluate(`(() => { window.__sent = []; window.__realWa = window.sisdelWhatsApp; window.sisdelWhatsApp = { start: async (d) => { window.__sent.push(d); return { ok: true, pending: d.items.length, estimatedMinutes: 1, skipped: 0 }; }, test: async () => ({ ok: true, sent: true }), control: async () => ({ ok: true }), one: async () => ({ ok: true, sent: true }), status: async () => window.__conn, reconcile: async (d) => { window.__calls.push(['reconcile', d]); return { ok: true, entregado: 3, rechazado: 7 }; }, resend: async (d) => { window.__calls.push(['resend', d]); return { ok: true, pending: 7, estimatedMinutes: 1 }; }, recipients: async (d) => { window.__calls.push(['recipients', d]); return { ok: true, items: window.__rec || [] }; }, watch: () => () => {} }; window.__calls = []; window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 } }; })()`);
        await oikos(`(() => {
            window.__origGet = Store.get; window.__realConfirm = window.confirm;
            // El condominio de prueba trae solo 2 vecinos: se agregan 6 de mentira (solo en pantalla) para poder elegir unos y dejar otros
            const names = ['Beatriz Lopez', 'Carlos Mejia', 'Diana Ortiz', 'Esteban Perez', 'Flor Quezada', 'Gabriel Rojas'];
            Store.get = function (k) {
                const v = window.__origGet.apply(Store, arguments);
                if (k !== 'residents') return v;
                const fakes = names.map((n, i) => Object.assign({}, v[0], { id: 'fake-' + i, name: n, unit: 'F-' + (i + 1), status: 'active', deleted: false, fase: i < 3 ? '2' : i < 5 ? '3' : '', waterUnits: i % 2 === 0 ? 1 : 0 }));
                return v.concat(fakes).map((r, i) => Object.assign({}, r, { contact: '5500' + String(1000 + i) }));
            };
            window.confirm = () => true;
            openReminders(); setReminderMode('varios');
            document.getElementById('rem-msg-general').value = 'Aviso de prueba para {nombre}';
        })()`);
        const rows = () => oikos(`[...document.querySelectorAll('#reminders-list .rem-pick')].length`);
        const shown = await oikos(`remShownList.length`);
        equal('con "Todos los residentes" no hay casillas: se envia a la lista que se ve', await rows(), 0);
        await oikos(`renderRemindersList('seleccion')`);
        record('en "Por seleccion" cada residente con telefono tiene su casilla', shown >= 3 && (await rows()) === shown, `lista ${shown}, casillas ${await rows()}`);
        equal('en Por seleccion sin marcar a nadie: el boton esta apagado y la barra dice que marque', await oikos(`[document.getElementById('rem-send-all-label').textContent, document.getElementById('rem-send-all').disabled, document.getElementById('rem-pick-count').textContent, document.getElementById('rem-clear-picks').classList.contains('hidden')]`), ['Enviar a los seleccionados', true, 'Marque a quienes recibirán el mensaje', true]);
        const chosen = await oikos(`(() => { const boxes = [...document.querySelectorAll('#reminders-list .rem-pick')]; boxes[0].click(); boxes[2].click(); return [boxes[0].dataset.id, boxes[2].dataset.id]; })()`);
        equal('con dos casillas el boton dice a los seleccionados y aparece Quitar seleccion', await oikos(`[document.getElementById('rem-send-all-label').textContent, document.getElementById('rem-pick-count').textContent, document.getElementById('rem-clear-picks').classList.contains('hidden'), document.querySelectorAll('#reminders-list .rem-row.ring-2').length]`), ['Enviar a los seleccionados (2)', '2 seleccionado(s)', false, 2]);
        // El buscador esta inmediatamente arriba de la lista, despues del editor del mensaje (pedido del usuario, 2026-11-17)
        equal('el buscador queda justo arriba de la lista de residentes, despues del editor del mensaje y del envio a todos', await oikos(`(() => { const d = (id) => document.getElementById(id); const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); const search = d('rem-search'); const box = search.parentElement; return [after(d('rem-bulk'), search), after(d('rem-msg-box'), search), box.nextElementSibling === d('rem-count'), d('rem-count').nextElementSibling === d('reminders-list'), search.getBoundingClientRect().top < d('reminders-list').getBoundingClientRect().top]; })()`), [true, true, true, true, true]);
        // Buscar y seguir eligiendo: lo elegido no se pierde al escribir en el buscador
        const lastName = await oikos(`String(remShownList[remShownList.length - 1].name || '').slice(0, 3)`);
        await oikos(`(() => { const s = document.getElementById('rem-search'); s.value = ${JSON.stringify(lastName)}; s.dispatchEvent(new Event('input')); })()`);
        equal('al buscar, la seleccion se conserva', await oikos(`[remSelected.size, document.getElementById('rem-send-all-label').textContent]`), [2, 'Enviar a los seleccionados (2)']);
        await oikos(`(() => { const s = document.getElementById('rem-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
        equal('al borrar la busqueda siguen marcados los mismos dos', await oikos(`[...document.querySelectorAll('#reminders-list .rem-pick:checked')].map(b => b.dataset.id)`), chosen);
        await oikos(`(() => { const c = document.getElementById('rem-only-selected'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
        equal('Ver solo los seleccionados deja unicamente esos dos', await oikos(`[...document.querySelectorAll('#reminders-list .rem-pick')].map(b => b.dataset.id).sort()`), [...chosen].sort());
        await oikos(`(() => { const c = document.getElementById('rem-only-selected'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
        await oikos(`sendRemindersToAll()`);
        const sent = await page.evaluate(`window.__sent`);
        equal('Enviar manda SOLO a los dos elegidos, con su id y su texto y nada mas (el telefono lo pone el servidor)', [sent.length, sent[0] && sent[0].items.map((i) => i.residentId).sort(), sent[0] && [...new Set(sent[0].items.flatMap((i) => Object.keys(i)))].sort(), sent[0] && sent[0].mode], [1, [...chosen].sort(), ['residentId', 'text'], 'varios']);
        record('el texto lleva el nombre de cada uno', !!sent[0] && sent[0].items.every((i) => i.text.startsWith('Aviso de prueba para ') && !i.text.includes('{nombre}')), JSON.stringify(sent[0] && sent[0].items[0]));
        equal('despues de enviar la seleccion queda vacia', await oikos(`[remSelected.size, document.getElementById('rem-send-all-label').textContent, document.querySelectorAll('#reminders-list .rem-pick:checked').length]`), [0, 'Enviar a los seleccionados', 0]);
        await oikos(`remPickAll()`);
        equal('Seleccionar los de la lista marca a todos y Quitar seleccion los desmarca', [await oikos(`[remSelected.size, document.querySelectorAll('#reminders-list .rem-pick:checked').length]`), await oikos(`(() => { remClearPicks(); return [remSelected.size, document.querySelectorAll('#reminders-list .rem-pick:checked').length]; })()`)], [[shown, shown], [0, 0]]);
        const noPick = await oikos(`(async () => { const seen = []; const real = window.alert; window.alert = (m) => seen.push(String(m)); try { await sendRemindersToAll(); } finally { window.alert = real; } return seen; })()`);
        record('en Por seleccion sin marcar a nadie NO se envia (avisa que marque), ya no es "a todos si no marco a nadie"', noPick.length === 1 && /Marque al menos/.test(noPick[0]) && (await page.evaluate(`window.__sent.length`)) === 1, JSON.stringify(noPick));
        await oikos(`renderRemindersList('all')`);
        await oikos(`sendRemindersToAll()`);
        equal('con "Todos los residentes" el envio es a todos los de la lista', (await page.evaluate(`window.__sent`)).map((d) => d.items.length), [2, shown]);
        await oikos(`(() => { remTogglePick(Store.get('residents')[0].id, true); setReminderMode('mora'); })()`);
        equal('cambiar de mensaje (morosidad <-> varios) empieza la seleccion de cero', await oikos(`remSelected.size`), 0);
        // La barra de opciones: por fase, solo casas, solo lotes (con casa = el lote paga agua; solo lote = sin agua)
        await oikos(`setReminderMode('varios'); openReminders(); document.getElementById('rem-msg-general').value = 'Aviso de prueba para {nombre}';`);
        const shownNow = () => oikos(`remShownList.length`);
        const barTexts = () => oikos(`[...document.querySelectorAll('#rem-tabs button:not(.hidden)')].map((b) => b.textContent)`);
        const sendLabel = () => oikos(`document.getElementById('rem-send-all-label').textContent`);
        const chipTexts = () => oikos(`[...document.querySelectorAll('#rem-fase-select option')].map((o) => o.textContent)`);
        const base = await shownNow();
        equal('todas las opciones estan en una sola barra y los selectores de abajo ya no existen', [await barTexts(), await oikos(`['rem-fase', 'rem-tipo'].map((id) => !!document.getElementById(id))`)], [['Todos los residentes', 'Solo Morosos', 'Todos los pendientes', 'Por fase', 'Solo casas (3)', `Solo lotes (${base - 3})`, 'Por selección'], [false, false]]);
        await oikos(`renderRemindersList('fase')`);
        equal('Por fase: las fases con cuantos hay, y queda elegida la primera', [await chipTexts(), await shownNow(), await sendLabel()], [['Fase 2 (3)', 'Fase 3 (2)', `Sin fase (${base - 5})`], 3, 'Enviar a la fase 2 (3)']);
        await oikos(`setRemFase('3')`);
        equal('elegir otra fase cambia la lista, el boton y la cuenta de la ventana', [await shownNow(), await sendLabel(), await oikos(`document.getElementById('rem-count').textContent`)], [2, 'Enviar a la fase 3 (2)', '2 residente(s) · fase 3']);
        const asked = await oikos(`(async () => { const seen = []; const real = window.confirm; window.confirm = (m) => { seen.push(String(m)); return false; }; try { await sendRemindersToAll(); } finally { window.confirm = real; } return seen; })()`);
        record('la confirmacion de enviar dice a quien: cuantos y de que fase', asked.length === 1 && /2 mensajes/.test(asked[0]) && /a los 2 residentes de la fase 3/.test(asked[0]), JSON.stringify(asked));
        await oikos(`setRemFase('__none__')`);
        equal('sin fase', [await shownNow(), await sendLabel()], [base - 5, `Enviar a los sin fase (${base - 5})`]);
        await oikos(`renderRemindersList('casas')`);
        equal('Solo casas: los lotes que pagan agua, y las fases se esconden', [await shownNow(), await sendLabel(), await oikos(`document.getElementById('rem-fase-bar').classList.contains('hidden')`)], [3, 'Enviar a las casas (3)', true]);
        await oikos(`renderRemindersList('lotes')`);
        equal('Solo lotes: los demas, sin casa', [await shownNow(), await sendLabel()], [base - 3, `Enviar a los lotes (${base - 3})`]);
        await oikos(`renderRemindersList('seleccion')`);
        equal('Por seleccion: se ve a todos para buscar y marcar, y aparece la barra de marcar', [await shownNow(), await oikos(`!document.getElementById('rem-pick-bar').classList.contains('hidden')`)], [base, true]);
        await oikos(`renderRemindersList('casas')`);
        equal('al salir de Por seleccion la barra de marcar se oculta', await oikos(`document.getElementById('rem-pick-bar').classList.contains('hidden')`), true);
        await oikos(`openReminders()`);
        equal('al abrir de nuevo la ventana vuelve a Todos los residentes (no se envia a un grupo por descuido)', [await oikos(`currentRemFilter`), await shownNow()], ['all', base]);
        await oikos(`setReminderMode('mora')`);
        const moraCounts = await oikos(`[remBaseList('mora').length, remBaseList('mora').filter(r => remInScope(r, 'casas')).length, remBaseList('mora').filter(r => remInScope(r, 'lotes')).length]`);
        equal('con el mensaje por morosidad la barra se limita a los morosos y las cuentas son de los morosos', [await barTexts(), moraCounts[1] + moraCounts[2] === moraCounts[0]], [['Todos los morosos', 'Por fase', `Solo casas (${moraCounts[1]})`, `Solo lotes (${moraCounts[2]})`, 'Por selección'], true]);
        // Botones del progreso segun el estado del envio: Pausar (en curso), Continuar (en pausa o detenido), Cancelar (definitivo)
        const panel = (status, extra = {}) => oikos(`(() => {
            remCampaign = Object.assign({ id: 'x', status: ${JSON.stringify(status)}, total: 10, sent: 3, failed: 0, skipped: 0, pending: 7, createdAt: new Date().toISOString() }, ${JSON.stringify(extra)});
            paintReminderProgress(); paintReminderBulk();
            const send = document.getElementById('rem-send-all');
            return [document.getElementById('rem-bulk-title').textContent, [...document.querySelectorAll('#rem-bulk-buttons button')].map(b => b.textContent.trim()), send.disabled];
        })()`);
        equal('en curso: Pausar y Cancelar envio, y no se puede empezar otro', await panel('running'), ['Enviando recordatorios...', ['Pausar', 'Cancelar envío'], true]);
        equal('en pausa: Continuar y Cancelar envio, y tampoco se empieza otro', await panel('paused', { pausedAt: new Date().toISOString() }), ['Envío en pausa', ['Continuar', 'Cancelar envío', 'Comprobar entregas'], true]);
        equal('detenido por un error: Continuar y Cancelar envio', await panel('error', { errorMessage: 'WhatsApp no responde' }), ['Envío detenido', ['Continuar', 'Cancelar envío', 'Comprobar entregas'], false]);
        equal('cancelado: no se puede continuar (definitivo) pero si comprobar que llego', (await panel('canceled'))[1], ['Comprobar entregas']);
        equal('terminado: comprobar entregas', (await panel('done', { pending: 0, sent: 10 }))[1], ['Comprobar entregas']);
        // Lo que llego de verdad (UltraMsg) y reenviar solo a los que no recibieron
        const delivery = { entregado: 3, enviado: 0, pendiente: 0, en_cola: 0, rechazado: 5, desconocido: 2, sinEnviar: 0, resend: 7, reasons: { temporary_block: 5 }, checkedAt: new Date().toISOString() };
        const withDel = await panel('done', { pending: 0, sent: 10, delivery });
        equal('con las entregas comprobadas aparece Reenviar a los que no recibieron con su numero', withDel[1], ['Comprobar entregas', 'Reenviar a los que no recibieron (7)']);
        const deliveryText = await oikos(`document.getElementById('rem-bulk-delivery').textContent`);
        record('y dice lo que llego de verdad: entregados, rechazados con su motivo y a cuantos reenviar', /3 entregados/.test(deliveryText) && /5 rechazados/.test(deliveryText) && /bloqueo temporal de WhatsApp \(5\)/.test(deliveryText) && /2 sin rastro/.test(deliveryText) && /A reenviar: 7/.test(deliveryText), deliveryText);
        equal('con un envio en pausa no se ofrece reenviar', (await panel('paused', { pausedAt: new Date().toISOString(), delivery }))[1], ['Continuar', 'Cancelar envío', 'Comprobar entregas']);
        await oikos(`(() => { window.confirm = () => true; })()`);
        await page.evaluate(`window.__calls.length = 0`);
        await panel('done', { id: 'envio-1', pending: 0, sent: 10, delivery });
        await oikos(`(async () => { await reconcileRemCampaign(); await resendRemCampaign(); })()`);
        equal('los botones llaman al servidor con el envio: comprobar y reenviar', await page.evaluate(`window.__calls.map((c) => [c[0], c[1].campaignId])`), [['reconcile', 'envio-1'], ['resend', 'envio-1']]);
        // Quienes recibieron el ultimo mensaje: boton y listado por lo que WhatsApp confirmo
        const nowIso = new Date().toISOString();
        await page.evaluate(`window.__rec = [
            { id: 'u-ana', name: 'Ana', casa: 'A1', phoneTail: '1111', status: 'sent', delivery: 'entregado', sentAt: '${nowIso}' },
            { id: 'fake-0', name: 'Beatriz', casa: 'F-1', phoneTail: '2222', status: 'sent', delivery: 'enviado', sentAt: '${nowIso}' },
            { id: 'fake-1', name: 'Carlos', casa: 'F-2', phoneTail: '3333', status: 'sent', delivery: 'pendiente', sentAt: '${nowIso}' },
            { id: 'fake-2', name: 'Diana', casa: 'F-3', phoneTail: '4444', status: 'sent', delivery: 'rechazado', deliveryReason: 'temporary_block', sentAt: '${nowIso}' },
            { id: 'fake-3', name: 'Esteban', casa: 'F-4', phoneTail: '5555', status: 'sent', delivery: 'desconocido', sentAt: '${nowIso}' },
            { id: 'fake-4', name: 'Flor', casa: 'F-5', phoneTail: '6666', status: 'pending', delivery: 'sin_enviar' },
            { id: 'fake-5', name: 'Gabriel', casa: 'F-6', phoneTail: '', status: 'skipped', reason: 'sin teléfono válido' }
        ]; window.__calls.length = 0;`);
        await panel('done', { id: 'envio-2', pending: 0, sent: 10, delivery });
        equal('con un envio aparece el boton Ver quienes recibieron', await oikos(`!document.getElementById('rem-rec-btn').classList.contains('hidden')`), true);
        await oikos(`showRemRecipients()`);
        await sleep(300);
        const recTabs = await oikos(`[...document.querySelectorAll('#rem-rec-tabs button')].map((b) => b.textContent)`);
        equal('el listado se divide por lo que WhatsApp confirmo, con su cuenta', recTabs, ['Ya recibieron (2)', 'Sin confirmar (1)', 'No recibieron (3)', 'Sin teléfono (1)']);
        const received = await oikos(`[...document.querySelectorAll('#rem-rec-list > div')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim())`);
        record('en Ya recibieron salen solo los que llegaron (entregado o recibido por WhatsApp), con su casa y su hora', received.length === 2 && /Ana/.test(received[0]) && /llegó al teléfono/.test(received[0]) && /Beatriz/.test(received[1]) && /WhatsApp lo recibió/.test(received[1]) && !received.some((t) => /Diana|Carlos|Esteban|Flor/.test(t)), JSON.stringify(received));
        equal('con el envio ya comprobado no se vuelve a preguntar a UltraMsg, solo se lee el listado', await page.evaluate(`window.__calls.map((c) => c[0])`), ['recipients']);
        await oikos(`setRemRecTab('no_recibieron')`);
        const notReceived = await oikos(`[...document.querySelectorAll('#rem-rec-list > div')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim())`);
        record('en No recibieron cada uno dice por que: rechazado por WhatsApp, sin rastro, o sin enviar', notReceived.length === 3 && notReceived.some((t) => /Diana.*bloqueo temporal de WhatsApp/.test(t)) && notReceived.some((t) => /Esteban.*sin rastro en UltraMsg/.test(t)) && notReceived.some((t) => /Flor.*todavía no se envió/.test(t)), JSON.stringify(notReceived));
        await oikos(`(() => { const s = document.getElementById('rem-rec-search'); s.value = 'dian'; renderRemRecipients(); })()`);
        equal('el buscador filtra el listado', await oikos(`[...document.querySelectorAll('#rem-rec-list > div')].length`), 1);
        await oikos(`(() => { document.getElementById('rem-rec-search').value = ''; })()`);
        await oikos(`showRemRecipients()`);
        equal('el mismo boton cierra el listado', await oikos(`document.getElementById('rem-recipients').classList.contains('hidden')`), true);
        // Un numero sin WhatsApp no se reenvia: el resumen lo dice y el listado ofrece corregir su telefono
        await page.evaluate(`window.__rec = [
            { id: 'u-ana', name: 'Ana', casa: 'A1', phoneTail: '1111', status: 'sent', delivery: 'rechazado', deliveryReason: 'invalid', sentAt: '${nowIso}' },
            { id: 'fake-2', name: 'Diana', casa: 'F-3', phoneTail: '4444', status: 'sent', delivery: 'rechazado', deliveryReason: 'temporary_block', sentAt: '${nowIso}' }
        ]; window.__calls.length = 0;`);
        const noWaPanel = await panel('done', { id: 'envio-5', pending: 0, sent: 2, delivery: { entregado: 0, enviado: 0, pendiente: 0, en_cola: 0, rechazado: 2, desconocido: 0, sinEnviar: 0, noWhatsapp: 1, resend: 1, reasons: { invalid: 1, temporary_block: 1 }, checkedAt: nowIso } });
        const noWaText = await oikos(`document.getElementById('rem-bulk-delivery').textContent`);
        record('el resumen dice cuantos tienen numero sin WhatsApp y que reenviarles no sirve, y A reenviar no los cuenta', /A reenviar: 1\./.test(noWaText) && /1 con número sin WhatsApp/.test(noWaText) && /reenviarles no sirve/.test(noWaText), noWaText);
        equal('el boton Reenviar cuenta solo a los que si se puede (1)', noWaPanel[1], ['Comprobar entregas', 'Reenviar a los que no recibieron (1)']);
        await oikos(`showRemRecipients()`);
        await sleep(300);
        await oikos(`setRemRecTab('no_recibieron')`);
        const noWaRows = await oikos(`[...document.querySelectorAll('#rem-rec-list > div')].map((d) => ({ text: d.textContent.replace(/\\s+/g, ' ').trim(), fix: !!d.querySelector('button[onclick^="editResident("]'), id: (d.querySelector('button[data-id]') || {}).dataset ? d.querySelector('button[data-id]').dataset.id : null }))`);
        record('en No recibieron, quien tiene el numero sin WhatsApp trae Corregir telefono (con su id) y el de bloqueo temporal no', noWaRows.length === 2 && noWaRows.find((r) => /Ana/.test(r.text)).fix === true && noWaRows.find((r) => /Ana/.test(r.text)).id === 'u-ana' && /número sin WhatsApp/.test(noWaRows.find((r) => /Ana/.test(r.text)).text) && noWaRows.find((r) => /Diana/.test(r.text)).fix === false, JSON.stringify(noWaRows));
        await oikos(`hideRemRecipients()`);
        // Envio cuidadoso: un envio en espera dice por que y cuando sigue, y cuanto falta (en dias si pasa del tope)
        const tomorrow8 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString(); })();
        await panel('running', { id: 'envio-6', total: 420, pending: 300, sent: 120, waitingUntil: tomorrow8, waitingReason: 'tope' });
        const waitTope = await oikos(`document.getElementById('rem-bulk-detail').textContent`);
        record('un envio con el tope del dia lleno dice que ya salieron los 120 de hoy, cuando sigue y que faltan unos dias', /en espera: ya salieron los 120 de hoy/.test(waitTope) && /sigue solo/.test(waitTope) && /08:00/.test(waitTope) && /faltan unos 3 días/.test(waitTope), waitTope);
        await panel('running', { id: 'envio-7', total: 50, pending: 50, sent: 0, waitingUntil: tomorrow8, waitingReason: 'horario' });
        const waitHour = await oikos(`document.getElementById('rem-bulk-detail').textContent`);
        record('fuera de horario dice que espera las 8:00', /fuera del horario de envío \(8:00 a 18:00\)/.test(waitHour) && /faltan unos 34 minutos/.test(waitHour), waitHour);
        await panel('running', { id: 'envio-8', total: 50, pending: 50, sent: 0, waitingUntil: new Date(Date.now() - 60000).toISOString(), waitingReason: 'horario' });
        record('una espera que ya paso no se muestra', !/en espera/.test(await oikos(`document.getElementById('rem-bulk-detail').textContent`)), '');
        // Sin haber comprobado: pregunta a UltraMsg y luego lista
        await page.evaluate(`window.__calls.length = 0`);
        await panel('done', { id: 'envio-3', pending: 0, sent: 10 });
        await oikos(`showRemRecipients()`);
        await sleep(300);
        equal('si todavia no se comprobo, primero comprueba con UltraMsg y despues lee el listado', await page.evaluate(`window.__calls.map((c) => [c[0], c[1].campaignId])`), [['reconcile', 'envio-3'], ['recipients', 'envio-3']]);
        // Con Meta: solo se sabe a quienes acepto
        await page.evaluate(`window.__rec = [{ id: 'u-ana', name: 'Ana', casa: 'A1', phoneTail: '1111', status: 'sent', delivery: null, sentAt: '${nowIso}' }]; window.__conn = { ok: true, connected: true, state: 'connected', message: '', queue: null, channel: 'meta', templates: { mora: null, general: null }, meta: null };`);
        await oikos(`checkRemConnection()`);
        await sleep(300);
        await panel('done', { id: 'envio-4', pending: 0, sent: 1 });
        await oikos(`showRemRecipients()`);
        await sleep(300);
        const metaRec = await oikos(`({ tabs: [...document.querySelectorAll('#rem-rec-tabs button')].map((b) => b.textContent), note: document.getElementById('rem-rec-note').textContent })`);
        record('con Meta no se promete entrega: dice a quienes acepto Meta y que todavia no se sabe si llego', metaRec.tabs.includes('Aceptados por Meta (1)') && /Meta/.test(metaRec.note) && /todavía no se sabe/.test(metaRec.note), JSON.stringify(metaRec));
        await oikos(`hideRemRecipients()`);
        await page.evaluate(`window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 } }`);
        await oikos(`checkRemConnection()`);
        await sleep(300);
        // El aviso de UN residente cuenta lo que paso de verdad (no basta con que UltraMsg lo acepte)
        const outcomes = await oikos(`[{ sent: true, delivery: 'entregado' }, { sent: true, delivery: 'enviado' }, { sent: true, delivery: 'rechazado' }, { sent: true, delivery: 'en_cola' }, { sent: true, delivery: 'pendiente' }, { sent: true, delivery: null }, { sent: false }].map(remOutcome)`);
        equal('entregado y enviado son ok; rechazado es rechazado; en cola, pendiente y sin saber NO se dan por entregados', outcomes, ['ok', 'ok', 'rejected', 'unconfirmed', 'unconfirmed', 'unconfirmed', 'failed']);
        const seen = await oikos(`(async () => {
            const asked = []; const realConfirm = window.confirm; const realAlert = window.alert;
            window.confirm = (m) => { asked.push('confirm: ' + m); return /^¿Enviar este mensaje/.test(m); }; window.alert = (m) => { asked.push('alert: ' + m); };
            const r = { id: 'perla-A006', unit: 'A006', name: 'UNION', contact: '41001708' };
            const bridge = window.parent.sisdelWhatsApp; const realOne = bridge.one;
            bridge.one = async () => ({ ok: true, sent: true, delivery: 'rechazado', deliveryText: 'WhatsApp bloqueó temporalmente el número del condominio (temporary_block).' });
            await remSendOne(r, 'hola', 'varios');
            bridge.one = async () => ({ ok: true, sent: true, delivery: 'en_cola' });
            await remSendOne(r, 'hola', 'varios');
            bridge.one = realOne; window.confirm = realConfirm; window.alert = realAlert;
            return asked;
        })()`);
        record('si WhatsApp lo rechazo dice que NO llego y por que; si sigue en cola no lo da por entregado', seen.length === 4 && /NO llegó: WhatsApp bloqueó temporalmente/.test(seen[1]) && /todavía no se sabe si llegó \(sigue en la cola/.test(seen[3]), JSON.stringify(seen));
        // Numero del condominio bloqueado por WhatsApp (La Perla, 2026-11-18): Enviar de una fila ofrece Mi WhatsApp con una pregunta
        // corta (antes el cuadro mostraba el aviso largo del servidor y la pregunta quedaba cortada abajo)
        const blockedOne = await oikos(`(async () => {
            const asked = []; const opened = []; let serverCalls = 0;
            const real = { confirm: window.confirm, alert: window.alert, open: window.open, one: window.parent.sisdelWhatsApp.one, conn: remConn };
            window.confirm = (m) => { asked.push(String(m)); return true; }; window.alert = (m) => { asked.push('alert: ' + m); };
            window.open = (u) => { opened.push(String(u)); return {}; };
            window.parent.sisdelWhatsApp.one = async () => { serverCalls++; return { ok: false, error: 'WhatsApp no está dejando salir los mensajes del número del condominio: ' + 'detalle largo '.repeat(60) + 'Después use "Enviar prueba" a su propio teléfono.' }; };
            const r = { id: 'perla-A006', unit: 'A006', name: 'UNION EMPRESARIAL, S.A', contact: '4100-1708' };
            const grab = () => ({ asked: asked.splice(0), opened: opened.splice(0), serverCalls });
            const out = {};
            try {
                remConn = { connected: true, confirming: true, at: Date.now() };
                await remSendOne(r, 'hola A006', 'mora');
                out.sinSaber = grab();                                  // 1) se pregunta si se envia, el servidor lo rechaza, 2) la pregunta corta
                out.apunta = remKnownBlock();                           // el rechazo se apunta: la siguiente vez no se vuelve a preguntar al servidor
                await remSendOne(r, 'hola A006', 'mora');
                out.yaSabe = grab();
                const at = Date.now();
                out.estados = [null, { checking: true }, { connected: false, at }, { connected: true, confirming: false, at }, { connected: true, confirming: true, at }, { connected: true, confirming: null, at }, { connected: true, confirming: false, at: at - 11 * 60 * 1000 }, { connected: false }].map((c) => { remConn = c; return remKnownBlock(); });
                remConn = { connected: false, message: 'WhatsApp no está conectado (estado: standby).', at: Date.now() };
                await remSendOne(r, 'hola A006', 'mora');
                out.desconectado = grab();
                remConn = { connected: true, confirming: false, at: Date.now() };
                await remSendOne({ id: 'x', unit: 'B1', name: 'Sin telefono', contact: '123' }, 'hola', 'mora');
                out.sinTelefono = grab();
            } finally {
                window.confirm = real.confirm; window.alert = real.alert; window.open = real.open; window.parent.sisdelWhatsApp.one = real.one; remConn = real.conn;
                paintRemConnection(); paintReminderBulk();
            }
            return out;
        })()`);
        const shortAsk = (m) => typeof m === 'string' && m.length < 300 && m.startsWith('¿Abrir su WhatsApp con el mensaje para A006') && !/detalle largo/.test(m);
        record('sin saber el estado: pregunta si se envia, el servidor lo rechaza y la pregunta de Mi WhatsApp es corta (la pregunta va primero y no trae el aviso largo)',
            blockedOne.sinSaber.asked.length === 2 && /^¿Enviar este mensaje/.test(blockedOne.sinSaber.asked[0]) && shortAsk(blockedOne.sinSaber.asked[1]) && blockedOne.sinSaber.serverCalls === 1, JSON.stringify(blockedOne.sinSaber));
        record('al aceptar abre SU WhatsApp en el chat de ese residente con el mensaje ya escrito', blockedOne.sinSaber.opened.length === 1 && /^https:\/\/(web\.whatsapp\.com\/send\?phone=50241001708&text=hola%20A006|wa\.me\/50241001708\?text=hola%20A006)$/.test(blockedOne.sinSaber.opened[0]), JSON.stringify(blockedOne.sinSaber.opened));
        equal('el rechazo se apunta y el siguiente Enviar ya no le pregunta al servidor: solo la pregunta corta y se abre Mi WhatsApp', [blockedOne.apunta, blockedOne.yaSabe.asked.length, shortAsk(blockedOne.yaSabe.asked[0]), blockedOne.yaSabe.serverCalls, blockedOne.yaSabe.opened.length], ['restringido', 1, true, 1, 1]);
        equal('lo que se sabe del WhatsApp del condominio: restringido o desconectado solo si la comprobacion es de hace menos de 10 minutos', blockedOne.estados, ['', '', 'desconectado', 'restringido', '', '', '', '']);
        record('desconectado: tambien una pregunta corta, que dice que esta desconectado, sin llamar al servidor', blockedOne.desconectado.asked.length === 1 && /^¿Abrir su WhatsApp con el mensaje para A006/.test(blockedOne.desconectado.asked[0]) && /desconectado/.test(blockedOne.desconectado.asked[0]) && blockedOne.desconectado.asked[0].length < 300 && blockedOne.desconectado.serverCalls === 1 && blockedOne.desconectado.opened.length === 1, JSON.stringify(blockedOne.desconectado));
        record('un residente sin telefono que sirva: lo dice y no abre WhatsApp', blockedOne.sinTelefono.opened.length === 0 && blockedOne.sinTelefono.asked.length === 2 && /no tiene un teléfono que sirva para WhatsApp/.test(blockedOne.sinTelefono.asked[1]), JSON.stringify(blockedOne.sinTelefono));
        await oikos(`(() => { remCampaign = Object.assign({}, remCampaign, { status: 'paused', pausedAt: new Date().toISOString() }); paintReminderProgress(); })()`);
        equal('el texto del avance en pausa dice que se pulse Continuar', await oikos(`/en pausa desde .*pulse Continuar/.test(document.getElementById('rem-bulk-detail').textContent)`), true);
        await oikos(`(() => { remCampaign = null; paintReminderProgress(); paintReminderBulk(); })()`);
        // Estado del WhatsApp del condominio: UltraMsg acepta los mensajes aunque este desconectado y los deja en cola (2026-11-16)
        await oikos(`openReminders()`);
        await sleep(300);
        const wa = () => oikos(`(() => ({ texto: document.getElementById('rem-wa-status').textContent.replace(/\\s+/g, ' ').trim(), enviar: document.getElementById('rem-send-all').disabled, prueba: document.getElementById('rem-send-test').disabled }))()`);
        const connected = await wa();
        record('conectado: dice WhatsApp conectado y deja enviar', connected.texto.includes('WhatsApp conectado') && !connected.enviar && !connected.prueba, JSON.stringify(connected));
        await page.evaluate(`window.__conn = { ok: true, connected: false, state: 'standby', message: 'WhatsApp no est\u00e1 conectado (estado: standby). Abra WhatsApp en el tel\u00e9fono vinculado.', queue: { queued: 709 } }`);
        await oikos(`checkRemConnection()`);
        await sleep(300);
        const down = await wa();
        record('desconectado: avisa, dice cuantos hay en la cola de UltraMsg y no deja enviar ni mandar la prueba', down.texto.includes('WhatsApp desconectado') && down.texto.includes('estado: standby') && down.texto.includes('709 en la cola de UltraMsg') && down.enviar && down.prueba, JSON.stringify(down));
        const alerts = await oikos(`(async () => { const seen = []; const real = window.alert; window.alert = (m) => seen.push(String(m)); try { await sendReminderTest(); await sendRemindersToAll(); } finally { window.alert = real; } return seen; })()`);
        record('y aunque se fuerce el clic, el envio se detiene con el aviso (no sale nada)', alerts.length === 2 && alerts.every((m) => m.includes('no est\u00e1 conectado')) && (await page.evaluate(`window.__sent.length`)) === 2, JSON.stringify(alerts));
        await page.evaluate(`window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 } }`);
        await oikos(`checkRemConnection()`);
        await sleep(300);
        const back = await wa();
        record('al volver la conexion y revisar de nuevo, se puede enviar otra vez', back.texto.includes('WhatsApp conectado') && !back.enviar && !back.prueba, JSON.stringify(back));
        await page.evaluate(`window.__conn = { ok: true, connected: null, state: 'sin-respuesta', message: '', queue: null }`);
        await oikos(`checkRemConnection()`);
        await sleep(300);
        const unknown = await wa();
        record('si no se pudo comprobar, lo dice y deja seguir (el servidor vuelve a comprobar)', unknown.texto.includes('No se pudo comprobar') && !unknown.enviar, JSON.stringify(unknown));
        // Conectado pero con el numero restringido por WhatsApp (La Perla, 16 y 17/11/2026: los mensajes salian sin palomita)
        await page.evaluate(`window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 }, confirming: false, healthMessage: 'WhatsApp no está dejando salir los mensajes del número del condominio: los últimos 16 mensajes siguen sin una sola palomita. Después use "Enviar prueba" a su propio teléfono.' }`);
        await oikos(`checkRemConnection()`);
        await sleep(300);
        const restricted = await wa();
        record('numero restringido: lo avisa en rojo, no deja enviar a todos y SI deja la prueba (es como se sabe que ya paso)', restricted.texto.includes('no está dejando salir los mensajes: no se puede enviar') && restricted.texto.includes('16 mensajes') && restricted.enviar && !restricted.prueba, JSON.stringify(restricted));
        const sentBeforeRestricted = await page.evaluate(`window.__sent.length`);
        const restrictedAlerts = await oikos(`(async () => { const seen = []; const real = window.alert; window.alert = (m) => seen.push(String(m)); try { await sendRemindersToAll(); } finally { window.alert = real; } return seen; })()`);
        record('y aunque se fuerce el clic en Enviar a todos, se detiene con el aviso (no sale nada)', restrictedAlerts.length === 1 && restrictedAlerts[0].includes('no está dejando salir') && (await page.evaluate(`window.__sent.length`)) === sentBeforeRestricted, JSON.stringify(restrictedAlerts));
        // La prueba sale y, si llega, el aviso se quita solo
        await page.evaluate(`window.sisdelWhatsApp.test = async (d) => { window.__calls.push(['test', d]); window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 }, confirming: true, healthMessage: '' }; return { ok: true, sent: true, delivery: 'entregado', phoneTail: '1111' }; }`);
        await oikos(`(async () => { const realPrompt = window.prompt; const realAlert = window.alert; window.prompt = () => '5555-1111'; window.alert = () => {}; try { await sendReminderTest(); } finally { window.prompt = realPrompt; window.alert = realAlert; } })()`);
        await sleep(400);
        const afterTest = await wa();
        record('con el numero restringido la prueba sale y, cuando llega, el aviso se quita y se puede enviar otra vez', (await page.evaluate(`window.__calls.filter((c) => c[0] === 'test').length`)) === 1 && afterTest.texto.includes('WhatsApp conectado') && !afterTest.enviar, JSON.stringify(afterTest));
        await page.evaluate(`window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 } }`);
        await oikos(`checkRemConnection()`);
        // WhatsApp OFICIAL de Meta: el texto lo fija la plantilla aprobada y a cada residente se le mandan sus datos
        const metaConn = (templates) => `window.__conn = { ok: true, connected: true, state: 'connected', message: '', queue: null, channel: 'meta', meta: { quality: 'GREEN', number: '+502 1111 2222', name: 'La Perla' }, templates: ${JSON.stringify(templates)} }`;
        await page.evaluate(metaConn({ mora: null, general: { name: 'aviso_general', language: 'es', params: ['nombre', 'casa', 'saldo'], body: 'Hola {{1}}, casa {{2}}: debe {{3}}.' } }));
        await oikos(`setReminderMode('varios'); checkRemConnection();`);
        await sleep(300);
        const metaUi = await oikos(`(() => ({ estado: document.getElementById('rem-wa-status').textContent.replace(/\\s+/g, ' ').trim(), caja: !document.getElementById('rem-template-box').classList.contains('hidden'), editableOculto: document.getElementById('rem-msg-box').classList.contains('hidden'), info: document.getElementById('rem-template-info').textContent, vista: document.getElementById('rem-template-preview').textContent }))()`);
        record('con Meta: dice WhatsApp oficial conectado, con el numero y la calidad', /WhatsApp oficial de Meta conectado/.test(metaUi.estado) && /\+502 1111 2222/.test(metaUi.estado) && /calidad GREEN/.test(metaUi.estado), metaUi.estado);
        record('con Meta: el texto fijo de la plantilla se muestra (no editable) y dice cual es y que datos lleva', metaUi.caja && metaUi.editableOculto && /aviso_general/.test(metaUi.info) && /nombre, casa, saldo/.test(metaUi.info), JSON.stringify(metaUi));
        record('con Meta: la vista previa es la plantilla con los datos reales del primer residente', /^Hola .+, casa .+: debe Q/.test(metaUi.vista), metaUi.vista);
        const sentBefore = await page.evaluate(`window.__sent.length`);
        await oikos(`sendRemindersToAll()`);
        const metaSent = await page.evaluate(`window.__sent.slice(${sentBefore})`);
        record('con Meta cada residente va con sus datos (vars) para llenar la plantilla, y sin telefonos', metaSent.length === 1 && metaSent[0].items.length > 0 && metaSent[0].items.every((i) => i.vars && ['nombre', 'casa', 'saldo', 'cuotas', 'mora', 'condominio'].every((k) => typeof i.vars[k] === 'string') && /^Hola /.test(i.text) && !('phone' in i) && !('contact' in i)), JSON.stringify(metaSent[0] && metaSent[0].items[0]));
        await oikos(`setReminderMode('mora')`);
        const noTpl = await oikos(`document.getElementById('rem-template-info').textContent`);
        const noTplAlerts = await oikos(`(() => { const seen = []; const real = window.alert; window.alert = (m) => seen.push(String(m)); let ready; try { ready = reminderTemplateReady({ id: 'x' }); } finally { window.alert = real; } return [ready, seen]; })()`);
        record('si falta la plantilla de ese tipo de aviso (mora) lo dice y no deja enviar', /Falta la plantilla/.test(noTpl) && noTplAlerts[0] === false && noTplAlerts[1].length === 1 && /Falta la plantilla de Meta/.test(noTplAlerts[1][0]), JSON.stringify([noTpl, noTplAlerts]));
        await page.evaluate(`window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 } }`);
        await oikos(`setReminderMode('mora'); checkRemConnection();`);
        await sleep(300);
        equal('al volver a UltraMsg se ve el texto editable otra vez', await oikos(`[document.getElementById('rem-template-box').classList.contains('hidden'), document.getElementById('rem-msg-box').classList.contains('hidden')]`), [true, false]);

        // Enviar desde MI WhatsApp (pedido del usuario el 2026-11-18): se abre el chat de cada residente con el texto ya escrito y la
        // persona pulsa Enviar en su WhatsApp. Aqui window.open es de mentira: se ve que se abriria, no sale nada.
        console.log('\nRecordatorios: enviar desde mi WhatsApp (WhatsApp Web o la app del celular)');
        await oikos(`(() => {
            window.__opened = []; window.__openResult = {}; window.__realOpen = window.open;
            window.open = (u, t) => { window.__opened.push([String(u), t]); return window.__openResult; };
            window.__asked = []; window.confirm = (m) => { window.__asked.push(String(m)); return true; };
            remManual = null; openReminders(); setReminderMode('varios'); remManualSetDest('web');
            document.getElementById('rem-msg-general').value = 'Aviso de prueba para {nombre}';
            renderRemindersList('fase'); setRemFase('3');
        })()`);
        const manualUi = () => oikos(`(() => { const d = (id) => document.getElementById(id); return { label: d('rem-manual-label').textContent, start: d('rem-manual-start').disabled, run: !d('rem-manual-run').classList.contains('hidden'), title: d('rem-manual-title') ? d('rem-manual-title').textContent : '', buttons: [...d('rem-manual-run').querySelectorAll('button')].map((b) => b.textContent.trim()) }; })()`);
        const opened = () => oikos(`window.__opened.map(([u, t]) => { const q = new URL(u); return [q.origin + q.pathname, q.searchParams.get('phone'), q.searchParams.get('text'), t]; })`);
        equal('el recuadro se ve junto al envio del servidor y cuenta a los de la lista (fase 3: 2)', await manualUi(), { label: 'Enviar desde mi WhatsApp (2)', start: false, run: false, title: '', buttons: [] });
        const fase3 = await oikos(`remShownList.map((r) => [String(r.id), r.name, '502' + String(r.contact).replace(/\\D/g, ''), r.unit])`);
        await oikos(`remManualStart()`);
        const startAsk = await oikos(`window.__asked.slice(-1)[0] || ''`);
        record('al empezar pide confirmar: a quienes (fase 3), en WhatsApp Web y que sale de SU numero', /a los 2 residentes de la fase 3/.test(startAsk) && /en WhatsApp Web/.test(startAsk) && /sale desde SU WhatsApp, no desde el número del condominio/.test(startAsk) && !/restringir/.test(startAsk), startAsk);
        equal('al empezar todavia no abre nada (el navegador pide un clic para abrir otra ventana) y muestra el primero', [await opened(), await manualUi()], [[], { label: 'Enviar desde mi WhatsApp (2)', start: true, run: true, title: 'Mensaje 1 de 2', buttons: ['Abrir el chat', 'Saltar', 'Terminar'] }]);
        await oikos(`remManualOpen()`);
        const first = await opened();
        equal('Abrir el chat: WhatsApp Web con el telefono (con el 502) y el texto de ese residente, en una pestana nueva', first, [['https://web.whatsapp.com/send', fase3[0][2], `Aviso de prueba para ${fase3[0][1]}`, '_blank']]);
        equal('ya abierto ofrece Ya lo envie: siguiente y Abrir el chat de nuevo', (await manualUi()).buttons, ['Ya lo envié: siguiente', 'Abrir el chat de nuevo', 'Saltar', 'Terminar']);
        await oikos(`remManualNext()`);
        const second = await opened();
        equal('Ya lo envie: siguiente abre el chat del segundo con el mismo clic', second.slice(1), [['https://web.whatsapp.com/send', fase3[1][2], `Aviso de prueba para ${fase3[1][1]}`, '_blank']]);
        equal('el primero queda marcado en la lista y el ultimo dice terminar', [await oikos(`[...document.querySelectorAll('#reminders-list .rem-row')].map((row) => row.querySelector('.rem-manual-tag') ? row.querySelector('.rem-manual-tag').textContent : '')`), (await manualUi()).title, (await manualUi()).buttons[0]], [['Enviado desde su WhatsApp', ''], 'Mensaje 2 de 2', 'Ya lo envié: terminar']);
        await oikos(`remManualNext()`);
        const finished = await manualUi();
        equal('al terminar no abre nada mas y dice cuantos salieron de su WhatsApp', [(await opened()).length, finished.title, finished.buttons, finished.start, await oikos(`document.getElementById('rem-manual-summary').textContent.replace(/\\s+/g, ' ')`)], [2, 'Tanda terminada', ['Cerrar'], false, '2 enviados desde su WhatsApp · 0 saltados. Revise en su WhatsApp que cada mensaje tenga sus palomitas.']);
        await oikos(`remManualClose()`);
        equal('Cerrar quita el recuadro de la tanda y las marcas de la lista', [(await manualUi()).run, await oikos(`document.querySelectorAll('#reminders-list .rem-manual-tag').length`)], [false, 0]);
        // En el celular: la app de WhatsApp (wa.me). Saltar no abre el siguiente; Terminar deja dicho a quienes no se abrio
        await oikos(`(() => { window.__opened.length = 0; remManualSetDest('app'); remManualStart(); remManualOpen(); })()`);
        equal('con "App de WhatsApp" abre wa.me con el telefono y el texto', await oikos(`window.__opened.map(([u]) => u.startsWith('https://wa.me/${fase3[0][2]}?text=') && decodeURIComponent(u.split('text=')[1]) === 'Aviso de prueba para ${fase3[0][1]}')`), [true]);
        await oikos(`remManualSkip()`);
        equal('Saltar pasa al siguiente sin abrirlo', [(await opened()).length, (await manualUi()).title, (await manualUi()).buttons[0]], [1, 'Mensaje 2 de 2', 'Abrir el chat']);
        await oikos(`remManualStop()`);
        const stopped = await oikos(`document.getElementById('rem-manual-run').textContent.replace(/\\s+/g, ' ')`);
        record('Terminar antes de tiempo dice cuantos se saltaron y a quien no se le abrio el chat', /Tanda terminada antes de tiempo/.test(stopped) && /0 enviados desde su WhatsApp · 1 saltados · 1 sin abrir/.test(stopped) && stopped.includes(`Sin abrir: ${fase3[1][3]} · ${fase3[1][1]}`), stopped);
        await oikos(`remManualClose()`);
        // El navegador no deja abrir la ventana: lo dice
        const blockedOpen = await oikos(`(() => { const seen = []; const real = window.alert; window.alert = (m) => seen.push(String(m)); window.__openResult = null; try { remManualStart(); remManualOpen(); } finally { window.alert = real; window.__openResult = {}; } remManualClose(); return seen; })()`);
        record('si el navegador bloquea la ventana avisa que permita las ventanas emergentes', blockedOpen.length === 1 && /Permita las ventanas emergentes/.test(blockedOpen[0]), JSON.stringify(blockedOpen));
        // Con muchos avisa que WhatsApp puede restringir SU numero
        await oikos(`(() => { REM_MANUAL_WARN = 1; remManualStart(); REM_MANUAL_WARN = 30; remManualClose(); })()`);
        record('con muchos residentes avisa que WhatsApp puede restringir SU numero', /WhatsApp puede restringir SU número/.test(await oikos(`window.__asked.slice(-1)[0] || ''`)), '');
        // El aviso sin escribir no se manda; en Por seleccion, solo los marcados
        const withPlaceholder = await oikos(`(() => { const seen = []; const real = window.alert; window.alert = (m) => seen.push(String(m)); document.getElementById('rem-msg-general').value = 'Hola {nombre}: ' + SISDEL_REMINDER_PLACEHOLDER; try { remManualStart(); } finally { window.alert = real; } document.getElementById('rem-msg-general').value = 'Aviso de prueba para {nombre}'; return [seen.length, remManual]; })()`);
        equal('con el aviso sin escribir ([Escriba aqui el aviso]) no empieza', [withPlaceholder[0], withPlaceholder[1]], [1, null]);
        await oikos(`(() => { remSelected.clear(); renderRemindersList('seleccion'); })()`);
        equal('en Por seleccion sin marcar a nadie el boton esta apagado', [(await manualUi()).label, (await manualUi()).start], ['Enviar desde mi WhatsApp', true]);
        await oikos(`(() => { remTogglePick(${JSON.stringify(fase3[1][0])}, true); })()`);
        equal('al marcar a uno, el boton cuenta solo a ese', (await manualUi()).label, 'Enviar desde mi WhatsApp (1)');
        // Mi WhatsApp tambien en cada fila de Recordatorios, en el menu de cada residente y en el chat (pedido del usuario el 2026-11-18)
        await oikos(`(() => { remSelected.clear(); window.__opened.length = 0; remManualSetDest('web'); renderRemindersList('fase'); setRemFase('3'); })()`);
        equal('el recuadro va arriba del envio desde el servidor', await oikos(`!!(document.getElementById('rem-manual').compareDocumentPosition(document.getElementById('rem-bulk')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
        equal('cada fila con telefono trae Mi WhatsApp junto a Enviar', await oikos(`[...document.querySelectorAll('#reminders-list .rem-row')].map((row) => [...row.querySelectorAll('button')].map((b) => b.textContent.trim()))`), [['Mi WhatsApp', 'Enviar'], ['Mi WhatsApp', 'Enviar']]);
        await oikos(`document.querySelector('#reminders-list .rem-row button[onclick^="sendReminderMine("]').click()`);
        equal('Mi WhatsApp de la fila abre su WhatsApp Web con el mensaje de ese residente', await opened(), [['https://web.whatsapp.com/send', fase3[0][2], `Aviso de prueba para ${fase3[0][1]}`, '_blank']]);
        const menuMine = await oikos(`(() => {
            window.__opened.length = 0; const realSaved = reminderMessagesSaved;
            reminderMessagesSaved = () => ({ mora: 'Mora de {nombre}', general: 'General para {nombre}' });
            const r = Store.get('residents').find((x) => String(x.id) === ${JSON.stringify(fase3[1][0])});
            const mora = checkIsMoroso(r);
            try { contactMyWhatsApp(r.id); contactSetKind(mora ? 'mora' : 'general'); document.getElementById('ct-send-mine').click(); } finally { reminderMessagesSaved = realSaved; }
            return [(mora ? 'Mora de ' : 'General para ') + r.name, window.__opened.map(([u]) => [new URL(u).searchParams.get('phone'), new URL(u).searchParams.get('text')])];
        })()`);
        equal('Enviar desde mi WhatsApp del menu abre la ventana de contactar y, al elegir el aviso y enviar, abre su WhatsApp con ese texto (mora o aviso general)', menuMine[1], [[fase3[1][2], menuMine[0]]]);
        // Ventana "Contactar al residente" (pedido del usuario el 2026-11-20): elegir que enviar, escribir o cambiar el texto y elegir desde donde sale
        console.log('\nContactar al residente: ventana con aviso, estado de cuenta o mensaje propio');
        const ct = (js) => oikos(js);
        const ctRes = await ct(`(() => { const ok = Store.get('residents').filter((x) => String(x.contact || '').replace(/\\D/g, '').length >= 8); const r = ok.find((x) => checkIsMoroso(x)) || ok[0]; return { id: String(r.id), name: r.name, moroso: checkIsMoroso(r), owes: sisdelOwedOf(r).total > 0.004 }; })()`);
        const ctOpen = await ct(`(() => {
            window.__alerts2 = []; const realAlert = window.alert; window.alert = (m) => window.__alerts2.push(String(m)); window.__realAlert2 = realAlert;
            window.__opened.length = 0;
            contactWhatsApp(${JSON.stringify(ctRes.id)});
            const modal = document.getElementById('modal-contact');
            return { visible: !modal.classList.contains('hidden-section'), kinds: [...document.querySelectorAll('#ct-kinds button')].map((b) => [b.dataset.kind, b.disabled]), kind: contactState.kind, text: document.getElementById('ct-text').value, alerts: window.__alerts2.length, who: document.getElementById('ct-who').textContent, chip: document.getElementById('ct-chip').textContent };
        })()`);
        record('Contactar abre la ventana (sin cuadros de aviso) con las cuatro clases de mensaje y el texto ya armado', ctOpen.visible && ctOpen.alerts === 0 && JSON.stringify(ctOpen.kinds.map((k) => k[0])) === JSON.stringify(['mora', 'general', 'estado', 'propio']) && ctOpen.text.length > 20 && ctOpen.who.includes(ctRes.name), JSON.stringify(ctOpen).slice(0, 300));
        record('lo primero que ofrece: el aviso de morosidad a quien esta en mora; el estado de cuenta a quien debe; el aviso general a quien esta al dia', ctOpen.kind === (ctRes.moroso ? 'mora' : ctRes.owes ? 'estado' : 'general') && /debe|Al día/.test(ctOpen.chip), `${ctOpen.kind} / ${ctOpen.chip}`);
        const ctEstado = await ct(`(() => { contactSetKind('estado'); const t = document.getElementById('ct-text').value; return { text: t, len: t.length, kind: contactState.kind }; })()`);
        record('el estado de cuenta en texto trae el nombre, lo que debe o que esta al dia, el ultimo pago y cabe en 1000 caracteres', ctEstado.kind === 'estado' && /\*Estado de cuenta\*/.test(ctEstado.text) && (/\*Total que debe: Q/.test(ctEstado.text) || /Está al día/.test(ctEstado.text)) && ctEstado.len < 1000 && ctEstado.text.includes(ctRes.name), ctEstado.text.slice(0, 260));
        const ctDraft = await ct(`(() => {
            const area = document.getElementById('ct-text');
            area.value = 'Estado editado a mano'; contactTextChanged();
            const resetShown = !document.getElementById('ct-reset').classList.contains('invisible');
            contactSetKind('propio'); const propio = area.value;
            contactSetKind('estado'); const back = area.value;
            contactResetText(); const reset = area.value;
            return { resetShown, propio, back, resetDiffers: reset !== 'Estado editado a mano', resetHidden: document.getElementById('ct-reset').classList.contains('invisible') };
        })()`);
        record('lo que se edita queda por clase al cambiar de una a otra, y "Volver al texto original" lo restaura', ctDraft.resetShown && /^Estimado\(a\) /.test(ctDraft.propio) && ctDraft.back === 'Estado editado a mano' && ctDraft.resetDiffers && ctDraft.resetHidden, JSON.stringify(ctDraft));
        const ctPlaceholder = await ct(`(() => {
            const real = reminderMessagesSaved; reminderMessagesSaved = () => ({ mora: 'Mora de {nombre}', general: 'General para {nombre}: ' + SISDEL_REMINDER_PLACEHOLDER });
            let out = {};
            try {
                contactWhatsApp(${JSON.stringify(ctRes.id)}); contactSetKind('general');
                window.__opened.length = 0;
                document.getElementById('ct-send-mine').click();
                out.errorShown = !document.getElementById('ct-error').classList.contains('hidden'); out.error = document.getElementById('ct-error').textContent; out.opened = window.__opened.length;
                const area = document.getElementById('ct-text');
                area.value = area.value.replace(SISDEL_REMINDER_PLACEHOLDER, 'Reunión el sábado a las 10:00'); contactTextChanged();
                document.getElementById('ct-send-mine').click();
                out.openedAfter = window.__opened.map(([u]) => new URL(u).searchParams.get('text'));
                out.closed = document.getElementById('modal-contact').classList.contains('hidden-section') || document.getElementById('modal-contact').classList.contains('opacity-0');
            } finally { reminderMessagesSaved = real; }
            return out;
        })()`);
        record('el aviso general sin escribir se escribe ahi mismo: no se envia con el hueco, avisa en la ventana y despues sale con lo escrito', ctPlaceholder.errorShown && /Escriba el aviso donde dice/.test(ctPlaceholder.error) && ctPlaceholder.opened === 0 && ctPlaceholder.openedAfter.length === 1 && /Reunión el sábado a las 10:00/.test(ctPlaceholder.openedAfter[0]), JSON.stringify(ctPlaceholder).slice(0, 300));
        const ctPropio = await ct(`(() => {
            window.__opened.length = 0; contactWhatsApp(${JSON.stringify(ctRes.id)}); contactSetKind('propio');
            document.getElementById('ct-text').value = 'Hola, buen día'; contactTextChanged();
            document.getElementById('ct-send-mine').click();
            return window.__opened.map(([u]) => { const q = new URL(u); return [q.searchParams.get('phone'), q.searchParams.get('text')]; });
        })()`);
        record('un mensaje propio sale desde mi WhatsApp al telefono del residente', ctPropio.length === 1 && ctPropio[0][1] === 'Hola, buen día' && /^502\d{8}$/.test(ctPropio[0][0]), JSON.stringify(ctPropio));
        const ctServer = await ct(`(async () => {
            const bridge = window.parent.sisdelWhatsApp; const real = { one: bridge.one, conn: remConn, confirm: window.confirm };
            const calls = []; const asked = [];
            bridge.one = async (a) => { calls.push(a); return { ok: true, sent: true, delivery: 'entregado' }; };
            window.confirm = (m) => { asked.push(String(m)); return true; };
            remConn = { connected: true, confirming: true, at: Date.now() };
            const out = {};
            try {
                contactWhatsApp(${JSON.stringify(ctRes.id)}); contactSetKind('propio');
                document.getElementById('ct-text').value = 'Mensaje por el servidor'; contactTextChanged();
                out.enabled = !document.getElementById('ct-send-server').disabled;
                await contactSendServer();
                out.calls = calls.map((c) => [c.residentId, c.text, c.mode]); out.asked = asked.length;
                out.closed = document.getElementById('modal-contact').classList.contains('hidden-section') || document.getElementById('modal-contact').classList.contains('opacity-0');
                // El numero del condominio desconectado: el boton queda apagado y dice por que
                remConn = { connected: false, message: 'desconectado', at: Date.now() };
                contactWhatsApp(${JSON.stringify(ctRes.id)});
                out.offDisabled = document.getElementById('ct-send-server').disabled; out.offNote = document.getElementById('ct-note').textContent; out.mineEnabled = !document.getElementById('ct-send-mine').disabled;
                // Un mensaje de mas de 1000 caracteres no sale por el servidor (si por mi WhatsApp)
                remConn = { connected: true, confirming: true, at: Date.now() };
                contactWhatsApp(${JSON.stringify(ctRes.id)}); contactSetKind('propio');
                document.getElementById('ct-text').value = 'x'.repeat(1001); contactTextChanged();
                out.longDisabled = document.getElementById('ct-send-server').disabled; out.longNote = document.getElementById('ct-note').textContent;
            } finally { bridge.one = real.one; remConn = real.conn; window.confirm = real.confirm; closeModal('modal-contact'); }
            return out;
        })()`);
        record('desde el WhatsApp del condominio: el aviso va al servidor con el texto de la ventana, sin volver a preguntar, y la ventana se cierra', ctServer.enabled && JSON.stringify(ctServer.calls) === JSON.stringify([[ctRes.id, 'Mensaje por el servidor', 'varios']]) && ctServer.asked === 0 && ctServer.closed, JSON.stringify(ctServer).slice(0, 300));
        record('con el numero del condominio desconectado o con un texto de mas de 1000 caracteres, ese boton se apaga y lo explica; Mi WhatsApp sigue', ctServer.offDisabled && /desconectado/.test(ctServer.offNote) && ctServer.mineEnabled && ctServer.longDisabled && /1000 caracteres/.test(ctServer.longNote), JSON.stringify([ctServer.offNote, ctServer.longNote]));
        const ctMora = await ct(`(() => {
            const r = Store.get('residents').find((x) => String(x.contact || '').replace(/\\D/g, '').length >= 8 && !checkIsMoroso(x));
            if (!r) return null;
            contactWhatsApp(r.id);
            const card = document.querySelector('#ct-kinds button[data-kind="mora"]');
            const before = contactState.kind; contactSetKind('mora');
            return { disabled: card.disabled, kind: contactState.kind, before };
        })()`);
        record('quien no esta en mora no puede recibir el aviso de morosidad (la tarjeta esta apagada)', ctMora === null || (ctMora.disabled && ctMora.kind === ctMora.before && ctMora.kind !== 'mora'), JSON.stringify(ctMora));
        const ctStatement = await ct(`(() => { window.__realAlert2 && (window.alert = window.__realAlert2); contactWhatsApp(${JSON.stringify(ctRes.id)}); contactOpenStatement(); return { contactClosed: document.getElementById('modal-contact').classList.contains('hidden-section') || document.getElementById('modal-contact').classList.contains('opacity-0'), statementOpen: !document.getElementById('modal-estado-cuenta').classList.contains('hidden-section') }; })()`);
        record('"Ver el estado de cuenta completo" cierra la ventana y abre el estado de cuenta del residente', ctStatement.contactClosed && ctStatement.statementOpen, JSON.stringify(ctStatement));
        await ct(`(() => { closeModal('modal-estado-cuenta'); window.__opened.length = 0; })()`);
        const chatMine = await oikos(`(() => {
            window.__opened.length = 0;
            chatNewResident = Store.get('residents').find((x) => String(x.id) === ${JSON.stringify(fase3[0][0])}); chatCurrentId = null; renderChatPane();
            const input = document.getElementById('chat-input'); input.value = 'Hola desde mi WhatsApp';
            const btn = document.getElementById('chat-send-mine');
            btn.click();
            const out = [btn.textContent.trim(), window.__opened.map(([u]) => [new URL(u).searchParams.get('phone'), new URL(u).searchParams.get('text')]), input.value, input.disabled];
            chatNewResident = null; renderChatPane();
            return out;
        })()`);
        equal('el chat trae Mi WhatsApp: abre su WhatsApp con lo escrito y vacia la caja', chatMine, ['Mi WhatsApp', [[fase3[0][2], 'Hola desde mi WhatsApp']], '', false]);
        await oikos(`(() => { remSelected.clear(); remManualSetDest('web'); window.open = window.__realOpen; window.confirm = () => true; try { localStorage.removeItem('sisdel_rem_wa_destino'); } catch (e) {} })()`);
        // Con poca pantalla (o la pagina muy ampliada) la ventana se desplaza: se llega al progreso, a la lista y al boton Cerrar
        await oikos(`openReminders()`);
        const scrolling = await oikos(`(() => {
            const card = document.querySelector('#modal-reminders > div');
            const list = document.getElementById('reminders-list');
            const prev = card.style.maxHeight; card.style.maxHeight = '320px';
            const out = { overflow: getComputedStyle(card).overflowY, listShrink: getComputedStyle(list).flexShrink, scrolls: card.scrollHeight > card.clientHeight + 10 };
            card.scrollTop = card.scrollHeight;
            const box = card.getBoundingClientRect(), close = document.getElementById('btn-rem-close').getBoundingClientRect();
            out.closeReachable = close.bottom <= box.bottom + 1 && close.top >= box.top;
            card.scrollTop = 0;
            out.titleReachable = document.getElementById('title-modal-rem').getBoundingClientRect().top >= box.top;
            card.style.maxHeight = prev;
            return out;
        })()`);
        equal('con poca pantalla la ventana de Recordatorios se desplaza y se llega al boton Cerrar y de vuelta al titulo', scrolling, { overflow: 'auto', listShrink: '0', scrolls: true, closeReachable: true, titleReachable: true });
        // Lo deja como estaba
        await oikos(`(() => { Store.get = window.__origGet; window.confirm = window.__realConfirm; closeModal('modal-reminders'); try { localStorage.removeItem('sisdel_rem_modo'); } catch (e) {} })()`);
        await page.evaluate(`(() => { window.sisdelWhatsApp = window.__realWa; })()`);

        console.log('\nPagos: una boleta no se repite y se ve el saldo del residente');
        await oikos(`(() => { window.__real = { alert: window.alert, confirm: window.confirm }; window.__alerts = []; window.__confirms = []; window.__confirmAnswer = true; window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer; }; navigate('accounting'); openModal('modal-income'); })()`);
        equal('al abrir el ingreso no hay saldo ni aviso de boleta y Registrar esta encendido', await oikos(`[document.getElementById('inc-balance-box').classList.contains('hidden'), document.getElementById('inc-doc-msg').classList.contains('hidden'), document.getElementById('btn-inc-reg').disabled]`), [true, true, false]);
        const bal = await oikos(`(() => { document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); const r = Store.get('residents').find((x) => x.id === 'u-ana'); const o = sisdelOwedOf(r); return [!document.getElementById('inc-balance-box').classList.contains('hidden'), document.getElementById('inc-bal-label').textContent, document.getElementById('inc-bal-total').textContent === formatMoney(o.total), o.total > 0]; })()`);
        equal('al elegir al residente se ve lo que debe (el mismo total que en Residentes y los reportes)', bal, [true, 'Debe', true, true]);
        equal('al escribir el monto dice como quedaria', await oikos(`(() => { document.getElementById('inc-amount').value = '100'; renderIncomeBalance(); const r = Store.get('residents').find((x) => x.id === 'u-ana'); const left = Math.round((residentShownBalance(r).shown + 100) * 100) / 100; const t = document.getElementById('inc-bal-after'); return [!t.classList.contains('hidden'), t.textContent === (left < -0.004 ? 'Con este pago quedaría debiendo ' + formatMoney(-left) : left > 0.004 ? 'Con este pago queda un saldo a favor de ' + formatMoney(left) : 'Con este pago queda al día')]; })()`), [true, true]);
        equal('Poner el total llena el monto con todo lo que debe y la nota dice que queda al dia', await oikos(`(() => { document.getElementById('inc-bal-fill').click(); const r = Store.get('residents').find((x) => x.id === 'u-ana'); return [document.getElementById('inc-amount').value === sisdelOwedOf(r).total.toFixed(2), document.getElementById('inc-bal-after').textContent]; })()`), [true, 'Con este pago queda al día']);
        equal('la boleta se compara sin importar mayusculas, espacios, guiones ni ceros a la izquierda', await oikos(`[normDocNum('B-123'), normDocNum('b 123'), normDocNum('0123'), normDocNum('00'), normDocNum('')]`), ['B123', 'B123', '123', '0', '']);
        // Un pago con su boleta
        const payWith = (resident, doc, amount) => `(() => { openModal('modal-income'); document.getElementById('inc-resident').value = '${resident}'; updateIncomeConcepts(); document.getElementById('inc-concept-type').value = 'custom'; handleIncomeConceptChange(); document.getElementById('inc-concept-custom').value = 'Pago de prueba'; document.getElementById('inc-amount').value = '${amount}'; document.getElementById('inc-receipt-num').value = '${doc}'; checkIncomeDoc(); handleTransactionSubmit({ preventDefault() {} }, 'income'); })()`;
        const paymentsNow = () => oikos(`Store.get('transactions').filter((t) => t.type === 'income').length`);
        const p0 = await paymentsNow();
        await oikos(payWith('u-maria', 'BOL-77', 40));
        equal('una boleta nueva se registra', [await paymentsNow(), await oikos(`Store.get('transactions').some((t) => t.type === 'income' && t.docNum === 'BOL-77' && t.amount === 40)`)], [p0 + 1, true]);
        const dupShown = await oikos(`(() => { openModal('modal-income'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); document.getElementById('inc-receipt-num').value = ' bol 77 '; checkIncomeDoc(); const m = document.getElementById('inc-doc-msg'); return [!m.classList.contains('hidden'), m.textContent, document.getElementById('btn-inc-reg').disabled]; })()`);
        record('la misma boleta (escrita distinto) avisa quien la tiene y apaga Registrar', dupShown[0] && dupShown[1].includes('Esta boleta ya está registrada') && dupShown[1].includes('Q40.00') && dupShown[2] === true, JSON.stringify(dupShown));
        await oikos(`(() => { window.__alerts.length = 0; document.getElementById('inc-concept-type').value = 'custom'; handleIncomeConceptChange(); document.getElementById('inc-concept-custom').value = 'Otro pago'; document.getElementById('inc-amount').value = '15'; handleTransactionSubmit({ preventDefault() {} }, 'income'); })()`);
        equal('al guardar con una boleta repetida no se crea nada y avisa', [await paymentsNow(), (await oikos(`window.__alerts`)).some((m) => m.includes('Esta boleta ya está registrada'))], [p0 + 1, true]);
        equal('la boleta de un pago anulado se puede registrar otra vez', await oikos(`findDuplicateDoc('TRF-0001') === null`), true);
        await oikos(payWith('u-ana', 'BOL-78', 25));
        equal('otra boleta del mismo residente se registra y el boton Registrar queda apagado hasta abrir el formulario', [await paymentsNow(), await oikos(`document.getElementById('btn-inc-reg').disabled`)], [p0 + 2, true]);
        // Un doble clic (mismo residente y monto, sin boleta) pide confirmar
        await oikos(`(() => { window.__confirms.length = 0; window.__confirmAnswer = false; document.getElementById('inc-receipt-num').value = ''; handleTransactionSubmit({ preventDefault() {} }, 'income'); })()`);
        equal('un pago igual de hace un momento pide confirmar y, si se dice que no, no se registra', [await paymentsNow(), (await oikos(`window.__confirms`)).length === 1 && (await oikos(`window.__confirms[0]`)).includes('Ya se registró un pago de Q25.00')], [p0 + 2, true]);
        await oikos(`(() => { window.__confirmAnswer = true; handleTransactionSubmit({ preventDefault() {} }, 'income'); })()`);
        equal('si se confirma, se registra', await paymentsNow(), p0 + 3);
        equal('al abrir el formulario otra vez el boton Registrar vuelve a estar encendido y no hay saldo ni aviso', await oikos(`(() => { openModal('modal-income'); return [document.getElementById('btn-inc-reg').disabled, document.getElementById('inc-balance-box').classList.contains('hidden'), document.getElementById('inc-doc-msg').classList.contains('hidden')]; })()`), [false, true, true]);
        await oikos(`(() => { closeModal('modal-income'); closeModal('modal-voucher-options'); window.alert = window.__real.alert; window.confirm = window.__real.confirm; })()`);
        await idle();

        console.log('\nEstado de cuenta desde el pago (boton del Ingreso y bloque del comprobante)');
        await oikos(`(() => { window.__real = { alert: window.alert, open: window.open, jsPdfSave: window.jspdf && window.jspdf.jsPDF.API.save }; window.__alerts = []; window.__opened = []; window.alert = (m) => { window.__alerts.push(String(m)); }; window.open = (u) => { window.__opened.push(String(u)); return { document: { write(h) { window.__printed = h; }, close() {} }, focus() {}, print() {} }; }; navigate('accounting'); openModal('modal-income'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); })()`);
        const ecShown = (id) => `(() => { const el = document.getElementById('${id}'); return !!el && !el.closest('.hidden') && !el.closest('.hidden-section') && getComputedStyle(el).display !== 'none'; })()`;
        equal('al elegir al residente se ve el boton Estado de cuenta junto al saldo, con su menu cerrado', [await oikos(ecShown('inc-ec-btn')), await oikos(ecShown('inc-ec-menu'))], [true, false]);
        equal('el boton abre el menu con Mostrar, Enviar por WhatsApp, Imprimir y Descargar PDF', await oikos(`(() => { document.getElementById('inc-ec-btn').click(); const m = document.getElementById('inc-ec-menu'); return [!m.classList.contains('hidden'), document.getElementById('inc-ec-btn').getAttribute('aria-expanded'), [...m.querySelectorAll('button')].map((b) => b.textContent.trim())]; })()`), [true, 'true', ['Mostrar estado de cuenta', 'Enviar por WhatsApp', 'Imprimir', 'Descargar PDF']]);
        equal('el menu queda dentro de la pantalla (no se corta a la derecha ni abajo)', await oikos(`(() => { const r = document.getElementById('inc-ec-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`), true);
        equal('un clic fuera del menu lo cierra, y Escape tambien', await oikos(`(() => { document.getElementById('inc-bal-total').click(); const a = document.getElementById('inc-ec-menu').classList.contains('hidden'); document.getElementById('inc-ec-btn').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return [a, document.getElementById('inc-ec-menu').classList.contains('hidden'), document.getElementById('inc-ec-btn').getAttribute('aria-expanded'), !document.getElementById('modal-income').classList.contains('hidden-section')]; })()`), [true, true, 'false', true]);
        const waQuick = await oikos(`(() => { window.__opened.length = 0; document.getElementById('inc-ec-btn').click(); document.querySelector('#inc-ec-menu button[onclick="ecQuickWhatsApp(\\'inc\\')"]').click(); return [window.__opened[0] || '', document.getElementById('inc-ec-menu').classList.contains('hidden'), document.getElementById('modal-estado-cuenta').classList.contains('hidden-section'), !document.getElementById('modal-income').classList.contains('hidden-section'), ecResidentId]; })()`);
        const waQuickText = decodeURIComponent(String(waQuick[0]).split('text=')[1] || '');
        record('Enviar por WhatsApp abre WhatsApp con el estado de cuenta del residente elegido, sin salir del pago', /wa\.me/.test(waQuick[0]) && /ESTADO DE CUENTA|Estado de cuenta/i.test(waQuickText) && waQuickText.includes('Ana') && waQuick[1] && waQuick[2] && waQuick[3] && waQuick[4] === 'u-ana', JSON.stringify([waQuick.slice(1), waQuickText.slice(0, 120)]));
        const printedQuick = await oikos(`(() => { window.__printed = ''; ecQuickPrint('inc'); return [window.__printed, document.getElementById('ec-date-from').value === new Date().getFullYear() + '-01-01']; })()`);
        record('Imprimir abre la impresion del estado de cuenta: solo las cuotas pendientes y lo que debe hoy', /ESTADO DE CUENTA/.test(printedQuick[0]) && printedQuick[0].includes('Ana') && printedQuick[0].includes('Cuotas pendientes de pago al') && !/Movimientos del per/.test(printedQuick[0]) && printedQuick[1], String(printedQuick[0]).slice(0, 120));
        const pdfQuick = await oikos(`(() => { const api = window.jspdf.jsPDF.API; let out = { pages: 0, name: '' }; api.save = function (n) { out = { pages: this.getNumberOfPages(), name: n }; return this; }; ecQuickPDF('inc'); return out; })()`);
        record('Descargar PDF genera el PDF del estado de cuenta del residente', pdfQuick.pages >= 1 && /^Estado_Cuenta_/.test(pdfQuick.name), JSON.stringify(pdfQuick));
        const viewQuick = await oikos(`(() => { ecQuickView('inc'); const ec = document.getElementById('modal-estado-cuenta'); return [!ec.classList.contains('hidden-section'), document.getElementById('ec-resident-info').textContent.includes('Ana'), !document.getElementById('modal-income').classList.contains('hidden-section')]; })()`);
        equal('Mostrar abre la ventana Estado de cuenta encima del pago, sin cerrarlo', viewQuick, [true, true, true]);
        await sleep(350);
        equal('la ventana Estado de cuenta queda encima del pago (es la que recibe los clics)', await oikos(`(() => { const box = document.querySelector('#modal-estado-cuenta > div').getBoundingClientRect(); const at = document.elementFromPoint(box.left + box.width / 2, box.top + 40); return !!at && !!at.closest('#modal-estado-cuenta'); })()`), true);
        equal('al cerrar el estado de cuenta el pago sigue como estaba (el mismo residente elegido)', await oikos(`(() => { closeModal('modal-estado-cuenta'); return [document.getElementById('inc-resident').value, !document.getElementById('modal-income').classList.contains('hidden-section')]; })()`), ['u-ana', true]);
        equal('sin residente elegido no se envia nada y pide elegirlo', await oikos(`(() => { openModal('modal-income'); window.__alerts.length = 0; window.__opened.length = 0; ecQuickWhatsApp('inc'); return [window.__opened.length, window.__alerts[0] || '']; })()`), [0, 'Elija primero al residente.']);
        // El comprobante que sale al registrar el pago ofrece el estado de cuenta ya con ese pago
        await oikos(`(() => { document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); document.getElementById('inc-concept-type').value = 'custom'; handleIncomeConceptChange(); document.getElementById('inc-concept-custom').value = 'Pago con estado de cuenta'; document.getElementById('inc-amount').value = '12.34'; document.getElementById('inc-receipt-num').value = 'EC-QUICK-1'; checkIncomeDoc(); handleTransactionSubmit({ preventDefault() {} }, 'income'); })()`);
        await sleep(500);
        equal('el comprobante del pago muestra el bloque del estado de cuenta con el residente', [await oikos(ecShown('voucher-ec')), await oikos(`document.getElementById('voucher-ec-who').textContent.includes('Ana')`)], [true, true]);
        // Sale la vista Cuotas pendientes: lo que debe DESPUES de este pago (el total de Residentes, que ya lo descuenta)
        const waVoucher = await oikos(`(() => { window.__opened.length = 0; ecQuickWhatsApp('voucher'); const owed = sisdelOwedOf(Store.get('residents').find((r) => r.id === 'u-ana')).total; return [window.__opened[0] || '', ecResidentId, !document.getElementById('modal-voucher-options').classList.contains('hidden-section'), formatMoney(owed), ecView]; })()`);
        record('desde el comprobante, WhatsApp manda lo que debe ya con ese pago (cuotas pendientes), y el comprobante sigue abierto', /wa\.me/.test(waVoucher[0]) && decodeURIComponent(String(waVoucher[0])).includes('TOTAL QUE DEBE: *' + waVoucher[3] + '*') && waVoucher[1] === 'u-ana' && waVoucher[2] && waVoucher[4] === 'pending', JSON.stringify([waVoucher.slice(1), decodeURIComponent(String(waVoucher[0])).slice(0, 400)]));
        equal('desde el comprobante, Mostrar cierra el comprobante y abre el estado de cuenta', await oikos(`(() => { ecQuickView('voucher'); return [document.getElementById('modal-voucher-options').classList.contains('hidden-section') || document.getElementById('modal-voucher-options').classList.contains('opacity-0'), !document.getElementById('modal-estado-cuenta').classList.contains('hidden-section')]; })()`), [true, true]);
        await oikos(`closeModal('modal-estado-cuenta')`);
        equal('el comprobante de un egreso no ofrece estado de cuenta', await oikos(`(() => { const realGet = Store.get; Store.get = (k) => (k === 'transactions' ? realGet(k).concat([{ id: 'egreso-de-prueba', type: 'expense', concept: 'Reparaciones', amount: 10, date: new Date().toISOString() }]) : realGet(k)); try { openVoucherOptions('egreso-de-prueba'); return [!document.getElementById('modal-voucher-options').classList.contains('hidden-section'), document.getElementById('voucher-ec').classList.contains('hidden')]; } finally { Store.get = realGet; } })()`), [true, true]);
        await oikos(`(() => { closeModal('modal-voucher-options'); closeModal('modal-income'); window.alert = window.__real.alert; window.open = window.__real.open; if (window.__real.jsPdfSave) window.jspdf.jsPDF.API.save = window.__real.jsPdfSave; })()`);
        await idle();

        console.log('\nPrivilegios de gerente: la fecha del pago');
        await oikos(`(() => { window.__real = { alert: window.alert }; window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); }; navigate('accounting'); openModal('modal-income'); })()`);
        const todayKey = await oikos(`localDayKey(new Date())`);
        equal('el administrador ve la fecha del pago, en hoy y sin poder pasar de hoy', await oikos(`(() => { const el = document.getElementById('inc-date'); return [getComputedStyle(document.getElementById('inc-date-wrap')).display !== 'none', el.value, el.max]; })()`), [true, todayKey, todayKey]);
        const threeDaysAgo = await oikos(`localDayKey(new Date(Date.now() - 3 * 86400000))`);
        const dateHint = await oikos(`(() => { document.getElementById('inc-resident').value = 'u-maria'; updateIncomeConcepts(); document.getElementById('inc-concept-type').value = 'custom'; handleIncomeConceptChange(); document.getElementById('inc-concept-custom').value = 'Pago con fecha cambiada'; document.getElementById('inc-amount').value = '33'; document.getElementById('inc-receipt-num').value = 'FECHA-1'; document.getElementById('inc-date').value = '${threeDaysAgo}'; checkIncomeDate(); const m = document.getElementById('inc-date-msg'); return [!m.classList.contains('hidden'), m.textContent]; })()`);
        record('al elegir otro dia avisa que la mora se calcula hasta ese dia', dateHint[0] && /quedará con fecha/.test(dateHint[1]) && /mora/.test(dateHint[1]), JSON.stringify(dateHint));
        await oikos(`handleTransactionSubmit({ preventDefault() {} }, 'income')`);
        const backTx = await oikos(`(() => { const t = Store.get('transactions').find((x) => x.docNum === 'FECHA-1'); return t ? { id: t.id, date: t.date, day: localDayKey(t.date), hour: new Date(t.date).getHours(), created: localDayKey(t.created_at), changed: txDateChanged(t) } : null; })()`);
        equal('el pago queda con esa fecha (a mediodia), registrado hoy', backTx && [backTx.day, backTx.hour, backTx.created, backTx.changed], [threeDaysAgo, 12, todayKey, true]);
        equal('se guarda en la nube (el administrador puede cambiar la fecha)', await idle(), 'ok');
        equal('la nube tiene la fecha elegida', backTx && ((await txRef(backTx.id).get()).data() || {}).date, backTx && backTx.date);
        equal('el detalle del movimiento dice que la fecha se cambio al registrarlo', await oikos(`(() => { closeModal('modal-voucher-options'); openTxDetail(${JSON.stringify(backTx && backTx.id)}); return document.getElementById('tx-detail-body').textContent.includes('Fecha del pago cambiada al registrarlo'); })()`), true);
        const paysBefore = await oikos(`Store.get('transactions').filter((t) => t.type === 'income').length`);
        const future = await oikos(`(() => { closeModal('modal-tx-detail'); window.__alerts.length = 0; openModal('modal-income'); document.getElementById('inc-resident').value = 'u-maria'; updateIncomeConcepts(); document.getElementById('inc-concept-type').value = 'custom'; handleIncomeConceptChange(); document.getElementById('inc-concept-custom').value = 'Pago a futuro'; document.getElementById('inc-amount').value = '7'; document.getElementById('inc-date').value = localDayKey(new Date(Date.now() + 2 * 86400000)); handleTransactionSubmit({ preventDefault() {} }, 'income'); return [Store.get('transactions').filter((t) => t.type === 'income').length, window.__alerts[0] || '']; })()`);
        equal('una fecha posterior a hoy no se registra y avisa', future, [paysBefore, 'La fecha del pago no puede ser posterior a hoy.']);
        const todayTx = await oikos(`(() => { document.getElementById('inc-date').value = localDayKey(new Date()); document.getElementById('inc-receipt-num').value = 'FECHA-HOY'; handleTransactionSubmit({ preventDefault() {} }, 'income'); const t = Store.get('transactions').find((x) => x.docNum === 'FECHA-HOY'); return t ? [txDateChanged(t), Math.abs(Date.parse(t.date) - Date.parse(t.created_at)) < 60000] : null; })()`);
        equal('con la fecha de hoy queda la hora exacta del registro (no se marca como cambiada)', todayTx, [false, true]);
        await oikos(`(() => { closeModal('modal-income'); closeModal('modal-voucher-options'); window.alert = window.__real.alert; })()`);
        await idle();

        // ───────── Saldo a favor (pedido del usuario el 2026-11-18) ─────────
        console.log('\nPagos: un pago de mas queda a favor y se aplica solo a las proximas cuotas');
        await oikos(`(() => { window.__real = { alert: window.alert, confirm: window.confirm }; window.alert = () => {}; window.confirm = () => true; navigate('accounting'); openModal('modal-income'); document.getElementById('inc-resident').value = 'u-maria'; updateIncomeConcepts(); })()`);
        // Maria paga lo que debe mas dos cuotas y Q 50: le quedan dos cuotas y Q 50 a favor
        const over = await oikos(`(() => {
            const r = Store.get('residents').find((x) => x.id === 'u-maria');
            const fee = SisdelCuotas.residentFee(Store.get('settings'), r);
            const shown = residentShownBalance(r).shown;
            const target = 2 * fee + 50;
            const amount = Math.round((target - shown) * 100) / 100;
            document.getElementById('inc-concept-type').value = 'custom'; handleIncomeConceptChange(); document.getElementById('inc-concept-custom').value = 'Pago adelantado';
            document.getElementById('inc-amount').value = amount.toFixed(2); renderIncomeBalance();
            const first = creditFirstPeriod(r);
            const cover = document.getElementById('inc-bal-cover');
            const R = SisdelReportesOikos;
            return { fee, target, amount, first, cur: currentFeePeriod(), after: document.getElementById('inc-bal-after').textContent, afterOk: document.getElementById('inc-bal-after').textContent === 'Con este pago queda un saldo a favor de ' + formatMoney(target),
                cover: cover.textContent, hidden: cover.classList.contains('hidden'),
                expected: 'Se aplica solo a las próximas cuotas: cubre las cuotas de ' + R.monthLong(first) + ' y ' + R.monthLong(R.addMonths(first, 1)) + ', y ' + formatMoney(50) + ' de la de ' + R.monthLong(R.addMonths(first, 2)) + '.',
                until: 'a favor · hasta ' + R.periodLabel(R.addMonths(first, 1)) };
        })()`);
        record('la cuota del lote de la prueba es mayor que cero (si no, no hay meses que cubrir)', over.fee > 0, JSON.stringify(over));
        record('al escribir un monto mayor que lo que debe, dice el saldo a favor que queda y a que meses llega', over.afterOk && !over.hidden && over.cover === over.expected, JSON.stringify(over));
        record('el primer mes es el que sigue a la ultima cuota cargada, nunca antes del mes en curso', over.first >= over.cur, JSON.stringify([over.first, over.cur]));
        const incBefore = await paymentsNow();
        await oikos(`handleTransactionSubmit({ preventDefault() {} }, 'income')`);
        await sleep(500);
        const saved = await oikos(`(() => { const tx = Store.get('transactions').filter((t) => t.type === 'income' && t.resiId === 'u-maria').pop(); return { creditAfter: tx.creditAfter, creditNote: tx.creditNote, id: tx.id, subtitle: document.getElementById('voucher-opts-subtitle').textContent }; })()`);
        equal('el pago se registra y anota el saldo a favor que dejo y a que meses llega (lo que dice el comprobante)', [await paymentsNow(), saved.creditAfter, saved.creditNote], [incBefore + 1, over.target, over.expected]);
        record('las opciones del comprobante dicen que deja saldo a favor', saved.subtitle.includes('deja un saldo a favor de'), saved.subtitle);
        const voucher = await oikos(`(() => { const b = _buildVoucherPdf(${JSON.stringify(saved.id)}); const raw = b.doc.output(); return { text: raw.includes('Saldo a favor despu'), cover: raw.includes('Se aplica solo a las pr'), h: Math.round(b.doc.internal.pageSize.getHeight()), w: Math.round(b.doc.internal.pageSize.getWidth()) }; })()`);
        record('el comprobante en PDF dice el saldo a favor y a que meses llega, con la hoja de 148 de ancho y mas alta', voucher.text && voucher.cover && voucher.w === 148 && voucher.h > 115, JSON.stringify(voucher));
        const tall = await oikos(`(() => { const id = ${JSON.stringify(saved.id)}; const realGet = Store.get; Store.get = (k) => { const v = realGet(k); if (k === 'transactions') { const t = v.find((x) => x.id === id); if (t) t.alloc = { maintenance: 1, water: 1, garbage: 1, electricity: 1, other: 1, fee: 1, extra: 1, mora: 1 }; } return v; }; let b; try { b = _buildVoucherPdf(id); } finally { Store.get = realGet; } return [Math.round(b.doc.internal.pageSize.getWidth()), Math.round(b.doc.internal.pageSize.getHeight()) > 148, b.doc.output().includes('Aplicado a:')]; })()`);
        equal('con muchas lineas (Aplicado a y saldo a favor) la hoja pasa a vertical y sigue midiendo 148 de ancho (no se corta abajo)', tall, [148, true, true]);
        await oikos(`closeModal('modal-voucher-options')`);
        const creditDetail = await oikos(`(() => { openTxDetail(${JSON.stringify(saved.id)}); const el = document.querySelector('#tx-detail-body .tx-credit-note'); const t = el ? el.textContent : ''; closeModal('modal-tx-detail'); return t; })()`);
        record('el detalle del movimiento dice el saldo a favor que dejo', creditDetail.includes('Dejó un saldo a favor de') && creditDetail.includes(over.expected), creditDetail);
        await idle();
        const listLine = await oikos(`(() => { navigate('residents'); const s = document.getElementById('res-search'); if (s) { s.value = ''; resSearchChanged(); } resTypeChanged(''); renderResidents(); const row = [...document.querySelectorAll('#residents-table-body tr')].find((tr) => tr.innerHTML.includes("openEstadoCuenta('u-maria')")); const el = row && row.querySelector('.resident-credit'); return el ? [el.textContent, el.title] : null; })()`);
        equal('la lista de Residentes dice hasta que mes cubre el saldo a favor (y el detalle al pasar el mouse)', listLine, [over.until, over.expected]);
        const ec = await oikos(`(() => { openEstadoCuenta('u-maria'); const box = document.getElementById('ec-credit-cover'); const out = [!box.classList.contains('hidden'), document.getElementById('ec-credit-amount').textContent === formatMoney(${over.target}), document.getElementById('ec-credit-text').textContent]; const model = ecReportModel(true); out.push((model.kpis || []).some((k) => k.label === 'Aplicación del saldo a favor' && k.value === document.getElementById('ec-credit-text').textContent)); return out; })()`);
        equal('el estado de cuenta muestra el saldo a favor y a que meses llega, y lo lleva a Excel y WhatsApp', ec, [true, true, over.expected, true]);
        const alDia = await oikos(`(() => { openEstadoCuenta('u-maria'); const m = ecDueModel(true); return [document.getElementById('ec-due-total-label').textContent, !document.getElementById('ec-due-empty').classList.contains('hidden'), document.getElementById('ec-due-wrap').classList.contains('hidden'), m.kpis.some((k) => k.label === 'Aplicación del saldo a favor')]; })()`);
        equal('con saldo a favor: Cuotas pendientes dice Al dia, que no tiene cuotas pendientes y a que meses llega lo que pago de mas', alDia, ['Al día', true, true, true]);
        const noCredit = await oikos(`(() => { openEstadoCuenta('u-ana'); const hidden = document.getElementById('ec-credit-cover').classList.contains('hidden'); const r = Store.get('residents').find((x) => x.id === 'u-ana'); return [hidden, residentShownBalance(r).shown > 0.004]; })()`);
        equal('quien no tiene saldo a favor no ve el recuadro', noCredit[0], !noCredit[1]);
        await oikos(`(() => { closeModal('modal-estado-cuenta'); window.alert = window.__real.alert; window.confirm = window.__real.confirm; })()`);
        await idle();

        console.log('\nClave del residente bajo el nombre (solo con el privilegio de ver codigos)');
        const anaCode = (await db.collection('codigos').where('userId', '==', 'u-ana').get()).docs[0].id;
        await oikos(`(() => { navigate('residents'); const s = document.getElementById('res-search'); if (s) { s.value = ''; resSearchChanged(); } resTypeChanged(''); renderResidents(); })()`);
        await idle();
        const clave = await oikos(`(() => { const row = [...document.querySelectorAll('#residents-table-body tr')].find((tr) => tr.innerHTML.includes("openEstadoCuenta('u-ana')")); const line = row && row.querySelector('.resident-code'); const name = row && row.querySelector('td:nth-child(2) button'); if (!line || !name) return null; const cs = getComputedStyle(line), ns = getComputedStyle(name); return { text: line.textContent.replace(/\\s+/g, ' ').trim(), code: line.querySelector('.select-all').textContent, size: parseFloat(cs.fontSize), nameSize: parseFloat(ns.fontSize), color: cs.color, below: line.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1 }; })()`);
        record('el administrador ve la clave de Ana bajo su nombre', !!clave && clave.text === 'Clave: ' + clave.code && clave.below, JSON.stringify(clave));
        record('la clave que se ve es la de la base de datos', !!clave && clave.code === anaCode, JSON.stringify([clave && clave.code, anaCode]));
        record('su letra es un 25 % mas pequena que la del nombre', !!clave && Math.abs(clave.size - clave.nameSize * 0.75) < 0.6, JSON.stringify(clave));
        const celeste = (clave && clave.color.match(/\d+/g) || []).map(Number);
        record('y es de color celeste (mas azul que rojo)', celeste.length >= 3 && celeste[2] > celeste[0] + 40 && celeste[2] >= 200, JSON.stringify(clave && clave.color));
        equal('todos los residentes con codigo muestran su clave', await oikos(`(() => { const rows = [...document.querySelectorAll('#residents-table-body tr')]; return rows.length > 0 && rows.every((tr) => tr.querySelector('.resident-code')); })()`), true);
        // Sin el puente (quien no puede ver codigos) no se pinta nada
        await oikos(`(() => { window.__codes = window.sisdelResidentCodes; window.sisdelResidentCodes = null; renderResidents(); })()`);
        equal('sin la clave disponible no sale la linea ni queda un hueco', await oikos(`document.querySelectorAll('#residents-table-body .resident-code').length`), 0);
        await oikos(`(() => { window.sisdelResidentCodes = window.__codes; renderResidents(); })()`);
        equal('al volver la clave, vuelve a salir', await oikos(`document.querySelectorAll('#residents-table-body .resident-code').length > 0`), true);
        console.log('\nPagos: detalle por concepto (de lo que debe, cuanto es de cada concepto, y el pago dirigido)');
        await oikos(`(() => { window.__real = { alert: window.alert, confirm: window.confirm }; window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = () => true; navigate('accounting'); openModal('modal-income'); })()`);
        const tabsState = () => oikos(`[document.getElementById('inc-pane-pago').classList.contains('hidden'), document.getElementById('inc-pane-detalle').classList.contains('hidden'), document.getElementById('inc-tab-pago').getAttribute('aria-selected'), document.getElementById('inc-tab-detalle').getAttribute('aria-selected')]`);
        equal('el ingreso abre en la pestana Pago y el Detalle esta oculto', await tabsState(), [false, true, 'true', 'false']);
        await oikos(`setIncTab('detalle')`);
        equal('sin residente, el Detalle pide elegir uno', [await tabsState(), await oikos(`document.getElementById('inc-alloc-empty').textContent`)], [[true, false, 'false', 'true'], 'Elija un residente para ver lo que debe, por concepto.']);
        // Con un residente: la tabla suma lo mismo que la caja "Debe"
        await oikos(`(() => { setIncTab('pago'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); setIncTab('detalle'); })()`);
        const detail = await oikos(`(() => {
            const r = Store.get('residents').find((x) => x.id === 'u-ana'); const o = sisdelOwedOf(r);
            const rows = [...document.querySelectorAll('#inc-alloc-rows tr')].map((tr) => ({ label: tr.cells[0].textContent.trim(), owed: tr.cells[1].textContent.trim(), input: !!tr.querySelector('input') }));
            return { rows, total: document.getElementById('inc-alloc-owed').textContent, box: formatMoney(o.total), sum: document.getElementById('inc-alloc-sum').textContent, mode: document.getElementById('inc-alloc-mode').textContent, hasMora: o.mora > 0 };
        })()`);
        record('el Detalle trae una fila por concepto que se debe, y su total es el de la caja Debe', detail.rows.length >= 1 && detail.total === detail.box, JSON.stringify(detail));
        record('cada concepto se puede pagar (hay casilla) salvo el ajuste de cuotas por venir', detail.rows.every((row) => row.input || row.label === 'Cuotas de meses por venir y otros'), JSON.stringify(detail.rows));
        equal('sin monto, la columna Pagar esta en cero y el reparto es automatico', [detail.sum, detail.mode], ['Q0.00', 'Reparto automático']);
        // El monto escrito en la pestana Pago se reparte solo y la columna Pagar lo muestra
        const auto = await oikos(`(() => {
            const r = Store.get('residents').find((x) => x.id === 'u-ana');
            const amt = Math.max(1, Math.min(100, Math.floor(sisdelOwedOf(r).total / 2)));
            document.getElementById('inc-amount').value = String(amt); renderIncomeBalance();
            const pv = SisdelMora.previewPayment(r.id, Store.get('transactions').filter((t) => String(t.resiId) === 'u-ana'), Store.get('settings'), amt, localDayKey(new Date()));
            const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
            const shown = sorted(Object.fromEntries([...document.querySelectorAll('#inc-alloc-rows input')].filter((i) => i.value).map((i) => [i.dataset.key, parseFloat(i.value)])));
            const expected = sorted(Object.assign({}, pv.parts, pv.mora > 0 ? { mora: pv.mora } : {}));
            return { shown, expected, sum: document.getElementById('inc-alloc-sum').textContent, want: formatMoney(amt), mode: document.getElementById('inc-alloc-mode').textContent, manual: incAlloc.manual };
        })()`);
        equal('con un monto escrito, la columna Pagar muestra como lo aplica el motor y suma ese monto', [auto.shown, auto.sum, auto.mode, auto.manual], [auto.expected, auto.want, 'Reparto automático', false]);
        // Anotar a mano: la primera casilla (hasta lo que debe) y la segunda
        const manual = await oikos(`(() => {
            const inputs = [...document.querySelectorAll('#inc-alloc-rows input')];
            const first = inputs[0], owed = parseFloat(first.max);
            first.value = String(Math.min(30, owed)); incAllocInput(first);
            const afterFirst = [document.getElementById('inc-amount').value, incAlloc.manual, document.getElementById('inc-alloc-mode').textContent];
            let afterSecond = null;
            if (inputs[1]) { inputs[1].value = String(Math.min(10, parseFloat(inputs[1].max))); incAllocInput(inputs[1]); afterSecond = document.getElementById('inc-amount').value; }
            return { afterFirst, afterSecond, firstKey: first.dataset.key, secondKey: inputs[1] ? inputs[1].dataset.key : null, firstVal: first.value, hint: !document.getElementById('inc-amount-hint').classList.contains('hidden') };
        })()`);
        equal('anotar una casilla pasa al reparto manual y el monto del pago es la suma', [manual.afterFirst, manual.hint], [[Number(manual.firstVal).toFixed(2), true, 'Reparto anotado por usted'], true]);
        if (manual.secondKey) equal('con dos casillas el monto es la suma de las dos', manual.afterSecond, (Number(manual.firstVal) + Math.min(10, Number(await oikos(`document.querySelector('#inc-alloc-rows input[data-key="${manual.secondKey}"]').max`)))).toFixed(2));
        // Una casilla no pasa de lo que se debe de ese concepto
        const clamp = await oikos(`(() => { const el = document.querySelector('#inc-alloc-rows input'); const max = parseFloat(el.max); el.value = String(max + 999); incAllocInput(el); return [parseFloat(el.value) === max, document.getElementById('inc-amount').value === (max + (parseFloat((document.querySelectorAll('#inc-alloc-rows input')[1] || {}).value) || 0)).toFixed(2)]; })()`);
        equal('una casilla no pasa de lo que se debe de ese concepto', clamp, [true, true]);
        // Cambiar el monto en la pestana Pago vuelve al reparto automatico
        const backAuto = await oikos(`(() => { document.getElementById('inc-amount').value = '1'; renderIncomeBalance(); return [incAlloc.manual, document.getElementById('inc-alloc-mode').textContent, document.getElementById('inc-alloc-sum').textContent]; })()`);
        equal('escribir el monto otra vez vuelve al reparto automatico', backAuto, [false, 'Reparto automático', 'Q1.00']);
        // Limpiar y Pagar todo
        await oikos(`incAllocClear()`);
        equal('Limpiar deja el monto y las casillas vacios', await oikos(`[document.getElementById('inc-amount').value, [...document.querySelectorAll('#inc-alloc-rows input')].every((i) => !i.value)]`), ['', true]);
        await oikos(`document.getElementById('inc-alloc-all').click()`);
        equal('Pagar todo es lo mismo que Poner el total: el monto es lo que debe', await oikos(`(() => { const r = Store.get('residents').find((x) => x.id === 'u-ana'); return document.getElementById('inc-amount').value === sisdelOwedOf(r).total.toFixed(2); })()`), true);
        // Registrar un pago dirigido (a mano) y ver que queda con su alloc, su concepto y lo que baja de cada concepto
        const regs = await oikos(`(() => {
            incAllocClear();
            const r = Store.get('residents').find((x) => x.id === 'u-ana');
            const own = () => Store.get('transactions').filter((t) => String(t.resiId) === 'u-ana');
            const before = SisdelMora.stateOf('u-ana', own(), Store.get('settings'), localDayKey(new Date()));
            const first = document.querySelector('#inc-alloc-rows input');
            const key = first.dataset.key, amount = Math.min(20, parseFloat(first.max));
            first.value = String(amount); incAllocInput(first);
            document.getElementById('inc-concept-type').value = '';
            window.__alerts.length = 0;
            handleTransactionSubmit({ preventDefault() {} }, 'income');
            const tx = Store.get('transactions').filter((t) => t.type === 'income' && t.resiId === 'u-ana' && t.alloc).pop();
            const after = SisdelMora.stateOf('u-ana', own(), Store.get('settings'), localDayKey(new Date()));
            window.__allocTx = tx && tx.id;
            return { key, amount, tx: tx && { amount: tx.amount, alloc: tx.alloc, concept: tx.concept }, beforeVal: key === 'mora' ? before.mora : before.parts[key], afterVal: key === 'mora' ? after.mora : after.parts[key], alerts: window.__alerts };
        })()`);
        record('registrar con el detalle a mano deja el pago con su alloc y un concepto que dice a que se aplico', !!regs.tx && regs.tx.amount === regs.amount && JSON.stringify(regs.tx.alloc) === JSON.stringify({ [regs.key]: regs.amount }) && /^Pago de /.test(regs.tx.concept) && regs.alerts.length === 0, JSON.stringify(regs));
        record('el concepto pagado baja exactamente lo anotado (y el motor lo aplica a ese concepto)', regs.tx && Math.abs((regs.beforeVal - (regs.afterVal || 0)) - regs.amount) < 0.011, JSON.stringify(regs));
        await oikos(`(() => { closeModal('modal-voucher-options'); })()`);
        // El pago dirigido en el detalle del movimiento y en el comprobante
        const txShows = await oikos(`(() => { openTxDetail(window.__allocTx); return document.getElementById('tx-detail-body').textContent.includes('Aplicado a:'); })()`);
        equal('el detalle del movimiento dice a que conceptos se aplico', txShows, true);
        await oikos(`closeModal('modal-tx-detail')`);
        const pdfHeights = await oikos(`(() => {
            const plain = Store.get('transactions').filter((t) => t.type === 'income' && !t.alloc && !t.creditAfter).pop();
            const withAlloc = _buildVoucherPdf(window.__allocTx);
            const without = plain ? _buildVoucherPdf(plain.id) : null;
            return [withAlloc && Math.round(withAlloc.doc.internal.pageSize.getHeight()), without && Math.round(without.doc.internal.pageSize.getHeight()), without && Math.round(without.doc.internal.pageSize.getWidth()), withAlloc && Math.round(withAlloc.doc.internal.pageSize.getWidth())];
        })()`);
        equal('el comprobante es horizontal (148 x 115, como se dibuja: antes jsPDF lo giraba y se cortaba a la derecha) y el de un pago dirigido es mas alto (lleva "Aplicado a:")', [pdfHeights[0] > pdfHeights[1], pdfHeights[1], pdfHeights[2], pdfHeights[3]], [true, 115, 148, 148]);
        // Un residente sin deuda: el Detalle dice que no debe nada
        const none = await oikos(`(() => { openModal('modal-income'); setIncTab('detalle'); syncIncAlloc({ id: '__sin_deuda__', name: 'Nadie' }); return [document.getElementById('inc-alloc-empty').textContent, document.getElementById('inc-alloc-empty').classList.contains('hidden'), document.getElementById('inc-alloc-wrap').classList.contains('hidden')]; })()`);
        equal('sin deuda, el Detalle dice que no debe nada y que lo que pague queda a favor', none, ['No debe nada: lo que pague quedará como saldo a favor y se aplicará solo a sus próximas cuotas.', false, true]);
        // Un detalle que no suma el monto no se registra
        const mismatch = await oikos(`(() => {
            openModal('modal-income'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts();
            const first = document.querySelector('#inc-alloc-rows input'); first.value = '5'; incAllocInput(first);
            document.getElementById('inc-amount').value = '9';
            incAlloc.manual = true;
            const before = Store.get('transactions').length; window.__alerts.length = 0;
            handleTransactionSubmit({ preventDefault() {} }, 'income');
            return [Store.get('transactions').length === before, window.__alerts.some((m) => m.includes('no suma el monto'))];
        })()`);
        equal('si lo anotado no suma el monto, no se registra y avisa', mismatch, [true, true]);
        await oikos(`(() => { closeModal('modal-income'); closeModal('modal-voucher-options'); window.alert = window.__real.alert; window.confirm = window.__real.confirm; })()`);
        await idle();

        console.log('\nChats: las palomitas suben aunque no llegue el aviso de UltraMsg');
        await page.evaluate(`(() => { window.__realChats = window.sisdelChats; window.__hist = []; window.sisdelChats = { available: true, state: { chats: [{ id: '50255550001', channel: 'ultramsg' }, { id: '50255550002', channel: 'meta' }] }, loadHistory: async (id) => { window.__hist.push(id); return { ok: true, saved: 0 }; } }; })()`);
        const refresh = (id, messages, extra) => oikos(`(() => { clearTimeout(chatAckTimer); CHAT_ACK_REFRESH_MS = 120; CHAT_ACK_MAX_TRIES = 2; chatAckTries = {}; window.parent.__hist.length = 0; currentView = 'chats'; chatCurrentId = ${JSON.stringify(id)}; chatMessages = ${JSON.stringify(messages)}; ${extra || ''} scheduleChatAckRefresh(${JSON.stringify(id)}); return document.visibilityState; })()`);
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const histCalls = () => page.evaluate(`window.__hist.length`);
        const justNow = new Date().toISOString();
        const vis = await refresh('50255550001', [{ fromMe: true, ack: 'pending', at: justNow }]);
        await pause(900);
        record('un enviado en cola se vuelve a preguntar a UltraMsg, con tope de intentos (2)', (await histCalls()) === 2, `pagina ${vis}, llamadas ${await histCalls()}`);
        await refresh('50255550001', [{ fromMe: true, ack: 'server', at: justNow }]);
        await pause(500);
        record('con una palomita gris (enviado) tambien se sigue preguntando', (await histCalls()) >= 1, String(await histCalls()));
        await refresh('50255550001', [{ fromMe: true, ack: 'device', at: justNow }, { fromMe: true, ack: 'read', at: justNow }]);
        await pause(500);
        equal('lo ya entregado o leido no se vuelve a preguntar', await histCalls(), 0);
        await refresh('50255550001', [{ fromMe: false, ack: 'pending', at: justNow }]);
        await pause(500);
        equal('lo que escribio el residente no cuenta', await histCalls(), 0);
        await refresh('50255550001', [{ fromMe: true, ack: 'pending', at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }]);
        await pause(500);
        equal('un enviado de hace mas de 20 minutos tampoco', await histCalls(), 0);
        await refresh('50255550002', [{ fromMe: true, ack: 'pending', at: justNow }]);
        await pause(500);
        equal('con el WhatsApp oficial de Meta no (no guarda mensajes de antes)', await histCalls(), 0);
        await refresh('50255550001', [{ fromMe: true, ack: 'pending', at: justNow }], `chatCurrentId = 'otro';`);
        await pause(500);
        equal('si ya no es el chat abierto no se pregunta', await histCalls(), 0);
        await refresh('50255550001', [{ fromMe: true, ack: 'pending', at: justNow }]);
        await oikos(`(() => { try { openChat('otro-chat'); } catch (e) { /* el chat falso no pinta todo: lo que importa es que ya cancelo el repaso */ } })()`);
        await pause(500);
        equal('al abrir otro chat se cancela el repaso del anterior', await histCalls(), 0);
        await page.evaluate(`(() => { window.sisdelChats = window.__realChats; })()`);
        await oikos(`(() => { clearTimeout(chatAckTimer); chatAckTimer = null; CHAT_ACK_REFRESH_MS = 30000; CHAT_ACK_MAX_TRIES = 10; chatMessages = []; chatCurrentId = null; })()`);

        console.log('\nLote o casa');
        const finRef = (id) => condoRef.collection('finanzas_residentes').doc(id);
        // El formulario de un residente nuevo pide el tipo; el de uno que ya existia sin tipo se puede editar sin elegirlo
        // Dos botones: Solo lote y Casa con lote. Un residente nuevo no se guarda sin elegir uno
        const pressed = `[document.getElementById('res-unit-type').value, document.getElementById('res-type-lote').getAttribute('aria-checked'), document.getElementById('res-type-casa').getAttribute('aria-checked')]`;
        equal('residente nuevo: ningun boton elegido', await oikos(`(() => { navigate('residents'); openModal('modal-resident'); return ${pressed}; })()`), ['', 'false', 'false']);
        const residentsBefore = await oikos(`Store.getRaw('residents').length`);
        const refused = await oikos(`(() => { let msg = ''; const real = window.alert; window.alert = (m) => { msg = m; }; document.getElementById('res-name').value = 'Prueba Sin Tipo'; handleResidentSubmit({ preventDefault() {} }); window.alert = real; return msg; })()`);
        equal('sin elegir el tipo no se guarda y avisa', [refused.includes('Solo lote') && refused.includes('Casa con lote'), await oikos(`Store.getRaw('residents').length`)], [true, residentsBefore]);
        equal('al pulsar Casa con lote queda elegido y Solo lote deja de estarlo', await oikos(`(() => { document.getElementById('res-type-casa').click(); return ${pressed}; })()`), ['casa', 'false', 'true']);
        equal('al pulsar Solo lote cambia', await oikos(`(() => { document.getElementById('res-type-lote').click(); const out = ${pressed}; closeModal('modal-resident'); return out; })()`), ['lote', 'true', 'false']);
        equal('residente que ya existia: sin tipo y con los dos botones sin elegir', await oikos(`(() => { editResident('u-ana'); return [...${pressed}, Store.get('residents').find(r => r.id === 'u-ana').unitType === undefined]; })()`), ['', 'false', 'false', true]);
        // Marcar a Ana como casa con lote desde su formulario
        await oikos(`(() => { document.getElementById('res-type-casa').click(); handleResidentSubmit({ preventDefault() {} }); })()`);
        equal('guardar con la flecha en Casa deja el tipo en el residente', await oikos(`Store.get('residents').find(r => r.id === 'u-ana').unitType`), 'casa');
        equal('se guarda en la nube con los datos financieros', await idle(), 'ok');
        equal('en finanzas_residentes (no en el vecino de SISDEL)', [(await finRef('u-ana').get()).get('unitType'), (await condoRef.collection('usuarios').doc('u-ana').get()).get('unitType')], ['casa', undefined]);
        // La lista
        equal('la lista solo con casa con lote muestra a Ana y los conteos de cada tipo salen en el filtro', await oikos(`(() => { resTypeChanged('casa'); const ids = visibleResidents().map(r => r.id); const opts = [...document.querySelectorAll('#res-type-filter option')].map(o => o.textContent); resTypeChanged(''); return [ids, opts[2], opts[1]]; })()`), [['u-ana'], 'Casa con lote (1)', 'Solo lote (1)']);
        equal('el tipo se ve bajo la referencia y "casa" lo encuentra en la busqueda', await oikos(`(() => { const s = document.getElementById('res-search'); s.value = 'casa'; resSearchChanged(); const ids = visibleResidents().map(r => r.id); const chip = document.querySelector('#residents-table-body tr .uppercase.block') ? document.querySelector('#residents-table-body tr .uppercase.block').textContent : ''; s.value = ''; resSearchChanged(); return [ids.includes('u-ana'), chip]; })()`), [true, 'Casa con lote']);
        // Sin marcar, el tipo lo dice el agua (el agua se cobra solo a los lotes con casa): los Recordatorios usan el mismo tipo
        equal('sin marcar, quien paga agua cuenta como casa con lote y quien no, como solo lote (tambien en Recordatorios)', await oikos(`(() => {
            const res = Store.get('residents'); res.find(r => r.id === 'u-maria').waterUnits = 1; Store.set('residents', res);
            const m = Store.get('residents').find(r => r.id === 'u-maria');
            const out = [unitTypeOf(m), unitTypeLabel(m), remPassFilters(m, '', 'casa'), remPassFilters(m, '', 'lote')];
            const back = Store.get('residents'); back.find(r => r.id === 'u-maria').waterUnits = 0; Store.set('residents', back);
            return out;
        })()`), ['casa', 'Casa con lote', true, false]);
        await idle();
        // Marcar tipo en bloque: solo a los que no se han marcado
        const withoutType = await oikos(`(() => { openBulkType(); return [Store.get('residents').filter(r => !r.unitType).length, document.getElementById('bt-summary').textContent]; })()`);
        record('Marcar tipo avisa cuantos faltan', withoutType[0] >= 1 && withoutType[1].includes(String(withoutType[0])), JSON.stringify(withoutType));
        // El agua de Maria sube a 1 antes de marcar segun el agua: ella pasa a casa con lote, los demas a solo lote
        await oikos(`(() => { const res = Store.get('residents'); res.find(r => r.id === 'u-maria').waterUnits = 1; Store.set('residents', res); })()`);
        const countsLine = await oikos(`(() => { openBulkType(); return document.getElementById('bt-agua-counts').textContent; })()`);
        record('Marcar tipo dice cuantos serian casa con lote y cuantos solo lote segun el agua', /^1 casa\(s\) con lote y \d+ solo lote$/.test(countsLine), countsLine);
        await oikos(`applyBulkType('agua')`);
        equal('Marcar segun el agua deja a Maria como casa con lote, a los demas como solo lote, y no toca a Ana (casa con lote)', await oikos(`Store.get('residents').map(r => [r.id, r.unitType]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))`).then((rows) => [rows.every((r) => r[0] === 'u-ana' || r[0] === 'u-maria' ? r[1] === 'casa' : r[1] === 'lote'), rows.length > 1]), [true, true]);
        equal('se guarda en la nube', await idle(), 'ok');
        equal('en la nube, Maria quedo como casa (por el agua) y Ana sigue como casa', [(await finRef('u-maria').get()).get('unitType'), (await finRef('u-ana').get()).get('unitType')], ['casa', 'casa']);
        // Maria vuelve a no pagar agua para que lo que sigue sea el mismo escenario de siempre (solo Ana es casa con lote)
        await oikos(`(() => { const res = Store.get('residents'); const m = res.find(r => r.id === 'u-maria'); m.waterUnits = 0; m.unitType = 'lote'; Store.set('residents', res); })()`);
        await idle();
        equal('ya no queda ninguno sin indicar y el boton Marcar tipo se oculta', await oikos(`(() => { renderResidents(); return [Store.get('residents').filter(r => !r.unitType).length, document.getElementById('res-bulk-type-btn').classList.contains('hidden')]; })()`), [0, true]);
        // Los reportes por residente
        equal('Tabla general de casa con lote trae solo a Ana; de solo lote, a los demas', await oikos(`(() => { repTypeFilter = 'casa'; const a = sisdelPayMap().map.rows.map(x => x.resident.id); repTypeFilter = 'lote'; const l = sisdelPayMap().map.rows.map(x => x.resident.id); repTypeFilter = ''; const all = sisdelPayMap().map.rows.length; return [a, l.includes('u-ana'), l.length + a.length === all]; })()`), [['u-ana'], false, true]);
        equal('el texto de Morosos, Tabla general y Listado de propietarios dice casa con lote', await oikos(`(() => { repTypeFilter = 'casa'; const out = [buildMorososReport().summary, buildPayMapReport().summary, buildOwnersReport().summary].map(t => t.includes('casa con lote')); repTypeFilter = ''; return out; })()`), [true, true, true]);
        equal('el Listado de propietarios de casa con lote trae una fila', await oikos(`(() => { repTypeFilter = 'casa'; const n = buildOwnersReport().rows.length; repTypeFilter = ''; return n; })()`), 1);
        equal('el filtro de los reportes aparece en los reportes por residente y no en los de dinero', await oikos(`(() => { const out = []; ['morosos', 'pay-map', 'owners', 'income', 'month-balance'].forEach(k => { selectReport(k); out.push(document.getElementById('rep-type-wrap').style.display !== 'none'); }); return out; })()`), [true, true, true, false, false]);

        console.log('\nFases: la flecha de Por fase y asignarlas por sector');
        equal('la fase se nombra una sola vez y el sector sale de las letras de la referencia', await oikos(`[faseLabel('2'), faseLabel('Fase 3'), faseLabel('2A'), sectorOfUnit({ unit: 'A001' }), sectorOfUnit({ unit: 'ba12' }), sectorOfUnit({ unit: '024' })]`), ['Fase 2', 'Fase 3', 'Fase 2A', 'A', 'BA', '']);
        await oikos(`(() => { setReminderMode('varios'); openReminders(); renderRemindersList('fase'); })()`);
        equal('sin fases anotadas: la flecha esta apagada y avisa, con el boton para asignarlas por sector', await oikos(`(() => { const s = document.getElementById('rem-fase-select'); return [s.disabled, s.textContent.trim(), !document.getElementById('rem-fase-empty').classList.contains('hidden'), !document.getElementById('rem-fase-assign').classList.contains('hidden')]; })()`), [true, 'Sin fases anotadas', true, true]);
        const sectorsShown = await oikos(`(() => { openAssignFases(); return [...document.querySelectorAll('#af-body tr')].map((tr) => [tr.children[0].textContent, tr.children[1].textContent, tr.children[2].textContent]); })()`);
        equal('Fases por sector: cada sector con cuantos lotes tiene y su fase de ahora', sectorsShown, [['CASA', '2', 'sin fase']]);
        await oikos(`(() => { document.querySelector('#af-body input[data-sector="CASA"]').value = '4'; applyAssignFases(); })()`);
        equal('Aplicar pone la fase a todos los lotes del sector', await oikos(`Store.get('residents').map((r) => r.fase)`), ['4', '4']);
        equal('se guarda en la nube (en el vecino de SISDEL)', await idle(), 'ok');
        equal('en la nube Ana tiene la fase 4', (await condoRef.collection('usuarios').doc('u-ana').get()).get('fase'), '4');
        equal('Por fase muestra ahora la flecha con la fase y cuantos hay', await oikos(`(() => { renderRemindersList('fase'); const s = document.getElementById('rem-fase-select'); return [s.disabled, [...s.options].map((o) => o.textContent), s.value, document.getElementById('rem-fase-empty').classList.contains('hidden')]; })()`), [false, ['Fase 4 (2)'], '4', true]);
        equal('con "No cambiar a los que ya tienen fase" marcado no se pisa la fase que ya existe', await oikos(`(() => { openAssignFases(); document.querySelector('#af-body input[data-sector="CASA"]').value = '5'; document.getElementById('af-keep').checked = true; applyAssignFases(); const out = [...new Set(Store.get('residents').map((r) => r.fase))]; closeModal('modal-assign-fases'); return out; })()`), ['4']);
        equal('sin esa marca si se cambia', await oikos(`(() => { openAssignFases(); document.querySelector('#af-body input[data-sector="CASA"]').value = '5'; document.getElementById('af-keep').checked = false; applyAssignFases(); return [...new Set(Store.get('residents').map((r) => r.fase))]; })()`), ['5']);
        await oikos(`closeModal('modal-reminders')`);

        // ───────── Descontar mora (pedido del dueno el 2026-11-18) ─────────
        console.log('\nDescontar mora: pestana del Ingreso, reporte y nube');
        equal('sin regla de mora la pestana Descontar mora no se ve', await oikos(`(() => { navigate('accounting'); openModal('modal-income'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); const t = document.getElementById('inc-tab-descuento'); const out = t.classList.contains('hidden'); closeModal('modal-income'); return out; })()`), true);
        await sleep(350);
        // La regla de mora de La Perla solo en la pantalla (no se guarda) y dos cuotas viejas de Ana, de verdad (van a la nube)
        await oikos(`(() => {
            window.__real = { alert: window.alert, confirm: window.confirm, prompt: window.prompt, get: Store.get };
            window.__alerts = []; window.__confirms = [];
            window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; window.prompt = () => 'prueba';
            Store.get = (k) => (k === 'settings' ? Object.assign({}, window.__real.get(k), { moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] }) : window.__real.get(k));
            const txs = Store.get('transactions');
            ['07', '08'].forEach((m) => txs.push({ id: 'disc-test-' + m, date: '2026-' + m + '-05T12:00:00.000Z', type: 'charge', kind: 'fee', period: '2026-' + m, amount: 300, manual: true, concept: 'Cuota de prueba ' + m, resiId: 'u-ana' }));
            Store.set('transactions', txs);
        })()`);
        equal('las cuotas de prueba se guardan', await idle(), 'ok');
        const discStart = await oikos(`(() => {
            navigate('accounting'); openModal('modal-income'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts();
            const r = Store.get('residents').find((x) => x.id === 'u-ana');
            const st = SisdelMora.stateOf('u-ana', Store.get('transactions'), Store.get('settings'), localDayKey(new Date()));
            const mora = (id) => (st.items.find((i) => i.id === id) || {}).mora || 0;
            const tab = document.getElementById('inc-tab-descuento');
            return { tab: !tab.classList.contains('hidden') && getComputedStyle(tab).display !== 'none', owed: sisdelOwedOf(r), m07: mora('disc-test-07'), m08: mora('disc-test-08'), all: st.mora };
        })()`);
        record('con regla de mora la pestana Descontar mora se ve y Ana debe mora de julio y agosto', discStart.tab && discStart.m07 > discStart.m08 && discStart.m08 > 0 && discStart.owed.mora >= discStart.m07 + discStart.m08 - 0.01, JSON.stringify(discStart));
        // La mora se carga el dia 6 de cada mes (pedido del usuario el 2026-11-19): cada cuota lleva 3 % (Q 9 de Q 300) por cada
        // dia 6 que paso desde que vencio, y la ventana del ingreso dice cuando es el proximo cargo si no paga antes
        const steps = await oikos(`(() => {
            const settings = Store.get('settings');
            const today = localDayKey(new Date());
            const when = SisdelMora.chargeDates(settings, today);
            const count = (period) => { let n = 0; const p = SisdelMora.periodDays(period); for (let d = p.last + 6; d <= SisdelMora.dayOfKey(today); d++) if (SisdelMora.keyOfDay(d).slice(8) === '06') n++; return n; };
            const st = SisdelMora.stateOf('u-ana', Store.get('transactions'), settings, today);
            const nextCapital = st.items.filter((i) => i.kind === 'fee' && i.capital > 0 && i.dueDate < when.next).reduce((a, i) => a + i.capital, 0);
            const el = document.getElementById('inc-bal-next');
            return { m07: count('2026-07') * 9, m08: count('2026-08') * 9, day: when.dayOfMonth, text: el.textContent, shown: !el.classList.contains('hidden'),
                expected: [sisdelDayText(when.next), formatMoney(Math.round(nextCapital * 3) / 100)], rule: sisdelMoraRuleText() };
        })()`);
        equal('la mora de cada cuota son los cargos de Q 9.00 de cada dia 6 desde que vencio (julio y agosto)', [discStart.m07, discStart.m08, steps.day], [steps.m07, steps.m08, 6]);
        record('la ventana del ingreso dice cuando se carga la proxima mora y cuanto, si no paga antes', steps.shown && steps.text.includes('el ' + steps.expected[0]) && steps.text.includes(steps.expected[1]) && /Hasta entonces su saldo no cambia/.test(steps.text), JSON.stringify(steps));
        record('el texto de la regla dice que se carga el dia 6', /cargado el día 6 de cada mes/.test(steps.rule), steps.rule);
        equal('la pestana se abre mas ancha, sin el boton Registrar, con la tabla de cuotas (casilla solo en los meses con mora)', await oikos(`(() => { setIncTab('descuento'); const rows = [...document.querySelectorAll('#disc-rows tr')]; return [!document.getElementById('inc-pane-descuento').classList.contains('hidden'), document.getElementById('inc-pane-pago').classList.contains('hidden'), document.getElementById('inc-modal-box').classList.contains('max-w-3xl'), document.getElementById('btn-inc-reg').classList.contains('hidden'), rows.length >= 2, document.querySelectorAll('#disc-rows input[data-id="disc-test-07"]').length, document.querySelectorAll('#disc-rows input[data-id="disc-test-08"]').length, document.getElementById('inc-tab-descuento').getAttribute('aria-selected')]; })()`), [true, true, true, true, true, 1, 1, 'true']);
        const markJul = await oikos(`(() => { document.querySelector('#disc-rows input[data-id="disc-test-07"]').click(); return [document.getElementById('disc-total').textContent, document.getElementById('disc-count').textContent, document.getElementById('disc-after').textContent, document.getElementById('disc-owed').textContent]; })()`);
        equal('marcar julio suma su mora y dice cuanto deberia con el descuento', markJul, await oikos(`[formatMoney(${discStart.m07}), '1 mes marcado', formatMoney(Math.round((${discStart.owed.total} - ${discStart.m07}) * 100) / 100), formatMoney(${discStart.owed.total})]`));
        equal('Marcar todos suma toda la mora', await oikos(`(() => { document.getElementById('disc-all').click(); return document.getElementById('disc-total').textContent === formatMoney(${discStart.owed.mora}); })()`), true);
        const byAmount = Math.round((discStart.m08 + 1) * 100) / 100;
        const amountRows = await oikos(`(() => { const el = document.getElementById('disc-amount'); el.value = '${byAmount.toFixed(2)}'; el.dispatchEvent(new Event('input', { bubbles: true })); const cell = (id) => { const row = document.querySelector('#disc-rows input[data-id="' + id + '"]').closest('tr'); return row.children[5].textContent; }; return [document.getElementById('disc-total').textContent, cell('disc-test-08'), cell('disc-test-07'), document.getElementById('disc-amount-note').textContent.startsWith('Se descuenta de:')]; })()`);
        equal('un total se descuenta primero del mes mas reciente con mora (agosto entero) y lo que falta del anterior (julio Q1.00)', amountRows, await oikos(`[formatMoney(${byAmount}), '-' + formatMoney(${discStart.m08}), '-' + formatMoney(1), true]`));
        const txCount = () => oikos(`Store.get('transactions').filter((t) => t.type === 'mora_discount').length`);
        const d0 = await txCount();
        equal('sin motivo el boton esta apagado y no se registra nada', await oikos(`(() => { window.__alerts.length = 0; const off = document.getElementById('disc-apply').disabled; applyMoraDiscount(); return [off, window.__alerts.some((m) => m.includes('motivo'))]; })()`), [true, true]);
        equal('(nada se guardo)', await txCount(), d0);
        const applied = await oikos(`(() => {
            const reason = document.getElementById('disc-reason'); reason.value = 'Acuerdo de pago de prueba'; reason.dispatchEvent(new Event('input', { bubbles: true }));
            const on = !document.getElementById('disc-apply').disabled;
            window.__confirms.length = 0;
            document.getElementById('disc-apply').click();
            const tx = Store.get('transactions').filter((t) => t.type === 'mora_discount').pop();
            const r = Store.get('residents').find((x) => x.id === 'u-ana');
            return { on, confirm: window.__confirms[0] || '', tx, owed: sisdelOwedOf(r), who: window.parent.sisdelWho, done: document.getElementById('disc-done').textContent, cash: isCashTx(tx) };
        })()`);
        record('con el motivo se enciende, pide confirmar (monto, meses y motivo) y lo registra', applied.on && applied.confirm.includes('Descontar') && applied.confirm.includes('Acuerdo de pago de prueba') && applied.tx && applied.tx.type === 'mora_discount', JSON.stringify([applied.on, applied.confirm.slice(0, 160)]));
        equal('el descuento guarda sus cuotas (agosto entero y Q1.00 de julio), el motivo, quien lo hizo y lo que debia antes y despues', [applied.tx.amount, applied.tx.moraItems.map((x) => [x.id, x.amount]), applied.tx.reason, applied.tx.byId === applied.who.id && !!applied.who.id, applied.tx.before.total, applied.tx.after.total, applied.tx.mode],
            [byAmount, [['disc-test-08', discStart.m08], ['disc-test-07', 1]], 'Acuerdo de pago de prueba', true, discStart.owed.total, Math.round((discStart.owed.total - byAmount) * 100) / 100, 'monto']);
        equal('lo que debe Ana baja exactamente lo descontado (y solo la mora: lo pendiente no cambia)', [applied.owed.total, applied.owed.pending], [Math.round((discStart.owed.total - byAmount) * 100) / 100, discStart.owed.pending]);
        record('la pestana dice que quedo registrado y cuanto debe ahora; no es un movimiento de caja', applied.done.startsWith('Descuento registrado') && !applied.cash, applied.done);
        equal('el descuento llega a la nube (las reglas lo aceptan con la cuenta de quien lo hizo)', await idle(), 'ok');
        const cloudDisc = await txRef(applied.tx.id).get();
        equal('en la nube: tipo, cuotas, motivo y autor', [cloudDisc.exists, cloudDisc.get('type'), (cloudDisc.get('moraItems') || []).length, cloudDisc.get('reason'), cloudDisc.get('byId') === applied.who.id], [true, 'mora_discount', 2, 'Acuerdo de pago de prueba', true]);
        const ecDisc = await oikos(`(() => { closeModal('modal-income'); openEstadoCuenta('u-ana'); const out = [getEcData().rows.some((x) => x.id === ${JSON.stringify(applied.tx.id)}), document.getElementById('ec-mora-note').textContent.includes('Mora descontada: ' + formatMoney(${byAmount})), (ecReportModel(true).kpis || []).some((k) => k.label === 'Mora descontada')]; closeModal('modal-estado-cuenta'); return out; })()`);
        equal('el estado de cuenta no lo lista como movimiento del libro y dice la mora descontada (tambien en Excel, PDF y WhatsApp)', ecDisc, [false, true, true]);
        equal('no aparece en el Estado de cuenta general (no es dinero)', await oikos(`(() => { openMovementsReport(); return document.getElementById('view-reports').innerHTML.includes(${JSON.stringify(applied.tx.id)}); })()`), false);
        const discRep = await oikos(`(() => { navigate('reports'); selectReport('mora-discounts'); const d = currentReportData; const row = d.rows[d.rows.length - 1]; return { title: document.getElementById('rep-current').textContent, n: d.rows.length, row: row.map(stripCellHtml), meta: d.rowsMeta[d.rows.length - 1], high: d.highlights[0].value, wa: SisdelReportExport.whatsappText(currentReportModel(false)).slice(0, 200), xlsx: currentReportModel(true).fileName }; })()`);
        record('el reporte Descuentos de mora lo lista con residente, meses, monto, motivo y quien lo hizo', discRep.title === 'Descuentos de mora' && discRep.n >= 1 && discRep.row[1].includes('Ana') && discRep.row[6] === 'Acuerdo de pago de prueba' && discRep.row[8] === 'Vigente' && discRep.meta.kind === 'tx', JSON.stringify(discRep));
        equal('con la mora descontada arriba y su salida a WhatsApp y Excel', [discRep.high === await oikos(`formatMoney(${byAmount})`), /Descuentos de mora/i.test(discRep.wa), !!discRep.xlsx], [true, true, true]);
        // Anularlo: la mora vuelve y el reporte lo muestra anulado
        const annulDisc = await oikos(`(() => { deleteTransaction(${JSON.stringify(applied.tx.id)}); const r = Store.get('residents').find((x) => x.id === 'u-ana'); selectReport('mora-discounts'); const d = currentReportData; return [sisdelOwedOf(r).total, stripCellHtml(d.rows[d.rows.length - 1][8]).startsWith('Anulado'), d.highlights[3].value]; })()`);
        equal('anular el descuento devuelve la mora y el reporte lo muestra anulado', annulDisc, [discStart.owed.total, true, '1']);
        // Limpieza: se anulan las cuotas de prueba y se quita la regla de mora de la pantalla
        await oikos(`(() => { deleteTransaction('disc-test-07'); deleteTransaction('disc-test-08'); Store.get = window.__real.get; window.alert = window.__real.alert; window.confirm = window.__real.confirm; window.prompt = window.__real.prompt; navigate('accounting'); })()`);
        equal('todo queda guardado en la nube', await idle(), 'ok');

        console.log('\nTablero: ingresos, gastos y saldo por mes en tres graficas, con flechas');
        // Un gasto de hace 4 meses registrado "en otro equipo" (directo en la nube): asi hay meses atras a donde ir
        const gtNow = new Date(Date.now() - 6 * 3600000);
        const monthKeyAgo = (n) => new Date(Date.UTC(gtNow.getUTCFullYear(), gtNow.getUTCMonth() - n, 1)).toISOString().slice(0, 7);
        const oldKey = monthKeyAgo(4);
        const dashStamp = new Date().toISOString();
        await txRef('dash-test-old').set({ id: 'dash-test-old', type: 'expense', amount: 75, date: `${oldKey}-15T18:00:00.000Z`, concept: 'Gasto de prueba del tablero', category: 'Mantenimiento', created_at: dashStamp, updated_at: dashStamp });
        await waitFor('un gasto de hace 4 meses registrado en otro equipo llega a OIKOS', () => oikos(`Store.get('transactions').some((t) => t.id === 'dash-test-old')`), 60000);
        // Lo que muestran las tres graficas y, aparte, lo que suman a mano los pagos y gastos vivos de esos meses
        const DASH = `(() => {
            navigate('dashboard');
            const chartOf = (k) => Chart.getChart(document.getElementById('dash-chart-' + k));
            const bars = (k) => (chartOf(k) ? chartOf(k).data.datasets[0].data.map(Number) : null);
            const end = dashMonthsEndKey();
            const keys = [2, 1, 0].map((i) => SisdelReportesOikos.addMonths(end, -i));
            const txs = Store.get('transactions');
            const sum = (type, key) => Math.round(txs.filter((t) => t.type === type && localDayKey(t.date).slice(0, 7) === key).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0) * 100) / 100;
            const noteEl = document.getElementById('dash-months-note');
            return {
                keys, labels: chartOf('income') ? chartOf('income').data.labels : null,
                income: bars('income'), expense: bars('expense'), balance: bars('balance'),
                byHand: keys.map((k) => [sum('income', k), sum('expense', k), Math.round((sum('income', k) - sum('expense', k)) * 100) / 100]),
                range: document.getElementById('dash-months-range').textContent,
                prev: document.getElementById('dash-months-prev').disabled, next: document.getElementById('dash-months-next').disabled, today: document.getElementById('dash-months-today').disabled,
                note: noteEl.classList.contains('hidden') ? '' : noteEl.textContent,
                totals: ['income', 'expense', 'balance'].map((k) => document.getElementById('dash-months-total-' + k).textContent),
                totalsByHand: [0, 1, 2].map((j) => dashMoney(Math.round(keys.reduce((s, k, i) => s + [sum('income', k), sum('expense', k), sum('income', k) - sum('expense', k)][j], 0) * 100) / 100)),
                yTicks: chartOf('income') ? chartOf('income').options.scales.y.ticks.display : null,
                old: !!document.getElementById('trendChart')
            };
        })()`;
        const sameAsHand = (d) => d.income.every((v, i) => v === d.byHand[i][0]) && d.expense.every((v, i) => v === d.byHand[i][1]) && d.balance.every((v, i) => v === d.byHand[i][2]);
        let dash = await oikos(DASH);
        equal('tres graficas (Ingresos, Gastos y Saldo del mes) de los ultimos 3 meses, con el ano en cada mes; la de Tendencia ya no esta',
            [dash.keys, dash.labels && dash.labels.length, [dash.income, dash.expense, dash.balance].every((b) => b && b.length === 3), dash.old],
            [[monthKeyAgo(2), monthKeyAgo(1), monthKeyAgo(0)], 3, true, false]);
        record('los labels dicen el mes y el ano (Nov 2026)', dash.labels.every((l) => /^[A-Z][a-z]{2} \d{4}$/.test(l)), JSON.stringify(dash.labels));
        record('cada barra es la suma de los pagos (o gastos) vivos de su mes; el saldo, ingresos menos gastos', sameAsHand(dash), JSON.stringify(dash));
        equal('los totales de los 3 meses arriba de cada grafica', dash.totals, dash.totalsByHand);
        equal('en el mes en curso: no se puede ir adelante ni a "Mes actual", si hacia atras (hay un gasto de hace 4 meses)', [dash.prev, dash.next, dash.today, dash.range.endsWith('(el mes en curso va hasta hoy)')], [false, true, true, true]);
        dash = await oikos(`(() => { document.getElementById('dash-months-prev').click(); return ${DASH}; })()`);
        equal('"Mes anterior" corre las tres graficas un mes hacia atras', [dash.keys, dash.next, dash.today, sameAsHand(dash)], [[monthKeyAgo(3), monthKeyAgo(2), monthKeyAgo(1)], false, false, true]);
        const windowZero = dash.byHand.every((m) => m[0] === 0 && m[1] === 0);
        record('sin pagos ni gastos en la ventana un aviso dice por que (y el eje no muestra 0.1, 0.2...); con pagos no hay aviso',
            windowZero ? (dash.note.startsWith('No hay pagos ni gastos registrados en estos meses') && dash.yTicks === false) : (dash.note === '' && dash.yTicks === true), JSON.stringify([windowZero, dash.note, dash.yTicks]));
        for (let i = 0; i < 8 && !(await oikos(`document.getElementById('dash-months-prev').disabled`)); i++) await oikos(`document.getElementById('dash-months-prev').click()`);
        dash = await oikos(DASH);
        equal('hacia atras llega hasta el primer mes con pagos o gastos y ahi se detiene, con el gasto en su mes', [dash.keys[0], dash.prev, dash.expense[0] === dash.byHand[0][1] && dash.expense[0] >= 75, dash.range.includes('mes en curso')], [oldKey, true, true, false]);
        dash = await oikos(`(() => { document.getElementById('dash-months-next').click(); return ${DASH}; })()`);
        equal('"Mes siguiente" la corre un mes hacia adelante', [dash.keys[0], dash.prev, sameAsHand(dash)], [monthKeyAgo(3), false, true]);
        dash = await oikos(`(() => { document.getElementById('dash-months-today').click(); return ${DASH}; })()`);
        equal('"Mes actual" vuelve a los ultimos 3 meses', [dash.keys[2], dash.next, dash.today], [monthKeyAgo(0), true, true]);
        const dashRep = await oikos(`(() => { document.getElementById('dash-months-prev').click(); document.getElementById('dash-months-report').click(); const out = { view: currentView, key: currentReportKey, title: document.getElementById('rep-current').textContent, from: document.getElementById('rep-from').value, to: document.getElementById('rep-to').value }; dashMonthsGo(0); return out; })()`);
        const lastDayAgo1 = new Date(Date.UTC(gtNow.getUTCFullYear(), gtNow.getUTCMonth(), 0)).toISOString().slice(0, 10);
        equal('"Ver el reporte" abre Ingresos, egresos y saldo por mes de esos mismos meses', dashRep, { view: 'reports', key: 'month-balance', title: 'Ingresos, egresos y saldo por mes', from: `${monthKeyAgo(3)}-01`, to: lastDayAgo1 });
        // Limpieza: el gasto de prueba se anula (nada se borra)
        await oikos(`deleteTransaction('dash-test-old')`);
        equal('el gasto de prueba se anula y queda guardado en la nube', [await idle(), (await txRef('dash-test-old').get()).get('deleted')], ['ok', true]);

        console.log('\nPlazo de pago de 35 dias: el mes y hasta el dia 5 del siguiente (en pantalla)');
        // Con fechas FIJAS (se sustituye la fecha de hoy) y movimientos de mentira, para que no dependa del dia en que corra la prueba
        const windowCases = await oikos(`(() => {
            const RealDate = Date;
            const realGet = Store.get;
            const realMem = window.sisdelMem;
            const at = (iso) => { window.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(iso); else super(...a); } static now() { return new RealDate(iso).getTime(); } }; };
            const fee = (period) => ({ id: 'w-' + period, type: 'charge', kind: 'fee', period, amount: 100, resiId: 'w1', date: period + '-01T18:00:00.000Z' });
            const out = {};
            try {
                window.sisdelMem = () => null;
                const moroso = (iso, periods, balance) => { at(iso); const txs = periods.map(fee); Store.get = (k) => (k === 'transactions' ? txs : realGet(k)); return checkIsMoroso({ id: 'w1', balance }); };
                out.nov19SoloNov = moroso('2026-11-19T18:00:00.000Z', ['2026-11'], -100);
                out.dic5SoloNov = moroso('2026-12-05T18:00:00.000Z', ['2026-11'], -100);
                out.dic6SoloNov = moroso('2026-12-06T18:00:00.000Z', ['2026-11'], -100);
                out.nov4OctYNov = moroso('2026-11-04T18:00:00.000Z', ['2026-10', '2026-11'], -200);
                out.nov5OctYNov = moroso('2026-11-05T18:00:00.000Z', ['2026-10', '2026-11'], -200);
                out.nov6OctYNov = moroso('2026-11-06T18:00:00.000Z', ['2026-10', '2026-11'], -200);
                out.nov19OctYNov = moroso('2026-11-19T18:00:00.000Z', ['2026-10', '2026-11'], -200);
                out.alDia = moroso('2026-11-19T18:00:00.000Z', ['2026-10', '2026-11'], 0);
                out.aFavor = moroso('2026-11-19T18:00:00.000Z', ['2026-10'], 50);
                out.multa = (() => { at('2026-11-19T18:00:00.000Z'); const txs = [{ id: 'w-m', type: 'charge', kind: 'fine', amount: 100, resiId: 'w1', date: '2026-11-10T18:00:00.000Z', concept: 'Multa' }]; Store.get = (k) => (k === 'transactions' ? txs : realGet(k)); return checkIsMoroso({ id: 'w1', balance: -100 }); })();
                // La Tabla general: la cuota en su plazo es 'pending' (en blanco) y la vencida 'owed'
                const status = (today, periods) => { const txs = periods.map(fee); return SisdelReportesOikos.paymentMap([{ id: 'w1', name: 'W', unit: '1' }], txs, { today, dayKey: localDayKey, feePeriodOf: txFeePeriod, dueOf: sisdelPeriodDue }).rows[0].cells; };
                window.Date = RealDate;
                const c19 = status('2026-11-19', ['2026-10', '2026-11']);
                out.tablaNov19 = [c19['2026-10'].status, c19['2026-11'].status];
                out.tablaDic5 = status('2026-12-05', ['2026-11'])['2026-11'].status;
                out.tablaDic6 = status('2026-12-06', ['2026-11'])['2026-11'].status;
                out.due = [sisdelPeriodDue('2026-11'), sisdelPeriodDue('2026-12')];
                // Con regla de mora por dia (La Perla: fin de mes + 5 dias) da lo mismo
                Store.get = (k) => (k === 'settings' ? Object.assign({}, realGet(k), { moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] }) : realGet(k));
                out.dueConRegla = [sisdelPeriodDue('2026-11'), sisdelPeriodDue('2026-12')];
            } finally { window.Date = RealDate; Store.get = realGet; window.sisdelMem = realMem; }
            return out;
        })()`);
        equal('una cuota del mes en su plazo no es mora: noviembre se paga hasta el 5 de diciembre (el 19 de noviembre y el mismo 5 de diciembre no es moroso; el 6 si)', [windowCases.nov19SoloNov, windowCases.dic5SoloNov, windowCases.dic6SoloNov], [false, false, true]);
        equal('quien debe octubre y noviembre: hasta el 5 de noviembre octubre aun esta en su plazo; desde el 6 es moroso por octubre (noviembre sigue en su plazo)', [windowCases.nov4OctYNov, windowCases.nov5OctYNov, windowCases.nov6OctYNov, windowCases.nov19OctYNov], [false, false, true, true]);
        equal('quien esta al dia o tiene saldo a favor no es moroso; una multa (no es cuota mensual) cuenta como vencida', [windowCases.alDia, windowCases.aFavor, windowCases.multa], [false, false, true]);
        equal('en la Tabla general el mes en su plazo va como "pending" (en blanco) y el vencido como "owed": el 19 de noviembre octubre vencio y noviembre no; noviembre vence despues del 5 de diciembre', [windowCases.tablaNov19, windowCases.tablaDic5, windowCases.tablaDic6], [['owed', 'pending'], 'pending', 'owed']);
        equal('el ultimo dia para pagar noviembre es el 5 de diciembre y diciembre el 5 de enero; con regla de mora por dia (La Perla) es el mismo', [windowCases.due, windowCases.dueConRegla], [['2026-12-05', '2027-01-05'], ['2026-12-05', '2027-01-05']]);
        equal('Configuracion muestra el plazo fijo de 5 dias y no se puede cambiar', await oikos(`(() => { navigate('settings'); const g = document.getElementById('cfg-grace'); return [g.value, g.readOnly]; })()`), ['5', true]);

        console.log('\nTabla general: buscador inteligente (ver solo a un residente)');
        await oikos(`(() => { navigate('reports'); selectReport('pay-map'); })()`);
        await sleep(700);
        const pmAll = await oikos(`currentReportData.rows.length`);
        const pmSearch = async (text) => {
            await oikos(`(() => { const el = document.getElementById('pm-search'); el.value = ${JSON.stringify(text)}; payMapSearchChanged(); })()`);
            await sleep(450);
            return oikos(`({ n: currentReportData.rows.length, names: currentReportData.rows.map((r) => stripCellHtml(r[0])), summary: currentReportData.summary, marks: (document.getElementById('rep-tbody').innerHTML.match(/<mark/g) || []).length, empty: document.getElementById('rep-empty-text').textContent, cards: document.getElementById('rep-highlights').innerText.replace(/\\s+/g, ' ').slice(0, 120) })`);
        };
        record('el buscador esta en la Tabla general y sin escribir nada muestra a todos', pmAll >= 2 && (await oikos(`!!document.getElementById('pm-search') && getComputedStyle(document.getElementById('rep-paymap-filters')).display !== 'none'`)), String(pmAll));
        const pmMaria = await pmSearch('maria');
        record('"maria" (sin acento ni mayuscula) deja solo a Maria, con lo que coincide resaltado y la busqueda dicha arriba', pmMaria.n >= 1 && pmMaria.n < pmAll && pmMaria.names.every((n) => /mar[ií]a/i.test(n)) && pmMaria.marks >= 1 && /búsqueda: «maria»/.test(pmMaria.summary), JSON.stringify(pmMaria));
        const pmWords = await pmSearch('rod MARÍA');
        equal('las palabras van en cualquier orden y cada una es el principio de otra ("rod MARÍA" encuentra a Maria Rodriguez)', pmWords.names.some((n) => /Mar[ií]a Rodr[ií]guez/.test(n)), true);
        const pmCasa = await pmSearch('casa 12');
        record('buscar por casa: "casa 12" encuentra a quien vive en la 12', pmCasa.n >= 1 && pmCasa.names.some((n) => /12/.test(n)), JSON.stringify(pmCasa.names));
        const pmNone = await pmSearch('zzzz');
        record('sin coincidencias no muestra filas y lo dice', pmNone.n === 0 && /Ningún residente coincide con «zzzz»/.test(pmNone.empty), JSON.stringify(pmNone));
        const pmClear = await pmSearch('');
        equal('al borrar el texto vuelven todos', pmClear.n, pmAll);
        await pmSearch('maria');
        const pmExport = await oikos(`(() => { const m = currentReportModel(true); return { filas: m.tables[0].rows.length, texto: m.tables[0].rows.map((r) => r[0]).join('|'), marcas: /<mark|&lt;mark/.test(JSON.stringify(m)) }; })()`);
        record('el Excel (y la impresion y el PDF) salen solo de quien se busco, sin etiquetas de resaltado: una fila por residente mas la de totales', pmExport.filas >= 2 && pmExport.filas < pmAll + 1 && /Mar[ií]a/.test(pmExport.texto) && !pmExport.marcas, JSON.stringify(pmExport));
        await pmSearch('');

        console.log('\nListado de vecinos con morosidad');
        // Con vecinos de mentira (solo en pantalla, nada se guarda): el seed no tiene cuotas ya vencidas. Los meses son relativos a
        // hoy (de hace 5 a hace 2 meses, siempre vencidos, y uno de hace 14 meses: de otro ano), asi no depende del dia de la prueba.
        await oikos(`(() => {
            const pk = (back) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back); return localDayKey(d).slice(0, 7); };
            const fee = (id, back) => ({ id: 'ml-' + id + '-' + back, type: 'charge', kind: 'fee', period: pk(back), amount: 300, resiId: id, date: pk(back) + '-01T18:00:00.000Z' });
            const pay = (id, amount) => ({ id: 'ml-p-' + id, type: 'income', amount: amount, resiId: id, date: pk(2) + '-20T18:00:00.000Z' });
            const txs = [];
            [14, 5, 4, 3, 2].forEach((b) => txs.push(fee('ml1', b)));
            [5, 4, 3, 2].forEach((b) => txs.push(fee('ml2', b)));
            txs.push(pay('ml2', 600));
            [5, 4, 3, 2].forEach((b) => txs.push(fee('ml3', b)));
            txs.push(pay('ml3', 1200));
            const mk = (id, name, unit, balance) => ({ id: id, name: name, unit: unit, balance: balance, status: 'active', waterUnits: 0 });
            const residents = [mk('ml1', 'Ana Prueba', 'A002', -1500), mk('ml2', 'Beto Prueba', 'A010', -600), mk('ml3', 'Carla Alida', 'A001', 0)];
            window.__mlRealGet = Store.get;
            Store.get = function (k) { return k === 'transactions' ? txs : k === 'residents' ? residents : window.__mlRealGet.call(Store, k); };
        })()`);
        await oikos(`(() => { navigate('reports'); selectReport('mora-list'); })()`);
        await sleep(700);
        const MLJS = `(() => {
            const d = currentReportData;
            const txt = (c) => stripCellHtml(c);
            const money = (t) => { const m = /[\\d,]+\\.\\d{2}/.exec(String(t)); return m ? parseFloat(m[0].replace(/,/g, '')) : 0; };
            const iMeses = d.headers.indexOf('Meses');
            const iMora = d.headers.indexOf('Mora a hoy');
            const iTotal = d.headers.length - 1;
            const out = { headers: d.headers, n: d.rows.length, iMeses, iMora, iTotal };
            out.redOk = d.rows.every((row, r) => { for (let c = 2; c < iMeses; c++) { if ((d.cellStatus[r][c] === 'owed') !== (txt(row[c]) !== '')) return false; } return true; });
            out.rowTotalOk = d.rows.every((row) => { let sum = 0; for (let c = 2; c < iMeses; c++) sum += money(txt(row[c])); if (iMora >= 0) sum += money(txt(row[iMora])); return Math.abs(sum - money(txt(row[iTotal]))) < 0.006; });
            const owedIds = d.rowsMeta.map((m) => m.residentId);
            out.onlyMorosos = owedIds.every((id) => { const r = Store.get('residents').find((x) => String(x.id) === String(id)); const o = r && sisdelOwedOf(r); return !!o && o.total > 0; });
            out.footerOk = (() => { const t = d.totals.map(txt); let ok = Math.abs(money(t[iTotal]) - d.rows.reduce((a, row) => a + money(txt(row[iTotal])), 0)) < 0.006; for (let c = 2; c < iMeses; c++) ok = ok && Math.abs(money(t[c]) - d.rows.reduce((a, row) => a + money(txt(row[c])), 0)) < 0.006; return ok; })();
            out.owedCells = d.cellStatus.reduce((a, row) => a + row.filter((x) => x === 'owed').length, 0);
            out.domRed = document.querySelectorAll('#rep-tbody td.bg-rose-600').length;
            const tds = document.querySelectorAll('#rep-tbody tr:first-child td');
            out.pinned = tds.length > 1 && getComputedStyle(tds[0]).position === 'sticky' && getComputedStyle(tds[1]).position === 'sticky';
            out.filtersShown = getComputedStyle(document.getElementById('rep-moralist-filters')).display !== 'none';
            out.units = d.rows.map((row) => txt(row[0]));
            out.totals = d.rows.map((row) => money(txt(row[iTotal])));
            out.meses = d.rows.map((row) => parseInt(txt(row[iMeses]), 10) || 0);
            out.names = d.rows.map((row) => txt(row[1]));
            out.kpis = d.highlights.map((h) => h.label);
            return out;
        })()`;
        const ml0 = await oikos(MLJS);
        record('el reporte abre con sus filtros, lote y nombre primero, el total al final y al menos un vecino', ml0.n >= 1 && ml0.filtersShown && ml0.headers[0] === 'Lote / Casa' && ml0.headers[1] === 'Nombre' && ml0.headers[ml0.iTotal] === 'Total adeudado' && ml0.iMeses > 2, JSON.stringify(ml0.headers));
        const mlFont = await oikos(`(() => { const tds = document.querySelectorAll('#rep-tbody tr:first-child td'); const a = getComputedStyle(tds[0]); const b = getComputedStyle(tds[1]); return { weight: b.fontWeight, loteWeight: a.fontWeight, ratio: parseFloat(b.fontSize) / parseFloat(a.fontSize) }; })()`);
        record('el nombre del vecino va en negrita y un 20 % mas grande que el lote', Number(mlFont.weight) >= 700 && Number(mlFont.loteWeight) < 700 && Math.abs(mlFont.ratio - 1.2) < 0.02, JSON.stringify(mlFont));
        record('solo salen los dos vecinos con morosidad (quien esta al dia no), con su total y sus meses', ml0.onlyMorosos && ml0.n === 2 && JSON.stringify(ml0.units) === JSON.stringify(['A002', 'A010']) && JSON.stringify(ml0.totals) === JSON.stringify([1500, 600]) && JSON.stringify(ml0.meses) === JSON.stringify([5, 2]), JSON.stringify([ml0.units, ml0.totals, ml0.meses]));
        record('cada mes que debe va en rojo con su monto y los demas en blanco', ml0.redOk && ml0.owedCells >= ml0.n, `${ml0.owedCells} celdas rojas`);
        record('la pantalla pinta de rojo esas celdas', ml0.domRed === ml0.owedCells, `${ml0.domRed} de ${ml0.owedCells}`);
        record('el total de cada vecino es la suma de sus meses (y su mora) y la fila de totales suma las columnas', ml0.rowTotalOk && ml0.footerOk);
        record('el lote y el nombre quedan fijos al desplazarse a la derecha', ml0.pinned);
        // Orden, minimo de meses y buscador
        const mlSet = async (id, value) => { await oikos(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(id === 'ml-search' ? 'input' : 'change')})); })()`); await sleep(id === 'ml-search' ? 450 : 250); return oikos(MLJS); };
        // Ordenar por + sentido: al cambiar "Ordenar por" el sentido pasa al natural (morosidad y dinero: el mayor primero; lote y nombre: de menor a mayor)
        const mlDirValue = () => oikos(`document.getElementById('ml-dir').value`);
        const mlMonths = await mlSet('ml-order', 'months');
        record('por morosidad (meses adeudados): el que mas meses debe primero y el sentido pasa a descendente', JSON.stringify(mlMonths.units) === JSON.stringify(['A002', 'A010']) && mlMonths.meses.every((m, i) => i === 0 || mlMonths.meses[i - 1] >= m) && (await mlDirValue()) === 'desc', JSON.stringify([mlMonths.units, mlMonths.meses]));
        const mlMonthsAsc = await mlSet('ml-dir', 'asc');
        record('con sentido ascendente, el que menos meses debe primero', JSON.stringify(mlMonthsAsc.units) === JSON.stringify(['A010', 'A002']), JSON.stringify(mlMonthsAsc.units));
        const mlDebt = await mlSet('ml-order', 'debt');
        record('por total adeudado: de mayor a menor (los totales no suben) y el sentido pasa a descendente', mlDebt.totals.every((t, i) => i === 0 || mlDebt.totals[i - 1] >= t - 0.006) && (await mlDirValue()) === 'desc', JSON.stringify(mlDebt.totals));
        const mlName = await mlSet('ml-order', 'name');
        record('alfabetico de A a Z: los nombres van en orden y el sentido pasa a ascendente', mlName.names.every((n, i) => i === 0 || mlName.names[i - 1].localeCompare(n, 'es', { sensitivity: 'base', numeric: true }) <= 0) && (await mlDirValue()) === 'asc', JSON.stringify(mlName.names));
        const mlNameDesc = await mlSet('ml-dir', 'desc');
        record('alfabetico de Z a A: los nombres van al reves', mlNameDesc.names.every((n, i) => i === 0 || mlNameDesc.names[i - 1].localeCompare(n, 'es', { sensitivity: 'base', numeric: true }) >= 0) && JSON.stringify(mlNameDesc.names) === JSON.stringify([...mlName.names].reverse()), JSON.stringify(mlNameDesc.names));
        const mlUnit = await mlSet('ml-order', 'unit');
        record('por lote: los lotes van en orden natural (A2 antes que A10)', mlUnit.units.every((u, i) => i === 0 || mlUnit.units[i - 1].localeCompare(u, 'es', { sensitivity: 'base', numeric: true }) <= 0) && (await mlDirValue()) === 'asc', JSON.stringify(mlUnit.units));
        const mlUnitDesc = await mlSet('ml-dir', 'desc');
        record('por lote de mayor a menor', JSON.stringify(mlUnitDesc.units) === JSON.stringify([...mlUnit.units].reverse()), JSON.stringify(mlUnitDesc.units));
        record('el orden y el sentido quedan dichos arriba, en el resumen del reporte', /de mayor a menor/.test(await oikos(`currentReportData.summary`)));
        await mlSet('ml-dir', 'asc');
        const mlMin = await mlSet('ml-min', '3');
        record('"3 meses o mas" deja solo a quien debe tantos', mlMin.n === 1 && mlMin.meses.every((m) => m >= 3), JSON.stringify(mlMin.meses));
        await mlSet('ml-min', '1');
        const mlFirst = ml0.names[0].split(' ')[0];
        const mlFound = await mlSet('ml-search', mlFirst.toLowerCase());
        record('el buscador deja solo a quien coincide, con lo encontrado resaltado y lo dice arriba', mlFound.n >= 1 && mlFound.names.every((n) => n.toLowerCase().includes(mlFirst.toLowerCase())) && (await oikos(`(document.getElementById('rep-tbody').innerHTML.match(/<mark/g) || []).length`)) >= 1 && (await oikos(`currentReportData.summary`)).includes('búsqueda'), JSON.stringify(mlFound.names));
        const mlNone = await mlSet('ml-search', 'zzzz');
        record('sin coincidencias no hay filas y lo dice', mlNone.n === 0 && /Ningún vecino con morosidad coincide/.test(await oikos(`document.getElementById('rep-empty-text').textContent`)));
        await mlSet('ml-search', '');
        // Las cuatro salidas
        const mlOut = await oikos(`(() => {
            const out = {};
            const m = currentReportModel(true);
            out.excelHeaders = m.tables[0].headers.slice(0, 2).concat(m.tables[0].headers.slice(-1));
            const rows = m.tables[0].rows;
            out.excelTotalRow = String(rows[rows.length - 1][0].v !== undefined ? rows[rows.length - 1][0].v : rows[rows.length - 1][0]);
            out.excelRed = rows.reduce((a, r) => a + r.filter((c) => c && typeof c === 'object' && c.s === 4).length, 0);
            out.excelNameBold = rows.slice(0, -1).every((r) => r[1] && typeof r[1] === 'object' && r[1].s === 1);
            out.excelNumbers = rows.slice(0, -1).every((r) => { const last = r[r.length - 1]; const v = last && typeof last === 'object' ? last.v : last; return typeof v === 'number'; });
            const w = currentReportModel(false);
            out.waHeaders = w.tables[0].headers;
            out.waText = SisdelReportExport.whatsappText(w);
            out.fileName = m.fileName;
            // Imprimir y PDF con ventana y archivo de mentira
            const savedOpen = window.open;
            let html = '';
            window.open = () => ({ document: { write: (h) => { html += h; }, close() {} }, print() {} });
            printCurrentReport();
            window.open = savedOpen;
            out.printHasTitle = html.includes('Listado de vecinos con morosidad');
            out.printLegend = html.includes('Rojo: mes adeudado');
            out.printRed = (html.match(/background:#dc2626/g) || []).length;
            out.printNameBold = html.includes('font-weight:700;font-size:14.4px');
            const Orig = window.jspdf.jsPDF;
            const texts = [];
            let saved = '';
            window.jspdf.jsPDF = function () { const d = new (Function.prototype.bind.apply(Orig, [null].concat(Array.from(arguments))))(); const t = d.text.bind(d); d.text = function (x) { texts.push(Array.isArray(x) ? x.join(' ') : String(x)); return t.apply(null, arguments); }; d.save = function (n) { saved = n; }; return d; };
            let pdfError = '';
            try { downloadCurrentReportPDF(); } catch (e) { pdfError = String(e && e.message || e); }
            window.jspdf.jsPDF = Orig;
            out.pdfError = pdfError;
            out.pdfSaved = saved;
            out.pdfFooter = texts.some((x) => /^Página 1 de \\d+$/.test(x));
            out.pdfLegend = texts.some((x) => x.includes('Rojo: mes adeudado'));
            out.pdfTitle = texts.some((x) => x === 'Listado de vecinos con morosidad');
            return out;
        })()`);
        record('Excel: titulos, una fila de totales al final, montos como numero y los meses adeudados con relleno rojo', mlOut.excelHeaders[0] === 'Lote / Casa' && mlOut.excelHeaders[1] === 'Nombre' && mlOut.excelHeaders[2] === 'Total adeudado' && mlOut.excelTotalRow === 'TOTAL' && mlOut.excelNumbers && mlOut.excelRed === ml0.owedCells, JSON.stringify([mlOut.excelHeaders, mlOut.excelTotalRow, mlOut.excelRed]));
        record('el nombre del vecino va en negrita en el Excel y en la impresion (14.4 px = 12 px mas un 20 %)', mlOut.excelNameBold && mlOut.printNameBold, JSON.stringify([mlOut.excelNameBold, mlOut.printNameBold]));
        record('WhatsApp: resumen con lote, nombre, meses y total adeudado', JSON.stringify(mlOut.waHeaders) === JSON.stringify(['Lote', 'Nombre', 'Meses', 'Total adeudado']) && /Listado de vecinos con morosidad/.test(mlOut.waText) && /Total adeudado/.test(mlOut.waText), mlOut.waText.slice(0, 120));
        record('Imprimir: titulo, leyenda de colores y las celdas adeudadas en rojo', mlOut.printHasTitle && mlOut.printLegend && mlOut.printRed >= ml0.owedCells, JSON.stringify([mlOut.printHasTitle, mlOut.printLegend, mlOut.printRed, ml0.owedCells]));
        record('PDF: se genera sin errores, con el nombre del reporte, la leyenda y "Pagina 1 de N" en el pie', !mlOut.pdfError && /listado-de-vecinos-con-morosidad/.test(mlOut.pdfSaved) && mlOut.pdfFooter && mlOut.pdfLegend && mlOut.pdfTitle, JSON.stringify([mlOut.pdfError, mlOut.pdfSaved, mlOut.pdfFooter, mlOut.pdfLegend, mlOut.pdfTitle]));
        await oikos(`(() => { Store.get = window.__mlRealGet; renderCurrentReport(); })()`);

        console.log('\nImpresion de marbetes por fase');
        // Los vehiculos son los del seed (Ana con dos y Maria con uno) y llegan de verdad por el puente de finanzas.html
        // (window.sisdelVehicles); los residentes son de mentira (solo en pantalla, nada se guarda), con fases, uno sin vehiculo
        // con HTML en el nombre, uno sin fase y uno finiquitado (no sale).
        await oikos(`(() => {
            const mk = (id, name, unit, fase, status) => ({ id: id, name: name, unit: unit, fase: fase, status: status || 'active', waterUnits: 0, balance: 0 });
            const residents = [mk('u-ana', 'Ana García', 'Casa 12', 'B'), mk('u-maria', 'María Rodríguez', 'Casa 23', 'A'), mk('mb-x', 'Sin <b>Carro</b>', 'Casa 5', 'A'), mk('mb-y', 'Sin Fase', 'Casa 9', ''), mk('mb-z', 'Ya Finiquitado', 'Casa 1', 'A', 'closed')];
            residents[1].balance = -100000;   // Maria debe (en mora): su marbete sale en rojo; Ana esta al dia: en verde
            window.__mbRealGet = Store.get;
            Store.get = function (k) { return k === 'residents' ? residents : window.__mbRealGet.call(Store, k); };
            navigate('reports');
            selectReport('marbetes');
        })()`);
        await waitFor('los vehiculos de los vecinos llegan de SISDEL por el puente de finanzas.html', async () => oikos(`Array.isArray(window.sisdelVehicleList) && window.sisdelVehicleList.length >= 3 && currentReportData && /marbete/i.test(currentReportData.title) && !/Cargando/.test(currentReportData.notice || '') && currentReportData.rows.some((r) => /P-987XYZ/.test(r[4]))`));
        const MBJS = `(() => {
            const d = currentReportData;
            const txt = (c) => stripCellHtml(c);
            return {
                headers: d.headers,
                screenHeaders: Array.from(document.querySelectorAll('#rep-thead th')).map((th) => th.textContent.trim()),
                rows: d.rows.map((r) => r.map(txt)),
                subtotals: d.rowsMeta.map((m, i) => (m && m.kind === 'subtotal' ? i : -1)).filter((i) => i >= 0),
                totals: d.totals.map(txt),
                notice: d.notice || '',
                kpis: d.highlights.map((h) => h.value + ' ' + h.label),
                filtersShown: getComputedStyle(document.getElementById('rep-marbetes-filters')).display !== 'none',
                faseOptions: Array.from(document.getElementById('mb-fase').options).map((o) => o.textContent),
                domRows: document.querySelectorAll('#rep-tbody tr').length,
                domCells: document.querySelectorAll('#rep-tbody tr:first-child td').length,
                tbodyHtml: document.getElementById('rep-tbody').innerHTML
            };
        })()`;
        const mb0 = await oikos(MBJS);
        const mbRow = (no, fase, unit, name, plate, veh, color, code, estado) => [no, fase, unit, name, plate, veh, color, code, estado, ''];
        equal('una fila por vehiculo, agrupadas por fase (A, B y Sin fase al final), por lote en cada fase, con su estado de pago y un subtotal por fase; el finiquitado no sale', mb0.rows, [
            mbRow('1', 'Fase A', 'Casa 5', 'Sin <b>Carro</b>', 'Sin vehículo registrado', '', '', '', 'Al día'),
            mbRow('2', 'Fase A', 'Casa 23', 'María Rodríguez', 'P-111MOR', 'Honda Fit', 'Gris', 'MARTEST3', 'En mora'),
            mbRow('', 'Fase A', 'Subtotal', '2 residentes (1 sin vehículo)', '1 vehículo', '', '', '1 con código', '1 en mora'),
            mbRow('1', 'Fase B', 'Casa 12', 'Ana García', 'P-222BBB', 'Mazda 3', 'Rojo', 'MARTEST2', 'Al día'),
            mbRow('2', 'Fase B', 'Casa 12', 'Ana García', 'P-987XYZ', 'Toyota Corolla', 'Blanco', 'MARTEST1', 'Al día'),
            mbRow('', 'Fase B', 'Subtotal', '1 residente', '2 vehículos', '', '', '2 con código', '0 en mora'),
            mbRow('1', 'Sin fase', 'Casa 9', 'Sin Fase', 'Sin vehículo registrado', '', '', '', 'Al día'),
            mbRow('', 'Sin fase', 'Subtotal', '1 residente (1 sin vehículo)', '0 vehículos', '', '', '', '0 en mora')
        ]);
        equal('las filas de subtotal van marcadas y la fila de totales suma todo', [mb0.subtotals, mb0.totals], [[2, 5, 7], ['TOTAL', '3 fases', '', '4 residentes (2 sin vehículo)', '3 vehículos', '', '', '3 con código', '1 en mora', '']]);
        equal('arriba, en grande: marbetes, residentes con y sin vehiculo y fases', mb0.kpis, ['3 marbetes (vehículos registrados)', '2 residentes con vehículo', '2 residentes sin vehículo registrado', '3 fases']);
        record('en pantalla no sale la columna de la firma (solo al imprimir, en el PDF y en Excel), y los filtros se ven', mb0.filtersShown && mb0.screenHeaders.length === 9 && !mb0.screenHeaders.includes('Recibido (firma)') && mb0.headers[9] === 'Recibido (firma)' && mb0.headers[8] === 'Estado de pago' && mb0.domCells === 9 && mb0.domRows === 8, JSON.stringify(mb0.screenHeaders));
        record('el nombre con HTML se escapa al pintarlo (no se vuelve HTML)', mb0.tbodyHtml.includes('Sin &lt;b&gt;Carro&lt;/b&gt;') && !mb0.tbodyHtml.includes('<b>Carro'));
        equal('la flecha de fase ofrece las que existen y "Sin fase"', mb0.faseOptions, ['Todas las fases', 'Fase A', 'Fase B', 'Sin fase']);
        record('con vehiculos registrados no hay aviso', mb0.notice === '', mb0.notice);
        const mbSet = async (id, value) => { await oikos(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(id === 'mb-search' ? 'input' : 'change')})); })()`); await sleep(id === 'mb-search' ? 450 : 250); return oikos(MBJS); };
        const mbA = await mbSet('mb-fase', 'A');
        equal('una fase: solo sus filas y su subtotal', mbA.rows.map((r) => r[1] + ' ' + r[2]), ['Fase A Casa 5', 'Fase A Casa 23', 'Fase A Subtotal']);
        const mbNoFase = await mbSet('mb-fase', '__none__');
        equal('"Sin fase": solo los que no tienen fase', mbNoFase.rows.map((r) => r[2]), ['Casa 9', 'Subtotal']);
        await mbSet('mb-fase', '');
        const mbWith = await mbSet('mb-show', 'with');
        equal('solo los que tienen vehiculo', mbWith.rows.filter((r) => r[0]).map((r) => r[4]), ['P-111MOR', 'P-222BBB', 'P-987XYZ']);
        const mbWithout = await mbSet('mb-show', 'without');
        equal('solo los que no tienen vehiculo', mbWithout.rows.filter((r) => r[0]).map((r) => r[2]), ['Casa 5', 'Casa 9']);
        await mbSet('mb-show', 'all');
        const mbPlate = await mbSet('mb-search', 'p-987');
        record('el buscador encuentra por placa (sin importar mayusculas), con lo encontrado resaltado', mbPlate.rows.filter((r) => r[0]).every((r) => r[3] === 'Ana García') && mbPlate.rows.some((r) => r[4] === 'P-987XYZ') && /<mark/.test(mbPlate.tbodyHtml), JSON.stringify(mbPlate.rows.map((r) => r[3])));
        const mbBrand = await mbSet('mb-search', 'honda');
        equal('y por marca', mbBrand.rows.filter((r) => r[0]).map((r) => r[3]), ['María Rodríguez']);
        const mbNone = await mbSet('mb-search', 'zzzz');
        record('sin coincidencias no hay filas y lo dice', mbNone.rows.length === 0 && /Ningún residente coincide/.test(await oikos(`document.getElementById('rep-empty-text').textContent`)));
        await mbSet('mb-search', '');
        const mbName = await mbSet('mb-order', 'name');
        equal('en orden alfabetico dentro de cada fase', mbName.rows.filter((r) => r[1] === 'Fase A' && r[0]).map((r) => r[3]), ['María Rodríguez', 'Sin <b>Carro</b>']);
        await mbSet('mb-order', 'unit');
        // Vista "Los marbetes" (la de siempre): las tarjetas como "Mi Marbete" del vecino, solo de los vehiculos, con su QR
        await mbSet('mb-view', 'cards');
        await waitFor('la vista de marbetes dibuja el QR de cada vehiculo con la libreria de vendor/', async () => oikos(`document.querySelectorAll('#rep-mb-cards .mbc .mbc-qr svg').length === 3`));
        const mbCards = await oikos(`(() => {
            const box = document.getElementById('rep-mb-cards');
            const cards = Array.from(box.querySelectorAll('.mbc'));
            const first = cards[0];
            const name = first.querySelector('.mbc-name');
            const detail = first.querySelector('.mbc-detail');
            const esc = marbeteCardHtml({ plate: '<i>X</i>', name: '<b>Nombre</b>', unit: 'A1', fase: 'Fase A', code: 'C1', brand: '<s>', model: '', color: '' }, '');
            const bands = cards.map((c) => { const b = c.querySelector('.mbc-band'); const p = c.querySelector('.mbc-plate'); const cr = c.getBoundingClientRect(); const br = b.getBoundingClientRect(); return { bg: getComputedStyle(b).backgroundColor, full: Math.abs(br.width - c.clientWidth) < 1.5 && Math.abs(br.left - cr.left) < 1.5 && Math.abs(br.top - cr.top) < 1.5, ratio: br.height / parseFloat(getComputedStyle(p).fontSize), plate: p.textContent }; });
            return {
                shown: !box.classList.contains('hidden') && document.getElementById('rep-table-wrap').classList.contains('hidden'),
                plates: cards.map((c) => c.querySelector('.mbc-plate').textContent),
                kinds: cards.map((c) => c.querySelector('.mbc-kind').textContent.toUpperCase()),
                where: cards.map((c) => c.querySelector('.mbc-where').textContent),
                details: cards.map((c) => c.querySelector('.mbc-detail').textContent),
                bands: bands,
                status: cards.map((c) => !!c.querySelector('.mbc-status')),
                nameBlock: getComputedStyle(name).display === 'block' && getComputedStyle(name).textAlign === 'center' && name.getBoundingClientRect().top > detail.getBoundingClientRect().top + 2,
                legend: (box.querySelector('.mb-legend') || {}).textContent || '',
                asOf: currentReportData.cardsAsOf,
                headers: Array.from(box.querySelectorAll('h4')).map((h) => h.textContent.replace(/\\s+/g, ' ').trim()),
                nameWeight: getComputedStyle(name).fontWeight,
                nameRatio: parseFloat(getComputedStyle(name).fontSize) / parseFloat(getComputedStyle(detail).fontSize),
                bg: getComputedStyle(first).backgroundColor,
                escaped: esc.includes('&lt;b&gt;Nombre') && !esc.includes('<b>Nombre') && esc.includes('&lt;i&gt;X') && !esc.includes('<s>')
            };
        })()`);
        record('en pantalla se ven los marbetes (y no la tabla): uno por vehiculo, agrupados por fase', mbCards.shown && JSON.stringify(mbCards.plates) === JSON.stringify(['P-111MOR', 'P-222BBB', 'P-987XYZ']) && /^Fase A · 1 marbete · 1 residente sin vehículo registrado$/.test(mbCards.headers[0]) && /^Fase B · 2 marbetes$/.test(mbCards.headers[1]), JSON.stringify([mbCards.plates, mbCards.headers]));
        record('cada marbete como el del vecino: placa, MARBETE VEHICULAR, lote y fase, y "Vehiculo: ... Residente: ..." en fondo oscuro', mbCards.kinds.every((k) => k === 'MARBETE VEHICULAR') && JSON.stringify(mbCards.where) === JSON.stringify(['Casa 23 · Fase A', 'Casa 12 · Fase B', 'Casa 12 · Fase B']) && mbCards.details[0] === 'Vehículo: Honda Fit Gris. Residente: María Rodríguez' && mbCards.bg === 'rgb(30, 41, 59)', JSON.stringify(mbCards));
        record('el nombre del residente va en negrita y un 25 % mas grande, en su propia linea y centrado', Number(mbCards.nameWeight) >= 700 && Math.abs(mbCards.nameRatio - 1.25) < 0.02 && mbCards.nameBlock, JSON.stringify([mbCards.nameWeight, mbCards.nameRatio, mbCards.nameBlock]));
        record('la placa va en una franja celeste (tambien la de quien esta en mora) que cubre TODO el ancho del marbete arriba y mide el doble de la letra de la placa', mbCards.bands.every((b) => b.bg === 'rgb(56, 189, 248)' && b.full && Math.abs(b.ratio - 2) < 0.05), JSON.stringify(mbCards.bands));
        record('el marbete no dice si el vecino esta en mora (lo muestra la garita al leer el QR) y la nota de arriba lo explica', mbCards.status.every((x) => x === false) && /lo muestra la garita al leer su código QR/.test(mbCards.legend), JSON.stringify([mbCards.status, mbCards.legend]));
        record('los textos del marbete se escapan', mbCards.escaped);
        const mbCardOut = await oikos(`(async () => {
            const out = {};
            const savedOpen = window.open;
            let html = '';
            window.open = () => ({ document: { write: (h) => { html += h; }, open() { html = ''; }, close() {} }, print() {} });
            await printCurrentReport();
            window.open = savedOpen;
            out.print = { cards: (html.match(/<div class="mbc">/g) || []).length, pages: (html.match(/<section class="fase-page">/g) || []).length, qr: (html.match(/aria-label="Código QR del marbete"/g) || []).length, oficio: html.includes('@page{size:8.5in 13in'), grid: html.includes('repeat(3,62mm)'), name: html.includes('Residente: <b class="mbc-name">Ana García</b>'), big: html.includes('.mbc-name{font-weight:700;font-size:1.25em'), noTable: !html.includes('Recibido (firma)'), celeste: (html.match(/<div class="mbc-band">/g) || []).length === 3 && html.includes('.mbc-band{background:#38bdf8;color:#0f172a;width:100%;height:2em;'), noState: !/mbc-band-late|mbc-band-ok|En mora al|Al día al/.test(html) };
            const Orig = window.jspdf.jsPDF;
            const texts = [];
            const sizes = {};
            let saved = '';
            let rects = 0;
            window.jspdf.jsPDF = function () { const d = new (Function.prototype.bind.apply(Orig, [null].concat(Array.from(arguments))))(); const t = d.text.bind(d); d.text = function (x) { const v = Array.isArray(x) ? x.join(' ') : String(x); texts.push(v); sizes[v] = d.getFontSize() + (d.getFont().fontStyle === 'bold' ? 'b' : ''); return t.apply(null, arguments); }; const r = d.rect.bind(d); d.rect = function () { rects++; return r.apply(null, arguments); }; d.save = function (n) { saved = n; }; return d; };
            let pdfError = '';
            try { await downloadCurrentReportPDF(); } catch (e) { pdfError = String(e && e.message || e); }
            window.jspdf.jsPDF = Orig;
            out.pdf = { error: pdfError, saved: saved, plates: ['P-111MOR', 'P-222BBB', 'P-987XYZ'].every((p) => texts.includes(p)), kind: texts.filter((x) => x === 'MARBETE VEHICULAR').length, name: sizes['Ana García'], label: Object.keys(sizes).filter((k) => /Residente:$/.test(k)).map((k) => sizes[k])[0], pages: texts.some((x) => /^Página 1 de 2$/.test(x)), qrRects: rects, noState: !texts.some((x) => /^(EN MORA|AL DÍA) AL /.test(x)) };
            out.excelHeaders = currentReportModel(true).tables[0].headers;
            return out;
        })()`);
        record('Imprimir con la vista de marbetes saca los marbetes (no la tabla): 3, con su QR, una fase por hoja de oficio, 3 x 3', mbCardOut.print.cards === 3 && mbCardOut.print.pages === 2 && mbCardOut.print.qr === 3 && mbCardOut.print.oficio && mbCardOut.print.grid && mbCardOut.print.name && mbCardOut.print.big && mbCardOut.print.noTable && mbCardOut.print.celeste && mbCardOut.print.noState, JSON.stringify(mbCardOut.print));
        record('PDF con la vista de marbetes: los 3 marbetes con su QR dibujado, el nombre en negrita de 10 pt (8 pt el texto: un 25 % mas) y "Pagina 1 de 2"', !mbCardOut.pdf.error && /^marbetes-villa-ferrer-/.test(mbCardOut.pdf.saved) && mbCardOut.pdf.plates && mbCardOut.pdf.kind === 3 && mbCardOut.pdf.name === '10b' && mbCardOut.pdf.label === '8' && mbCardOut.pdf.pages && mbCardOut.pdf.qrRects > 100 && mbCardOut.pdf.noState, JSON.stringify(mbCardOut.pdf));
        equal('Excel sigue siendo el listado de control', mbCardOut.excelHeaders, mb0.headers);
        // Vista "Listado de control": la tabla, con el nombre en negrita y un 25 % mas grande, y sus salidas
        await mbSet('mb-view', 'list');
        const mbList = await oikos(`(() => {
            const tds = document.querySelectorAll('#rep-tbody tr:nth-child(2) td');
            return { tableShown: !document.getElementById('rep-table-wrap').classList.contains('hidden') && document.getElementById('rep-mb-cards').classList.contains('hidden'), weight: getComputedStyle(tds[3]).fontWeight, ratio: parseFloat(getComputedStyle(tds[3]).fontSize) / parseFloat(getComputedStyle(tds[0]).fontSize) };
        })()`);
        record('con el listado se ve la tabla y el nombre del residente va en negrita y un 25 % mas grande', mbList.tableShown && Number(mbList.weight) >= 700 && Math.abs(mbList.ratio - 1.25) < 0.02, JSON.stringify(mbList));
        // Las salidas del listado: Excel, imprimir y PDF
        const mbOut = await oikos(`(() => {
            const out = {};
            const m = currentReportModel(true);
            const rows = m.tables[0].rows;
            const v = (c) => (c && typeof c === 'object' ? c.v : c);
            out.excelHeaders = m.tables[0].headers;
            out.excelNo = v(rows[0][0]);
            out.excelPlateBold = rows[1][4] && typeof rows[1][4] === 'object' && rows[1][4].s === 1 && rows[1][3] && typeof rows[1][3] === 'object' && rows[1][3].s === 1;
            out.excelSubtotalBold = rows[2].every((c) => c && typeof c === 'object' && c.s === 1);
            out.excelTotal = v(rows[rows.length - 1][0]);
            out.fileName = m.fileName;
            const savedOpen = window.open;
            let html = '';
            window.open = () => ({ document: { write: (h) => { html += h; }, close() {} }, print() {} });
            printCurrentReport();
            out.print = { title: html.includes('Impresión de marbetes por fase'), firma: html.includes('Recibido (firma)'), subtotal: html.includes('Subtotal'), escaped: html.includes('Sin &lt;b&gt;Carro') && !html.includes('<b>Carro'), oficio: html.includes('@page{size:13in 8.5in') };
            window.open = savedOpen;
            const Orig = window.jspdf.jsPDF;
            const texts = [];
            let saved = '';
            window.jspdf.jsPDF = function () { const d = new (Function.prototype.bind.apply(Orig, [null].concat(Array.from(arguments))))(); const t = d.text.bind(d); d.text = function (x) { texts.push(Array.isArray(x) ? x.join(' ') : String(x)); return t.apply(null, arguments); }; d.save = function (n) { saved = n; }; return d; };
            let pdfError = '';
            try { downloadCurrentReportPDF(); } catch (e) { pdfError = String(e && e.message || e); }
            window.jspdf.jsPDF = Orig;
            out.pdf = { error: pdfError, saved: saved, title: texts.some((x) => x === 'Impresión de marbetes por fase'), footer: texts.some((x) => /^Página 1 de \\d+$/.test(x)) };
            const w = currentReportModel(false);
            out.waHeaders = w.tables[0].headers;
            return out;
        })()`);
        record('Excel: las diez columnas (con el estado de pago y la firma), el No. como numero, el nombre, la placa y los subtotales en negrita y la fila TOTAL', JSON.stringify(mbOut.excelHeaders) === JSON.stringify(mb0.headers) && mbOut.excelNo === 1 && mbOut.excelPlateBold && mbOut.excelSubtotalBold && mbOut.excelTotal === 'TOTAL' && /^impresion-de-marbetes-por-fase/.test(mbOut.fileName), JSON.stringify(mbOut));
        record('Imprimir: oficio horizontal con el titulo, la columna de la firma, los subtotales y los nombres escapados', Object.values(mbOut.print).every(Boolean), JSON.stringify(mbOut.print));
        record('PDF: se genera sin errores, con el titulo y "Pagina 1 de N"', !mbOut.pdf.error && /^impresion-de-marbetes-por-fase/.test(mbOut.pdf.saved) && mbOut.pdf.title && mbOut.pdf.footer, JSON.stringify(mbOut.pdf));
        equal('WhatsApp: resumen con fase, lote, residente y placa (sin el codigo del marbete)', mbOut.waHeaders, ['Fase', 'Lote', 'Residente', 'Placa']);
        await oikos(`(() => { Store.get = window.__mbRealGet; renderCurrentReport(); })()`);
        equal('en los demas reportes vuelve la tabla (los marbetes solo se ven en este)', await oikos(`(() => { selectReport('income'); return [document.getElementById('rep-table-wrap').classList.contains('hidden'), document.getElementById('rep-mb-cards').classList.contains('hidden')]; })()`), [false, true]);

        console.log('\nGenerar marbete (menu de cada residente)');
        // Ana tiene dos vehiculos en el seed (llegan por el puente de verdad); se prueban la ventana, Imprimir, el PDF y WhatsApp
        // (en la computadora: descarga y chat del residente; en el celular: compartir el PDF), y un residente sin vehiculo
        await oikos(`navigate('residents')`);
        record('el menu de cada residente trae "Generar marbete"', await oikos(`document.querySelectorAll('#residents-table-body button[onclick="openMarbete(this.dataset.id)"]').length > 0 && !!document.querySelector('#residents-table-body button[onclick="openMarbete(this.dataset.id)"][data-id="u-ana"]')`));
        await oikos(`openMarbete('u-ana')`);
        await waitFor('la ventana muestra los dos marbetes de Ana, cada uno con su QR', async () => oikos(`document.querySelectorAll('#mbm-body .mbc .mbc-qr svg').length === 2`));
        const mbm = await oikos(`(() => ({
            open: marbeteModalOpen(),
            info: document.getElementById('mbm-info').textContent,
            plates: Array.from(document.querySelectorAll('#mbm-body .mbc-plate')).map((p) => p.textContent),
            names: Array.from(document.querySelectorAll('#mbm-body .mbc-name')).map((n) => n.textContent),
            bands: Array.from(document.querySelectorAll('#mbm-body .mbc')).every((c) => { const b = c.querySelector('.mbc-band'); return !!b && getComputedStyle(b).backgroundColor === 'rgb(56, 189, 248)' && Math.abs(b.getBoundingClientRect().width - c.clientWidth) < 1.5; }),
            actions: !document.getElementById('mbm-actions').classList.contains('hidden') && ['mbm-print', 'mbm-pdf', 'mbm-wa'].every((id) => !!document.getElementById(id))
        }))()`);
        record('con su placa en su franja, su nombre y los tres botones (Imprimir, Descargar PDF y Enviar por WhatsApp)', mbm.open && /Ana García/.test(mbm.info) && JSON.stringify(mbm.plates) === JSON.stringify(['P-222BBB', 'P-987XYZ']) && mbm.names.every((n) => n === 'Ana García') && mbm.bands && mbm.actions, JSON.stringify(mbm));
        const mbmOut = await oikos(`(async () => {
            const out = {};
            const savedOpen = window.open;
            let html = '';
            window.open = () => ({ document: { write: (h) => { html += h; }, open() { html = ''; }, close() {} }, print() {} });
            await printResidentMarbete();
            out.print = { cards: (html.match(/<div class="mbc">/g) || []).length, qr: (html.match(/aria-label="Código QR del marbete"/g) || []).length, oficio: html.includes('@page{size:8.5in 13in') };
            // PDF: un marbete por pagina, del tamano del marbete
            const Orig = window.jspdf.jsPDF;
            const pdf = { saved: '', pages: 0, size: null, texts: [] };
            window.jspdf.jsPDF = function () { const d = new (Function.prototype.bind.apply(Orig, [null].concat(Array.from(arguments))))(); const t = d.text.bind(d); d.text = function (x) { pdf.texts.push(Array.isArray(x) ? x.join(' ') : String(x)); return t.apply(null, arguments); }; d.save = function (n) { pdf.saved = n; pdf.pages = d.internal.getNumberOfPages(); pdf.size = [Math.round(d.internal.pageSize.getWidth()), Math.round(d.internal.pageSize.getHeight())]; }; return d; };
            await downloadResidentMarbetePDF();
            window.jspdf.jsPDF = Orig;
            out.pdf = { saved: pdf.saved, pages: pdf.pages, size: pdf.size, plates: ['P-222BBB', 'P-987XYZ'].every((p) => pdf.texts.includes(p)) };
            // WhatsApp en la computadora (no se pueden compartir archivos): se descarga el PDF y se abre el chat de Ana con el texto
            const savedCan = Object.getOwnPropertyDescriptor(navigator, 'canShare');
            const savedShare = Object.getOwnPropertyDescriptor(navigator, 'share');
            Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
            const savedClick = HTMLAnchorElement.prototype.click;
            const downloads = [];
            HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
            let url = '';
            window.open = (u) => { url = String(u); return {}; };
            await sendResidentMarbeteWhatsApp();
            out.desk = { downloads: downloads.slice(), url: url, text: decodeURIComponent((url.split('text=')[1] || '').replace(/\\+/g, ' ')) };
            // WhatsApp en el celular: se comparte el PDF (el telefono lo adjunta en WhatsApp)
            let shared = null;
            Object.defineProperty(navigator, 'canShare', { value: (d) => !!(d && d.files && d.files.length), configurable: true });
            Object.defineProperty(navigator, 'share', { value: async (d) => { shared = d; }, configurable: true });
            url = '';
            downloads.length = 0;
            await sendResidentMarbeteWhatsApp();
            out.phone = shared ? { name: shared.files[0].name, type: shared.files[0].type, size: shared.files[0].size, text: shared.text, opened: url, downloads: downloads.length } : null;
            HTMLAnchorElement.prototype.click = savedClick;
            window.open = savedOpen;
            if (savedCan) Object.defineProperty(navigator, 'canShare', savedCan); else delete navigator.canShare;
            if (savedShare) Object.defineProperty(navigator, 'share', savedShare); else delete navigator.share;
            return out;
        })()`);
        record('Imprimir saca los dos marbetes con su QR en la hoja de oficio', mbmOut.print.cards === 2 && mbmOut.print.qr === 2 && mbmOut.print.oficio, JSON.stringify(mbmOut.print));
        record('Descargar PDF: un marbete por pagina, del tamano del marbete (72 x 106 mm), con el nombre del residente en el archivo', /^marbete-casa-12-ana-garcia\.pdf$/.test(mbmOut.pdf.saved) && mbmOut.pdf.pages === 2 && JSON.stringify(mbmOut.pdf.size) === JSON.stringify([72, 106]) && mbmOut.pdf.plates, JSON.stringify(mbmOut.pdf));
        record('WhatsApp en la computadora: descarga el PDF y abre el chat de Ana con sus placas y el codigo de cada marbete', mbmOut.desk.downloads.length === 1 && /\.pdf$/.test(mbmOut.desk.downloads[0]) && /50255555678/.test(mbmOut.desk.url) && /Hola Ana García/.test(mbmOut.desk.text) && /P-222BBB/.test(mbmOut.desk.text) && /MARTEST2/.test(mbmOut.desk.text) && /MARTEST1/.test(mbmOut.desk.text), JSON.stringify(mbmOut.desk).slice(0, 300));
        record('WhatsApp en el celular: comparte el PDF (WhatsApp lo adjunta) con el texto, sin descargar ni abrir otra ventana', !!mbmOut.phone && /\.pdf$/.test(mbmOut.phone.name) && mbmOut.phone.type === 'application/pdf' && mbmOut.phone.size > 2000 && /P-987XYZ/.test(mbmOut.phone.text) && mbmOut.phone.opened === '' && mbmOut.phone.downloads === 0, JSON.stringify(mbmOut.phone));
        // Un residente sin vehiculo: lo dice y ofrece agregar la placa en su ficha
        const mbmNone = await oikos(`(() => {
            closeModal('modal-marbete');
            const realGet = Store.get;
            Store.get = function (k) { return k === 'residents' ? realGet.call(Store, k).concat([{ id: 'mb-sin-vehiculo', name: 'Sin <b>Vehiculo</b>', unit: 'Casa 99', status: 'active', balance: 0 }]) : realGet.call(Store, k); };
            openMarbete('mb-sin-vehiculo');
            const out = { text: document.getElementById('mbm-body').textContent, add: !!document.getElementById('mbm-add-plate'), actionsHidden: document.getElementById('mbm-actions').classList.contains('hidden'), info: document.getElementById('mbm-info').innerHTML };
            closeModal('modal-marbete');
            Store.get = realGet;
            return out;
        })()`);
        record('sin vehiculo: lo dice, ofrece agregar la placa en su ficha, no muestra los botones y el nombre se escapa', /no tiene vehículos registrados/.test(mbmNone.text) && mbmNone.add && mbmNone.actionsHidden && mbmNone.info.includes('&lt;b&gt;Vehiculo') && !mbmNone.info.includes('<b>'), JSON.stringify(mbmNone));

        console.log('\nGasto: boton "Crear nueva categoria"');
        const catOut = await oikos(`(() => {
            navigate('accounting'); openModal('modal-expense');
            const d = (id) => document.getElementById(id);
            const list = () => (Store.get('settings').customExpenseConcepts || []).filter((c) => c === 'Fumigación de Áreas Verdes').length;
            const before = { boton: d('exp-cat-new-btn').offsetParent !== null, abierto: !d('exp-cat-new').classList.contains('hidden') };
            d('exp-cat-new-btn').click();
            const opened = [!d('exp-cat-new').classList.contains('hidden'), document.activeElement === d('exp-cat-new-name')];
            d('exp-cat-new-name').value = '  Fumigación de   Áreas Verdes ';
            const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            d('exp-cat-new-name').dispatchEvent(enter);
            const created = { enterNoEnvia: enter.defaultPrevented, abierto: !d('exp-cat-new').classList.contains('hidden'), categoria: d('exp-concept-input').value, veces: list() };
            d('exp-cat-new-btn').click(); d('exp-cat-new-name').value = 'FUMIGACION DE AREAS VERDES'; checkNewExpCategory();
            const aviso = d('exp-cat-new-msg').textContent;
            d('exp-concept-input').value = ''; saveNewExpCategory();
            const again = { categoria: d('exp-concept-input').value, veces: list() };
            d('exp-concept-input').value = 'fumi'; filterExpCategories();
            const sugerida = [...document.querySelectorAll('#exp-categ-dropdown > div')].map((x) => x.textContent.trim())[0];
            closeModal('modal-expense');
            return { before, opened, created, aviso, again, sugerida };
        })()`);
        equal('el Gasto trae el boton y el recuadro empieza cerrado; el boton lo abre con el foco en el nombre', [catOut.before, catOut.opened], [{ boton: true, abierto: false }, [true, true]]);
        equal('Enter guarda la categoria (sin enviar el gasto) con los espacios limpios y la deja elegida', catOut.created, { enterNoEnvia: true, abierto: false, categoria: 'Fumigación de Áreas Verdes', veces: 1 });
        equal('la misma sin acentos ni mayusculas avisa, se elige la que ya existe y no se repite', [catOut.aviso, catOut.again], ['Ya existe «Fumigación de Áreas Verdes»: al guardar se elige esa.', { categoria: 'Fumigación de Áreas Verdes', veces: 1 }]);
        equal('y sale en las sugerencias de Categoria', catOut.sugerida, 'Fumigación de Áreas Verdes');
        equal('se guarda en la nube', await idle(), 'ok');
        equal('la categoria queda en la configuracion del condominio (la ven todos los equipos)', ((await condoRef.collection('finanzas_config').doc('oikos_settings').get()).data().customExpenseConcepts || []).filter((c) => c === 'Fumigación de Áreas Verdes').length, 1);

        console.log('\nResidente: la X de cerrar fija y las placas de sus vehiculos al editarlo');
        // El puente de placas es el real (finanzas.html, con vehiculos.ver / crear / eliminar del administrador) y la base la del emulador
        const dbPlates = async (uid) => (await condoRef.collection('vehiculos').where('userId', '==', uid).get()).docs.map((d) => d.get('plate')).sort();
        await oikos(`(() => { window.confirm = () => true; navigate('residents'); editResident('u-ana'); return true; })()`);
        await page.waitFor(`(() => { try { const d = document.querySelector('#frameBox iframe').contentWindow.document; return d.querySelectorAll('#res-plates-list [data-plate]').length > 0; } catch (e) { return false; } })()`, 'las placas de Ana en su formulario', 20000);
        const plUi = () => oikos(`(() => { const d = (id) => document.getElementById(id); const vis = (id) => !!d(id) && !d(id).classList.contains('hidden');
            return { edit: vis('res-plates-edit'), nuevo: vis('res-plates-new'), fila: vis('res-plates-add-row'), placas: [...document.querySelectorAll('#res-plates-list [data-plate]')].map((x) => x.dataset.plate).sort(), quitar: document.querySelectorAll('#res-plates-list .res-plate-del').length, msg: d('res-plates-msg').textContent }; })()`);
        const anaPlates = await dbPlates('u-ana');
        const pl0 = await plUi();
        equal('editar a un vecino muestra sus placas de verdad (las de la base), con agregar y quitar', [pl0.edit, pl0.nuevo, pl0.fila, pl0.placas, pl0.quitar], [true, false, true, anaPlates, anaPlates.length]);
        await oikos(`(() => { document.getElementById('res-plate-add').value = ' q-555 tst '; resAddPlate(); })()`);
        const added = await waitFor('la placa nueva queda como vehiculo del vecino en la base', async () => (await condoRef.collection('vehiculos').where('userId', '==', 'u-ana').where('plate', '==', 'Q555TST').get()).docs[0] || null);
        record('con su condominio, su marbete y la placa limpia en mayusculas', !!added && added.get('condominioId') === CONDO && /^MAR/.test(String(added.get('marbeteCode'))) && added.get('plateNorm') === 'Q555TST', JSON.stringify(added && added.data()));
        // La base ya la tiene un instante antes de que la pantalla termine de pintar la lista: se espera a la pantalla
        await waitFor('la lista y el aviso de la pantalla se actualizan', async () => { const u = await plUi(); return u.placas.includes('Q555TST') && u.msg === 'Placa Q555TST agregada.'; });
        const pl1 = await plUi();
        equal('y se ve en la lista, con el aviso', [pl1.placas.includes('Q555TST'), pl1.msg], [true, 'Placa Q555TST agregada.']);
        equal('el residente no cambio (agregar placas no lo marca como modificado ni lo guarda)', await oikos(`resIsDirty()`), false);
        await oikos(`document.querySelector('#res-plates-list [data-plate="Q555TST"] .res-plate-del').click()`);
        await waitFor('quitarla la borra de la base', async () => (await dbPlates('u-ana')).length === anaPlates.length && !(await dbPlates('u-ana')).includes('Q555TST'));
        await waitFor('la pantalla quita la placa de la lista', async () => !(await plUi()).placas.includes('Q555TST'));
        equal('y sale de la lista', (await plUi()).placas, anaPlates);
        equal('un residente nuevo sigue viendo el campo de placas de siempre', await oikos(`(() => { closeModal('modal-resident'); openModal('modal-resident'); const d = (id) => document.getElementById(id); return [!d('res-plates-new').classList.contains('hidden'), d('res-plates-edit').classList.contains('hidden')]; })()`), [true, true]);
        // La X fija: con el formulario desplazado hasta Guardar la X sigue arriba, a la vista
        const xOut = await oikos(`(async () => {
            closeModal('modal-resident'); await new Promise((r) => setTimeout(r, 400));
            editResident('u-ana'); await new Promise((r) => setTimeout(r, 400));
            const card = document.querySelector('#modal-resident > div'); card.scrollTop = card.scrollHeight; await new Promise((r) => setTimeout(r, 200));
            const x = document.getElementById('res-modal-close').getBoundingClientRect(), c = card.getBoundingClientRect(), h = document.getElementById('res-modal-head').getBoundingClientRect();
            return { scrolled: card.scrollTop > 50, flush: Math.abs(h.top - c.top) <= 1, inside: x.top >= c.top - 1 && x.bottom <= c.top + h.height + 1 && x.right <= c.right + 1, title: document.getElementById('title-modal-res').textContent };
        })()`);
        equal('al bajar hasta Guardar la X queda fija arriba a la derecha de la ventana', xOut, { scrolled: true, flush: true, inside: true, title: 'Editar Residente' });
        await oikos(`closeModal('modal-resident')`);

        console.log('\nResidentes: dos menus por residente y el codigo del boton de panico');
        const pmOut = await oikos(`(async () => {
            navigate('residents'); renderResidents();
            const tr = [...document.querySelectorAll('#residents-table-body tr')].find((r) => r.innerHTML.includes("menu-fav-u-ana"));
            const cell = tr.lastElementChild;
            const items = (id) => [...document.getElementById(id).querySelectorAll('button')].map((b) => b.textContent.trim().replace(/\\s+/g, ' '));
            const shape = { botones: [...cell.querySelectorAll(':scope > button')].map((b) => b.title), izq: items('menu-fav-u-ana'), der: items('menu-u-ana') };
            cell.querySelector('.drop-btn').click();
            shape.soloIzq = [getComputedStyle(document.getElementById('menu-fav-u-ana')).display !== 'none', getComputedStyle(document.getElementById('menu-u-ana')).display !== 'none'];
            document.body.click();
            openPanicQr('u-ana');
            for (let i = 0; i < 40 && !document.querySelector('#pqm-card .pq-qr svg'); i++) await new Promise((r) => setTimeout(r, 150));
            const d = (id) => document.getElementById(id);
            shape.modal = { abierta: !d('modal-panico-qr').classList.contains('hidden-section'), url: d('pqm-url').value, tarjeta: d('pqm-card').innerText.replace(/\\s+/g, ' ').trim(), qr: d('pqm-card').querySelectorAll('.pq-qr svg').length, botones: ['pqm-copy', 'pqm-print', 'pqm-pdf', 'pqm-wa'].map((i) => d(i).disabled) };
            closeModal('modal-panico-qr');
            return shape;
        })()`);
        equal('cada residente trae tres puntos, el lapiz y tres puntos', pmOut.botones, ['Estado de cuenta y mensajes', 'Editar', 'Más opciones']);
        equal('izquierda: estado de cuenta y mensajes (con Enviar clave de acceso: el administrador ve las claves); derecha: lo demas, con Generar codigo boton de panico', [pmOut.izq, pmOut.der],
            [['Estado de Cuenta', 'Contactar', 'Enviar desde mi WhatsApp', 'Enviar clave de acceso', 'Chat de WhatsApp'], ['Cargar cuotas por mes', 'Generar marbete', 'Generar código botón de pánico', 'Finiquitar relación', 'Eliminar']]);
        equal('el boton de la izquierda abre solo su menu', pmOut.soloIzq, [true, false]);
        equal('el codigo del boton de panico: la tarjeta del vecino con su QR y el enlace con su condominio y su id (sin codigo de acceso)',
            [pmOut.modal.abierta, pmOut.modal.url, pmOut.modal.qr, /BOTÓN DE PÁNICO/.test(pmOut.modal.tarjeta), /Ana García/.test(pmOut.modal.tarjeta), pmOut.modal.botones], [true, `${BASE}/panico.html?c=${CONDO}&v=u-ana`, 1, true, true, [false, false, false, false]]);

        console.log('\nResidentes: enviar la clave de acceso del vecino y el enlace de garita.app');
        const anaAccessCode = (await db.collection('codigos').where('userId', '==', 'u-ana').get()).docs.map((d) => d.id).find(Boolean);
        const ck = await oikos(`(async () => {
            for (let i = 0; i < 60 && !residentCodeOf('u-ana'); i++) await new Promise((r) => setTimeout(r, 150));
            navigate('residents'); renderResidents();
            const item = !!document.querySelector('#menu-fav-u-ana button[onclick^="openSendCode("]');
            const realOpen = window.open, realConfirm = window.confirm, realAlert = window.alert;
            window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return {}; };
            window.confirm = () => true; window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); };
            openSendCode('u-ana');
            const d = (id) => document.getElementById(id);
            const out = { item, code: d('clv-code').textContent, phone: d('clv-phone').textContent, text: d('clv-text').value, server: d('clv-server').disabled, mine: d('clv-mine').disabled, hidden: d('clv-server').classList.contains('hidden') };
            sendCodeMine();
            out.wa = window.__opened.slice();
            await new Promise((r) => setTimeout(r, 450));   // la ventana se cierra con su animacion (0.3 s)
            out.closedMine = d('modal-clave').classList.contains('hidden-section');
            openSendCode('u-ana');
            await sendCodeServer();
            out.alerts = window.__alerts.slice();
            window.open = realOpen; window.confirm = realConfirm; window.alert = realAlert;
            closeModal('modal-clave');
            return out;
        })()`);
        equal('con el privilegio de ver claves, el menu de mensajes trae "Enviar clave de acceso" y la ventana muestra SU clave y su telefono',
            [ck.item, !!anaAccessCode && ck.code === anaAccessCode, /^\+502\d{8}$/.test(ck.phone)], [true, true, true]);
        equal('el mensaje lleva la clave, el enlace de garita.app y el aviso; los dos envios encendidos', [ck.text.includes(anaAccessCode), ck.text.includes('https://garita.app/'), /No comparta esta clave/.test(ck.text), ck.server, ck.mine, ck.hidden], [true, true, true, false, false, false]);
        const codeWaUrl = new URL(ck.wa[0] || 'http://x');
        equal('"Enviar desde mi WhatsApp" abre su WhatsApp en el chat del vecino con el mensaje (y cierra la ventana)', [/whatsapp\.com|wa\.me/.test(codeWaUrl.hostname), decodeURIComponent(ck.wa[0] || '').includes(anaAccessCode), ck.closedMine], [true, true, true]);
        const clavesLog = (await condoRef.collection('recordatorios_individuales').where('mode', '==', 'clave').get()).docs.map((x) => x.data());
        equal('"Desde el WhatsApp del condominio": lo manda el servidor (simulado) y queda anotado sin la clave', [clavesLog.length >= 1, clavesLog.some((x) => x.residentId === 'u-ana' && x.status === 'sent'), JSON.stringify(clavesLog).includes(anaAccessCode), ck.alerts.filter((a) => /no tiene|no puede|inválid/i.test(a))], [true, true, false, []]);

        console.log('\nPrivilegios de gerente: sin cambiar nombres ni fechas (bloqueo de pantalla)');
        // Se vuelve a instalar el bloqueo como un usuario sin "cambiar el nombre" ni "cambiar la fecha"; Actualizar (abajo) monta
        // OIKOS de nuevo con los privilegios reales del administrador
        await inside(`window.SisdelFinanzasBloqueo.install(w, (k) => k !== 'usuarios.vecinos_nombre' && k !== 'finanzas.pagos_fecha' && SISDEL.can(k), { notify() {} }); return true;`);
        equal('al editar a un residente el nombre queda de solo lectura', await oikos(`(() => { navigate('residents'); editResident('u-ana'); const f = document.getElementById('res-name'); return [f.readOnly, f.value.length > 0, f.title.includes('privilegio')]; })()`), [true, true, true]);
        equal('pasar al siguiente residente lo deja igual', await oikos(`(() => { const nx = resNeighbors('u-ana').next; if (nx) editResident(nx.id); return document.getElementById('res-name').readOnly; })()`), true);
        equal('al registrar un residente nuevo el nombre si se escribe', await oikos(`(() => { closeModal('modal-resident'); openModal('modal-resident'); return document.getElementById('res-name').readOnly; })()`), false);
        equal('sin "cambiar la fecha" el Ingreso no muestra la fecha del pago', await oikos(`(() => { closeModal('modal-resident'); navigate('accounting'); openModal('modal-income'); return getComputedStyle(document.getElementById('inc-date-wrap')).display; })()`), 'none');
        await oikos(`closeModal('modal-income')`);

        console.log('\nCelular: el menu se esconde y cada pantalla usa todo el ancho');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await sleep(400);
        const phone = await oikos(`(async () => {
            const wait = () => new Promise((r) => setTimeout(r, 350));   // el menu entra deslizandose (0.2 s)
            const side = () => document.getElementById('oikos-sidebar').getBoundingClientRect();
            const main = () => document.querySelector('main .section-container');
            navigate('dashboard');
            const out = { hidden: side().right <= 0, btn: getComputedStyle(document.getElementById('oikos-menu-btn')).display !== 'none', date: getComputedStyle(document.getElementById('current-date')).display };
            document.getElementById('oikos-menu-btn').click();
            await wait();
            out.opened = side().left >= 0 && document.body.classList.contains('oikos-menu-open');
            document.getElementById('nav-residents').click();
            out.closed = !document.body.classList.contains('oikos-menu-open') && currentView === 'residents';
            out.residentsFit = main().scrollWidth <= main().clientWidth + 1;
            oikosMenu(true); document.getElementById('oikos-menu-backdrop').click();
            out.backdrop = !document.body.classList.contains('oikos-menu-open');
            navigate('accounting');
            out.accountingFit = main().scrollWidth <= main().clientWidth + 1;
            return out;
        })()`);
        equal('en el celular el menu no se ve hasta tocar su boton, y la fecha no ocupa el encabezado', [phone.hidden, phone.btn, phone.date], [true, true, 'none']);
        equal('el boton abre el menu; elegir Residentes lo cierra y muestra solo Residentes; tocar fuera tambien lo cierra', [phone.opened, phone.closed, phone.backdrop], [true, true, true]);
        equal('Residentes y Contabilidad caben en el ancho del celular (sin moverse de lado)', [phone.residentsFit, phone.accountingFit], [true, true]);
        equal('la barra de SISDEL va en una sola linea', await page.evaluate(`(() => { const bar = document.querySelector('.fin-bar'); return bar.getBoundingClientRect().height < 60; })()`), true);
        await page.send('Emulation.clearDeviceMetricsOverride');
        await sleep(400);
        equal('en una pantalla ancha el menu se ve siempre y el boton no', await oikos(`[document.getElementById('oikos-sidebar').getBoundingClientRect().left >= 0, getComputedStyle(document.getElementById('oikos-menu-btn')).display]`), [true, 'none']);

        console.log('\nActualizar (OIKOS se vuelve a montar sin recargar la pagina)');
        const beforeRemount = await oikos(`[Store.getRaw('transactions').length, Store.get('residents').length]`);
        await page.evaluate(`document.getElementById('btnReload').click()`);
        await sleep(800);
        await page.waitFor(OPENED, 'OIKOS montado de nuevo', 30000);
        await page.waitFor(`(() => { try { return document.querySelector('#frameBox iframe').contentWindow.eval('typeof Store !== "undefined" && typeof currentFeePeriod === "function"'); } catch (e) { return false; } })()`, 'OIKOS listo', 30000);
        equal('conserva las mismas listas', await oikos(`[Store.getRaw('transactions').length, Store.get('residents').length]`), beforeRemount);
        // Un registro creado por el OIKOS anterior (su iframe ya no existe) se sigue pudiendo leer, anular y subir
        const feeId = `fee_u-maria_${period}`;
        await oikos(`deleteTransaction(${JSON.stringify(feeId)})`);
        await idle();
        equal('anular una cuota creada antes de actualizar funciona y llega a la nube', await (async () => { const d = (await txRef(feeId).get()).data(); return [d.deleted, d.deleted_reason, d.amount, d.period]; })(), [true, 'prueba', 500, period]);
        equal('y deshacer la devuelve, tambien en la nube', [await oikos(`(() => { History.undo(); return Store.get('transactions').some(x => x.id === ${JSON.stringify(feeId)}); })()`), await (async () => { await idle(); return (await txRef(feeId).get()).data().deleted; })()], [true, false]);

        console.log('\nVolver a abrir (usa la copia del equipo)');
        // Mismo contenido (el orden de la lista al abrir es por fecha de alta; durante la sesion, por orden de llegada)
        const SNAPSHOT = `(() => {
            // El rastro de una anulacion devuelta (restored_at y, en un registro vivo, el motivo y la fecha de la
            // anulacion) lo conserva la nube y llega al volver a abrir: no es un cambio del movimiento
            const trace = (o, k) => k === 'restored_at' || (o.deleted !== true && ['deleted', 'deleted_at', 'deleted_reason'].includes(k));
            // Las claves de los mapas de adentro (antes y despues de un descuento de mora, sus cuotas, alloc, breakdown) tambien
            // en orden: la nube no guarda el orden en que se escribieron
            const deep = (v) => (Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((out, k) => { out[k] = deep(v[k]); return out; }, {}) : v);
            const sorted = (o) => Object.keys(o).filter((k) => !trace(o, k)).sort().reduce((out, k) => { out[k] = deep(o[k]); return out; }, {});
            const byId = (list) => list.map(sorted).sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
            const s = Store.get('settings');
            return JSON.stringify([byId(Store.getRaw('transactions')), byId(Store.get('residents')).map(r => [r.id, r.name, r.unit, r.contact, r.dpi, r.balance]), [s.fee, s.receiptCounter, s.chargeDay]]);
        })()`;
        const listBefore = await oikos(SNAPSHOT);
        equal('abre de nuevo', await openFinance(), 'ok');
        const listAfter = await oikos(SNAPSHOT);
        // Si difiere, el detalle dice el primer movimiento (o la parte) que cambio
        const firstDiff = (() => {
            if (listAfter === listBefore) return '';
            const [a, b] = [JSON.parse(listBefore), JSON.parse(listAfter)];
            const ids = new Set([...a[0], ...b[0]].map((t) => String(t.id)));
            for (const id of ids) {
                const x = JSON.stringify(a[0].find((t) => String(t.id) === id) || null);
                const y = JSON.stringify(b[0].find((t) => String(t.id) === id) || null);
                if (x !== y) return `movimiento ${id}: antes ${x} / despues ${y}`;
            }
            return JSON.stringify(a[1]) !== JSON.stringify(b[1]) ? `residentes: ${JSON.stringify(a[1])} / ${JSON.stringify(b[1])}` : `configuracion: ${JSON.stringify(a[2])} / ${JSON.stringify(b[2])}`;
        })();
        record('con los mismos movimientos (campo por campo), saldos y contador de recibos', listAfter === listBefore, firstDiff.slice(0, 900));
        equal('la cuota que se anulo y se devolvio sigue viva y trae el rastro de su anulacion', await oikos(`(() => { const t = Store.getRaw('transactions').find(x => x.id === ${JSON.stringify(feeId)}); return [Store.get('transactions').some(x => x.id === t.id), t.deleted, t.deleted_reason, typeof t.restored_at]; })()`), [true, false, 'prueba', 'string']);
        equal('y el pago que se devolvio y se volvio a anular trae su rastro desde la nube', await oikos(`(() => { const t = Store.getRaw('transactions').find(x => x.id === ${JSON.stringify(payment.id)}); return [t.deleted, t.deleted_reason, typeof t.restored_at]; })()`), [true, 'prueba', 'string']);
        copy = await page.evaluate(COPY);
        record('la copia guarda los movimientos (en bloques y cambios sueltos)', copy.enBloques + copy.sueltos >= txBefore + active && copy.info.complete === true, JSON.stringify([copy.enBloques, copy.sueltos]));

        console.log('\nSin conexion con la nube');
        await page.send('Network.setBlockedURLs', { urls: ['*127.0.0.1:8080*', '*localhost:8080*'] });
        await inside(`w.eval("navigate('accounting'); openModal('modal-expense')");
            w.document.getElementById('exp-concept-input').value = 'Reparaciones'; w.document.getElementById('exp-amount').value = '75.5';
            w.eval("handleTransactionSubmit({ preventDefault() {} }, 'expense')");`);
        const expense = await oikos(`(() => { const t = Store.get('transactions').filter(x => x.type === 'expense' && x.amount === 75.5).pop(); return t ? t.id : null; })()`);
        await sleep(1200);
        copy = await page.evaluate(COPY);
        // Tambien queda pendiente la configuracion: registrar un movimiento avanza el contador de recibos
        equal('el egreso queda anotado como pendiente en el equipo', [copy.pendientes.sort(), (await txRef(expense).get()).exists, (await page.evaluate(`localStorage.getItem('sisdel_fin_pendiente_${CONDO}')`)) === '1'], [['settings:settings', 'transactions:' + expense], false, true]);
        equal('y tambien, al instante, en el respaldo de localStorage', copy.respaldo.sort(), ['settings:settings', 'transactions:' + expense]);
        await page.send('Network.setBlockedURLs', { urls: [] });
        equal('al volver la conexion y abrir de nuevo', await openFinance(), 'ok');
        await waitFor('el egreso se sube solo', async () => (await txRef(expense).get()).exists);
        await idle();
        copy = await page.evaluate(COPY);
        equal('y deja de estar pendiente (en la copia y en el respaldo)', [copy.pendientes, copy.respaldo, await oikos(`Store.get('transactions').some(x => x.id === ${JSON.stringify(expense)})`)], [[], [], true]);

        console.log('\nCopia de la version anterior (localStorage)');
        const prefix = `oikos_multisys-${CONDO}_`;
        const stamp = new Date().toISOString();
        await page.evaluate(`(() => {
            const w = document.querySelector('#frameBox iframe').contentWindow;
            const txs = w.eval("Store.getRaw('transactions')").slice(0, 2);
            txs.push({ id: 'pago-version-anterior', date: ${JSON.stringify(stamp)}, type: 'income', amount: 123, concept: 'Abono', receiptNum: 'ZZ9001', resiId: 'u-maria', created_at: ${JSON.stringify(stamp)}, updated_at: ${JSON.stringify(stamp)} });
            localStorage.setItem(${JSON.stringify(prefix)} + 'transactions', JSON.stringify(txs));
            localStorage.setItem(${JSON.stringify(prefix)} + 'residents', JSON.stringify(w.eval("Store.getRaw('residents')")));
            localStorage.setItem('sisdel_fin_pendiente_${CONDO}', '1');
        })()`);
        equal('con una copia vieja en el equipo tambien abre', await openFinance(), 'ok');
        await waitFor('lo que la copia vieja tenia sin subir llega a la nube', async () => (await txRef('pago-version-anterior').get()).exists);
        await idle();
        copy = await page.evaluate(COPY);
        equal('y la copia vieja se borra de localStorage', copy.viejas, []);
        equal('OIKOS lo muestra', await oikos(`Store.get('transactions').some(x => x.id === 'pago-version-anterior')`), true);

        console.log('\nGarita: el marbete leido con su franja verde (al dia) o roja (en mora)');
        // El guardia del seed lee el marbete escribiendo su codigo (lo mismo que hace el lector). El estado de pago lo escribe el
        // servidor; aqui se fija para la prueba (Ana al dia, Maria morosa) y despues se devuelve como estaba
        const usersRef = condoRef.collection('usuarios');
        const statusBefore = { ana: (await usersRef.doc('u-ana').get()).get('paymentStatus'), maria: (await usersRef.doc('u-maria').get()).get('paymentStatus') };
        await usersRef.doc('u-ana').update({ paymentStatus: 'al_dia' });
        await usersRef.doc('u-maria').update({ paymentStatus: 'moroso' });
        const guard = await newPage({ stepTimeoutMs: 120000 });
        await guard.login(BASE, 'VP103');
        await guard.waitFor(`location.pathname.endsWith('/garita.html') && !!document.getElementById('formManual') && typeof SISDEL !== 'undefined'`, 'la garita', 60000);
        await sleep(1500);
        const readMarbete = async (code) => {
            await guard.evaluate(`(() => { document.getElementById('modalResult').style.display = 'none'; const old = document.getElementById('marbeteLeido'); if (old) old.remove(); document.getElementById('manualCode').value = ${JSON.stringify(code)}; document.getElementById('formManual').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()`);
            await guard.waitFor(`document.getElementById('modalResult').style.display !== 'none' && !!document.getElementById('marbeteLeido')`, 'el marbete leido', 30000);
            return guard.evaluate(`(() => {
                const c = document.getElementById('marbeteLeido');
                const band = c.querySelector('.mbg-band');
                const plate = c.querySelector('.mbg-plate');
                const name = c.querySelector('.mbg-name');
                return {
                    cls: c.className, bg: getComputedStyle(band).backgroundColor,
                    ratio: band.getBoundingClientRect().height / parseFloat(getComputedStyle(plate).fontSize),
                    full: Math.abs(band.getBoundingClientRect().width - c.clientWidth) < 2 && band.getBoundingClientRect().top - c.getBoundingClientRect().top < 2,
                    plate: plate.textContent, status: c.querySelector('.mbg-status').textContent, name: name.textContent,
                    nameBold: Number(getComputedStyle(name).fontWeight) >= 700 && getComputedStyle(name).display === 'block'
                };
            })()`);
        };
        const gOk = await readMarbete('MARTEST1');
        record('al dia: el marbete de Ana con una franja verde a todo el ancho arriba, de alto el doble de la letra de la placa', gOk.cls.includes('mbg-ok') && gOk.bg === 'rgb(22, 163, 74)' && Math.abs(gOk.ratio - 2) < 0.05 && gOk.full && gOk.plate === 'P-987XYZ' && gOk.status === 'Al día' && gOk.name === 'Ana García' && gOk.nameBold, JSON.stringify(gOk));
        const gLate = await readMarbete('MARTEST3');
        record('en mora: el de Maria con una franja roja a todo el ancho arriba, de alto el doble de la letra de la placa', gLate.cls.includes('mbg-late') && gLate.bg === 'rgb(220, 38, 38)' && Math.abs(gLate.ratio - 2) < 0.05 && gLate.full && gLate.plate === 'P-111MOR' && gLate.status === 'En mora' && gLate.name === 'María Rodríguez', JSON.stringify(gLate));
        await guard.evaluate(`SISDEL.logout()`).catch(() => {});
        await guard.close();
        const restore = (v) => (v === undefined ? FieldValue.delete() : v);
        await usersRef.doc('u-ana').update({ paymentStatus: restore(statusBefore.ana) });
        await usersRef.doc('u-maria').update({ paymentStatus: restore(statusBefore.maria) });

        console.log('\nCerrar sesion');
        record('sin errores en la consola durante la prueba', page.errors.length === 0, JSON.stringify([...new Set(page.errors)].slice(0, 4)));
        await page.goto(`${BASE}/admin.html`);
        await page.waitFor(`typeof SISDEL !== 'undefined' && document.readyState === 'complete'`, 'el panel admin');
        await page.evaluate(`SISDEL.logout()`);
        await page.waitFor(`location.pathname.endsWith('/index.html') && document.readyState === 'complete'`, 'el login');
        copy = await page.evaluate(COPY);
        equal('al salir se borra la copia del equipo', [copy.bases, copy.registro, copy.viejas, copy.respaldo], [[], null, [], []]);
    } finally {
        await close();
    }
}
run().catch((error) => { console.error(error); failures.push('error inesperado: ' + error.message); }).finally(() => {
    console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
    if (failures.length) failures.forEach((f) => console.log('  - ' + f));
    process.exit(failures.length ? 1 : 0);
});
