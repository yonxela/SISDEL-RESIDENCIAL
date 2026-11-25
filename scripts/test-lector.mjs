// Pruebas del lector de codigos USB de la garita (lector-codigos.js): sin emuladores ni navegador.
// La logica con teclas simuladas a distintas velocidades (un lector escribe a pocos ms por letra; una persona, a 100 o mas), el
// codigo normalizado y la conexion con una pagina de mentira (campos, foco, Enter que no debe enviar nada, cierre por silencio).
// La garita de verdad, con una rafaga de teclas en Chrome, se prueba en test-garita-lector.mjs.
// Uso: node test-lector.mjs (tambien corre con npm test).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const L = require('../lector-codigos.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

// Escribe `text` en el detector con `gap` ms entre letras desde `t0`; devuelve { actions, t (la hora de la ultima tecla) }
function type(det, text, gap, t0 = 1000, extra = {}) {
    let t = t0;
    const actions = [];
    for (let i = 0; i < text.length; i++) {
        actions.push(det.key({ key: text[i], ...extra }, t).action);
        if (i < text.length - 1) t += gap;
    }
    return { actions, t };
}

console.log('\nLa rafaga de un lector');
{
    const det = L.createDetector();
    const r = type(det, 'MARMWPKCY3TCC', 6);
    equal('las dos primeras letras se esperan y de la tercera en adelante ya es una lectura en curso (no se escribe nada en la pagina)', [r.actions[0], r.actions[1], r.actions[2], r.actions[12]], ['buffer', 'buffer', 'swallow', 'swallow']);
    const end = det.key({ key: 'Enter' }, r.t + 8);
    equal('con Enter termina la lectura', [end.action, end.scan.text, end.scan.length, end.scan.endedBy], ['scan', 'MARMWPKCY3TCC', 13, 'Enter']);
    equal('y mide la velocidad (ms por letra)', [end.scan.avgGap, end.scan.maxGap], [6, 6]);
    equal('despues queda limpio para la siguiente', det.size(), 0);
}
{
    const det = L.createDetector();
    const r = type(det, 'VA101', 15);
    const end = det.key({ key: 'Tab' }, r.t + 20);
    equal('algunos lectores terminan con Tab', [end.action, end.scan.text, end.scan.endedBy], ['scan', 'VA101', 'Tab']);
}
{
    const det = L.createDetector();
    const a = type(det, 'MARTEST1', 4);
    const e1 = det.key({ key: 'Enter' }, a.t + 4);
    const b = type(det, 'MARTEST3', 4, a.t + 900);
    const e2 = det.key({ key: 'Enter' }, b.t + 4);
    equal('dos lecturas seguidas salen una por una', [e1.scan.text, e2.scan.text], ['MARTEST1', 'MARTEST3']);
}
{
    const det = L.createDetector();
    const r = type(det, 'MAR', 5);
    det.key({ key: 'Shift' }, r.t + 2);
    const r2 = type(det, 'tEst1', 5, r.t + 6);
    const end = det.key({ key: 'Enter' }, r2.t + 5);
    equal('el Shift que el lector manda entre mayusculas y minusculas no corta la lectura', [end.action, end.scan.text], ['scan', 'MARtEst1']);
}
{
    const det = L.createDetector();
    const r = type(det, 'AB@1234', 8, 1000, { ctrl: true, alt: true });
    const end = det.key({ key: 'Enter' }, r.t + 8);
    equal('AltGr (Ctrl + Alt) es una letra normal (un "@" o un "|" que pide AltGr)', [end.action, end.scan && end.scan.text], ['scan', 'AB@1234']);
}

