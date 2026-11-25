// Prueba del boton de panico, "todo sin novedad" (panico-prueba.js): lo que ve el vecino, punto por punto, segun la alerta.
// Sin emuladores. Uso: node test-panico-prueba.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const P = require('../panico-prueba.js');

let passed = 0;
const failures = [];
function equal(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name}\n        obtenido: ${JSON.stringify(got)}\n        esperado: ${JSON.stringify(want)}`); }
}
const T0 = Date.parse('2026-11-25T14:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const states = (r) => Object.fromEntries(r.rows.map((x) => [x.key, x.state]));
const row = (r, key) => r.rows.find((x) => x.key === key);
// La alerta como esta en la base (portal del vecino)
const base = { id: 'p1', simulacro: true, status: 'ACTIVE', createdAt: at(0), lat: 14.54, lng: -90.45, accuracy: 12.4, userName: 'Ana García' };

console.log('\nRecien enviada: comprobando');
{
    const r = P.report(base, T0 + 5000);
    equal('llego, llevo el GPS y espera a la garita y al WhatsApp', states(r), { envio: 'ok', gps: 'ok', garita: 'wait', whatsapp: 'wait' });
    equal('dice que esta comprobando', [r.state, r.title], ['wait', 'PRUEBA ENVIADA: COMPROBANDO...']);
    equal('la precision del GPS se ve en metros', row(r, 'gps').title, 'Llevó su ubicación GPS (±12 m)');
    equal('siempre dice que no sono ninguna sirena ni se aviso a los contactos ni a la PNC', /no sonó ninguna sirena/.test(r.text) && /contactos de emergencia ni a la PNC/.test(r.text), true);
}

console.log('\nTodo funciono: 100 %');
{
    const a = { ...base, status: 'ATTENDED', attendedAt: at(3), attendedByName: 'Juan Pérez', notes: P.AUTO_RECEIVED_NOTE,
        whatsapp: { sent: true, simulacro: true, recipients: [{ nombre: 'Central SISDEL', exito: true }, { nombre: 'Garita', exito: true }, { nombre: 'Ana García', exito: true }] } };
    const r = P.report(a, T0 + 20000);
    equal('todo en verde', states(r), { envio: 'ok', gps: 'ok', garita: 'ok', whatsapp: 'ok' });
    equal('dice que funciona al 100 %', [r.state, r.title], ['ok', 'TODO SIN NOVEDAD: SU BOTÓN DE PÁNICO FUNCIONA AL 100 %']);
    equal('quien la recibio en la garita', /Juan Pérez/.test(row(r, 'garita').detail), true);
    equal('cuantos avisos de WhatsApp salieron', row(r, 'whatsapp').title, 'Aviso de prueba por WhatsApp: 3 enviados');
    const closed = { ...a, status: 'RESOLVED', resolvedAt: at(123), resolvedByName: 'Juan Pérez', notes: P.AUTO_CLOSE_NOTE };
    equal('cerrada sola por la garita a los 2 minutos sigue diciendo que funciono (la recepcion se queda)', [P.report(closed, T0 + 130000).state, row(P.report(closed, T0 + 130000), 'garita').state], ['ok', 'ok']);
    equal('cerrada directo (sin pasar por recibida) tambien cuenta como recibida', row(P.report({ ...base, status: 'RESOLVED', resolvedAt: at(40), resolvedByName: 'Luis', whatsapp: a.whatsapp }, T0 + 60000), 'garita').state, 'ok');
}

console.log('\nLo que hay que revisar');
{
    const noGps = P.report({ ...base, lat: null, lng: null, accuracy: null, status: 'ATTENDED', attendedAt: at(2), whatsapp: { recipients: [{ exito: true }] } }, T0 + 10000);
    equal('sin ubicacion: falla y dice como activarla', [noGps.state, row(noGps, 'gps').state, /Activar ubicación/.test(row(noGps, 'gps').detail)], ['check', 'fail', true]);
    const rough = P.report({ ...base, accuracy: 350, status: 'ATTENDED', attendedAt: at(2), whatsapp: { recipients: [{ exito: true }] } }, T0 + 10000);
    equal('ubicacion aproximada (mas de 100 m): aviso con los metros', [rough.state, row(rough, 'gps').state, row(rough, 'gps').title], ['check', 'warn', 'Llevó su ubicación, pero aproximada (±350 m)']);
    const late = P.report(base, T0 + P.GARITA_WAIT_MS + 1000);
    equal('la garita no la recibe en minuto y medio: aviso de que su pantalla puede estar cerrada', [late.state, row(late, 'garita').state, /pantalla de la garita esté cerrada/.test(row(late, 'garita').detail)], ['check', 'warn', true]);
    equal('sin saber del WhatsApp pasado el minuto y medio: aviso', row(late, 'whatsapp').state, 'warn');
    const cancelled = P.report({ ...base, status: 'CANCELLED', cancelledAt: at(4) }, T0 + 10000);
    equal('terminada antes de que la garita la recibiera', row(cancelled, 'garita').state, 'fail');
    const noWa = P.report({ ...base, status: 'ATTENDED', attendedAt: at(2), whatsapp: { sent: false, reason: 'WhatsApp sin configurar' } }, T0 + 10000);
    equal('el WhatsApp no salio: aviso con el motivo', [noWa.state, row(noWa, 'whatsapp').state, /WhatsApp sin configurar/.test(row(noWa, 'whatsapp').detail)], ['check', 'warn', true]);
    const quota = P.report({ ...base, status: 'ATTENDED', attendedAt: at(2), whatsapp: { sent: false, simulacro: true, reason: 'Hoy ya hizo 2 simulacros con WhatsApp: este quedo solo en la pantalla de la garita' } }, T0 + 10000);
    equal('el tope de pruebas con WhatsApp del dia no es una falla: funciona al 100 %', [quota.state, row(quota, 'whatsapp').state], ['ok', 'info']);
}

console.log('\nEl resumen del QR de panico (panicDevice)');
{
    const qr = { id: 'q1', simulacro: true, status: 'ATTENDED', createdAt: at(0), hasLocation: true, accuracy: 20, receivedAt: at(4), receivedBy: 'Garita norte', whatsapp: { done: true, sent: 2, reason: '' } };
    const r = P.report(qr, T0 + 15000);
    equal('con hasLocation, receivedAt y whatsapp.sent tambien funciona al 100 %', [r.state, states(r)], ['ok', { envio: 'ok', gps: 'ok', garita: 'ok', whatsapp: 'ok' }]);
    equal('quien la recibio', /Garita norte/.test(row(r, 'garita').detail), true);
    equal('sin ubicacion en el QR', row(P.report({ ...qr, hasLocation: false, accuracy: undefined }, T0 + 15000), 'gps').state, 'fail');
}

console.log('\nTextos y constantes');
{
    equal('el boton dice "Prueba: todo sin novedad"', P.LABEL, 'Prueba: todo sin novedad');
    equal('la confirmacion avisa que no suena la sirena ni se avisa a los contactos ni a la PNC', /No suena ninguna sirena/.test(P.CONFIRM) && /NO se avisa a sus contactos de emergencia ni a la PNC/.test(P.CONFIRM), true);
    equal('la garita la cierra sola a los 2 minutos', P.AUTO_CLOSE_MS, 120000);
    const banner = fs.readFileSync(new URL('../panico-alertas.js', import.meta.url), 'utf8');
    const val = (txt, k) => (txt.match(new RegExp(`const ${k} = '([^']*)'`)) || [])[1];
    equal('las notas de la garita son las mismas que lee el vecino', [val(banner, 'AUTO_RECEIVED_NOTE'), val(banner, 'AUTO_CLOSE_NOTE')], [P.AUTO_RECEIVED_NOTE, P.AUTO_CLOSE_NOTE]);
    equal('la garita espera lo mismo para cerrarla', Number(val(banner, 'AUTO_CLOSE_MS') || (banner.match(/const AUTO_CLOSE_MS = (\d+);/) || [])[1]), P.AUTO_CLOSE_MS);
    equal('nada de esto se pinta como HTML (solo los iconos fijos)', (fs.readFileSync(new URL('../panico-prueba.js', import.meta.url), 'utf8').match(/innerHTML/g) || []).length, 1);
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
