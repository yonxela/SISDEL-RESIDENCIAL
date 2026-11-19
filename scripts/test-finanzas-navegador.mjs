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
        record('Imprimir abre la impresion del estado de cuenta (este ano, con lo que debe hoy)', /ESTADO DE CUENTA/.test(printedQuick[0]) && printedQuick[0].includes('Ana') && printedQuick[1], String(printedQuick[0]).slice(0, 120));
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
        const waVoucher = await oikos(`(() => { window.__opened.length = 0; ecQuickWhatsApp('voucher'); return [window.__opened[0] || '', ecResidentId, !document.getElementById('modal-voucher-options').classList.contains('hidden-section')]; })()`);
        record('desde el comprobante, WhatsApp manda el estado de cuenta que ya trae ese pago, y el comprobante sigue abierto', /wa\.me/.test(waVoucher[0]) && decodeURIComponent(String(waVoucher[0])).includes('12.34') && waVoucher[1] === 'u-ana' && waVoucher[2], JSON.stringify([waVoucher.slice(1), decodeURIComponent(String(waVoucher[0])).slice(0, 160)]));
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
        equal('sin regla de mora por dia la pestana Descontar mora no se ve', await oikos(`(() => { navigate('accounting'); openModal('modal-income'); document.getElementById('inc-resident').value = 'u-ana'; updateIncomeConcepts(); const t = document.getElementById('inc-tab-descuento'); const out = t.classList.contains('hidden'); closeModal('modal-income'); return out; })()`), true);
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
        equal('no aparece en Contabilidad (no es dinero)', await oikos(`(() => { navigate('accounting'); renderAccounting(); return document.getElementById('accounting-table-body').innerHTML.includes(${JSON.stringify(applied.tx.id)}); })()`), false);
        const discRep = await oikos(`(() => { navigate('reports'); selectReport('mora-discounts'); const d = currentReportData; const row = d.rows[d.rows.length - 1]; return { title: document.getElementById('rep-current').textContent, n: d.rows.length, row: row.map(stripCellHtml), meta: d.rowsMeta[d.rows.length - 1], high: d.highlights[0].value, wa: SisdelReportExport.whatsappText(currentReportModel(false)).slice(0, 200), xlsx: currentReportModel(true).fileName }; })()`);
        record('el reporte Descuentos de mora lo lista con residente, meses, monto, motivo y quien lo hizo', discRep.title === 'Descuentos de mora' && discRep.n >= 1 && discRep.row[1].includes('Ana') && discRep.row[6] === 'Acuerdo de pago de prueba' && discRep.row[8] === 'Vigente' && discRep.meta.kind === 'tx', JSON.stringify(discRep));
        equal('con la mora descontada arriba y su salida a WhatsApp y Excel', [discRep.high === await oikos(`formatMoney(${byAmount})`), /Descuentos de mora/i.test(discRep.wa), !!discRep.xlsx], [true, true, true]);
        // Anularlo: la mora vuelve y el reporte lo muestra anulado
        const annulDisc = await oikos(`(() => { deleteTransaction(${JSON.stringify(applied.tx.id)}); const r = Store.get('residents').find((x) => x.id === 'u-ana'); selectReport('mora-discounts'); const d = currentReportData; return [sisdelOwedOf(r).total, stripCellHtml(d.rows[d.rows.length - 1][8]).startsWith('Anulado'), d.highlights[3].value]; })()`);
        equal('anular el descuento devuelve la mora y el reporte lo muestra anulado', annulDisc, [discStart.owed.total, true, '1']);
        // Limpieza: se anulan las cuotas de prueba y se quita la regla de mora de la pantalla
        await oikos(`(() => { deleteTransaction('disc-test-07'); deleteTransaction('disc-test-08'); Store.get = window.__real.get; window.alert = window.__real.alert; window.confirm = window.__real.confirm; window.prompt = window.__real.prompt; navigate('accounting'); })()`);
        equal('todo queda guardado en la nube', await idle(), 'ok');

        console.log('\nPrivilegios de gerente: sin cambiar nombres ni fechas (bloqueo de pantalla)');
        // Se vuelve a instalar el bloqueo como un usuario sin "cambiar el nombre" ni "cambiar la fecha"; Actualizar (abajo) monta
        // OIKOS de nuevo con los privilegios reales del administrador
        await inside(`window.SisdelFinanzasBloqueo.install(w, (k) => k !== 'usuarios.vecinos_nombre' && k !== 'finanzas.pagos_fecha' && SISDEL.can(k), { notify() {} }); return true;`);
        equal('al editar a un residente el nombre queda de solo lectura', await oikos(`(() => { navigate('residents'); editResident('u-ana'); const f = document.getElementById('res-name'); return [f.readOnly, f.value.length > 0, f.title.includes('privilegio')]; })()`), [true, true, true]);
        equal('pasar al siguiente residente lo deja igual', await oikos(`(() => { const nx = resNeighbors('u-ana').next; if (nx) editResident(nx.id); return document.getElementById('res-name').readOnly; })()`), true);
        equal('al registrar un residente nuevo el nombre si se escribe', await oikos(`(() => { closeModal('modal-resident'); openModal('modal-resident'); return document.getElementById('res-name').readOnly; })()`), false);
        equal('sin "cambiar la fecha" el Ingreso no muestra la fecha del pago', await oikos(`(() => { closeModal('modal-resident'); navigate('accounting'); openModal('modal-income'); return getComputedStyle(document.getElementById('inc-date-wrap')).display; })()`), 'none');
        await oikos(`closeModal('modal-income')`);

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
