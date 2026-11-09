// Genera la tabla de privilegios del README.md a partir de privilegios.js (la fuente unica).
// Uso: node generar-tabla-privilegios.mjs          escribe la tabla entre las marcas BEGIN/END del README
//      node generar-tabla-privilegios.mjs --check  falla si el README no esta al dia (lo corre test-privilegios.mjs)
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../privilegios.js');
const readmeUrl = new URL('../README.md', import.meta.url);
const BEGIN = '<!-- BEGIN tabla-privilegios (scripts/generar-tabla-privilegios.mjs) -->';
const END = '<!-- END tabla-privilegios -->';

const cell = (text) => String(text).replace(/\|/g, '/');
const roles = (item) => (item.roles && item.roles.length ? item.roles.map((r) => `\`${r}\``).join(', ') : 'ninguno');

export function buildTable() {
    const total = P.KEYS.length;
    const roots = P.ITEMS.filter((i) => !i.parent).length;
    const out = [BEGIN, '', `${total} privilegios: ${roots} paraguas y ${total - roots} acciones. **Garantía** dice quién hace cumplir cada uno: *Reglas* = las reglas de Firestore (o el servidor) lo rechazan aunque se salten la pantalla; *Pantalla* = solo oculta o bloquea en la interfaz (lectura de datos que las reglas no separan por campo).`, ''];
    for (const group of P.GROUPS) {
        out.push(`### ${group.title}`, '', '| Privilegio | Qué permite | Por defecto | Garantía |', '| --- | --- | --- | --- |');
        for (const item of group.items) {
            const key = `${item.depth ? '&nbsp;&nbsp;'.repeat(item.depth) + '↳ ' : ''}\`${item.key}\``;
            const flags = item.sensitive ? ' **(sensible)**' : '';
            const by = item.parent ? 'los de su paraguas' : roles(item);
            out.push(`| ${key} | ${cell(item.label)}${flags}. ${cell(item.description)} | ${by} | ${item.enforce === 'reglas' ? 'Reglas' : 'Pantalla'} |`);
        }
        out.push('');
    }
    out.push(END);
    return out.join('\n');
}

const readme = fs.readFileSync(readmeUrl, 'utf8');
const a = readme.indexOf(BEGIN);
const b = readme.indexOf(END);
if (a < 0 || b < 0) { console.error('Faltan las marcas de la tabla en README.md'); process.exit(1); }
const next = readme.slice(0, a) + buildTable() + readme.slice(b + END.length);
if (process.argv.includes('--check')) {
    if (next !== readme) { console.error('La tabla de privilegios del README no esta al dia: corre `node scripts/generar-tabla-privilegios.mjs`'); process.exit(1); }
    console.log('Tabla de privilegios al dia');
} else {
    fs.writeFileSync(readmeUrl, next);
    console.log(`Tabla escrita: ${P.KEYS.length} privilegios`);
}
