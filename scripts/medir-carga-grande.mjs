// Mide en Chrome (sin ventana y con un perfil temporal) cuanto tardan el panel admin y el Sistema Financiero con el
// condominio de prueba grande del emulador (ver seed-carga-grande.mjs). No instala nada: usa chrome.mjs.
//
// Uso (con los emuladores levantados y el condominio sembrado):
//   cd scripts && node medir-carga-grande.mjs
//   node medir-carga-grande.mjs --cobrar            ademas cobra la cuota del mes siguiente a todos (escribe en el emulador)
//   node medir-carga-grande.mjs --salida=antes.json guarda los numeros en un archivo
//   node medir-carga-grande.mjs --codigo=CG7190 --url=http://127.0.0.1:5050 --chrome="/ruta/a/Chrome"
//
// Abre el Sistema Financiero dos veces: la primera baja todo de la nube; la segunda usa la copia del equipo.
import fs from 'node:fs';
import { parseArgs } from './admin.mjs';
import { launch, sleep } from './chrome.mjs';

const args = parseArgs();
const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CODE = String(args.codigo || 'CG7190');

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
    console.error('Este script solo mide paginas locales (emuladores).');
    process.exit(1);
}

const OPENED = `(() => {
    const frame = document.querySelector('#frameBox iframe');
    const failed = document.querySelector('#frameMessage button');
    if (failed) return { abrio: false, ms: Math.round(performance.now()), mensaje: document.getElementById('frameMessage').innerText.trim() };
    if (!frame || frame.classList.contains('pendiente')) return null;
    return { abrio: true, ms: Math.round(performance.now()) };
})()`;
const STORAGE = `(async () => {
    const out = { letrasEnLocalStorage: 0 };
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('oikos_multisys-')) out.letrasEnLocalStorage += (localStorage.getItem(key) || '').length;
    }
    try { const e = await navigator.storage.estimate(); out.copiaEnElEquipoMb = Math.round((e.usage || 0) / 104857.6) / 10; } catch (e) { /* sin dato */ }
    return out;
})()`;
const IDLE = `(() => { const s = document.getElementById('syncPill').dataset.state; return s !== 'saving' && s !== 'loading' ? s : null; })()`;

async function openFinance(page) {
    page.errors.length = 0;
    await page.goto(`${BASE}/finanzas.html`);
    const opened = await page.waitFor(OPENED, 'el Sistema Financiero');
    const state = opened.abrio ? await page.waitFor(IDLE, 'que termine de sincronizar') : await page.evaluate(`document.getElementById('syncPill').dataset.state`);
    return { ...opened, estado: state, ...(await page.evaluate(STORAGE)), lecturasKb: Math.round(page.networkBytes / 1024), memoriaMb: await page.heapMb() };
}