console.log('\nUna persona no es un lector');
{
    const det = L.createDetector();
    const r = type(det, 'VA101', 150);
    const end = det.key({ key: 'Enter' }, r.t + 200);
    equal('alguien que escribe a mano (150 ms por letra) no es una lectura: cada letra es una rafaga nueva y el Enter pasa de largo', [r.actions.every((a) => a === 'buffer'), end.action], [true, 'ignore']);
    equal('(las letras no se tragan: una persona escribe en su campo, el Enter lo envia ella)', r.actions.includes('swallow'), false);
}
{
    const det = L.createDetector();
    const r = type(det, 'VA101', 70);
    const end = det.key({ key: 'Enter' }, r.t + 70);
    equal('70 ms por letra (mecanografo rapido) no pasa el promedio de un lector', end.action, 'ignore');
}
{
    const det = L.createDetector();
    const a = type(det, 'MAR', 5);
    const b = type(det, 'TEST1', 5, a.t + 400);
    const end = det.key({ key: 'Enter' }, b.t + 5);
    equal('una pausa de 400 ms en medio corta la rafaga: solo cuenta lo ultimo (5 letras, que si alcanzan)', [end.action, end.scan.text], ['scan', 'TEST1']);
}
{
    const det = L.createDetector();
    const r = type(det, 'VA1', 5);
    const end = det.key({ key: 'Enter' }, r.t + 5);
    equal('menos de 4 letras no es un codigo (el Enter pasa de largo)', end.action, 'ignore');
}
{
    const det = L.createDetector();
    const r = type(det, 'MARTEST1', 5);
    const end = det.key({ key: 'Enter' }, r.t + 600);
    equal('un Enter que llega medio segundo despues ya es de una persona', end.action, 'ignore');
}
{
    const det = L.createDetector();
    const r = type(det, 'MARTE', 5);
    det.key({ key: 'Backspace' }, r.t + 5);
    const end = det.key({ key: 'Enter' }, r.t + 10);
    equal('Retroceso, Escape o las flechas cortan: es una persona corrigiendo', end.action, 'ignore');
}
{
    const det = L.createDetector();
    const r = type(det, 'MARTEST1', 5, 1000, { repeat: true });
    equal('una tecla sostenida (repeat) nunca es una lectura', [r.actions.every((a) => a === 'ignore'), det.size()], [true, 0]);
    const r2 = type(det, 'MARTEST1', 5, 3000, { ctrl: true });
    equal('Ctrl+letra son atajos (Ctrl+V pega): no es una lectura', [r2.actions.every((a) => a === 'ignore'), det.size()], [true, 0]);
}
{
    const det = L.createDetector();
    const big = 'A'.repeat(80);
    const r = type(det, big, 3);
    const end = det.key({ key: 'Enter' }, r.t + 3);
    equal('mas de 64 letras no es un codigo de este sistema: se queda con las ultimas 16 (la rafaga se reinicio)', [end.action, end.scan && end.scan.length], ['scan', 16]);
}

console.log('\nLectores que no mandan Enter');
{
    const det = L.createDetector();
    const r = type(det, 'MARMWPKCY3TCC', 6);
    equal('antes de que pase el silencio no cierra nada', det.idle(r.t + 100), null);
    const scan = det.idle(r.t + 260);
    equal('con 220 ms de silencio una lectura larga y rapida se cierra sola', [scan && scan.text, scan && scan.endedBy], ['MARMWPKCY3TCC', 'ninguno']);
}
{
    const det = L.createDetector();
    const r = type(det, 'VA101', 5);
    equal('una lectura corta sin Enter no se cierra sola (se confundiria con cualquiera)', det.idle(r.t + 400), null);
    equal('y la rafaga vieja se descarta', det.size(), 0);
}
{
    const det = L.createDetector();
    const r = type(det, 'MARTEST1ABC', 40);
    equal('una rafaga lenta sin Enter (40 ms por letra) tampoco', det.idle(r.t + 400), null);
}

console.log('\nEl codigo como lo entiende el sistema');
{
    equal('mayusculas y sin espacios ni caracteres de control', L.normalize('  mar test 1\r\n').code, 'MARTEST1');
    equal('quita el prefijo de simbologia (]Q1) que algunos lectores agregan', L.normalize(']Q1MARMWPKCY3TCC').code, 'MARMWPKCY3TCC');
    equal('un codigo de letras y numeros no trae alternativas', L.normalize('MARMWPKCY3TCC'), { code: 'MARMWPKCY3TCC', alternatives: [], odd: false });
    equal('un lector en teclado de ingles escribe "\'" donde va "-" y "Ñ" donde va ":": se ofrece la lectura corregida', L.normalize("VIS'TEST").alternatives, ['VIS-TEST']);
    equal('(y la lectura de verdad se conserva primero)', L.normalize("VIS'TEST").code, "VIS'TEST");
    equal('nada de lo recibido (vacio, null) rompe', [L.normalize('').code, L.normalize(null).code, L.normalize(undefined).alternatives], ['', '', []]);
}

