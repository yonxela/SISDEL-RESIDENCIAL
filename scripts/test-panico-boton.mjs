// Pruebas del boton de panico de mantener presionado (panico-boton.js), el mismo del portal del vecino y del QR de panico:
// el circulo se va llenando y, al terminar, dice ALERTA ENVIADA. Corre sin emuladores ni navegador: con un DOM de mentira
// (solo lo que usa el boton) y tiempos cortos. Uso: node test-panico-boton.mjs (tambien corre con npm test).
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Un DOM de mentira: solo los nodos y metodos que usa mount() ──
function fakeNode() {
    const listeners = {};
    const node = {
        dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, attrs: {}, textContent: '', innerHTML: '',
        classes: new Set(),
        classList: { add: (c) => node.classes.add(c), toggle: (c, on) => (on ? node.classes.add(c) : node.classes.delete(c)), contains: (c) => node.classes.has(c) },
        setAttribute(k, v) { node.attrs[k] = v; },
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        fire(ev, extra = {}) { (listeners[ev] || []).forEach((fn) => fn({ preventDefault() { this.prevented = true; }, key: undefined, ...extra })); }
    };
    return node;
}
function setup({ confirmAnswer = true } = {}) {
    const nodes = { '.pb-wrap': fakeNode(), '.pb-btn': fakeNode(), '.pb-ico': fakeNode(), '.pb-label': fakeNode(), '.pb-hint': fakeNode() };
    const host = Object.assign(fakeNode(), { querySelector: (sel) => nodes[sel] });
    const head = { children: [], appendChild(n) { this.children.push(n); } };
    const context = {
        document: { getElementById: () => null, createElement: () => fakeNode(), head },
        confirm: () => confirmAnswer, console: { error() {}, log() {} }, setTimeout, clearTimeout, Promise, JSON, navigator: {}
    };
    vm.createContext(context);
    vm.runInContext(read('panico-boton.js'), context);
    const B = vm.runInContext('SisdelPanicoBoton', context);
    return { B, nodes, host, head };
}
const view = (nodes) => ({ state: nodes['.pb-wrap'].dataset.state, label: nodes['.pb-label'].textContent, hint: nodes['.pb-hint'].textContent });

console.log('\nEstados y textos');
{
    const { B } = setup();
    equal('mantener presionado son 2 segundos', B.HOLD_MS, 2000);
    equal('el texto al terminar es ALERTA ENVIADA (y ENVIANDO... mientras se manda)', [B.STATES.sent.label, B.STATES.sending.label, B.STATES.attended.label, B.STATES.error.label], ['ALERTA ENVIADA', 'ENVIANDO...', 'ALERTA ATENDIDA', 'NO SE ENVIÓ']);
    equal('que estado le toca segun la alerta: enviada, atendida; sin alerta, cancelada o resuelta, disponible otra vez', ['ACTIVE', 'ATTENDED', 'RESOLVED', 'CANCELLED', undefined, null].map((s) => B.stateForAlert(s)), ['sent', 'attended', 'ready', 'ready', 'ready', 'ready']);
    equal('enviando, enviada y atendida bloquean el boton (no se mandan alertas repetidas)', B.LOCKED, ['sending', 'sent', 'attended']);
    yes('todos los textos son fijos del sistema, sin emojis', Object.values(B.STATES).every((s) => s.label && s.hint && !/[\u{1F300}-\u{1FAFF}]/u.test(s.label + s.hint)));
}