async function main() {
    const { newPage, close } = await launch(args.chrome);
    try {
        const page = await newPage();
        const report = { fecha: new Date().toISOString(), url: BASE };

        // 1. Entrar y medir el panel admin (lista de usuarios)
        await page.login(BASE, CODE);
        await page.goto(`${BASE}/admin.html`);
        const admin = await page.waitFor(`(() => {
            const list = document.getElementById('usersList');
            if (!list || !list.children.length) return null;
            return { ms: Math.round(performance.now()), nodos: document.getElementsByTagName('*').length, nodosLista: list.getElementsByTagName('*').length };
        })()`, 'lista de usuarios del panel admin');
        report.admin = { ...admin, memoriaMb: await page.heapMb(), lecturasKb: Math.round(page.networkBytes / 1024) };

        // 2. Sistema Financiero: primera apertura (baja todo) y segunda (usa la copia del equipo)
        report.primeraApertura = await openFinance(page);
        if (report.primeraApertura.abrio) report.segundaApertura = await openFinance(page);
        const opened = report.segundaApertura || report.primeraApertura;

        // 3. Dentro de OIKOS: cuanto tarda cada pantalla
        if (opened.abrio) {
            const inside = (code) => page.evaluate(`(async () => { const w = document.querySelector('#frameBox iframe').contentWindow; ${code} })()`);
            const timed = (js) => inside(`const t = performance.now(); try { w.eval(${JSON.stringify(js)}); } catch (e) { return { ms: Math.round(performance.now() - t), error: String(e && e.message || e).slice(0, 200) }; } return { ms: Math.round(performance.now() - t) };`);
            report.oikos = {
                residentes: await inside(`return w.eval("Store.get('residents').length")`),
                movimientos: await inside(`return w.eval("Store.getRaw('transactions').length")`),
                leerMovimientos: await timed(`Store.get('transactions')`),
                tablero: await timed(`navigate('dashboard')`),
                residentesPantalla: await timed(`navigate('residents')`),
                contabilidad: await timed(`navigate('accounting')`),
                filasContabilidad: await inside(`return w.document.getElementById('accounting-table-body').children.length`),
                estadoDeCuenta: await timed(`openEstadoCuenta(Store.get('residents')[0].id)`),
                fotoParaDeshacer: await timed(`History.push()`),
                reporteMorosos: await timed(`closeModal('modal-estado-cuenta'); navigate('reports'); selectReport('morosos')`),
                reporteAlDia: await timed(`openResidentStatusReport('aldia')`),
                memoriaMb: await page.heapMb()
            };
            // Saldos y totales: para comprobar que antes y despues dan lo mismo
            report.cifras = await inside(`return w.eval(${JSON.stringify(`(() => {
                const res = Store.get('residents'); const txs = Store.get('transactions');
                let inc = 0, exp = 0, chg = 0;
                txs.forEach(t => { const a = parseFloat(t.amount) || 0; if (t.type === 'income') inc += a; else if (t.type === 'expense') exp += a; else if (t.type === 'charge') chg += a; });
                const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
                const mor = buildMorososReport();
                return { ingresos: r2(inc), egresos: r2(exp), cargos: r2(chg), saldoTotal: r2(res.reduce((s, r) => s + r.balance, 0)),
                    conDeuda: res.filter(r => r.balance < -0.005).length, enMora: res.filter(r => isResidentActive(r) && checkIsMoroso(r)).length,
                    movimientosVivos: txs.length, reporteMorosos: mor.totals, siguienteRecibo: (() => { const s = Store.get('settings'); let max = 0; Store.getRaw('transactions').forEach(t => { const m = /(\\d{4,})$/.exec(String(t.receiptNum || '')); if (m) max = Math.max(max, parseInt(m[1], 10)); }); return Math.max(parseInt(s.receiptCounter) || 0, max) + 1; })() };
            })()`)})`);

            // 4. Cobrar la cuota del mes siguiente a todos (escribe en el emulador)
            if (args.cobrar) {
                await inside(`w.eval("closeModal('modal-res-status'); navigate('residents'); openFeeRun()"); const d = new Date(); const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
                    w.document.getElementById('fr-year').value = String(next.getFullYear()); w.document.getElementById('fr-month').value = String(next.getMonth()); w.eval('updateFeeRunPreview()');`);
                const before = await inside(`return w.eval("Store.getRaw('transactions').length")`);
                const run = await timed(`applyFeeRun()`);
                const after = await inside(`return w.eval("Store.getRaw('transactions').length")`);
                const started = Date.now();
                await sleep(600);
                const state = await page.waitFor(IDLE, 'que se guarde la cuota del mes');
                report.cuotaDelMes = { ...run, creadas: after - before, guardarEnNubeMs: Date.now() - started, estado: state };
            }
        }
        report.errores = [...new Set(page.errors)].slice(0, 12);
        report.avisos = page.dialogs.slice(0, 5);
        return report;
    } finally {
        await close();
    }
}

main().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (args.salida) fs.writeFileSync(String(args.salida), JSON.stringify(report, null, 2));
    process.exit(0);
}).catch((error) => { console.error(error); process.exit(1); });
