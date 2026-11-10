// Pruebas de las acciones comunes de los reportes (reportes-export.js): Excel (.xlsx armado a mano), texto de WhatsApp,
// nombres de hoja y texto apto para el PDF. No necesitan emuladores. Si hay Python con openpyxl, el .xlsx tambien se abre
// con esa libreria (una lectura independiente de la nuestra).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const X = require('../reportes-export.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

// ───────── Lectura minima de un zip (para revisar lo que armamos) ─────────
function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error('sin fin de directorio central');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error('directorio central dañado');
        const crc = view.getUint32(at + 16, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extra = view.getUint16(at + 30, true);
        const comment = view.getUint16(at + 32, true);
        const offset = view.getUint32(at + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
        if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('entrada local dañada');
        const localName = view.getUint16(offset + 26, true);
        const localExtra = view.getUint16(offset + 28, true);
        const start = offset + 30 + localName + localExtra;
        entries.push({ name, crc, size, data: bytes.subarray(start, start + size) });
        at += 46 + nameLength + extra + comment;
    }
    return entries;
}
const text = (entry) => new TextDecoder().decode(entry.data);

console.log('\nCRC y zip');
equal('crc32 de "123456789" (valor de referencia)', X.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
const demoZip = readZip(X.zip([{ name: 'a.txt', data: new TextEncoder().encode('hola') }, { name: 'dir/b.txt', data: new TextEncoder().encode('ñandú') }]));
equal('un zip de dos archivos se lee de vuelta', demoZip.map((e) => [e.name, text(e)]), [['a.txt', 'hola'], ['dir/b.txt', 'ñandú']]);

console.log('\nExcel (.xlsx)');
const model = {
    title: 'Visitas del período', subtitle: '1 de noviembre al 7 de noviembre de 2026', condoName: 'Villa Ferrer', userName: 'Ana', at: new Date('2026-11-09T15:00:00Z'),
    kpis: [{ label: 'Visitas dentro', value: 3 }, { label: 'Morosidad', value: '12 %' }],
    tables: [
        { title: 'Visitas', headers: ['Visitante', 'Cantidad', 'Nota'], rows: [['Ana', 5, '=SUMA(1;1)'], ['Luis & <b>Co</b>', '7', 'ñandú "x"'], ['\u0001ctrl', 0, '—']], numeric: [1] },
        { title: 'Visitas', headers: ['Casa'], rows: [['Casa 1']] }
    ],
    excelExtra: [{ title: 'Listado: accesos/visitas [completo] con un nombre muy largo', headers: ['Z'], rows: [['uno']] }],
    fileName: 'visitas-villa-ferrer'
};
const bytes = X.buildXlsx(model);
const entries = readZip(bytes);
const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
equal('el .xlsx trae las partes que Excel exige', entries.map((e) => e.name), ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']);
ok('el CRC de cada archivo coincide con sus datos', entries.every((e) => X.crc32(e.data) === e.crc));
ok('la firma es la de un zip (PK)', bytes[0] === 0x50 && bytes[1] === 0x4b);
const workbook = text(byName['xl/workbook.xml']);
const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
equal('una hoja por tabla y por listado extra, con nombres validos y sin repetirse', names, ['Visitas', 'Visitas 2', 'Listado accesos visitas complet']);
ok('los nombres de hoja no pasan de 31 caracteres', names.every((n) => n.length <= 31));
const sheet1 = text(byName['xl/worksheets/sheet1.xml']);
ok('los numeros de las columnas numericas quedan como numeros', /<c r="B[0-9]+"><v>5<\/v><\/c>/.test(sheet1) && /<c r="B[0-9]+"><v>7<\/v><\/c>/.test(sheet1));
ok('un texto que parece formula queda como texto, no se ejecuta', sheet1.includes('<t xml:space="preserve">=SUMA(1;1)</t>') && !/<f>/.test(sheet1));
ok('los caracteres especiales de XML se escapan', sheet1.includes('Luis &amp; &lt;b&gt;Co&lt;/b&gt;') && sheet1.includes('&quot;x&quot;'));
ok('los caracteres de control se eliminan', !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(sheet1) && sheet1.includes('>ctrl<'));
ok('la primera hoja lleva los indicadores', sheet1.includes('Visitas dentro') && sheet1.includes('<v>3</v>') && sheet1.includes('Morosidad'));
const sheet2 = text(byName['xl/worksheets/sheet2.xml']);
ok('las demas hojas no repiten los indicadores', !sheet2.includes('Visitas dentro'));
ok('el titulo largo no ensancha la columna A (el ancho lo da la tabla)', (() => { const m = /<col min="1" max="1" width="([0-9.]+)"/.exec(sheet1); return m && Number(m[1]) < 25; })());
ok('el encabezado de la tabla usa el estilo de encabezado', /<c r="A[0-9]+" s="2" t="inlineStr"><is><t xml:space="preserve">Visitante<\/t>/.test(sheet1));
equal('sin tablas igual se arma un libro con una hoja', readZip(X.buildXlsx({ title: 'Vacío', tables: [] })).filter((e) => e.name.startsWith('xl/worksheets/')).length, 1);
equal('nombres de hoja repetidos se numeran', (() => { const used = new Set(); return [X.sheetName('Resumen', used), X.sheetName('Resumen', used), X.sheetName('RESUMEN', used)]; })(), ['Resumen', 'Resumen 2', 'RESUMEN 3']);
equal('nombres de hoja sin caracteres prohibidos', X.sheetName('a/b\\c[d]:e*f?g', new Set()), 'a b c d e f g');

// Lectura independiente con openpyxl (si esta instalado)
const py = spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' });
if (py.status === 0) {
    const file = path.join(os.tmpdir(), `sisdel-reporte-${process.pid}.xlsx`);
    fs.writeFileSync(file, bytes);
    const script = 'import sys, json, openpyxl\nwb = openpyxl.load_workbook(sys.argv[1])\nprint(json.dumps({ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb}, ensure_ascii=False))';
    const read = spawnSync('python3', ['-c', script, file], { encoding: 'utf8' });
    fs.rmSync(file, { force: true });
    ok('openpyxl abre el .xlsx', read.status === 0, read.stderr);
    if (read.status === 0) {
        const wb = JSON.parse(read.stdout);
        const first = wb.Visitas;
        ok('openpyxl lee el titulo, los indicadores y la tabla', first[0][0] === 'Visitas del período' && first.some((r) => r[0] === 'Visitas dentro' && r[1] === 3)
            && first.some((r) => r[0] === 'Ana' && r[1] === 5 && r[2] === '=SUMA(1;1)') && first.some((r) => r[0] === 'Luis & <b>Co</b>' && r[1] === 7));
        ok('openpyxl lee el listado extra', Object.values(wb).some((rows) => rows.some((r) => r[0] === 'uno')));
    }
} else {
    console.log('  (sin Python con openpyxl: se omite la lectura independiente del .xlsx)');
}

console.log('\nWhatsApp');
const big = { title: 'Visitas', subtitle: 'hoy', condoName: 'Villa Ferrer', userName: 'Ana', at: new Date('2026-11-09T15:00:00Z'), kpis: [{ label: 'Dentro', value: 2 }],
    tables: [{ title: 'Detalle', headers: ['Fecha', 'Nombre'], rows: Array.from({ length: 30 }, (_, i) => [`2026-11-${String((i % 28) + 1).padStart(2, '0')}`, `Visitante ${i + 1}`]) }] };
const wa = X.whatsappText(big);
ok('el mensaje lleva condominio, titulo, indicadores y encabezados', wa.includes('*Villa Ferrer*') && wa.includes('*Visitas* - hoy') && wa.includes('- Dentro: *2*') && wa.includes('(Fecha | Nombre)'));
ok('solo incluye las primeras 12 filas y avisa cuantas faltan', wa.includes('Visitante 12') && !wa.includes('Visitante 13') && wa.includes('... y 18 fila(s) más'));
ok('termina con la firma de SISDEL', wa.trimEnd().endsWith('_Enviado desde SISDEL_'));
const huge = X.whatsappText({ title: 'X', tables: [{ headers: ['a'], rows: Array.from({ length: 12 }, () => ['x'.repeat(500)]) }] });
ok('el mensaje no pasa de 3400 caracteres', huge.length <= 3400 && huge.includes('mensaje recortado'));
ok('una tabla sin filas dice que no hay datos', X.whatsappText({ title: 'X', tables: [{ title: 'T', headers: ['a'], rows: [] }] }).includes('Sin datos en el periodo.'));
ok('el enlace es de WhatsApp con el texto codificado', X.whatsappUrl('hola ñ & más').startsWith('https://wa.me/?text=hola%20') && !X.whatsappUrl('a&b').includes('&b'));

console.log('\nPDF y botones');
equal('el texto del PDF sustituye lo que la fuente no dibuja', X.latin1('Visita → Casa 4 – “ok” … ñ á ✓'), 'Visita -> Casa 4 - "ok" ... ñ á ?');
const buttons = X.actionsHtml({ print: true, pdf: true, whatsapp: true, excel: true });
equal('con todos los permisos hay cuatro botones', [...buttons.matchAll(/data-rx="([a-z]+)"/g)].map((m) => m[1]), ['print', 'pdf', 'whatsapp', 'excel']);
equal('sin permiso no hay botones', X.actionsHtml({}), '');
equal('solo los permitidos', [...X.actionsHtml({ excel: true, whatsapp: true }).matchAll(/data-rx="([a-z]+)"/g)].map((m) => m[1]), ['whatsapp', 'excel']);
ok('los botones llevan icono SVG, sin emojis', /<svg/.test(buttons) && !/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(buttons));
ok('los botones no salen al imprimir', /rp-noprint no-print/.test(buttons));
ok('el modulo de PDF reutiliza el jsPDF de OIKOS (misma carpeta, sin CDN)', fs.readFileSync(new URL('../reportes-export.js', import.meta.url), 'utf8').includes('finanzas/vendor/jspdf.umd.min.js') && fs.existsSync(new URL('../finanzas/vendor/jspdf.umd.min.js', import.meta.url)) && fs.existsSync(new URL('../finanzas/vendor/jspdf.plugin.autotable.min.js', import.meta.url)));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