console.log('\nEl circulo se llena y avisa');
{
    const { B, nodes, host } = setup();
    let holdStarts = 0;
    let fires = 0;
    const api = B.mount(host, { size: '11rem', holdMs: 40, onHoldStart: () => { holdStarts++; }, onFire: async () => { fires++; await sleep(10); } });
    equal('al montar esta listo: PANICO y "Mantenga presionado 2 segundos"', view(nodes), { state: 'ready', label: 'PÁNICO', hint: 'Mantenga presionado 2 segundos' });
    equal('el tamano y el tiempo del llenado van como variables CSS (el aro y el relleno tardan lo mismo)', [nodes['.pb-wrap'].style.props['--pb-size'], nodes['.pb-wrap'].style.props['--pb-hold']], ['11rem', '40ms']);
    nodes['.pb-btn'].fire('pointerdown');
    equal('al presionar empieza a llenarse (holding), pide el GPS y dice que siga presionando', [view(nodes).state, holdStarts, view(nodes).hint], ['holding', 1, 'Siga presionando hasta llenar el círculo...']);
    await sleep(15);
    equal('antes de llenarse todavia no se manda nada', fires, 0);
    await sleep(60);
    equal('al llenarse el circulo manda la alerta y pasa a ENVIANDO...', [fires, view(nodes).state, view(nodes).label], [1, 'sending', 'ENVIANDO...']);
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(60);
    equal('mientras se envia, presionar otra vez no manda otra alerta', fires, 1);
    api.setState('sent');
    equal('al guardarse la alerta el circulo dice ALERTA ENVIADA', view(nodes), { state: 'sent', label: 'ALERTA ENVIADA', hint: 'La garita y la administración ya fueron avisadas.' });
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(60);
    equal('con la alerta enviada tampoco se manda otra por tocar dos veces', [fires, holdStarts], [1, 1]);
    api.setState(B.stateForAlert('ATTENDED'));
    equal('al atenderla dice ALERTA ATENDIDA', view(nodes).label, 'ALERTA ATENDIDA');
    api.setState(B.stateForAlert('CANCELLED'));
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(80);
    equal('cuando la alerta se cancela o se resuelve el boton vuelve a servir', [fires, view(nodes).state], [2, 'sending']);
}
{
    const { B, nodes, host } = setup();
    let fires = 0;
    B.mount(host, { holdMs: 60, onFire: () => { fires++; } });
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(20);
    nodes['.pb-btn'].fire('pointerup');
    await sleep(80);
    equal('soltar antes de llenar el circulo NO envia nada y lo dice', [fires, view(nodes).state, view(nodes).hint], [0, 'ready', 'No se envió: mantenga presionado hasta llenar el círculo.']);
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(20);
    nodes['.pb-btn'].fire('pointerleave');
    await sleep(80);
    equal('salirse del boton con el dedo tambien cancela', [fires, view(nodes).state], [0, 'ready']);
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(90);
    nodes['.pb-btn'].fire('pointerup');
    nodes['.pb-btn'].fire('pointerleave');
    equal('soltar ya despues de llenarse no cancela el envio', [fires, view(nodes).state], [1, 'sending']);
    const menu = { prevented: false };
    nodes['.pb-btn'].fire('contextmenu', { preventDefault() { menu.prevented = true; } });
    yes('el menu de mantener presionado del telefono no aparece sobre el boton', menu.prevented);
}
{
    const { B, nodes, host } = setup();
    let fires = 0;
    B.mount(host, { holdMs: 20, onFire: async () => { fires++; throw new Error('sin internet'); } });
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(80);
    equal('si el envio falla, el boton dice NO SE ENVIO y se puede volver a intentar', [view(nodes).state, view(nodes).label], ['error', 'NO SE ENVIÓ']);
    nodes['.pb-btn'].fire('pointerdown');
    await sleep(80);
    equal('despues del error volver a presionar manda otra vez', fires, 2);
}
{
    let fires = 0;
    let s = setup({ confirmAnswer: true });
    s.B.mount(s.host, { holdMs: 20, onFire: () => { fires++; } });
    s.nodes['.pb-btn'].fire('keydown', { key: 'Enter' });
    await sleep(10);
    equal('con teclado y confirmando, manda la alerta', [fires, view(s.nodes).state], [1, 'sending']);
    s = setup({ confirmAnswer: false });
    s.B.mount(s.host, { holdMs: 20, onFire: () => { fires++; } });
    s.nodes['.pb-btn'].fire('keydown', { key: ' ' });
    await sleep(10);
    equal('con teclado y sin confirmar, no manda nada', [fires, view(s.nodes).state], [1, 'ready']);
}

