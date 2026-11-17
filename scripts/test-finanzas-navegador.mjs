// Prueba del Sistema Financiero en un navegador de verdad (Chrome sin ventana, contra los emuladores): OIKOS con sus
// formularios, la memoria compartida, la copia en IndexedDB, deshacer, la cuota del mes, cambios sin conexion, la
// copia de la version anterior y el borrado al cerrar sesion. Completa a test-finanzas-nube.mjs (que prueba la
// sincronizacion sin navegador) y a test-finanzas-datos.mjs.
// No corre con `npm test` porque necesita Chrome instalado:
//   cd scripts && npm run seed && npm run test:navegador     (con los emuladores levantados)
import { connect, parseArgs, emulatorTriggersRespond } from './admin.mjs';
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
        equal('la tabla de contabilidad lo muestra primero', await inside(`return w.document.querySelector('#accounting-table-body tr').innerText.includes('500.00');`), true);

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
        // Un vecino con 227 cuotas sin pagar desde 2008 (como C070 de La Perla) y la mora por dia: la pantalla, la impresion,
        // el PDF, el Excel y WhatsApp dicen lo mismo y las tres cifras suman. El estado de mora se arma con el modulo de verdad
        // (a un dia fijo) y se le entrega a la pantalla; lo demas es el codigo de OIKOS tal cual.
        const feesCount = await oikos(`(() => {
            const txs = [];
            for (let y = 2008; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 11) break; const p = y + '-' + String(m).padStart(2, '0'); txs.push({ id: 'fee_x_' + p, type: 'charge', kind: 'fee', period: p, amount: 300, resiId: 'u-ana', date: p + '-05T18:00:00.000Z' }); }
            const state = SisdelMora.stateOf('u-ana', txs, { fee: 300, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] }, '2026-11-16');
            const ledger = -300 * txs.length;
            window.__real = { ecMora, sisdelMoraRuleText, open: window.open, jsPdfSave: window.jspdf && window.jspdf.jsPDF.API.save };
            ecMora = () => Object.assign({}, state, { total: Math.round((ledger - state.moraDaily) * 100) / 100 });
            sisdelMoraRuleText = () => '3 % al mes por día sobre cada cuota vencida';
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
        // Devuelve todo como estaba
        await oikos(`(() => { ecMora = __real.ecMora; sisdelMoraRuleText = __real.sisdelMoraRuleText; window.open = __real.open; if (__real.jsPdfSave) window.jspdf.jsPDF.API.save = __real.jsPdfSave; closeModal('modal-estado-cuenta'); })()`);

        console.log('\nRecordatorios: elegir a quienes se envia (por ejemplo 20 para una prueba)');
        // WhatsApp de mentira (no sale nada): se ve a quien le tocaria. A los residentes de prueba se les pone un telefono solo en pantalla.
        await page.evaluate(`(() => { window.__sent = []; window.__realWa = window.sisdelWhatsApp; window.sisdelWhatsApp = { start: async (d) => { window.__sent.push(d); return { ok: true, pending: d.items.length, estimatedMinutes: 1, skipped: 0 }; }, test: async () => ({ ok: true, sent: true }), control: async () => ({ ok: true }), one: async () => ({ ok: true, sent: true }), status: async () => window.__conn, reconcile: async (d) => { window.__calls.push(['reconcile', d]); return { ok: true, entregado: 3, rechazado: 7 }; }, resend: async (d) => { window.__calls.push(['resend', d]); return { ok: true, pending: 7, estimatedMinutes: 1 }; }, watch: () => () => {} }; window.__calls = []; window.__conn = { ok: true, connected: true, state: 'authenticated', message: '', queue: { queued: 0 } }; })()`);
        await oikos(`(() => {
            window.__origGet = Store.get; window.__realConfirm = window.confirm;
            // El condominio de prueba trae solo 2 vecinos: se agregan 6 de mentira (solo en pantalla) para poder elegir unos y dejar otros
            const names = ['Beatriz Lopez', 'Carlos Mejia', 'Diana Ortiz', 'Esteban Perez', 'Flor Quezada', 'Gabriel Rojas'];
            Store.get = function (k) {
                const v = window.__origGet.apply(Store, arguments);
                if (k !== 'residents') return v;
                const fakes = names.map((n, i) => Object.assign({}, v[0], { id: 'fake-' + i, name: n, unit: 'F-' + (i + 1), status: 'active', deleted: false }));
                return v.concat(fakes).map((r, i) => Object.assign({}, r, { contact: '5500' + String(1000 + i) }));
            };
            window.confirm = () => true;
            openReminders(); setReminderMode('varios');
            document.getElementById('rem-msg-general').value = 'Aviso de prueba para {nombre}';
        })()`);
        const rows = () => oikos(`[...document.querySelectorAll('#reminders-list .rem-pick')].length`);
        const shown = await oikos(`remShownList.length`);
        record('la ventana lista a los residentes y cada uno con telefono tiene su casilla', shown >= 3 && (await rows()) === shown, `lista ${shown}, casillas ${await rows()}`);
        equal('sin elegir a nadie el boton dice a todos y la barra lo explica', await oikos(`[document.getElementById('rem-send-all-label').textContent, document.getElementById('rem-pick-count').textContent, document.getElementById('rem-clear-picks').classList.contains('hidden')]`), [`Enviar a todos (${shown})`, 'Sin selección: se envía a todos los de la lista', true]);
        const chosen = await oikos(`(() => { const boxes = [...document.querySelectorAll('#reminders-list .rem-pick')]; boxes[0].click(); boxes[2].click(); return [boxes[0].dataset.id, boxes[2].dataset.id]; })()`);
        equal('con dos casillas el boton dice a los seleccionados y aparece Quitar seleccion', await oikos(`[document.getElementById('rem-send-all-label').textContent, document.getElementById('rem-pick-count').textContent, document.getElementById('rem-clear-picks').classList.contains('hidden'), document.querySelectorAll('#reminders-list .rem-row.ring-2').length]`), ['Enviar a los seleccionados (2)', '2 seleccionado(s)', false, 2]);
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
        equal('despues de enviar la seleccion queda vacia', await oikos(`[remSelected.size, document.getElementById('rem-send-all-label').textContent, document.querySelectorAll('#reminders-list .rem-pick:checked').length]`), [0, `Enviar a todos (${shown})`, 0]);
        await oikos(`remPickAll()`);
        equal('Seleccionar los de la lista marca a todos y Quitar seleccion los desmarca', [await oikos(`[remSelected.size, document.querySelectorAll('#reminders-list .rem-pick:checked').length]`), await oikos(`(() => { remClearPicks(); return [remSelected.size, document.querySelectorAll('#reminders-list .rem-pick:checked').length]; })()`)], [[shown, shown], [0, 0]]);
        await oikos(`sendRemindersToAll()`);
        equal('sin elegir a nadie el envio es a todos los de la lista', (await page.evaluate(`window.__sent`)).map((d) => d.items.length), [2, shown]);
        await oikos(`(() => { remTogglePick(Store.get('residents')[0].id, true); setReminderMode('mora'); })()`);
        equal('cambiar de mensaje (morosidad <-> varios) empieza la seleccion de cero', await oikos(`remSelected.size`), 0);
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
            const sorted = (o) => Object.keys(o).filter((k) => !trace(o, k)).sort().reduce((out, k) => { out[k] = o[k]; return out; }, {});
            const byId = (list) => list.map(sorted).sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
            const s = Store.get('settings');
            return JSON.stringify([byId(Store.getRaw('transactions')), byId(Store.get('residents')).map(r => [r.id, r.name, r.unit, r.contact, r.dpi, r.balance]), [s.fee, s.receiptCounter, s.chargeDay]]);
        })()`;
        const listBefore = await oikos(SNAPSHOT);
        equal('abre de nuevo', await openFinance(), 'ok');
        equal('con los mismos movimientos (campo por campo), saldos y contador de recibos', await oikos(SNAPSHOT) === listBefore, true);
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
