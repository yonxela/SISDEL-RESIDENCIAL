// Lector de archivos .xlsx sin dependencias (zip + XML a mano), para los scripts de carga.
// Solo LEE valores: no ejecuta formulas ni macros, no sigue enlaces externos y nunca escribe en el archivo.
// Un Excel que llega de fuera es un dato no confiable: se rechaza si esta cifrado, si es zip64 o si alguna
// de sus partes pasa de MAX_PART al descomprimirse.
//
// readXlsx(rutaOBuffer) -> {
//   files:  nombres de las partes del zip,
//   date1904: true si el libro cuenta las fechas desde 1904,
//   sheets: [{ name, state, rows: [{ r, hidden, cells: { [columna]: { v, t, s, f } } }], merges }]
// }
// La columna va desde 0 (A = 0, B = 1). `v` es el valor como TEXTO tal como esta en el archivo (un numero
// llega como '300' o '1250.5'; una fecha con formato de fecha llega como su numero de serie: excelDateKey lo
// convierte); `t` el tipo de Excel ('n' numero, 's' e 'inlineStr' texto, 'str' texto de formula, 'b', 'e');
// `s` el estilo y `f` la formula (texto, sin evaluar) o null.
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAX_PART = 256 * 1024 * 1024;
const DAY_MS = 86400000;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
export function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Zip ──
// Devuelve { names, read(nombre) -> Buffer | null }. Lee el directorio central; cada parte se descomprime al pedirla.
export function unzip(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xFFFF); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('El archivo no es un .xlsx valido (no es un zip).');
    const total = buffer.readUInt16LE(end + 10);
    const centralOffset = buffer.readUInt32LE(end + 16);
    if (total === 0xFFFF || centralOffset === 0xFFFFFFFF) throw new Error('El archivo es demasiado grande (zip64): no se admite.');
    const entries = new Map();
    let at = centralOffset;
    for (let n = 0; n < total; n++) {
        if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('El archivo esta danado (directorio del zip).');
        const flags = buffer.readUInt16LE(at + 8);
        const nameLength = buffer.readUInt16LE(at + 28);
        const entry = {
            encrypted: (flags & 1) === 1,
            method: buffer.readUInt16LE(at + 10),
            crc: buffer.readUInt32LE(at + 16),
            compressedSize: buffer.readUInt32LE(at + 20),
            size: buffer.readUInt32LE(at + 24),
            localOffset: buffer.readUInt32LE(at + 42)
        };
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
        if (!entries.has(name)) entries.set(name, entry);
        at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    }
    function read(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        if (entry.encrypted) throw new Error('El archivo esta protegido con clave: guardelo sin clave y vuelva a intentar.');
        if (entry.size > MAX_PART || entry.compressedSize === 0xFFFFFFFF) throw new Error(`La parte ${name} es demasiado grande.`);
        const local = entry.localOffset;
        if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('El archivo esta danado (encabezado del zip).');
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const raw = buffer.subarray(start, start + entry.compressedSize);
        if (raw.length !== entry.compressedSize) throw new Error('El archivo esta danado (incompleto).');
        let data;
        if (entry.method === 0) data = raw;
        else if (entry.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART });
        else throw new Error(`Compresion no admitida en ${name} (metodo ${entry.method}).`);
        if (crc32(data) !== entry.crc) throw new Error(`El archivo esta danado (${name} no coincide con su suma de control).`);
        return data;
    }
    return { names: [...entries.keys()], read };
}

// ── XML ──
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(text) {
    return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, code) => {
        if (code[0] !== '#') return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : all;
        const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point >= 0 && point <= 0x10FFFF ? String.fromCodePoint(point) : all;
    });
}
// Excel escribe los caracteres de control como _x000D_ (y un "_x" literal como _x005F_x...)
const unescapeExcel = (text) => text.replace(/_x([0-9a-fA-F]{4})_/g, (all, hex) => String.fromCharCode(parseInt(hex, 16)));
const textOf = (raw) => unescapeExcel(unescapeXml(raw));

// Atributos de una etiqueta: 'r="B5" t="s"' -> { r: 'B5', t: 's' }. El prefijo (r:id) se conserva
function attributes(raw) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let mt;
    while ((mt = re.exec(raw))) out[mt[1]] = unescapeXml(mt[2] !== undefined ? mt[2] : mt[3]);
    return out;
}
// Etiquetas <nombre ...>...</nombre> o <nombre .../> (con o sin prefijo): [{ attrs, inner }]
function elements(xml, name) {
    const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, 'g');
    const out = [];
    let mt;
    while ((mt = re.exec(xml))) out.push({ attrs: attributes(mt[1]), inner: mt[2] === undefined ? '' : mt[2] });
    return out;
}
// Todo el texto de los <t> de un fragmento (texto con formato: varios <r><t>); la guia fonetica (<rPh>) no cuenta
function richText(xml) {
    return elements(xml.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, ''), 't').map((t) => textOf(t.inner)).join('');
}

