// Saca de OIKOS (en Chrome sin ventana, contra los emuladores) todas las cifras que muestra: saldo y mora de cada
// residente, reportes, estados de cuenta, la tabla de contabilidad y el siguiente numero de recibo. Sirve para
// comprobar que un cambio no altera ninguna cifra: se corre contra la version anterior y contra la nueva, con los
// mismos datos, y se comparan los dos archivos.
//
// Uso (con emuladores y el condominio de seed-carga-grande.mjs):
//   node cifras-oikos.mjs --salida=nueva.json                              la version de esta carpeta (puerto 5050)
//   node cifras-oikos.mjs --url=http://127.0.0.1:5051 --salida=vieja.json  otra version servida en otro puerto
//   node cifras-oikos.mjs --comparar=vieja.json,nueva.json
// (para servir otra version: `git archive <commit> | tar -x -C /tmp/vieja` y `python3 -m http.server 5051 --bind 127.0.0.1`
//  en esa carpeta; en 127.0.0.1 las paginas usan los emuladores)
import fs from 'node:fs';
import { parseArgs } from './admin.mjs';
import { launch } from './chrome.mjs';

const args = parseArgs();

if (args.comparar) {
    const [a, b] = String(args.comparar).split(',').map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    let differences = 0;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const same = JSON.stringify(a[key]) === JSON.stringify(b[key]);
        if (!same) differences++;
        console.log(`${same ? 'igual   ' : 'DISTINTO'} ${key}`);
        if (!same && Array.isArray(a[key]) && Array.isArray(b[key])) {
            const at = a[key].findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[key][i]));
            console.log(`         primera diferencia en la posicion ${at}:\n           ${JSON.stringify(a[key][at]).slice(0, 300)}\n           ${JSON.stringify(b[key][at]).slice(0, 300)}`);
        }
    }
    console.log(differences ? `\n${differences} bloques distintos` : '\nTodas las cifras son iguales');
    process.exit(differences ? 1 : 0);
}

const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CODE = String(args.codigo || 'CG7190');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) { console.error('Solo paginas locales (emuladores).'); process.exit(1); }

// Corre dentro de OIKOS
const DIGEST = `(() => {
    const iso = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString() : d);
    const out = {};
    const residents = Store.get('residents');
    out.residentes = residents.map(r => [r.id, r.unit, r.name, r.dpi, r.balance, isResidentActive(r), checkIsMoroso(r)]);
    const txs = Store.get('transactions');
    out.movimientos = [Store.getRaw('transactions').length, txs.length, Store.getDeleted('transactions').length];
    out.ordenDeLaLista = txs.map(t => t.id);
    out.configuracion = (() => { const s = Store.get('settings'); delete s.updated_at; return s; })();
    navigate('dashboard');
    out.tablero = ['dash-balance', 'dash-income', 'dash-expenses', 'lbl-debt-count'].map(id => document.getElementById(id).innerText);
    navigate('residents');
    out.pantallaResidentes = [...document.querySelectorAll('#residents-table-body tr')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim());
    navigate('accounting');
    out.contabilidad = [...document.querySelectorAll('#accounting-table-body tr')].slice(0, 300).map(tr => tr.innerText.replace(/\\s+/g, ' ').trim());
    out.contabilidadTotalFilas = (() => { let n = Store.get('transactions').filter(t => t.type !== 'charge').length; return n; })();
    setTxFilter('expense');
    out.contabilidadEgresos = [...document.querySelectorAll('#accounting-table-body tr')].slice(0, 300).map(tr => tr.innerText.replace(/\\s+/g, ' ').trim());
    setTxFilter('all');
    navigate('reports');
    const report = (key, build) => { selectReport(key); const r = build(); return { title: r.title, summary: r.summary, headers: r.headers, rows: r.rows, totals: r.totals, chartValues: r.chartValues }; };
    out.reporteIngresos = report('income', buildIncomeReport);
    out.reporteMorosos = report('morosos', buildMorososReport);
    out.reporteGastos = report('expense-cat', buildExpenseByCategoryReport);
    out.reporteLibro = report('account-statement', buildAccountStatementReport);
    out.pagosPorResidente = residents.map(r => { const i = getResidentPaymentInfo(r); return [r.id, i.last3, i.monthsDelay, iso(i.lastPayDate), i.totalDebt, i.totalPayments]; });
    out.estadosDeCuenta = residents.filter((r, i) => i % 9 === 0 || r.balance < -500).map(r => {
        openEstadoCuenta(r.id);
        document.getElementById('ec-date-from').value = '2000-01-01';
        const all = getEcData(true);
        document.getElementById('ec-date-from').value = new Date().getFullYear() + '-06-01';
        const part = getEcData(false);
        closeModal('modal-estado-cuenta');
        const view = (d) => [d.opening, d.totInc, d.totChg, d.balance, d.rows.map(x => [x.id, x.tipo, x.monto, x.runBal, x.deleted])];
        return [r.id, view(all), view(part)];
    });
    out.siguienteRecibo = (() => { const s = Store.get('settings'); let max = 0; const used = new Set(); Store.getRaw('transactions').forEach(t => { if (!t || !t.receiptNum) return; used.add(String(t.receiptNum)); const m = /(\\d{4,})$/.exec(String(t.receiptNum)); if (m) max = Math.max(max, parseInt(m[1], 10)); }); return [Math.max(parseInt(s.receiptCounter) || 0, max) + 1, used.size]; })();
    out.cuotasDuplicadas = (() => { scanDuplicateFees(); return dupFeeGroups.length; })();
    out.cuotaDelMes = (() => { openFeeRun(); const t = feeRunTargets(); closeModal('modal-fee-run'); return [t.period, t.pending.length, t.done.length, t.skippedDeleted.length, t.inactive.length]; })();
    return out;
})()`;

const { newPage, close } = await launch(args.chrome);
try {
    const page = await newPage({ stepTimeoutMs: 600000 });
    await page.login(BASE, CODE);
    await page.goto(`${BASE}/finanzas.html`);
    const opened = await page.waitFor(`(() => {
        const frame = document.querySelector('#frameBox iframe');
        if (document.querySelector('#frameMessage button')) return 'error';
        return frame && !frame.classList.contains('pendiente') ? 'ok' : null;
    })()`, 'el Sistema Financiero');
    if (opened !== 'ok') throw new Error('El Sistema Financiero no abrio: ' + await page.evaluate(`document.getElementById('frameMessage').innerText`));
    await page.waitFor(`(() => { const s = document.getElementById('syncPill').dataset.state; return s !== 'saving' && s !== 'loading'; })()`, 'que termine de sincronizar');
    const digest = await page.evaluate(`document.querySelector('#frameBox iframe').contentWindow.eval(${JSON.stringify(DIGEST)})`);
    const text = JSON.stringify(digest);
    if (args.salida) fs.writeFileSync(String(args.salida), text);
    console.log(`Cifras de ${BASE}: ${digest.residentes.length} residentes, ${digest.movimientos[0]} movimientos, ${text.length} letras${args.salida ? ' -> ' + args.salida : ''}`);
    if (page.errors.length) console.log('Errores en la pagina:', [...new Set(page.errors)].slice(0, 5));
} finally {
    await close();
}
process.exit(0);
