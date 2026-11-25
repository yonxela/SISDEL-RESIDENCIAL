/* ═══════════════════════════════════════════════════════════════
   SISDEL - Configuracion > Panel del vecino (admin.html)
   ───────────────────────────────────────────────────────────────
   Pedido del usuario el 2026-11-24: "cuando el vecino entra con su clave el puede generar su marbete y gestionar sus visitas,
   eso es lo que necesito que este en configuracion para activar o desactivar".
   Interruptores para TODOS los vecinos del condominio (vecino-config.js, condominios/{id}/vecino_config/general):
   - Marbete del vehiculo: ver y descargar su marbete en "Mi Marbete".
   - Pases de visita y, debajo, accesos temporales (varios dias).
   Cada interruptor se guarda al instante (con confirmacion); el mensaje que ve el vecino cuando algo esta apagado se guarda con
   su boton. Las reglas piden vecino.configurar y la bitacora anota cada cambio. Todo lo escrito se pinta como texto.
   - Clave de acceso con el QR de panico (2026-11-25: el usuario la busco aqui, la "activo" con los interruptores de arriba y no
     salia; la habia apagado en Reportes > QR de panico): el MISMO interruptor de la entrega general de claves de ese reporte
     (panicCodeDelivery generalStatus / generalOn / generalOff, que exige el servidor), con su estado a la vista. Aqui se enciende
     para todos los vecinos; para solo algunos (casas, lotes, una fase) se usa el reporte. Se ve con usuarios.codigos y se cambia con
     reportes.panico_entrega.
   ═══════════════════════════════════════════════════════════════ */
