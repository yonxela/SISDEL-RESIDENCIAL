/* ═══════════════════════════════════════════════════════════════
   SISDEL - Busqueda inteligente (la usan OIKOS, admin y auditor)
   ───────────────────────────────────────────────────────────────
   Reglas, iguales en todo el sistema:
   - No importan mayusculas, acentos ni la enie: "nunez" encuentra "Núñez".
   - Se busca mientras se escribe: cada palabra escrita es el PRINCIPIO de alguna palabra del registro
     ("jua per" encuentra "Juan Pérez"; el orden no importa: "perez jua" tambien).
   - Todas las palabras escritas deben coincidir (en cualquier campo: nombre, casa, telefono...).
   - Los numeros (casa, telefono, DPI) tambien coinciden dentro del dato cuando se escriben 3 o mas cifras:
     "5678" encuentra +502 5555 5678.
   - Si nada coincide por el principio, se afloja: se busca la parte escrita en cualquier lugar de las palabras
     (a partir de 3 letras), para que un pedazo de en medio tambien encuentre algo.
   - El resultado sale ordenado: primero los que empiezan con lo escrito en el primer campo (el nombre).

   Es logica pura (sin pantalla): se prueba en scripts/test-busqueda.mjs. La ventana de busqueda de cada pagina
   usa query(), score(), filter() y highlight().
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelBusqueda = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Minusculas, sin acentos y sin signos: todo lo que no es letra o numero queda como espacio. El largo no cambia
    // (cada caracter se vuelve uno solo), asi un lugar del texto plegado es el mismo lugar del texto original.
    const cache = new Map();
    function fold(text) {
        // NFC: una letra con acento escrita en dos partes (Mac, pegado) vale como una sola
        const source = String(text == null ? '' : text).normalize('NFC');
        const cached = cache.get(source);
        if (cached !== undefined) return cached;
        let out = '';
        for (const ch of source) {
            const c = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().charAt(0);
            out += /[a-z0-9]/.test(c) ? c : ' ';
            if (ch.length > 1) out += ' '.repeat(ch.length - 1);
        }
        if (cache.size > 6000) cache.clear();
        cache.set(source, out);
        return out;
    }
    const wordsOf = (folded) => folded.split(' ').filter(Boolean);
    const isDigits = (token) => /^[0-9]+$/.test(token);

    // Lo que el usuario escribio: sus palabras, ya plegadas ("" = sin busqueda)
    function query(text) {
        return { text: String(text == null ? '' : text), tokens: wordsOf(fold(text)) };
    }
    const asQuery = (q) => (q && Array.isArray(q.tokens) ? q : query(q));

    // Puntos con que un registro responde a la busqueda (0 = no coincide). `fields` son los textos del registro;
    // el primero es el principal (el nombre). Con loose se acepta la parte escrita en cualquier lugar.
    function score(q, fields, loose) {
        const { tokens } = asQuery(q);
        if (!tokens.length) return 1;
        const parts = (fields || []).map((f) => {
            const folded = fold(f);
            return { words: wordsOf(folded), compact: folded.replace(/ /g, '') };
        });
        let total = 0;
        for (const token of tokens) {
            let best = 0;
            parts.forEach((part, index) => {
                const main = index === 0;
                for (let w = 0; w < part.words.length; w++) {
                    const word = part.words[w];
                    if (word === token) best = Math.max(best, isDigits(token) ? 120 : main ? 110 : 80);
                    else if (word.startsWith(token)) best = Math.max(best, main && w === 0 ? 100 : main ? 80 : 70);
                    else if (loose && token.length >= 3 && word.includes(token)) best = Math.max(best, 20);
                }
                // Cifras sueltas dentro del dato (un telefono con otro formato, un lote con letra delante)
                if (!best && isDigits(token) && token.length >= 3 && part.compact.includes(token)) best = 40;
            });
            if (!best) return 0;
            total += best;
        }
        return total;
    }

    // Los items que coinciden, los mejores primero (a igualdad de puntos, en su orden de siempre).
    // getFields(item) devuelve los textos del item. Sin nada escrito devuelve todos, sin reordenar.
    function filter(items, text, getFields, options) {
        const q = asQuery(text);
        const list = Array.isArray(items) ? items : [];
        const limit = options && options.limit > 0 ? options.limit : Infinity;
        if (!q.tokens.length) return limit === Infinity ? list.slice() : list.slice(0, limit);
        const rank = (loose) => list
            .map((item, index) => ({ item, index, points: score(q, getFields(item), loose) }))
            .filter((x) => x.points > 0)
            .sort((a, b) => b.points - a.points || a.index - b.index);
        let found = rank(false);
        if (!found.length) found = rank(true);
        return found.slice(0, limit === Infinity ? found.length : limit).map((x) => x.item);
    }

    function escapeHtml(text) {
        return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // El texto en HTML (escapado) con lo que coincide dentro de <mark>. El nombre de una etiqueta nunca sale de aqui:
    // todo lo que viene de la base se escapa.
    function highlight(text, search) {
        const source = String(text == null ? '' : text).normalize('NFC');
        const { tokens } = asQuery(search);
        if (!tokens.length) return escapeHtml(source);
        const folded = fold(source);
        const marks = [];
        for (const token of tokens) {
            let at = -1;
            let from = 0;
            // primero al principio de una palabra; si no hay, donde este
            while ((at = folded.indexOf(token, from)) !== -1) {
                if (at === 0 || folded[at - 1] === ' ') { marks.push([at, at + token.length]); break; }
                from = at + 1;
            }
            if (at === -1) {
                const anywhere = folded.indexOf(token);
                if (anywhere !== -1 && token.length >= 3) marks.push([anywhere, anywhere + token.length]);
            }
        }
        if (!marks.length) return escapeHtml(source);
        marks.sort((a, b) => a[0] - b[0]);
        const merged = [marks[0].slice()];
        for (const m of marks.slice(1)) {
            const last = merged[merged.length - 1];
            if (m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push(m.slice());
        }
        let html = '';
        let cursor = 0;
        for (const [start, end] of merged) {
            html += escapeHtml(source.slice(cursor, start)) + '<mark>' + escapeHtml(source.slice(start, end)) + '</mark>';
            cursor = end;
        }
        return html + escapeHtml(source.slice(cursor));
    }

    return { fold, query, score, filter, highlight, escapeHtml };
});