console.log('\nConectado a una pagina');
// Una pagina de mentira: reloj manual, un solo escuchador por tipo de evento y campos con foco
function makePage() {
    const page = { now: 0, handlers: { keydown: [], keyup: [] }, timers: [] };
    page.win = {
        performance: { now: () => page.now },
        setTimeout: (fn, ms) => { const t = { fn, at: page.now + ms, on: true }; page.timers.push(t); return t; },
        clearTimeout: (t) => { if (t) t.on = false; }
    };
    page.doc = {
        defaultView: page.win,
        addEventListener: (type, fn) => { page.handlers[type].push(fn); },
        removeEventListener: (type, fn) => { page.handlers[type] = page.handlers[type].filter((f) => f !== fn); }
    };
    page.advance = (ms) => {
        const end = page.now + ms;
        for (;;) {
            const next = page.timers.filter((t) => t.on && t.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!next) break;
            page.now = next.at; next.on = false; next.fn();
        }
        page.now = end;
    };
    // Una tecla en un elemento: devuelve si la pagina la dejo pasar (false = preventDefault)
    page.press = (target, key, opts = {}) => {
        const ev = { key, target, timeStamp: page.now, repeat: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...opts, prevented: false, stopped: false };
        ev.preventDefault = () => { ev.prevented = true; };
        ev.stopImmediatePropagation = () => { ev.stopped = true; };
        page.handlers.keydown.forEach((fn) => fn(ev));
        return ev;
    };
    page.burst = (target, text, gap, end = 'Enter') => {
        const evs = [];
        for (const c of text) {
            evs.push(page.press(target, c));
            if (target && typeof target.value === 'string' && !evs[evs.length - 1].prevented) target.value += c;
            page.advance(gap);
        }
        if (end) evs.push(page.press(target, end));
        return evs;
    };
    return page;
}
const body = { tagName: 'BODY' };
const button = { tagName: 'BUTTON', type: 'button' };
const manual = { tagName: 'INPUT', type: 'text', id: 'manualCode', value: '' };
const other = { tagName: 'INPUT', type: 'text', id: 'otro', value: '' };
const checkbox = { tagName: 'INPUT', type: 'checkbox' };
const allowIn = (el) => el.id === 'manualCode';
{
    equal('los campos de texto son editables; un boton, el cuerpo y una casilla no', [L.isEditable(manual), L.isEditable({ tagName: 'TEXTAREA' }), L.isEditable({ tagName: 'DIV', isContentEditable: true }), L.isEditable(button), L.isEditable(body), L.isEditable(checkbox)], [true, true, true, false, false, false]);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    const evs = page.burst(body, 'MARMWPKCY3TCC', 6);
    equal('sin tocar ningun campo: la lectura llega con el codigo y como se leyo', [got.length, got[0].code, got[0].raw, got[0].endedBy], [1, 'MARMWPKCY3TCC', 'MARMWPKCY3TCC', 'Enter']);
    equal('el Enter final no hace nada en la pagina (ni activa un boton ni envia un formulario)', [evs[evs.length - 1].prevented, evs[evs.length - 1].stopped], [true, true]);
    equal('de la tercera letra en adelante la pagina no escribe nada (Firefox busca con "/" y "\'")', evs.slice(0, 13).map((e) => e.prevented).filter(Boolean).length, 11);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    const evs = page.burst(button, 'MARTEST1', 5);
    equal('con un boton con el foco (el de Confirmar Ingreso): el Enter del lector NO lo activa', [got.length, evs[evs.length - 1].prevented], [1, true]);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    manual.value = '';
    page.burst(manual, 'MARTEST1', 5);
    equal('en el campo de codigo tambien: se ve lo que llega, se borra al terminar y el formulario no se envia', [got.length, got[0].code, manual.value], [1, 'MARTEST1', '']);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    manual.value = 'VA101';
    page.burst(manual, 'MARTEST1', 5);
    equal('si ya habia algo escrito en el campo solo se borra la lectura', [got[0].code, manual.value], ['MARTEST1', 'VA101']);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    other.value = '';
    const evs = page.burst(other, 'MARTEST1', 5);
    equal('en cualquier otro campo (un mensaje, una nota) se asume que una persona escribe: nada se lee ni se borra', [got.length, other.value, evs.some((e) => e.prevented)], [0, 'MARTEST1', false]);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    manual.value = '';
    const evs = page.burst(manual, 'VA101', 150);
    equal('una persona escribiendo su codigo en el campo: Enter lo envia ella (el modulo no se mete)', [got.length, manual.value, evs[evs.length - 1].prevented], [0, 'VA101', false]);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    page.burst(body, 'MARMWPKCY3TCC', 6, null);
    equal('sin Enter: todavia no', got.length, 0);
    page.advance(400);
    equal('sin Enter: con el silencio la lectura se cierra sola', [got.length, got[0] && got[0].endedBy], [1, 'ninguno']);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    manual.value = '';
    page.burst(manual, 'MARMWPKCY3TCC', 6, null);
    page.advance(400);
    equal('sin Enter en el campo de codigo: se cierra sola y se borra lo que alcanzo a escribirse', [got.length, manual.value], [1, '']);
}
{
    const page = makePage();
    const got = [];
    const lector = L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    const probe = [];
    lector.test((s) => probe.push(s));
    page.burst(body, 'MARTEST1', 5);
    equal('en modo de prueba la lectura llega a la prueba y no a la garita', [probe.length, got.length, lector.state().testing, lector.state().last.code], [1, 0, true, 'MARTEST1']);
    lector.test(null);
    page.advance(500);
    page.burst(body, 'MARTEST3', 5);
    equal('al terminar la prueba vuelve a la garita', [got.length, got[0].code, lector.state().testing], [1, 'MARTEST3', false]);
}
{
    const page = makePage();
    const got = [];
    let on = false;
    const lector = L.attach(page.doc, { onScan: (s) => got.push(s), allowIn, enabled: () => on });
    const off = page.burst(body, 'MARTEST1', 5);
    equal('si la garita no deja leer codigos (enabled false) no hace nada ni toca las teclas', [got.length], [0]);
    equal('apagado (escaner manual desactivado) ninguna tecla se frena: ni el Enter ni el espacio', [off.some((e) => e.prevented)], [false]);
    on = true;
    page.advance(500);
    page.burst(body, 'MARTEST1', 5);
    equal('y cuando puede, lee', got.length, 1);
    lector.pause();
    page.advance(500);
    const evs = page.burst(body, 'MARTEST3', 5);
    equal('en pausa tampoco (mientras otra ventana pide el teclado)', [got.length, evs.some((e) => e.prevented)], [1, false]);
    lector.resume();
    page.advance(500);
    page.burst(body, 'MARTEST3', 5);
    equal('y al reanudar lee de nuevo', got.length, 2);
}
{
    const page = makePage();
    const got = [];
    const lector = L.attach(page.doc, { onScan: (s) => { got.push(s); throw new Error('falla de la garita'); }, allowIn });
    const origError = console.error; console.error = () => {};
    page.burst(body, 'MARTEST1', 5);
    page.advance(500);
    page.burst(body, 'MARTEST3', 5);
    console.error = origError;
    equal('un error al procesar una lectura no deja a la pagina sin lector', got.length, 2);
    lector.detach();
    equal('detach quita los escuchadores', [page.handlers.keydown.length, page.handlers.keyup.length], [0, 0]);
}
{
    const page = makePage();
    const got = [];
    L.attach(page.doc, { onScan: (s) => got.push(s), allowIn });
    const evs = page.burst(body, 'AB CD123', 5);
    equal('un espacio dentro de la lectura no activa nada y se quita del codigo', [got[0].raw, got[0].code, evs[2].prevented], ['AB CD123', 'ABCD123', true]);
}

