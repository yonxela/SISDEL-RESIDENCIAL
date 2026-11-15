// Pruebas del lector de .xlsx (scripts/lib-xlsx.mjs). Sin emuladores y con datos inventados:
//   node scripts/test-lib-xlsx.mjs
// Lee de vuelta un Excel armado por reportes-export.js (zip sin compresion, texto en linea) y otro armado
// aqui como los guarda Excel (comprimido, con tabla de textos compartidos, prefijos y celdas sin referencia).
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { readXlsx, unzip, crc32, columnIndex, excelDateKey, unescapeXml, cellText, cellNumber } from './lib-xlsx.mjs';

const require = createRequire(import.meta.url);
const Export = require('../reportes-export.js');

const failures = [];
let passed = 0;
function equal(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failures.push(name);
    console.log(`  FALLA  ${name}\n         esperado ${e}\n         obtuvo   ${a}`);
}
function yes(name, value) { equal(name, !!value, true); }
function throws(name, fn, pattern) {
    try { fn(); } catch (err) { equal(name, pattern.test(err.message), true); return; }
    failures.push(name);
    console.log(`  FALLA  ${name}\n         no rechazo`);
}

// Zip armado a mano para las pruebas: cada parte comprimida (metodo 8) o guardada (metodo 0)
function makeZip(files, { method = 8, flags = 0, breakCrc = false } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    files.forEach((file) => {
        const name = Buffer.from(file.name, 'utf8');
        const data = Buffer.from(file.data, 'utf8');
        const body = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = (Export.crc32(data) + (breakCrc ? 1 : 0)) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += 30 + name.length + body.length;
    });
    const centralBytes = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBytes, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function bookFiles({ sheets, shared = null, date1904 = false, targets = null }) {
    const files = [
        { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
        {
            name: 'xl/workbook.xml',
            data: `<?xml version="1.0"?><workbook ${NS}>${date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets>`
                + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')
                + '</sheets></workbook>'
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="hoja" Target="${targets ? targets[i] : `worksheets/sheet${i + 1}.xml`}"/>`).join('')
                + '</Relationships>'
        }
    ];
    if (shared) files.push({ name: 'xl/sharedStrings.xml', data: `<sst ${NS}>${shared.map((s) => `<si>${s}</si>`).join('')}</sst>` });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml }));
    return files;
}
const rowOf = (sheet, r) => sheet.rows.find((row) => row.r === r);
const valuesOf = (row) => Object.fromEntries(Object.entries(row.cells).map(([column, cell]) => [column, cell.v]));

console.log('\nUtilidades');
equal('crc32 de "123456789"', crc32(Buffer.from('123456789')), 0xCBF43926);
equal('crc32 igual al del exportador', crc32(Buffer.from('Lote A-12 Q 300.00')), Export.crc32(Buffer.from('Lote A-12 Q 300.00')));
equal('columna A', columnIndex('A1'), 0);
equal('columna B', columnIndex('B5'), 1);
equal('columna Z', columnIndex('Z99'), 25);
equal('columna AA', columnIndex('AA10'), 26);
equal('columna AZ', columnIndex('az3'), 51);
equal('sin referencia', columnIndex(''), null);
equal('fecha 1', excelDateKey(1), '1900-01-01');
equal('fecha 59', excelDateKey(59), '1900-02-28');
equal('fecha 61', excelDateKey(61), '1900-03-01');
equal('fecha 46341', excelDateKey('46341'), '2026-11-15');
equal('fecha con hora', excelDateKey('46341.75'), '2026-11-15');
equal('fecha 1904', excelDateKey(1, true), '1904-01-02');
equal('fecha vacia', excelDateKey(''), null);
equal('fecha de texto', excelDateKey('abc'), null);
equal('fecha negativa', excelDateKey(-3), null);
equal('entidades', unescapeXml('A &amp; B &lt;1&gt; &quot;x&quot; &apos;y&apos; &#65;&#x42;'), 'A & B <1> "x" \'y\' AB');
equal('entidad desconocida se deja', unescapeXml('&nbsp;&amp;'), '&nbsp;&');
equal('doble escape no se deshace dos veces', unescapeXml('&amp;lt;'), '&lt;');

console.log('\nIda y vuelta con el exportador de reportes (zip sin compresion, texto en linea)');
{
    const model = {
        title: 'Reporte de prueba', subtitle: 'Datos inventados', condoName: 'Condominio Ficticio', userName: 'Persona Inventada',
        kpis: [{ label: 'Lotes', value: 3 }],
        tables: [
            {
                title: 'Saldos', headers: ['Lote', 'Propietario', 'Saldo'], numeric: [2],
                rows: [['A-1', 'Ana <Inventada> & Hija', 300], ['B-2', '=HYPERLINK("x")', 1250.5], ['C-3', 'Texto con "comillas"', 0]]
            },
            { title: 'Segunda: hoja', headers: ['Mes', 'Monto'], rows: [['2026-10', 80]] }
        ]
    };
    const bytes = Export.buildXlsx(model);
    const book = readXlsx(Buffer.from(bytes));
    equal('dos hojas', book.sheets.length, 2);
    equal('nombres de hoja', book.sheets.map((s) => s.name), ['Saldos', 'Segunda hoja']);
    equal('hojas visibles', book.sheets.map((s) => s.state), ['visible', 'visible']);
    equal('fechas 1900', book.date1904, false);
    yes('partes del zip', book.files.includes('xl/workbook.xml') && book.files.includes('xl/worksheets/sheet2.xml'));
    const first = book.sheets[0];
    equal('titulo en A1', cellText(first.rows[0], 0), 'Reporte de prueba');
    const header = first.rows.find((row) => cellText(row, 0) === 'Lote');
    yes('fila de encabezados', header);
    equal('encabezados', [0, 1, 2].map((c) => cellText(header, c)), ['Lote', 'Propietario', 'Saldo']);
    const data = first.rows.filter((row) => row.r > header.r);
    equal('tres filas de datos', data.length, 3);
    equal('texto con simbolos', cellText(data[0], 1), 'Ana <Inventada> & Hija');
    equal('numero entero', cellNumber(data[0], 2), 300);
    equal('lo que parece formula llega como texto', data[1].cells[1], { v: '=HYPERLINK("x")', t: 'inlineStr', s: data[1].cells[1].s, f: null });
    equal('numero con decimales', cellNumber(data[1], 2), 1250.5);
    equal('tipo numero', data[1].cells[2].t, 'n');
    equal('comillas', cellText(data[2], 1), 'Texto con "comillas"');
    equal('cero', data[2].cells[2].v, '0');
    const second = book.sheets[1];
    const header2 = second.rows.find((row) => cellText(row, 0) === 'Mes');
    equal('segunda hoja', [cellText(rowOf(second, header2.r + 1), 0), cellNumber(rowOf(second, header2.r + 1), 1)], ['2026-10', 80]);
    equal('celda que no existe', [cellText(header2, 40), cellNumber(header2, 40)], ['', 0]);
}

console.log('\nLibro como lo guarda Excel (comprimido, textos compartidos)');
{
    const shared = [
        '<t>Lote</t>',
        '<t>Propietario</t>',
        '<r><t>Juana </t></r><r><rPr><b/></rPr><t xml:space="preserve">de la Prueba</t></r>',
        '<t>Mu&#241;oz &amp; C&#xED;a</t>',
        '<t>Linea uno_x000D__x000A_linea dos</t>',
        '<t>Kana</t><rPh sb="0" eb="1"><t>NO</t></rPh><phoneticPr fontId="1"/>',
        '<t/>'
    ];
    const sheet1 = `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:H9"/><sheetData>`
        + '<row r="1" spans="1:8"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s" s="4"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="str"><f>CONCATENATE("A","-",1)</f><v>A-1</v></c><c r="B2" t="s"><v>2</v></c><c r="E2"><v>300</v></c><c r="H2" s="7"><v>46341</v></c></row>'
        + '<row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>B-2</t></is></c><c r="B3" t="s"><v>3</v></c><c r="E3"><f>E2*2</f><v>600.5</v></c></row>'
        + '<row r="5"><c r="B5" t="s"><v>4</v></c><c r="C5" t="s"><v>5</v></c><c r="D5" t="s"><v>6</v></c><c r="F5" t="b"><v>1</v></c><c r="G5" t="e"><v>#N/A</v></c><c r="AA5"><v>-12.75</v></c></row>'
        + '<row r="6"><c r="A6" s="2"/><c r="B6"><f>SUM(E2:E3)</f></c><c r="C6" t="s"><v>99</v></c></row>'
        + '<row><c t="inlineStr"><is><t>sin</t></is></c><c><v>7</v></c></row>'
        + '<row r="9"><c r="C9"><v>1</v></c><c><v>2</v></c></row>'
        + '</sheetData><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C5:D6"/></mergeCells></worksheet>';
    const sheet2 = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>`
        + "<x:row r='2'><x:c r='B2' t='inlineStr'><x:is><x:t>con prefijo</x:t></x:is></x:c><x:c r='C2'><x:v>15</x:v></x:c></x:row>"
        + '</x:sheetData></x:worksheet>';
    const empty = `<worksheet ${NS}><sheetData/></worksheet>`;
    const files = bookFiles({
        shared,
        sheets: [{ name: 'CARTERA &amp; SALDOS', xml: sheet1 }, { name: 'Oculta', state: 'hidden', xml: sheet2 }, { name: 'Vacia', xml: empty }],
        targets: ['worksheets/sheet1.xml', '/xl/worksheets/sheet2.xml', 'worksheets/sheet3.xml']
    });
    const book = readXlsx(makeZip(files));
    equal('tres hojas', book.sheets.map((s) => s.name), ['CARTERA & SALDOS', 'Oculta', 'Vacia']);
    equal('estado de las hojas', book.sheets.map((s) => s.state), ['visible', 'hidden', 'visible']);
    const sheet = book.sheets[0];
    equal('filas leidas', sheet.rows.map((row) => row.r), [1, 2, 3, 5, 6, 7, 9]);
    equal('fila 1', valuesOf(rowOf(sheet, 1)), { 0: 'Lote', 1: 'Propietario' });
    equal('estilo de la celda', rowOf(sheet, 1).cells[1].s, '4');
    equal('texto de formula', rowOf(sheet, 2).cells[0], { v: 'A-1', t: 'str', s: null, f: 'CONCATENATE("A","-",1)' });
    equal('texto con formato (varios tramos)', cellText(rowOf(sheet, 2), 1), 'Juana de la Prueba');
    equal('numero en la columna E', rowOf(sheet, 2).cells[4], { v: '300', t: 'n', s: null, f: null });
    equal('fecha como numero de serie', excelDateKey(cellText(rowOf(sheet, 2), 7), book.date1904), '2026-11-15');
    equal('fila oculta', [rowOf(sheet, 2).hidden, rowOf(sheet, 3).hidden], [false, true]);
    equal('texto en linea', cellText(rowOf(sheet, 3), 0), 'B-2');
    equal('entidades en textos compartidos', cellText(rowOf(sheet, 3), 1), 'Muñoz & Cía');
    equal('formula con su valor', rowOf(sheet, 3).cells[4], { v: '600.5', t: 'n', s: null, f: 'E2*2' });
    equal('saltos de linea de Excel', rowOf(sheet, 5).cells[1].v, 'Linea uno\r\nlinea dos');
    equal('la guia fonetica no cuenta', rowOf(sheet, 5).cells[2].v, 'Kana');
    equal('texto vacio', rowOf(sheet, 5).cells[3].v, '');
    equal('booleano y error', [rowOf(sheet, 5).cells[5].v, rowOf(sheet, 5).cells[6].v], ['1', '#N/A']);
    equal('columna AA y negativo', cellNumber(rowOf(sheet, 5), 26), -12.75);
    equal('celda solo con estilo no existe', rowOf(sheet, 6).cells[0], undefined);
    equal('formula sin valor', rowOf(sheet, 6).cells[1], { v: null, t: 'n', s: null, f: 'SUM(E2:E3)' });
    equal('texto compartido que no existe', rowOf(sheet, 6).cells[2], undefined);
    equal('fila y celdas sin referencia', valuesOf(rowOf(sheet, 7)), { 0: 'sin', 1: '7' });
    equal('celda sin referencia tras una con referencia', valuesOf(rowOf(sheet, 9)), { 2: '1', 3: '2' });
    equal('celdas combinadas', sheet.merges, ['A1:B1', 'C5:D6']);
    equal('hoja con prefijo y comillas simples', valuesOf(rowOf(book.sheets[1], 2)), { 1: 'con prefijo', 2: '15' });
    equal('hoja vacia', book.sheets[2].rows, []);
    equal('mismo libro sin comprimir', readXlsx(makeZip(files, { method: 0 })).sheets[0].rows.length, 7);

    const book1904 = readXlsx(makeZip(bookFiles({ date1904: true, sheets: [{ name: 'F', xml: `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>44879</v></c></row></sheetData></worksheet>` }] })));
    equal('libro con fechas desde 1904', [book1904.date1904, excelDateKey(cellText(book1904.sheets[0].rows[0], 0), book1904.date1904)], [true, '2026-11-15']);
}

console.log('\nArchivos que se rechazan');
{
    const sheet = `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
    const files = bookFiles({ sheets: [{ name: 'Hoja', xml: sheet }] });
    const good = makeZip(files);
    equal('el archivo bueno se lee', readXlsx(good).sheets[0].rows[0].cells[0].v, '1');
    throws('texto que no es un zip', () => readXlsx(Buffer.from('lote,propietario\nA-1,Inventada\n')), /no es un \.xlsx/);
    throws('archivo vacio', () => readXlsx(Buffer.alloc(0)), /no es un \.xlsx/);
    throws('zip que no es un libro', () => readXlsx(makeZip([{ name: 'nota.txt', data: 'hola' }])), /no es un libro de Excel/);
    throws('protegido con clave', () => readXlsx(makeZip(files, { flags: 1 })), /protegido con clave/);
    throws('suma de control que no coincide', () => readXlsx(makeZip(files, { breakCrc: true })), /suma de control/);
    // Copia del zip con cada entrada del directorio central retocada por `change(buffer, posicion)`
    const tampered = (source, change) => {
        const bad = Buffer.from(source);
        let at = bad.readUInt32LE(bad.length - 22 + 16);
        for (let n = 0; n < files.length; n++) { const next = at + 46 + bad.readUInt16LE(at + 28); change(bad, at); at = next; }
        return bad;
    };
    throws('directorio danado', () => { const bad = Buffer.from(good); bad.writeUInt32LE(0, bad.readUInt32LE(bad.length - 22 + 16)); readXlsx(bad); }, /directorio del zip/);
    throws('encabezado local danado', () => readXlsx(tampered(good, (bad, at) => bad.writeUInt32LE(0, bad.readUInt32LE(at + 42)))), /encabezado del zip/);
    throws('zip64', () => { const bad = Buffer.from(good); bad.writeUInt32LE(0xFFFFFFFF, bad.length - 22 + 16); readXlsx(bad); }, /zip64/);
    throws('compresion desconocida', () => readXlsx(tampered(makeZip(files, { method: 0 }), (bad, at) => bad.writeUInt16LE(12, at + 10))), /Compresion no admitida/);
    throws('hoja que apunta fuera del archivo', () => readXlsx(makeZip(bookFiles({ sheets: [{ name: 'Hoja', xml: sheet }], targets: ['../../etc/passwd'] }))), /No se encontro la hoja/);
    throws('hoja que no esta en el archivo', () => readXlsx(makeZip(bookFiles({ sheets: [{ name: 'Hoja', xml: sheet }], targets: ['worksheets/otra.xml'] }))), /No se encontro la hoja/);
    // Una parte que declara un tamano enorme no se descomprime
    throws('parte que declara un tamano enorme', () => readXlsx(tampered(good, (bad, at) => bad.writeUInt32LE(0x7FFFFFFF, at + 24))), /demasiado grande/);
    throws('archivo cortado', () => readXlsx(tampered(good, (bad, at) => bad.writeUInt32LE(bad.length, at + 20))), /incompleto|suma de control/);
    const zip = unzip(good);
    equal('parte que no existe', zip.read('xl/no-existe.xml'), null);
    equal('nombres de las partes', zip.names.slice(0, 3), ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']);
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) console.log(`Fallas:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length ? 1 : 0);
