/* ═══════════════════════════════════════════════════════════════
   SISDEL - Ayuda para activar la ubicacion del telefono (boton de panico)
   ───────────────────────────────────────────────────────────────
   La usan vecino.html (boton de panico del portal) y panico.html (el QR de panico pegado en la puerta o el carro).
   Una pagina NO puede activar la ubicacion ni abrir los Ajustes del telefono (iOS y Android lo bloquean a proposito):
   solo puede pedir el permiso y, si el telefono lo tiene bloqueado, GUIAR con los pasos de ese telefono. Esta ventana
   muestra solo lo que sirve al telefono que la abre (iPhone con Safari, iPhone con otro navegador, Android).

   Uso: SisdelGpsAyuda.mount({ safariUrl, copyText }) una vez; SisdelGpsAyuda.ask(fromHelp) al tocar "Activar ubicacion";
   SisdelGpsAyuda.open() para abrir la ayuda. Requiere rondas-core.js (SisdelRondas.gps) y styles.css (.modal-overlay).
   ═══════════════════════════════════════════════════════════════ */

const SisdelGpsAyuda = (() => {
    // La ayuda muestra solo lo que sirve a este telefono (una pagina no puede abrir los Ajustes: solo guiar)
    const UA = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_ANDROID = /Android/i.test(UA);
    const IS_IOS_NOT_SAFARI = IS_IOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(UA); // Chrome, Firefox, Edge u Opera en iPhone
    const IOS_BROWSER = /CriOS/.test(UA) ? 'Chrome' : /FxiOS/.test(UA) ? 'Firefox' : /EdgiOS/.test(UA) ? 'Edge' : /OPiOS/.test(UA) ? 'Opera' : 'su navegador';

    const HTML = `
    <div class="modal-overlay" id="modalGpsHelp" style="display:none;">
        <div class="modal" style="max-width:460px;">
            <div class="modal-header">
                <h3>Activar la ubicación</h3>
                <button class="btn btn-ghost btn-icon modal-close" id="btnCloseGpsHelp" type="button">&times;</button>
            </div>
            <div class="gps-help" style="padding:1.25rem; font-size:0.9rem; line-height:1.5;">
                <p style="margin-bottom:0.75rem;">Su teléfono tiene bloqueada la ubicación para esta página, y por eso la alerta de pánico sale sin saber dónde está. Una página no puede activarla ni abrir los Ajustes por usted: se activa una sola vez.</p>
                <!-- iPhone con Chrome (u otro que no es Safari): cada navegador tiene su PROPIO permiso de ubicacion; el de Safari no vale aqui -->
                <div id="gpsHelpIosOther" style="display:none;">
                    <div style="margin-bottom:0.9rem; padding:0.75rem; border-radius:0.75rem; background:rgba(217,119,6,0.14); border:1px solid rgba(217,119,6,0.5);">
                        <strong>Está usando <span class="gps-browser">su navegador</span>.</strong>
                        <p class="text-xs" style="margin:0.35rem 0 0;">Aunque Safari ya tenga la ubicación activada, cada navegador tiene su propio permiso: el de Safari no vale en <span class="gps-browser">su navegador</span>. Hay dos caminos:</p>
                    </div>
                    <div style="margin-bottom:0.9rem; padding:0.75rem; border-radius:0.75rem; background:rgba(22,163,74,0.12); border:1px solid rgba(22,163,74,0.45);">
                        <strong>Camino 1, el más rápido: use Safari</strong>
                        <p class="text-xs" style="margin:0.35rem 0 0.6rem;" id="gpsHelpSafariText">Como Safari ya tiene la ubicación activada, solo hay que abrir allí garita.app, ingresar su clave y tocar "Permitir" si el teléfono pregunta.</p>
                        <a class="btn btn-primary btn-sm" id="btnOpenSafari" href="#" style="width:100%; white-space:normal; justify-content:center; margin-bottom:0.5rem;">Abrir en Safari</a>
                        <button class="btn btn-ghost btn-sm" id="btnCopyLink" type="button" style="border:1px solid var(--border-strong); width:100%; white-space:normal; justify-content:center;">Si no abre: copiar el enlace para pegarlo en Safari</button>
                    </div>
                    <strong>Camino 2: activar la ubicación de <span class="gps-browser">su navegador</span></strong>
                    <ol>
                        <li>Salga a los Ajustes del iPhone &gt; <span class="gps-browser">su navegador</span> &gt; Ubicación &gt; elija "Al usar la app" (o "Preguntar la próxima vez o al compartir").</li>
                        <li>Cierre <span class="gps-browser">su navegador</span> por completo (deslice hacia arriba desde el selector de apps) y vuelva a abrir garita.app.</li>
                        <li>Ingrese su clave y toque "Permitir" cuando el teléfono pregunte por su ubicación.</li>
                    </ol>
                </div>
                <div id="gpsHelpIos">
                    <strong>En el iPhone (Safari)</strong>
                    <ol>
                        <li>Ajustes del iPhone &gt; Privacidad y seguridad &gt; Localización: active "Localización" y, en "Sitios web de Safari", elija "Al usar la app".</li>
                        <li>En Safari, toque "aA" junto a la dirección &gt; Configuración del sitio web &gt; Ubicación &gt; Permitir.</li>
                    </ol>
                </div>
                <div id="gpsHelpAndroid">
                    <strong>En Android (Chrome)</strong>
                    <ol>
                        <li>Toque el icono junto a la dirección &gt; Permisos &gt; Ubicación &gt; Permitir.</li>
                        <li>Si la ubicación del teléfono está apagada, enciéndala en los Ajustes.</li>
                    </ol>
                    <a class="btn btn-ghost btn-sm" id="btnAndroidLoc" href="intent:#Intent;action=android.settings.LOCATION_SOURCE_SETTINGS;end" style="border:1px solid var(--border-strong); margin-bottom:0.9rem; width:100%; white-space:normal; justify-content:center;">Abrir los ajustes de ubicación</a>
                </div>
                <p class="text-xs text-muted">Al volver a esta página la ubicación se comprueba sola. Los nombres de los menús pueden variar según su teléfono.</p>
                <!-- pegado al fondo de la ventana: en un telefono chico la lista de pasos se desplaza y el boton siempre se ve -->
                <div style="position:sticky; bottom:-1.25rem; margin:0 -1.25rem -1.25rem; padding:0.75rem 1.25rem 1.25rem; background:var(--bg-surface);">
                    <button class="btn btn-primary" id="btnGpsRecheck" type="button" style="width:100%;">Ya la activé: comprobar</button>
                    <p id="gpsHelpResult" class="text-xs" style="display:none; margin-top:0.6rem; font-weight:700;"></p>
                </div>
            </div>
        </div>
    </div>`;
    const CSS = `
        /* Boton de la ubicacion del celular (la alerta lleva las coordenadas): casilla vacia = por activar; con chequesito verde = activada;
           ambar = buscando; rojo = bloqueada (al tocarlo explica como activarla) */
        .panic-loc { display: inline-flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0.9rem 0.5rem 0.6rem; border-radius: 999px; border: 1px solid var(--border-strong);
            background: var(--bg-surface); color: var(--text-primary); font: inherit; font-size: 0.8rem; font-weight: 700; line-height: 1.25; text-align: left; cursor: pointer; max-width: 100%; }
        .panic-loc-box { flex: none; width: 1.4rem; height: 1.4rem; border-radius: 0.4rem; border: 2px solid currentColor; display: inline-flex; align-items: center; justify-content: center; }
        .panic-loc.warn { color: #d97706; border-color: rgba(217,119,6,0.55); }
        .panic-loc.bad { color: #dc2626; border-color: rgba(220,38,38,0.55); }
        .panic-loc.ok { color: #16a34a; border-color: rgba(22,163,74,0.6); background: rgba(22,163,74,0.12); cursor: default; }
        .panic-loc.ok .panic-loc-box { background: #16a34a; border-color: #16a34a; color: #fff; }
        .panic-loc small { display: block; font-weight: 600; opacity: 0.85; }
        .gps-help ol { margin: 0.35rem 0 0.9rem 1.25rem; padding: 0; }
        .gps-help li { margin-bottom: 0.3rem; }`;

    // El boton de la ubicacion (#panicGps con #panicGpsBox y #panicGpsText): casilla vacia = por activar; con chequesito verde =
    // ubicacion activada (la alerta llevara las coordenadas); rojo = bloqueada (al tocarlo explica como activarla)
    const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    const GPS_BUTTON = {
        idle: ['warn', 'Activar ubicación'],
        searching: ['warn', 'Buscando su ubicación...'],
        denied: ['bad', 'Ubicación bloqueada: toque para activarla'],
        unsupported: ['bad', 'Este teléfono no permite obtener la ubicación']
    };
    function paint(s) {
        const panicGps = document.getElementById('panicGps');
        if (!panicGps) return;
        const panicGpsBox = document.getElementById('panicGpsBox');
        const panicGpsText = document.getElementById('panicGpsText');
        let cls, text;
        const ok = s.status === 'ok';
        if (ok) { cls = 'ok'; text = 'Ubicación activada' + (s.pos && s.pos.accuracy ? ' (±' + s.pos.accuracy + ' m)' : ''); }
        else [cls, text] = GPS_BUTTON[s.status] || GPS_BUTTON.idle;
        panicGps.className = 'panic-loc ' + cls;
        panicGps.setAttribute('aria-checked', ok ? 'true' : 'false');
        panicGpsBox.innerHTML = ok ? CHECK_SVG : '';
        panicGpsText.textContent = text;
        panicGps.style.display = '';
    }

    let modalGpsHelp = null;
    let gpsHelpResult = null;
    let opts = {};

    // Copia el enlace (el portal usa SISDEL.copyText; panico.html no carga sisdel-core.js)
    function copy(text, message) {
        if (opts.copyText) { opts.copyText(text, message); return; }
        const done = () => { const b = document.getElementById('btnCopyLink'); if (b) b.textContent = message; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copie este enlace:', text));
        else window.prompt('Copie este enlace:', text);
    }

    // safariUrl: la pagina que se abre en Safari (el portal abre el login; el QR, el mismo QR)
    // safariText: lo que dice el Camino 1 (en el QR no hay que ingresar la clave: solo vincular el telefono)
    if (typeof document !== 'undefined' && document.head) {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function mount(options = {}) {
        opts = options;
        if (modalGpsHelp) return;
        document.body.insertAdjacentHTML('beforeend', HTML);
        modalGpsHelp = document.getElementById('modalGpsHelp');
        gpsHelpResult = document.getElementById('gpsHelpResult');
        const safariUrl = opts.safariUrl || (location.origin + '/index.html');
        if (opts.safariText) document.getElementById('gpsHelpSafariText').textContent = opts.safariText;
        // x-safari-https:// abre la pagina en Safari desde otro navegador (no esta documentado por Apple: sirve en iOS 15, 17 y 18; por eso hay tambien "copiar el enlace")
        document.getElementById('btnOpenSafari').setAttribute('href', 'x-safari-' + safariUrl);
        document.getElementById('btnCopyLink').addEventListener('click', () => copy(safariUrl, 'Enlace copiado: péguelo en Safari'));
        document.getElementById('btnGpsRecheck').addEventListener('click', () => ask(true));
        document.getElementById('btnCloseGpsHelp').addEventListener('click', close);
        // Si la activo mientras leia la ayuda, ya no hace falta
        SisdelRondas.gps.onChange((s) => { if (s.status === 'ok') close(); });
    }

    function open() {
        if (!modalGpsHelp) mount(opts);
        document.querySelectorAll('.gps-browser').forEach((el) => { el.textContent = IOS_BROWSER; });
        document.getElementById('gpsHelpIosOther').style.display = IS_IOS_NOT_SAFARI ? 'block' : 'none';
        document.getElementById('gpsHelpIos').style.display = IS_IOS_NOT_SAFARI ? 'none' : (IS_IOS || !IS_ANDROID ? 'block' : 'none');
        document.getElementById('gpsHelpAndroid').style.display = IS_ANDROID || !IS_IOS ? 'block' : 'none';
        gpsHelpResult.style.display = 'none';
        modalGpsHelp.style.display = 'flex';
    }
    function close() { if (modalGpsHelp) modalGpsHelp.style.display = 'none'; }

    // Tocar "Activar ubicacion" pide el permiso (el telefono muestra su ventana) y espera la respuesta; si esta bloqueado,
    // explica como activarlo. Devuelve lo mismo que SisdelRondas.gps.ask ('granted' | 'denied' | 'timeout' | 'unsupported')
    async function ask(fromHelp) {
        if (SisdelRondas.gps.state().status === 'ok') return 'granted';
        const result = await SisdelRondas.gps.ask(20000);
        if (result === 'granted') SisdelRondas.gps.start(); // y sigue la posicion
        else if (result === 'denied') {
            if (fromHelp) { gpsHelpResult.textContent = 'Todavía está bloqueada. Revise los pasos y vuelva a comprobar.'; gpsHelpResult.style.color = '#dc2626'; gpsHelpResult.style.display = 'block'; }
            else open();
        }
        return result;
    }

    return { mount, open, close, ask, paint, IS_IOS, IS_ANDROID, IS_IOS_NOT_SAFARI, IOS_BROWSER };
})();