console.log('\nLa garita y el servidor');
{
    const garita = read('garita.html');
    yes('garita.html carga lector-codigos.js antes del script de la pagina', garita.indexOf('lector-codigos.js') > 0 && garita.indexOf('lector-codigos.js') < garita.indexOf("document.addEventListener('DOMContentLoaded'"));
    // Escaner manual y Control Garita (pedido del usuario el 2026-11-23)
    yes('garita.html es la Central de Monitoreo (antes Control Garita): titulo, encabezado con reloj en vivo y el guardia, y el boton Configuración', /<title>SISDEL - Central de Monitoreo<\/title>/.test(garita) && garita.includes('<h1>CENTRAL DE MONITOREO</h1>') && garita.includes('id="cgClock"') && garita.includes('id="guardName"') && garita.includes('id="btnGaritaConfig"'));
    yes('el lector de marbetes tiene su anillo "LISTO PARA LEER", las ultimas lecturas y la tarjeta del marbete (medallon en relieve) con "Era una salida"', garita.includes('id="cgRing"') && garita.includes('LISTO PARA LEER') && garita.includes('id="lastReads"') && garita.includes('id="lectorOverlay"') && garita.includes('id="lovExit"'));
    yes('la configuracion trae escaner, tiempo (3 a 30), sonido, pantalla completa y probar el lector', ['gcfgScanner', 'gcfgSeconds', 'gcfgSound', 'gcfgFull', 'btnGcfgTest', 'gcfgLastProbe'].every((id) => garita.includes(`id="${id}"`)) && /min="3" max="30"/.test(garita));
    yes('las etiquetas de privilegio del diseno no salen en la pagina real', !/Privilegio nuevo:|Privilegio: /.test(garita));
    yes('cada parte se muestra segun su privilegio (garita.lector, garita.configurar, visitas del dia y el historial)', ['lector: SISDEL.can(\'garita.lector\')', 'configurar: SISDEL.can(\'garita.configurar\')', "if (!g.visitasDia) document.getElementById('visitsCard')", 'if (!g.historial) { document.getElementById(\'historyMonitorContainer\')'].every((t) => garita.includes(t)) && garita.includes('const lectorAllowed = g.lector &&') && garita.includes('if (g.configurar) {'));
    yes('el lector solo lee si el escaner esta activado (o se esta probando)', garita.includes('enabled: () => scannerOn || testing'));
    yes('el escáner viene activado de entrada: solo "off" lo apaga, y se recuerda en este equipo por condominio con tolerancia a que no haya almacenamiento', garita.includes("!== 'off'") && garita.includes("setItem(PREF_KEY, 'off')") && /sisdel_escaner_manual_\$\{condoId\}/.test(garita) && /catch \(e\) \{ return true; \}/.test(garita));
    yes('la configuracion (tiempo, sonido, pantalla completa) se guarda en la computadora y el tiempo se limita de 3 a 30', /sisdel_garita_config_\$\{condoId\}/.test(garita) && garita.includes('SECONDS_MIN = 3, SECONDS_MAX = 30') && garita.includes('c.sound !== false') && garita.includes('c.full === true'));
    yes('lo no guardado se anota en el equipo y se guarda al abrir la garita (lectura pendiente)', garita.includes('sisdel_lector_pend_') && garita.includes('for (const rec of pendRead()) enqueueWrite(rec)'));
    yes('avisa cuando la ventana no esta al frente (el lector escribiria en otra ventana)', garita.includes("nofocus:") && /document\.hasFocus/.test(garita) && garita.includes("addEventListener('blur', refreshLector)"));
    yes('el sonido usa Web Audio (sin archivos): agudo al dia, doble en mora, grave si no entra', garita.includes('createOscillator') && !/<audio|\.mp3|\.wav/.test(garita) && garita.includes("tone === 'late'") && garita.includes("tone === 'bad'"));
    yes('Ultimos accesos sale del registro de accesos (con el medio) y las cifras del dia tambien; la camara de placas solo dice su ultima lectura', garita.includes('SISDEL.getAccessBetween(condoId') && garita.includes("VIA_LABEL = { lector: 'Escáner manual', camara: 'Cámara de placas'") && garita.includes('última lectura') && !/Cámara de placas en línea/.test(garita));
    yes('el registro de camera_logs que escribe la propia garita no levanta otra vez la pantalla de moroso', garita.includes('ownLogs.add(') && garita.includes('ownLogs.has(ownKey)'));

}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