// 'B5' -> 1 ; 'AA10' -> 26 ; null si no es una referencia de celda
export function columnIndex(ref) {
    const mt = /^([A-Za-z]+)/.exec(String(ref || ''));
    if (!mt) return null;
    let n = 0;
    for (const ch of mt[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

// Numero de serie de una fecha de Excel -> 'AAAA-MM-DD' (null si no es un numero de fecha razonable)
export function excelDateKey(serial, date1904 = false) {
    const n = Math.floor(parseFloat(serial));
    if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
    // Sistema 1900: el dia 1 es 1900-01-01 y Excel cuenta un 29 de febrero de 1900 que no existio
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, n < 60 ? 31 : 30);
    return new Date(base + n * DAY_MS).toISOString().slice(0, 10);
}

function parseSheet(xml, shared) {
    const data = /<(?:[\w.-]+:)?sheetData(?=[\s/>])[^>]*?>([\s\S]*?)<\/(?:[\w.-]+:)?sheetData>/.exec(xml);
    const rows = [];
    let rowNumber = 0;
    elements(data ? data[1] : '', 'row').forEach((row) => {
        const explicit = parseInt(row.attrs.r, 10);
        rowNumber = Number.isFinite(explicit) ? explicit : rowNumber + 1; // sin "r", la fila es la siguiente
        const cells = {};
        let column = -1;
        elements(row.inner, 'c').forEach((cell) => {
            const index = columnIndex(cell.attrs.r);
            column = index === null ? column + 1 : index; // sin "r", la celda es la siguiente
            const type = cell.attrs.t || 'n';
            const valueNode = elements(cell.inner, 'v')[0];
            const formulaNode = elements(cell.inner, 'f')[0];
            let value = null;
            if (type === 's' && valueNode) {
                const item = shared[parseInt(valueNode.inner, 10)];
                value = item === undefined ? null : item;
            } else if (type === 'inlineStr') {
                value = richText(cell.inner);
            } else if (valueNode) {
                value = textOf(valueNode.inner);
            }
            if (value === null && !formulaNode) return;
            cells[column] = { v: value, t: type, s: cell.attrs.s === undefined ? null : cell.attrs.s, f: formulaNode ? textOf(formulaNode.inner) : null };
        });
        rows.push({ r: rowNumber, hidden: row.attrs.hidden === '1' || row.attrs.hidden === 'true', cells });
    });
    return { rows, merges: elements(xml, 'mergeCell').map((m) => m.attrs.ref).filter(Boolean) };
}

export function readXlsx(input) {
    const zip = unzip(typeof input === 'string' ? fs.readFileSync(input) : input);
    const part = (name) => { const data = zip.read(name); return data ? data.toString('utf8') : null; };
    const workbook = part('xl/workbook.xml');
    const rels = part('xl/_rels/workbook.xml.rels');
    if (!workbook || !rels) throw new Error('El archivo no es un libro de Excel (.xlsx).');
    const sharedXml = part('xl/sharedStrings.xml');
    const shared = sharedXml ? elements(sharedXml, 'si').map((si) => richText(si.inner)) : [];
    const targets = {};
    elements(rels, 'Relationship').forEach((r) => { targets[r.attrs.Id] = r.attrs.Target; });
    const properties = elements(workbook, 'workbookPr')[0];
    const date1904 = !!properties && (properties.attrs.date1904 === '1' || properties.attrs.date1904 === 'true');
    const sheets = elements(workbook, 'sheet').map((sheet) => {
        const target = targets[sheet.attrs['r:id']] || '';
        // Solo partes dentro del propio archivo: un destino con ".." o externo no se sigue
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        const xml = target && !path.includes('..') ? part(path) : null;
        if (xml === null) throw new Error(`No se encontro la hoja "${sheet.attrs.name}" dentro del archivo.`);
        return { name: sheet.attrs.name || '', state: sheet.attrs.state || 'visible', ...parseSheet(xml, shared) };
    });
    return { files: zip.names, date1904, sheets };
}

// Valor de una celda como texto recortado ('' si no hay) y como numero (0 si no es numero)
export function cellText(row, column) {
    const cell = row && row.cells ? row.cells[column] : null;
    return cell && cell.v !== null && cell.v !== undefined ? String(cell.v).trim() : '';
}
export function cellNumber(row, column) {
    const n = parseFloat(cellText(row, column).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}
