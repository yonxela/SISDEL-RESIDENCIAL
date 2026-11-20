// Pruebas del GPS del boton de panico (rondas-core.js: SisdelRondas.gps) con un GPS de mentira, sin emuladores.
// La alerta de panico necesita las coordenadas al crearse (el WhatsApp sale de ahi): el permiso se pide al abrir y al empezar
// a mantener presionado el boton, la posicion se sigue mientras la pagina esta visible y, al enviar, se usa la reciente o se
// espera un poco a una nueva. Uso: node test-gps-panico.mjs
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
const fix = (lat, lng, accuracy = 12) => ({ coords: { latitude: lat, longitude: lng, accuracy } });

// Un telefono de mentira: GPS que solo hace lo que la prueba le diga, y un reloj que la prueba puede adelantar
function phone({ geolocation = true, permission = 'prompt' } = {}) {
    const geo = {
        watchers: [], cleared: [], current: [], nextId: 1,
        watchPosition(ok, err, options) { const id = geo.nextId++; geo.watchers.push({ id, ok, err, options }); return id; },
        clearWatch(id) { geo.cleared.push(id); geo.watchers = geo.watchers.filter((w) => w.id !== id); },
        getCurrentPosition(ok, err, options) { geo.current.push({ ok, err, options }); }
    };
    const clock = { now: 1_000_000 };
    const perms = { state: permission, onchange: null };
    const context = {
        navigator: Object.assign({}, geolocation ? { geolocation: geo } : {}, { permissions: { query: async () => perms } }),
        setTimeout, clearTimeout, Promise, JSON, Math, Date: { now: () => clock.now }, window: {}
    };
    vm.createContext(context);
    vm.runInContext(read('rondas-core.js'), context);
    const core = vm.runInContext('SisdelRondas', context);
    return { geo, clock, perms, gps: core.gps, core };
}
// Cuanto tarda una promesa en resolverse (ms) y con que
async function timed(promise) {
    const t0 = process.hrtime.bigint();
    const value = await promise;
    return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

console.log('\nPosicion al instante');
{
    const t = phone();
    t.gps.start();
    t.geo.watchers[0].ok(fix(14.6, -90.5, 8));
    const r = await timed(t.gps.bestPosition(500));
    equal('con una posicion reciente la alerta sale al instante con las coordenadas', [r.value, r.ms < 50], [{ lat: 14.6, lng: -90.5, accuracy: 8 }, true]);
    equal('el estado dice que hay ubicacion', [t.gps.state().status, t.gps.state().pos.lat], ['ok', 14.6]);
}
{
    const t = phone();
    t.gps.start();
    t.geo.watchers[0].ok(fix(14.6, -90.5));
    t.clock.now += 5 * 60 * 1000; // 5 minutos despues: ya no es "reciente" (2 min), pero todavia sirve de ultimo recurso (10 min)
    const p = t.gps.bestPosition(300);
    const r = await timed(p);
    equal('una posicion de hace 5 minutos no sale al instante: espera una nueva y, si no llega, usa esa', [r.value && r.value.lat, r.ms >= 250], [14.6, true]);
}
{
    const t = phone();
    t.gps.start();
    t.geo.watchers[0].ok(fix(14.6, -90.5));
    t.clock.now += 11 * 60 * 1000;
    const r = await timed(t.gps.bestPosition(200));
    equal('una posicion de hace 11 minutos ya no se usa: la alerta sale sin coordenadas antes que con un lugar viejo', r.value, null);
}

console.log('\nEsperar al GPS');
{
    const t = phone();
    const waiting = t.gps.bestPosition(1000);
    equal('al pedir la posicion se empieza a seguir el GPS (el telefono pide el permiso)', t.geo.watchers.length, 1);
    await sleep(60);
    t.geo.watchers[0].ok(fix(14.7, -90.6));
    const r = await timed(waiting);
    equal('si el GPS responde mientras se espera, sale con esas coordenadas sin agotar la espera', [r.value && r.value.lat, r.ms < 400], [14.7, true]);
}
{
    const t = phone();
    const waiting = t.gps.bestPosition(900);
    await sleep(400); // a un tercio de la espera (300 ms) ya se intento la ubicacion de red
    equal('a un tercio de la espera se intenta la ubicacion de baja precision (red y wifi), que llega rapido dentro de edificios', [t.geo.current.length, t.geo.current[0] && t.geo.current[0].options.enableHighAccuracy], [1, false]);
    t.geo.current[0].ok(fix(14.8, -90.7, 900));
    const r = await timed(waiting);
    equal('si la de red responde, esa se usa', r.value && r.value.lat, 14.8);
}
{
    const t = phone();
    const r = await timed(t.gps.bestPosition(300));
    equal('si nada responde, al terminar la espera la alerta sale igual, sin coordenadas', [r.value, r.ms >= 250, r.ms < 600], [null, true, true]);
    equal('sin respuesta el estado queda en "buscando"', t.gps.state().status, 'searching');
}

console.log('\nPermiso negado');
{
    const t = phone();
    const waiting = t.gps.bestPosition(3000);
    await sleep(30);
    t.geo.watchers[0].err({ code: 1 });
    const r = await timed(waiting);
    equal('con el permiso negado no se espera: sale al instante sin coordenadas', [r.value, r.ms < 400], [null, true]);
    equal('el estado es "denied" y se deja de insistir (se cierra la vigilancia)', [t.gps.state().status, t.geo.watchers.length, t.geo.cleared.length], ['denied', 0, 1]);
}
{
    const t = phone();
    t.gps.start();
    t.geo.watchers[0].ok(fix(14.6, -90.5));
    t.geo.watchers[0].err({ code: 1 });
    equal('si el permiso se niega despues de tener una posicion, el estado es "denied" y la posicion vieja sigue guardada', [t.gps.state().status, t.gps.state().pos.lat], ['denied', 14.6]);
}
{
    const t = phone();
    t.gps.start();
    t.geo.watchers[0].err({ code: 3 }); // sin senal por ahora: no es un rechazo, se sigue buscando
    equal('un fallo de senal no es un rechazo: sigue buscando', [t.gps.state().status, t.geo.watchers.length], ['searching', 1]);
}

console.log('\nSeguir la posicion');
{
    const t = phone();
    t.gps.start();
    t.gps.start();
    equal('pedir el GPS dos veces (al abrir y al presionar) deja una sola vigilancia', t.geo.watchers.length, 1);
    equal('la vigilancia pide alta precision y acepta una posicion de hasta 15 s', [t.geo.watchers[0].options.enableHighAccuracy, t.geo.watchers[0].options.maximumAge], [true, 15000]);
    t.gps.stop();
    t.gps.stop();
    equal('con la pagina oculta se cierra la vigilancia (bateria) y se puede retomar', [t.geo.watchers.length, t.geo.cleared.length], [0, 1]);
    t.gps.start();
    equal('al volver se retoma', t.geo.watchers.length, 1);
}
{
    const t = phone();
    const seen = [];
    const off = t.gps.onChange((s) => seen.push(s.status));
    t.gps.start();
    t.geo.watchers[0].ok(fix(1, 2));
    off();
    t.geo.watchers[0].ok(fix(3, 4));
    equal('quien escucha los cambios recibe buscando y luego ok, y deja de recibir al darse de baja', seen, ['searching', 'ok']);
}
{
    const t = phone();
    t.gps.onChange(() => { throw new Error('escuchador roto'); });
    let later = null;
    t.gps.onChange((s) => { later = s.status; });
    t.gps.start();
    equal('un escuchador que falla no frena a los demas', later, 'searching');
}

console.log('\nTelefono sin GPS o sin API de permisos');
{
    const t = phone({ geolocation: false });
    const r = await timed(t.gps.bestPosition(500));
    t.gps.start();
    equal('sin GPS la alerta sale al instante sin coordenadas y el estado lo dice', [r.value, r.ms < 100, t.gps.state().status], [null, true, 'unsupported']);
}
{
    const t = phone({ permission: 'denied' });
    equal('el permiso se puede consultar antes de pedirlo', await t.gps.permission(), 'denied');
    const notYet = phone({ permission: 'prompt' });
    equal('"prompt": todavia no se ha pedido', await notYet.gps.permission(), 'prompt');
    let changes = [];
    notYet.gps.watchPermission((s) => changes.push(s));
    await sleep(10);
    notYet.perms.state = 'granted';
    notYet.perms.onchange();
    equal('si el usuario cambia el permiso (en los ajustes del telefono) se entera', changes, ['granted']);
    const bare = vm.createContext({ navigator: { geolocation: {} }, setTimeout, clearTimeout, Promise, JSON, Math, Date, window: {} });
    vm.runInContext(read('rondas-core.js'), bare);
    equal('sin la API de permisos del navegador responde "unknown"', await vm.runInContext('SisdelRondas', bare).gps.permission(), 'unknown');
}

console.log('\nAl ingresar: pedir el permiso y esperar la respuesta');
{
    const t = phone({ permission: 'prompt' });
    const asking = t.gps.ask(2000);
    await sleep(20);
    equal('con el permiso sin pedir, el telefono lo pide (se hace una lectura de posicion de alta precision)', [t.geo.current.length, t.geo.current[0].options.enableHighAccuracy], [1, true]);
    let settled = false;
    asking.then(() => { settled = true; });
    await sleep(100);
    equal('y se ESPERA a que el vecino responda: no pasa al portal mientras la ventana del permiso sigue abierta', settled, false);
    t.geo.current[0].ok(fix(14.61, -90.51, 15));
    const r = await timed(asking);
    equal('al permitir, devuelve "granted" y la posicion queda guardada para la alerta', [r.value, t.gps.state().status, t.gps.state().pos.lat], ['granted', 'ok', 14.61]);
}
{
    const t = phone({ permission: 'prompt' });
    const asking = t.gps.ask(2000);
    await sleep(20);
    t.geo.current[0].err({ code: 1 });
    equal('al negar, devuelve "denied" y el estado lo dice', [await asking, t.gps.state().status], ['denied', 'denied']);
}
{
    const t = phone({ permission: 'prompt' });
    const asking = t.gps.ask(2000);
    await sleep(20);
    t.geo.current[0].err({ code: 2 });
    equal('si dio el permiso pero aun no hay senal, cuenta como permitido (el portal sigue buscando)', await asking, 'granted');
}
{
    const t = phone({ permission: 'prompt' });
    const r = await timed(t.gps.ask(300));
    equal('si no responde la ventana en el tiempo de espera, sigue al portal ("timeout"): alli se vuelve a pedir', [r.value, r.ms >= 250, r.ms < 700], ['timeout', true, true]);
}
{
    const t = phone({ permission: 'granted' });
    const r = await timed(t.gps.ask(2000));
    equal('con el permiso ya dado no espera ni vuelve a preguntar: empieza a seguir la posicion', [r.value, r.ms < 100, t.geo.current.length, t.geo.watchers.length], ['granted', true, 0, 1]);
}
{
    // La API de permisos de iOS se equivoca (dice "prompt" cuando esta negado y se atrasa al cambiar los Ajustes): un "denied" no se cree, se intenta de verdad
    const t = phone({ permission: 'denied' });
    const asking = t.gps.ask(2000);
    await sleep(20);
    equal('aunque la API diga "denied" se intenta de verdad (negado de verdad no muestra ventana: el error 1 llega al instante)', t.geo.current.length, 1);
    t.geo.current[0].err({ code: 1 });
    equal('negado de verdad: devuelve "denied" para avisarle como activarlo', [await asking, t.gps.state().status], ['denied', 'denied']);
}
{
    const t = phone({ permission: 'denied' });
    const asking = t.gps.ask(2000);
    await sleep(20);
    t.geo.current[0].ok(fix(14.62, -90.52, 20));
    equal('si la API se quedo atrasada ("denied") pero el usuario ya lo activo en los Ajustes, funciona', [await asking, t.gps.state().status], ['granted', 'ok']);
}
{
    const t = phone({ geolocation: false });
    equal('sin GPS en el telefono devuelve "unsupported"', [await t.gps.ask(500), t.gps.state().status], ['unsupported', 'unsupported']);
}
{
    const bare = vm.createContext({ navigator: { geolocation: { getCurrentPosition(ok) { ok(fix(1, 2)); }, watchPosition() { return 1; }, clearWatch() {} } }, setTimeout, clearTimeout, Promise, JSON, Math, Date, window: {} });
    vm.runInContext(read('rondas-core.js'), bare);
    equal('sin la API de permisos del navegador (Safari antiguo) tambien lo pide y espera la respuesta', await vm.runInContext('SisdelRondas', bare).gps.ask(500), 'granted');
}

console.log('\nvecino.html y las demas paginas');
const vecino = read('vecino.html');
// La ayuda para activar la ubicacion y el boton con su casilla viven en gps-ayuda.js: los comparten el portal del vecino y el QR de panico
const ayuda = read('gps-ayuda.js');
yes('el boton pide el GPS al empezar a mantenerse presionado', /e\.preventDefault\(\);\s*SisdelRondas\.gps\.start\(\);/.test(vecino));
yes('al enviar espera la mejor posicion (no la pide recien al terminar los 2 segundos con solo 6 s de espera)', /const pos = await SisdelRondas\.gps\.bestPosition\(6000\);/.test(vecino) && !/SisdelRondas\.getPosition\(/.test(vecino));
yes('al abrir (con el panico activo) se intenta de verdad y se sigue la posicion, sin creerle el "denied" a la API de permisos de iOS', /if \(panicOn\) \{\s*paintGps\(SisdelRondas\.gps\.state\(\)\);\s*SisdelRondas\.gps\.start\(\);/.test(vecino) && !/gps\.permission\(\)\.then\(\(state\) => \{ if \(state === 'denied'\)/.test(vecino));
yes('hay un boton "Activar ubicacion" con casilla: vacia por activar, con chequesito verde cuando esta activada, y bloqueada en rojo', /id="panicGps"/.test(vecino) && /role="checkbox" aria-checked="false"/.test(vecino) && /panicGpsBox\.innerHTML = ok \? CHECK_SVG : ''/.test(ayuda) && /panicGps\.setAttribute\('aria-checked', ok \? 'true' : 'false'\)/.test(ayuda) && /text = 'Ubicación activada'/.test(ayuda) && /denied: \['bad', 'Ubicación bloqueada: toque para activarla'\]/.test(ayuda) && /\.panic-loc\.ok \.panic-loc-box \{ background: #16a34a/.test(ayuda) && /const paintGps = SisdelGpsAyuda\.paint;\s*SisdelRondas\.gps\.onChange\(paintGps\);/.test(vecino));
yes('tocar el boton pide el permiso (y espera la respuesta); si esta bloqueado, abre la ayuda para activarlo en el telefono', /const result = await SisdelRondas\.gps\.ask\(20000\);/.test(ayuda) && /panicGps\.addEventListener\('click', \(\) => SisdelGpsAyuda\.ask\(false\)\)/.test(vecino) && /modalGpsHelp\.style\.display = 'flex'/.test(ayuda) && /id="modalGpsHelp"/.test(ayuda) && /Ajustes del iPhone &gt; Privacidad y seguridad &gt; Localización/.test(ayuda) && /Android \(Chrome\)/.test(ayuda));
yes('la ayuda tiene "Ya la active: comprobar" y se cierra sola cuando la ubicacion queda activada', /id="btnGpsRecheck"/.test(ayuda) && /addEventListener\('click', \(\) => ask\(true\)\)/.test(ayuda) && /SisdelRondas\.gps\.onChange\(\(s\) => \{ if \(s\.status === 'ok'\) close\(\); \}\)/.test(ayuda));
yes('vecino.html carga gps-ayuda.js despues de rondas-core.js y ya no repite la ayuda', vecino.indexOf('src="gps-ayuda.js') > vecino.indexOf('src="rondas-core.js') && vecino.indexOf('src="rondas-core.js') > 0 && !/id="modalGpsHelp"/.test(vecino) && !/const IS_IOS =/.test(vecino) && /SisdelGpsAyuda\.mount\(\{ safariUrl: location\.origin \+ '\/index\.html', copyText: \(text, message\) => SISDEL\.copyText\(text, message\) \}\)/.test(vecino));
yes('con la pagina oculta el GPS descansa y al volver se retoma', /document\.hidden\) SisdelRondas\.gps\.stop\(\);\s*else if \(panicOn\) SisdelRondas\.gps\.start\(\);/.test(vecino));
// La ayuda del permiso bloqueado muestra solo lo que sirve a cada telefono (una pagina no puede abrir los Ajustes: solo guiar)
const cut = (name) => (ayuda.match(new RegExp(`const ${name} = ([^;]+);`)) || [])[1];
const IS_IOS_SRC = cut('IS_IOS'), IS_ANDROID_SRC = cut('IS_ANDROID'), IS_IOS_NOT_SAFARI_SRC = cut('IS_IOS_NOT_SAFARI');
function device(ua, platform = 'iPhone', touch = 5) {
    const ctx = vm.createContext({ navigator: { userAgent: ua, platform, maxTouchPoints: touch } });
    const UA = ua;
    return vm.runInContext(`(() => { const UA = ${JSON.stringify(ua)}; const IS_IOS = ${IS_IOS_SRC}; const IS_ANDROID = ${IS_ANDROID_SRC}; const IS_IOS_NOT_SAFARI = ${IS_IOS_NOT_SAFARI_SRC}; return [IS_IOS, IS_ANDROID, IS_IOS_NOT_SAFARI]; })()`, ctx);
}
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const CHROME_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
equal('el telefono se reconoce: iPhone con Safari, iPhone con Chrome, Android y computadora (IS_IOS, IS_ANDROID, IS_IOS_NOT_SAFARI)', [
    device(SAFARI_IPHONE), device(CHROME_IPHONE), device(CHROME_ANDROID, 'Linux armv81', 5), device('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36', 'Win32', 0)
], [[true, false, false], [true, false, true], [false, true, false], [false, false, false]]);
equal('un iPad que se presenta como Mac tambien cuenta como iOS', device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'MacIntel', 5)[0], true);
yes('en iPhone con Chrome la ayuda dice que usa Chrome (cada navegador tiene su propio permiso: el de Safari no vale), ofrece abrirla en Safari y activar el permiso de ese navegador', /id="gpsHelpIosOther"/.test(ayuda) && /Aunque Safari ya tenga la ubicación activada, cada navegador tiene su propio permiso/.test(ayuda) && /Camino 1, el más rápido: use Safari/.test(ayuda) && /Camino 2: activar la ubicación de/.test(ayuda) && /Ajustes del iPhone &gt; <span class="gps-browser">su navegador<\/span> &gt; Ubicación/.test(ayuda) && /Cierre <span class="gps-browser">su navegador<\/span> por completo/.test(ayuda) && /gpsHelpIosOther'\)\.style\.display = IS_IOS_NOT_SAFARI \? 'block' : 'none'/.test(ayuda));
yes('"Abrir en Safari" usa x-safari-https:// (sirve en iOS 15, 17 y 18) y hay un respaldo que copia el enlace', /id="btnOpenSafari"/.test(ayuda) && /setAttribute\('href', 'x-safari-' \+ safariUrl\)/.test(ayuda) && /copy\(safariUrl, 'Enlace copiado: péguelo en Safari'\)/.test(ayuda) && /id="btnCopyLink"/.test(ayuda));
{
    const cutName = (ayuda.match(/const IOS_BROWSER = ([^;]+);/) || [])[1];
    const browser = (ua) => vm.runInContext(`(() => { const UA = ${JSON.stringify(ua)}; return ${cutName}; })()`, vm.createContext({}));
    equal('el navegador del iPhone se nombra: Chrome, Firefox, Edge, Opera; Safari o desconocido, "su navegador"', [
        browser(CHROME_IPHONE), browser(CHROME_IPHONE.replace('CriOS/131.0.6778.73', 'FxiOS/133.0')), browser(CHROME_IPHONE.replace('CriOS/131.0.6778.73', 'EdgiOS/131.0')), browser(CHROME_IPHONE.replace('CriOS/131.0.6778.73', 'OPiOS/16.0')), browser(SAFARI_IPHONE)
    ], ['Chrome', 'Firefox', 'Edge', 'Opera', 'su navegador']);
}
yes('la ayuda dice la verdad: una pagina no puede activar la ubicacion ni abrir los Ajustes', /Una página no puede activarla ni abrir los Ajustes por usted/.test(ayuda));
yes('en Android hay un boton que intenta abrir los ajustes de ubicacion del telefono', /id="btnAndroidLoc" href="intent:#Intent;action=android\.settings\.LOCATION_SOURCE_SETTINGS;end"/.test(ayuda));
yes('al volver de los Ajustes (enfocar la pagina o regresar a ella) la ubicacion se comprueba sola', /\['focus', 'pageshow'\]\.forEach\(\(ev\) => window\.addEventListener\(ev, \(\) => \{ if \(panicOn && SisdelRondas\.gps\.state\(\)\.status !== 'ok'\) SisdelRondas\.gps\.start\(\); \}\)\)/.test(vecino));

// El QR de panico (panico.html): primero la ubicacion, despues el boton; la misma ayuda y el mismo GPS que el portal
const qrPage = read('panico.html');
yes('panico.html pide la ubicacion al abrir y espera la respuesta (hasta 25 s) antes de mostrar el boton', /const asking = SisdelRondas\.gps\.ask\(25000\);/.test(qrPage) && /asking\.then\(afterGps, \(\) => afterGps\('timeout'\)\);/.test(qrPage) && /function showNext\(\) \{\s*if \(!gpsDone \|\| blocked\) return;/.test(qrPage) && /<section class="pq-panic" id="pqStepPanic" hidden>/.test(qrPage) && /<section class="pq-step" id="pqStepLink" hidden>/.test(qrPage));
yes('con la ubicacion bloqueada abre la ayuda con los pasos de ese telefono, pero el boton funciona igual (sin el mapa)', /if \(result === 'denied'\) SisdelGpsAyuda\.open\(\);/.test(qrPage) && /id="pqNoGps"/.test(qrPage) && /Sin su ubicación la alerta sale igual/.test(qrPage));
yes('panico.html usa la misma ayuda y el mismo boton de ubicacion (gps-ayuda.js), y "Abrir en Safari" abre el mismo QR', /<script src="gps-ayuda\.js\?v=\w+"><\/script>/.test(qrPage) && /safariUrl: location\.href/.test(qrPage) && /SisdelGpsAyuda\.paint\(s\)/.test(qrPage) && /id="panicGps"/.test(qrPage) && /SisdelGpsAyuda\.ask\(false\)/.test(qrPage));
yes('panico.html: mantener presionado tambien calienta el GPS y al enviar usa la mejor posicion', /e\.preventDefault\(\);\s*SisdelRondas\.gps\.start\(\);/.test(qrPage) && /const pos = await SisdelRondas\.gps\.bestPosition\(6000\);/.test(qrPage) && /lat: pos \? pos\.lat : null, lng: pos \? pos\.lng : null, accuracy: pos \? pos\.accuracy : null/.test(qrPage));
yes('gps-ayuda.js lleva la misma version en vecino.html y en panico.html', (() => { const v = (f) => (read(f).match(/gps-ayuda\.js\?v=(\w+)/) || [])[1]; return v('vecino.html') && v('vecino.html') === v('panico.html'); })());

const login = read('index.html');
yes('al ingresar, el vecino con panico activo (y con panico.activar) recibe la peticion del permiso de ubicacion ANTES de pasar al portal', /logged\.role !== 'vecino' \|\| !SISDEL\.can\('panico\.activar'\)/.test(login) && /SisdelRondas\.neighborPanicEnabled\(\)/.test(login) && /await SisdelRondas\.gps\.ask\(25000\)/.test(login));
yes('la peticion se hace despues del bienvenido y antes del redireccionamiento (si no, el cambio de pagina se lleva la ventana del permiso)', /Bienvenido, \$\{userName\}`, 'success'\);\s*await askLocationAtLogin\(\);[\s\S]*?setTimeout\(\(\) => \{\s*window\.location\.href = target;/.test(login));
yes('si algo falla al pedir la ubicacion, el ingreso sigue igual', /catch \(err\) \{\s*console\.warn\('ubicacion al ingresar:'/.test(login));
yes('el login no le cree el "denied" a la API de permisos: intenta de verdad y, si esta bloqueada, manda al boton rojo del portal', /const result = await SisdelRondas\.gps\.ask\(25000\);\s*if \(result === 'denied'\)/.test(login) && /La ubicación está bloqueada en este navegador\. En el portal, toque el botón rojo/.test(login));
yes('index.html carga rondas-core.js (con la misma version que las demas paginas)', /<script src="rondas-core\.js\?v=\w+"><\/script>/.test(login));
const versions = ['index.html', 'vecino.html', 'garita.html', 'admin.html', 'panico.html'].map((f) => (read(f).match(/rondas-core\.js\?v=(\w+)/) || [])[1]);
yes('rondas-core.js lleva la misma version en el login, vecino, garita, admin y el QR de panico', versions.every((v) => v && v === versions[0]));
yes('la alerta lleva las coordenadas cuando las hay (lat, lng y precision)', /lat: pos \? pos\.lat : null, lng: pos \? pos\.lng : null, accuracy: pos \? pos\.accuracy : null/.test(read('rondas-core.js')));
yes('el aviso por WhatsApp dice las coordenadas y el enlace del mapa cuando las hay', /GPS: \$\{Number\(alert\.lat\)\.toFixed\(5\)\}/.test(read('functions/src/rondas/avisos.js')) && /maps\.google\.com\/\?q=/.test(read('functions/src/rondas/avisos.js')));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