const SisdelVecinoConfigUI = (() => {
    const C = () => window.SisdelVecinoConfig;

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'text') node.textContent = v;
            else if (k === 'class') node.className = v;
            else if (k === 'style') node.style.cssText = v;
            else node.setAttribute(k, v);
        });
        children.forEach((c) => node.appendChild(c));
        return node;
    }

    function injectStyles() {
        if (document.getElementById('vcf-styles')) return;
        const css = `
        .vcf-intro { margin:0 0 1rem; }
        .vcf-card { padding:1.15rem 1.25rem; margin-bottom:1rem; }
        .vcf-row { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
        .vcf-row h3 { margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem; }
        .vcf-row h4 { margin:0; font-size:0.95rem; }
        .vcf-text { min-width:0; flex:1 1 260px; }
        .vcf-text p { margin:0.3rem 0 0; }
        .vcf-sub { margin-top:1rem; padding:0.85rem 1rem; border:1px solid var(--border-color); border-radius:var(--radius-md); background:var(--bg-item); }
        .vcf-sub.off { opacity:0.55; }
        .vcf-switch { display:inline-flex; align-items:center; gap:0.6rem; padding:0.35rem 0.5rem 0.35rem 0.35rem; border-radius:999px; border:1px solid var(--border-strong); background:var(--bg-item); color:var(--text-primary); font-weight:800; font-size:0.85rem; letter-spacing:0.02em; cursor:pointer; flex:0 0 auto; }
        .vcf-switch:disabled { cursor:not-allowed; opacity:0.6; }
        .vcf-track { position:relative; width:48px; height:26px; border-radius:999px; background:#64748b; transition:background .2s; }
        .vcf-track::after { content:''; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.35); transition:transform .2s; }
        .vcf-switch[aria-checked="true"] .vcf-track { background:#16a34a; }
        .vcf-switch[aria-checked="true"] .vcf-track::after { transform:translateX(22px); }
        .vcf-switch[aria-checked="true"] .vcf-label { color:#16a34a; }
        .vcf-switch[aria-checked="false"] .vcf-label { color:var(--danger); }
        .vcf-state { margin-top:0.75rem; padding:0.6rem 0.8rem; border-radius:var(--radius-md); font-size:0.85rem; line-height:1.45; }
        .vcf-state.on { background:rgba(22,163,74,.12); border:1px solid rgba(22,163,74,.35); }
        .vcf-state.off { background:rgba(220,38,38,.1); border:1px solid rgba(220,38,38,.35); }
        .vcf-note { margin-top:0.85rem; }
        .vcf-note-row { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; }
        .vcf-note-row input { flex:1 1 260px; padding-left:1rem; }
        .vcf-foot { font-size:0.8rem; }
        .vcf-keys-opts { display:flex; flex-wrap:wrap; align-items:flex-end; gap:0.75rem; margin-top:0.85rem; }
        .vcf-keys-opts label { display:block; font-size:0.8rem; font-weight:700; margin-bottom:0.25rem; }
        .vcf-keys-opts select { padding-left:0.85rem; min-width:9rem; }
        `;
        document.head.appendChild(el('style', { id: 'vcf-styles', text: css }));
    }

    function mount(root, opts) {
        // SISDEL es una constante global de sisdel-core.js (no cuelga de window)
        const S = typeof SISDEL !== 'undefined' ? SISDEL : window.SISDEL;
        const condoId = opts.condominioId;
        const session = opts.session || {};
        const db = window.sisdelFirebase.db;
        const canEdit = S.can('vecino.configurar');
        const who = { id: session.userId, name: session.userName || '' };
        let saved = C().clean(null);
        let meta = { exists: false, updatedAt: null, updatedBy: null };
        let loaded = false;
        let busy = false;
        injectStyles();

        root.innerHTML = '';
        const intro = el('p', { class: 'text-sm text-muted vcf-intro', text: `Lo que cada vecino puede hacer al entrar con su clave en garita.app. Apagar algo aquí lo apaga para TODOS los vecinos de ${session.condominioName || 'este condominio'}, aunque su usuario tenga el privilegio; encenderlo deja a cada vecino con sus privilegios de siempre (Configuración > Privilegios > Panel del vecino).` });

        const makeSwitch = (id, label) => {
            const b = el('button', { type: 'button', class: 'vcf-switch', id, role: 'switch', 'aria-checked': 'true', 'aria-label': label });
            b.append(el('span', { class: 'vcf-track' }), el('span', { class: 'vcf-label', text: 'ENCENDIDO' }));
            return b;
        };
        const makeNote = (id, option) => {
            const input = el('input', { class: 'form-input', id, maxlength: String(C().NOTE_MAX), placeholder: C().DEFAULT_NOTES[option] });
            const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'border:1px solid var(--border-strong);', text: 'Guardar mensaje' });
            const wrap = el('div', { class: 'vcf-note' }, [
                el('label', { class: 'form-label', for: id, text: 'Lo que ve el vecino cuando está apagado' }),
                el('div', { class: 'vcf-note-row' }, [input, btn]),
                el('p', { class: 'text-xs text-muted', style: 'margin:0.3rem 0 0;', text: 'En blanco se usa el texto de siempre (el gris).' })
            ]);
            return { wrap, input, btn };
        };

        // ── Marbete ──
        const marbeteSwitch = makeSwitch('vcfMarbete', 'Marbete del vehículo');
        const marbeteState = el('div', { class: 'vcf-state', id: 'vcfMarbeteState' });
        const marbeteNote = makeNote('vcfMarbeteNote', 'marbete');
        const marbeteCard = el('div', { class: 'card vcf-card' }, [
            el('div', { class: 'vcf-row' }, [
                el('div', { class: 'vcf-text' }, [
                    el('h3', { text: 'Marbete del vehículo' }),
                    el('p', { class: 'text-sm text-muted', text: 'En "Mi Marbete" el vecino ve y descarga el código QR (marbete) de cada vehículo que tiene registrado.' })
                ]),
                marbeteSwitch
            ]),
            marbeteState, marbeteNote.wrap
        ]);

        // ── Pases de visita y accesos temporales ──
        const visitasSwitch = makeSwitch('vcfVisitas', 'Pases de visita');
        const visitasState = el('div', { class: 'vcf-state', id: 'vcfVisitasState' });
        const temporalSwitch = makeSwitch('vcfTemporal', 'Accesos temporales');
        const temporalText = el('p', { class: 'text-xs text-muted', id: 'vcfTemporalText' });
        const temporalBox = el('div', { class: 'vcf-sub', id: 'vcfTemporalBox' }, [
            el('div', { class: 'vcf-row' }, [
                el('div', { class: 'vcf-text' }, [el('h4', { text: 'Accesos temporales (varios días)' }), temporalText]),
                temporalSwitch
            ])
        ]);
        const visitasNote = makeNote('vcfVisitasNote', 'visitas');
        const visitasCard = el('div', { class: 'card vcf-card' }, [
            el('div', { class: 'vcf-row' }, [
                el('div', { class: 'vcf-text' }, [
                    el('h3', { text: 'Pases de visita' }),
                    el('p', { class: 'text-sm text-muted', text: 'En "Registrar Visita" el vecino genera el pase con código QR para su invitado (vale su día y una sola vez), lo comparte y lo cancela.' })
                ]),
                visitasSwitch
            ]),
            visitasState, temporalBox, visitasNote.wrap
        ]);

        // ── Clave de acceso con el QR de panico (la entrega general de claves de Reportes > QR de panico por vecino) ──
        const canSeeKeys = S.can('usuarios.codigos') && !!(window.sisdelFirebase && window.sisdelFirebase.functions);
        const canSwitchKeys = canSeeKeys && S.can('reportes.panico_entrega');
        let general = null;
        let generalError = '';
        let generalBusy = false;
        const keysSwitch = makeSwitch('vcfKeys', 'Clave de acceso con el QR de pánico');
        const keysState = el('div', { class: 'vcf-state', id: 'vcfKeysState', text: 'Consultando…' });
        const keysDays = el('select', { class: 'form-input', id: 'vcfKeysDays' });
        [1, 3, 7, 15, 30].forEach((d) => { const o = el('option', { value: String(d), text: `${d} día${d === 1 ? '' : 's'}` }); if (d === 7) o.selected = true; keysDays.appendChild(o); });
        const keysRefresh = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'border:1px solid var(--border-strong);', text: 'Actualizar' });
        const keysOpts = el('div', { class: 'vcf-keys-opts', id: 'vcfKeysOpts' }, [
            el('div', {}, [el('label', { for: 'vcfKeysDays', text: 'Se apaga sola en' }), keysDays]),
            el('p', { class: 'text-xs text-muted', style: 'margin:0; flex:1 1 220px;', text: 'Aquí se enciende para TODOS los vecinos. Para darla solo a algunos (casas con lote, solo lotes, una fase o elegidos uno por uno), use Reportes > QR de pánico por vecino.' }),
            keysRefresh
        ]);
        const keysNoPriv = el('p', { class: 'text-xs text-muted', id: 'vcfKeysNoPriv', style: 'margin:0.6rem 0 0; display:none;', text: 'Usted puede ver si está encendida, pero encenderla o apagarla pide el privilegio "Activar o desactivar la entrega de claves con el QR" (Configuración > Privilegios > Reportes).' });
        const keysCard = el('div', { class: 'card vcf-card', id: 'vcfKeysCard' }, [
            el('div', { class: 'vcf-row' }, [
                el('div', { class: 'vcf-text' }, [
                    el('h3', { text: 'Clave de acceso con el QR de pánico' }),
                    el('p', { class: 'text-sm text-muted', text: 'Encendida, la primera vez que se escanea el QR de pánico de cada vecino muestra su clave de acceso a garita.app UNA sola vez (con el aviso de no compartirla) y ese teléfono queda vinculado a su botón de pánico. Quien ya recibió su clave no la vuelve a ver. Apagada, los QR no muestran ninguna clave.' })
                ]),
                keysSwitch
            ]),
            keysState, keysOpts, keysNoPriv
        ]);

        const foot = el('p', { class: 'text-muted vcf-foot', id: 'vcfFoot', text: 'Cargando…' });
        root.append(intro, ...(canSeeKeys ? [keysCard] : []), marbeteCard, visitasCard, foot);

        const fmtKeys = (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString('es-GT', { timeZone: 'America/Guatemala', dateStyle: 'medium', timeStyle: 'short' }) : ''; };
        function paintKeys() {
            if (!canSeeKeys) return;
            const on = !!(general && general.active);
            paintSwitch(keysSwitch, on);
            keysSwitch.disabled = generalBusy || !general || !canSwitchKeys;
            keysState.className = `vcf-state ${general ? (on ? 'on' : 'off') : ''}`;
            let text;
            if (generalBusy) text = 'Guardando…';
            else if (!general) text = generalError ? `No se pudo consultar: ${generalError}` : 'Consultando…';
            else if (on) {
                const who = general.scope === 'lista'
                    ? `para ${general.count} vecino${general.count === 1 ? '' : 's'}${general.label ? ` (${general.label})` : ''}`
                    : 'para todos los vecinos';
                text = `Encendida hasta el ${fmtKeys(general.until)}${general.startedByName ? ` (la encendió ${general.startedByName})` : ''}, ${who}. Entregadas en esta entrega: ${general.delivered || 0}.`;
            } else {
                const ended = general.endedAt ? ` Se apagó el ${fmtKeys(general.endedAt)}${general.endedByName ? ` (${general.endedByName})` : ''}.`
                    : (general.until && Date.parse(general.until) <= Date.now() ? ` La última venció el ${fmtKeys(general.until)}.` : '');
                text = `Apagada: los QR no muestran ninguna clave.${ended}${general.campaignId ? ` En la última entrega se entregaron ${general.delivered || 0}.` : ''}`;
            }
            keysState.textContent = text;
            keysOpts.style.display = canSwitchKeys && general && !on ? '' : 'none';
            keysNoPriv.style.display = canSwitchKeys ? 'none' : '';
            keysRefresh.disabled = generalBusy;
        }
        async function callKeys(payload) {
            try {
                const r = await window.sisdelFirebase.functions.httpsCallable('panicCodeDelivery')({ condoId, ...payload });
                return r.data || { ok: false, error: 'Sin respuesta del servidor.' };
            } catch (e) { return { ok: false, error: String((e && e.message) || 'No se pudo completar. Intente de nuevo.').replace(/\s*\[\d{3}\]\s*$/, '') }; }
        }
        async function loadKeys() {
            if (!canSeeKeys) return;
            const res = await callKeys({ action: 'generalStatus' });
            general = res.ok ? res : null;
            generalError = res.ok ? '' : (res.error || '');
            paintKeys();
        }
        async function runKeys(payload, done) {
            generalBusy = true; paintKeys();
            const res = await callKeys(payload);
            generalBusy = false;
            if (res.ok) { general = res; S.showToast(done, 'success'); }
            else { alert(res.error || 'No se pudo completar. Intente de nuevo.'); if (res.campaignId !== undefined) general = res; }
            paintKeys();
        }
        if (canSeeKeys) {
            keysSwitch.addEventListener('click', () => {
                if (!general || generalBusy || !canSwitchKeys) return;
                if (general.active) {
                    if (!confirm('¿Apagar la entrega de la clave con el QR?\n\nDesde ahora los QR no mostrarán ninguna clave. Las que ya se entregaron no cambian.')) return;
                    runKeys({ action: 'generalOff' }, 'Clave con el QR: apagada. Los QR ya no muestran claves.');
                    return;
                }
                const days = Number(keysDays.value) || 7;
                if (!confirm(`¿Encender la entrega de la clave con el QR para TODOS los vecinos durante ${days} día${days === 1 ? '' : 's'}?\n\nMientras esté encendida, la PRIMERA persona que escanee el QR de cada vecino verá su clave una sola vez (también en los QR que ya estén pegados en puertas o carros). Enciéndala solo mientras se reparten las tarjetas.`)) return;
                runKeys({ action: 'generalOn', days }, `Clave con el QR: encendida por ${days} día${days === 1 ? '' : 's'} para todos los vecinos.`);
            });
            keysRefresh.addEventListener('click', () => { general = null; generalError = ''; paintKeys(); loadKeys(); });
        }

        const paintSwitch = (b, on) => {
            b.setAttribute('aria-checked', on ? 'true' : 'false');
            b.querySelector('.vcf-label').textContent = on ? 'ENCENDIDO' : 'APAGADO';
        };
        const fmt = (iso) => {
            try { return new Date(iso).toLocaleString('es-GT', { timeZone: 'America/Guatemala', dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso || ''; }
        };
        function paint() {
            const c = saved;
            paintSwitch(marbeteSwitch, c.marbete);
            paintSwitch(visitasSwitch, c.visitas);
            paintSwitch(temporalSwitch, c.visitas && c.temporal);
            marbeteState.className = `vcf-state ${c.marbete ? 'on' : 'off'}`;
            marbeteState.textContent = c.marbete
                ? 'Encendido: cada vecino con el privilegio "Ver y descargar su marbete" lo ve en su celular.'
                : 'Apagado: ningún vecino ve ni descarga su marbete ni su código desde el celular (sí puede seguir registrando sus vehículos). Lo entrega la administración: Finanzas > Residentes > Generar marbete, o Reportes > Impresión de marbetes por fase. Los marbetes ya entregados siguen abriendo en la garita.';
            visitasState.className = `vcf-state ${c.visitas ? 'on' : 'off'}`;
            visitasState.textContent = c.visitas
                ? 'Encendido: cada vecino con el privilegio "Crear pases de visita" genera los pases de sus visitas.'
                : 'Apagado: ningún vecino puede generar pases nuevos (la base de datos lo rechaza aunque lo intente). Los que ya generó siguen valiendo su día y los puede cancelar. La administración, con el privilegio "Crear visitas", no se ve afectada.';
            temporalBox.classList.toggle('off', !c.visitas);
            temporalText.textContent = !c.visitas
                ? 'Sin pases de visita no hay accesos temporales.'
                : (c.temporal ? 'Encendido: el vecino puede dar un pase válido por varios días (con el privilegio "Crear accesos temporales").' : 'Apagado: el vecino solo genera pases de un día.');
            const disabled = !canEdit || !loaded || busy;
            [marbeteSwitch, visitasSwitch].forEach((b) => { b.disabled = disabled; });
            temporalSwitch.disabled = disabled || !c.visitas;
            [[marbeteNote, c.marbeteNote], [visitasNote, c.visitasNote]].forEach(([n, value]) => {
                if (document.activeElement !== n.input && !n.input.dataset.dirty) n.input.value = value;
                n.input.disabled = !canEdit || !loaded;
                n.btn.disabled = disabled || C().clean({ marbeteNote: n.input.value }).marbeteNote === value;
            });
            if (!loaded) return;
            const by = meta.updatedBy && meta.updatedBy.name ? meta.updatedBy.name : '';
            foot.textContent = meta.exists
                ? `Último cambio: ${fmt(meta.updatedAt)}${by ? ` (${by})` : ''} · Cada cambio queda en la bitácora.${canEdit ? '' : ' Usted solo puede ver esta configuración.'}`
                : `Todavía no se ha cambiado: todo está encendido, como siempre.${canEdit ? '' : ' Usted solo puede ver esta configuración.'}`;
        }

        async function load() {
            try {
                const r = await C().read(db, condoId);
                saved = r.config;
                meta = { exists: r.exists, updatedAt: r.updatedAt, updatedBy: r.updatedBy };
                loaded = true;
            } catch (error) {
                console.error('vecino-config', error);
                foot.textContent = 'No se pudo leer la configuración del panel del vecino. Revise la conexión y vuelva a abrir esta pestaña.';
            }
            paint();
        }

        async function store(next, okText) {
            busy = true; paint();
            try {
                const doc = await C().save(db, condoId, next, who);
                saved = C().clean(doc);
                meta = { exists: true, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
                S.showToast(okText, 'success');
                return true;
            } catch (error) {
                console.error('vecino-config', error);
                S.showToast(error && error.code === 'permission-denied' ? 'Su usuario no tiene permiso para cambiar esta configuración' : 'No se pudo guardar: revise la conexión', 'error');
                return false;
            } finally {
                busy = false; paint();
            }
        }

        const QUESTIONS = {
            marbete: [
                '¿Apagar el marbete para TODOS los vecinos?\n\nNingún vecino podrá ver ni descargar su marbete desde el celular. Lo entrega la administración. Los marbetes ya entregados siguen abriendo en la garita.',
                '¿Encender el marbete?\n\nCada vecino con el privilegio podrá ver y descargar el marbete de sus vehículos.'
            ],
            visitas: [
                '¿Apagar los pases de visita para TODOS los vecinos?\n\nNingún vecino podrá generar pases nuevos. Los que ya generó siguen valiendo su día.',
                '¿Encender los pases de visita?\n\nCada vecino con el privilegio podrá generar los pases de sus visitas.'
            ],
            temporal: [
                '¿Apagar los accesos temporales para TODOS los vecinos?\n\nSolo podrán dar pases de un día. Los accesos temporales que ya existen siguen valiendo hasta su fecha.',
                '¿Encender los accesos temporales?\n\nCada vecino con el privilegio podrá dar pases válidos por varios días.'
            ]
        };
        const LABELS = { marbete: 'Marbete', visitas: 'Pases de visita', temporal: 'Accesos temporales' };
        function bindSwitch(button, option) {
            button.addEventListener('click', async () => {
                if (button.disabled) return;
                const on = !(option === 'temporal' ? saved.visitas && saved.temporal : saved[option]);
                if (!confirm(QUESTIONS[option][on ? 1 : 0])) return;
                await store({ ...saved, [option]: on }, `${LABELS[option]}: ${on ? 'encendido' : 'apagado'} para todos los vecinos`);
            });
        }
        bindSwitch(marbeteSwitch, 'marbete');
        bindSwitch(visitasSwitch, 'visitas');
        bindSwitch(temporalSwitch, 'temporal');

        function bindNote(n, field) {
            n.input.addEventListener('input', () => { n.input.dataset.dirty = '1'; paint(); });
            n.btn.addEventListener('click', async () => {
                const ok = await store({ ...saved, [field]: n.input.value }, 'Mensaje guardado');
                if (ok) { delete n.input.dataset.dirty; n.input.value = saved[field]; paint(); }
            });
        }
        bindNote(marbeteNote, 'marbeteNote');
        bindNote(visitasNote, 'visitasNote');

        load();
        loadKeys();
        return {
            reload: () => { load(); loadKeys(); },
            // Hay un mensaje escrito sin guardar
            isDirty: () => [[marbeteNote, 'marbeteNote'], [visitasNote, 'visitasNote']].some(([n, f]) => C().clean({ [f]: n.input.value })[f] !== saved[f])
        };
    }

    return { mount };
})();