console.log('\nEspera con limite');
{
    const { B } = setup();
    const rejects = async (p) => { try { await p; return 'sin error'; } catch (e) { return e.message; } };
    equal('sin respuesta en el tiempo dado se avisa en vez de quedarse esperando para siempre', await rejects(B.withTimeout(new Promise(() => {}), 30, 'sin respuesta')), 'sin respuesta');
    equal('una respuesta a tiempo pasa tal cual', await B.withTimeout(sleep(5).then(() => 'ok'), 100), 'ok');
    equal('un error de la propia espera pasa tal cual', await rejects(B.withTimeout(Promise.reject(new Error('rechazada')), 100)), 'rechazada');
}

console.log('\nPantallas que lo usan');
{
    const vecino = read('vecino.html');
    const qr = read('panico.html');
    const lib = read('panico-boton.js');
    for (const [name, html] of [['vecino.html', vecino], ['panico.html', qr]]) {
        yes(`${name} usa el mismo boton (panico-boton.js) y ya no tiene el suyo`, /<script src="panico-boton\.js\?v=\w+"><\/script>/.test(html) && /SisdelPanicoBoton\.mount\(/.test(html) && !/btnPanicHold|panicFill|holdStartFn/.test(html));
        yes(`${name}: la alerta enviada dice ALERTA ENVIADA y el boton pasa a "enviada"`, /ACTIVE: 'ALERTA ENVIADA'/.test(html) && /panicButton\.setState\('sent'\)/.test(html) && /SisdelPanicoBoton\.stateForAlert\(/.test(html));
        yes(`${name}: sin respuesta en 20 segundos avisa que no se pudo confirmar (el boton no se queda en ENVIANDO...)`, /SisdelPanicoBoton\.withTimeout\([\s\S]{0,260}20000/.test(html) && /panicButton\.setState\('error'\)/.test(html));
        yes(`${name}: aunque la respuesta tarde, el boton pasa solo a enviada cuando llega`, /sending\.then\(/.test(html));
    }
    yes('en el portal el circulo sigue arriba a la derecha de la bienvenida', /\.panic-top \{ display: none; flex-direction: column; align-items: flex-end;/.test(vecino) && /size: '11rem'/.test(vecino));
    yes('panico-boton.js lleva la misma version en el portal y en el QR', (() => { const v = (h) => (h.match(/panico-boton\.js\?v=(\w+)/) || [])[1]; return v(vecino) && v(vecino) === v(qr); })());
    yes('el aro y el relleno del circulo suben juntos y tardan lo mismo (var --pb-hold)', /\.pb-wrap\[data-state="holding"\] \.pb-prog \{ stroke-dashoffset: 0; transition: stroke-dashoffset var\(--pb-hold/.test(lib) && /\.pb-wrap\[data-state="holding"\] \.pb-fill \{ height: 100%; transition: height var\(--pb-hold/.test(lib));
    yes('al enviarse el circulo pasa a verde con palomita', /\.pb-wrap\[data-state="sent"\] \.pb-done[\s\S]{0,60}opacity: 1/.test(lib) && /icon: 'check'/.test(lib));
    yes('el boton no deja que el telefono abra su menu de mantener presionado (iOS) ni resalte el toque', /-webkit-touch-callout: none/.test(lib) && /-webkit-tap-highlight-color: transparent/.test(lib));
    yes('el panel de estado pinta los datos de la base escapados (portal: escHtml) o con textContent (QR)', /escHtml\(PANIC_HEAD\[alert\.status\]/.test(vecino) && /strong\.textContent = PANIC_HEAD\[a\.status\]/.test(qr) && !/innerHTML/.test(qr.split('<script>').slice(1).join('')));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
