/* ═══════════════════════════════════════════════════════════════
   SISDEL - Configuracion > Boton de panico (admin.html)
   ───────────────────────────────────────────────────────────────
   Pedido del usuario el 2026-11-20: "crear una pestana para configurar boton de panico, para personalizar el mensaje que
   entregara y los numeros de telefono de garita y de PNC a donde llegaran los avisos".
   - Los telefonos que reciben cada alerta (garita, PNC u otro; hasta 10) y si tambien se avisa al personal que atiende alertas.
   - El titulo y las indicaciones del aviso a la garita, la PNC y el personal; la nota a los familiares y la firma.
   - La vista previa de los dos mensajes (panico-avisos.js, el MISMO modulo que usa el servidor en cada alerta).
   - Guardar (condominios/{id}/panico_config/general; las reglas piden panico.configurar y la bitacora anota cada cambio) y
     "Enviar prueba" (la funcion testPanicNotice manda un mensaje que dice PRUEBA a los telefonos guardados).
   - El interruptor "Botón de pánico de los vecinos" (el mismo de Rondas > Configuracion; con su privilegio).
   Todo lo escrito se pinta con textContent o value (nunca como HTML).
   ═══════════════════════════════════════════════════════════════ */
const SisdelPanicoConfigUI = (() => {
    const A = () => window.SisdelPanicoAvisos;
    const KIND_OPTIONS = [['garita', 'Garita'], ['pnc', 'PNC'], ['otro', 'Otro']];

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'text') node.textContent = v;
            else if (k === 'style') node.style.cssText = v;
            else if (k === 'class') node.className = v;
            else node.setAttribute(k, v);
        });
        children.forEach((c) => node.appendChild(c));
        return node;
    }

    function mount(root, opts) {
        // SISDEL es una constante global de sisdel-core.js (no cuelga de window)
        const S = typeof SISDEL !== 'undefined' ? SISDEL : window.SISDEL;
        const condoId = opts.condominioId;
        const session = opts.session || {};
        const condoName = opts.condoName || session.condominioName || '';
        const db = window.sisdelFirebase.db;
        const docRef = db.collection('condominios').doc(condoId).collection('panico_config').doc('general');
        const rondasRef = db.collection('condominios').doc(condoId).collection('rondas_config').doc('general');
        const canSwitch = S.can('rondas.ajustes_panicovecinos');
        let saved = A().cleanConfig(null);   // lo guardado (limpio)
        let savedPhonesCount = 0;
        let dirty = false;

        root.innerHTML = '';
        const intro = el('p', { class: 'text-sm text-muted', style: 'margin:0 0 1rem;', text: 'Cuando un vecino o un guardia activa el botón de pánico, el sistema manda un WhatsApp a los teléfonos de abajo, al personal que atiende alertas y a los familiares del vecino. Aquí se decide a quién más le llega y qué dice.' });

        // ── Interruptor del boton de los vecinos ──
        const switchCard = el('div', { class: 'card', style: 'padding:1rem 1.25rem; margin-bottom:1rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;' });
        const switchText = el('div', { style: 'min-width:0;' }, [el('strong', { text: 'Botón de pánico de los vecinos' }), el('p', { class: 'text-xs text-muted', id: 'pcNeighborState', style: 'margin:0.2rem 0 0;', text: 'Revisando...' })]);
        const switchBtn = el('button', { class: 'btn btn-ghost btn-sm', id: 'pcNeighborSwitch', type: 'button', style: 'border:1px solid var(--border-strong);' });
        switchBtn.style.display = canSwitch ? '' : 'none';
        switchCard.append(switchText, switchBtn);

        // ── Telefonos ──
        const phonesCard = el('div', { class: 'card', style: 'padding:1.25rem; margin-bottom:1rem;' });
        phonesCard.append(
            el('h3', { style: 'margin:0 0 0.25rem; font-size:1.05rem;', text: 'Teléfonos que reciben cada alerta' }),
            el('p', { class: 'text-xs text-muted', style: 'margin:0 0 0.9rem;', text: `La garita, la PNC u otros (hasta ${A().MAX_PHONES}). Les llega un WhatsApp con quién activó el botón, dónde está (GPS y mapa) y sus indicaciones. Un número de 8 cifras se toma como de Guatemala (+502).` })
        );
        const phonesList = el('div', { id: 'pcPhones', style: 'display:flex; flex-direction:column; gap:0.6rem;' });
        const addPhone = el('button', { class: 'btn btn-ghost btn-sm', id: 'pcAddPhone', type: 'button', style: 'border:1px solid var(--border-strong); margin-top:0.75rem;', text: '+ Agregar teléfono' });
        const staffLabel = el('label', { style: 'display:flex; gap:0.6rem; align-items:flex-start; margin-top:1rem; font-size:0.9rem; cursor:pointer;' });
        const staffBox = el('input', { type: 'checkbox', id: 'pcNotifyStaff', style: 'margin-top:0.2rem;' });
        staffLabel.append(staffBox, el('span', { text: 'Avisar también al personal que atiende alertas (administradores y supervisores con teléfono y el privilegio «Atender alertas de pánico»).' }));
        phonesCard.append(phonesList, addPhone, staffLabel);

        // ── Mensajes ──
        const field = (label, input, help) => {
            const wrap = el('div', { class: 'form-group', style: 'margin-bottom:0.9rem;' }, [el('label', { class: 'form-label', text: label })]);
            wrap.appendChild(input);
            if (help) wrap.appendChild(el('p', { class: 'text-xs text-muted', style: 'margin:0.3rem 0 0;', text: help }));
            return wrap;
        };
        const staffTitle = el('input', { class: 'form-input', id: 'pcStaffTitle', maxlength: String(A().LIMITS.staffTitle), placeholder: 'ALERTA DE PANICO', style: 'padding-left:1rem;' });
        const staffNote = el('textarea', { class: 'form-input', id: 'pcStaffNote', rows: '3', maxlength: String(A().LIMITS.staffNote), placeholder: 'Ej.: Diríjase de inmediato al lote. Si no responde, llame a la PNC al 110.', style: 'padding:0.6rem 1rem; resize:vertical;' });
        const familyNote = el('textarea', { class: 'form-input', id: 'pcFamilyNote', rows: '3', maxlength: String(A().LIMITS.familyNote), placeholder: A().DEFAULT_FAMILY_NOTE.replace('\n', ' '), style: 'padding:0.6rem 1rem; resize:vertical;' });
        const signature = el('input', { class: 'form-input', id: 'pcSignature', maxlength: String(A().LIMITS.signature), placeholder: 'Central SISDEL', style: 'padding-left:1rem;' });
        const msgCard = el('div', { class: 'card', style: 'padding:1.25rem; margin-bottom:1rem;' });
        msgCard.append(
            el('h3', { style: 'margin:0 0 0.75rem; font-size:1.05rem;', text: 'Mensajes' }),
            field('Título del aviso a la garita, la PNC y el personal', staffTitle),
            field('Indicaciones para quien recibe el aviso', staffNote, 'Siempre van, además: quién la envió, el condominio, el lote, su teléfono, la ubicación GPS y el enlace del mapa.'),
            field('Mensaje a los familiares del vecino', familyNote, 'Si lo deja en blanco va el de siempre.'),
            field('Firma de los dos mensajes', signature)
        );

        // ── Vista previa ──
        const prevStaff = el('pre', { id: 'pcPreviewStaff', style: 'white-space:pre-wrap; word-break:break-word; margin:0; font-family:inherit; font-size:0.85rem; background:var(--bg-item, rgba(148,163,184,0.12)); padding:0.85rem; border-radius:10px;' });
        const prevFamily = el('pre', { id: 'pcPreviewFamily', style: prevStaff.style.cssText });
        const prevCard = el('div', { class: 'card', style: 'padding:1.25rem; margin-bottom:1rem;' });
        prevCard.append(
            el('h3', { style: 'margin:0 0 0.75rem; font-size:1.05rem;', text: 'Vista previa (con datos de ejemplo)' }),
            el('div', { style: 'display:grid; grid-template-columns:repeat(auto-fit, minmax(16rem, 1fr)); gap:1rem;' }, [
                el('div', {}, [el('p', { class: 'text-xs text-muted', style: 'margin:0 0 0.35rem; font-weight:700;', text: 'A la garita, la PNC y el personal' }), prevStaff]),
                el('div', {}, [el('p', { class: 'text-xs text-muted', style: 'margin:0 0 0.35rem; font-weight:700;', text: 'A los familiares' }), prevFamily])
            ])
        );

        // ── Acciones ──
        const status = el('p', { id: 'pcStatus', class: 'text-sm', style: 'margin:0; font-weight:700;' });
        const btnSave = el('button', { class: 'btn btn-primary btn-sm', id: 'pcSave', type: 'button', text: 'Guardar' });
        const btnDiscard = el('button', { class: 'btn btn-ghost btn-sm', id: 'pcDiscard', type: 'button', style: 'border:1px solid var(--border-strong);', text: 'Descartar' });
        const btnTest = el('button', { class: 'btn btn-ghost btn-sm', id: 'pcTest', type: 'button', style: 'border:1px solid var(--border-strong);', text: 'Enviar prueba a los teléfonos' });
        const testOut = el('div', { id: 'pcTestOut', class: 'text-sm', style: 'margin-top:0.75rem;' });
        const actions = el('div', { class: 'card', style: 'padding:1rem 1.25rem;' }, [
            el('div', { style: 'display:flex; gap:0.6rem; flex-wrap:wrap; align-items:center; justify-content:space-between;' }, [status, el('div', { style: 'display:flex; gap:0.5rem; flex-wrap:wrap;' }, [btnTest, btnDiscard, btnSave])]),
            testOut
        ]);
        root.append(intro, switchCard, phonesCard, msgCard, prevCard, actions);

        // ── Estado del formulario ──
        function phoneRow(p) {
            // En una fila en la computadora; en el celular se acomoda en dos (sin salirse de la pantalla)
            const row = el('div', { class: 'pc-phone', style: 'display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center;' });
            const kind = el('select', { class: 'form-input pc-kind', 'aria-label': 'Tipo', style: 'padding-left:0.75rem; flex:1 1 7rem; max-width:10rem; min-width:0;' });
            KIND_OPTIONS.forEach(([v, label]) => { const o = el('option', { value: v, text: label }); if (v === (p.kind || 'garita')) o.selected = true; kind.appendChild(o); });
            const name = el('input', { class: 'form-input pc-name', maxlength: String(A().LIMITS.name), placeholder: 'Nombre (ej.: Garita principal)', 'aria-label': 'Nombre', style: 'padding-left:0.75rem; flex:3 1 12rem; min-width:0;' });
            name.value = p.name || '';
            const phone = el('input', { class: 'form-input pc-phone-number', type: 'tel', maxlength: String(A().LIMITS.phone), placeholder: 'Teléfono', 'aria-label': 'Teléfono', style: 'padding-left:0.75rem; flex:2 1 8rem; min-width:0;' });
            phone.value = p.phone ? (String(p.phone).startsWith('502') && String(p.phone).length === 11 ? String(p.phone).slice(3) : p.phone) : '';
            const remove = el('button', { class: 'btn btn-ghost btn-icon btn-sm pc-remove', type: 'button', title: 'Quitar este teléfono', 'aria-label': 'Quitar este teléfono', text: '×', style: 'color:var(--danger); font-size:1.2rem;' });
            remove.addEventListener('click', () => { row.remove(); changed(); });
            [kind, name, phone].forEach((x) => x.addEventListener('input', changed));
            kind.addEventListener('change', changed);
            row.append(kind, name, phone, remove);
            return row;
        }
        function formConfig() {
            return {
                phones: [...phonesList.querySelectorAll('.pc-phone')].map((r) => ({ kind: r.querySelector('.pc-kind').value, name: r.querySelector('.pc-name').value, phone: r.querySelector('.pc-phone-number').value })),
                notifyStaff: staffBox.checked,
                staffTitle: staffTitle.value, staffNote: staffNote.value, familyNote: familyNote.value, signature: signature.value
            };
        }
        function fill(cfg) {
            phonesList.innerHTML = '';
            cfg.phones.forEach((p) => phonesList.appendChild(phoneRow(p)));
            staffBox.checked = cfg.notifyStaff !== false;
            staffTitle.value = cfg.staffTitle || '';
            staffNote.value = cfg.staffNote || '';
            familyNote.value = cfg.familyNote || '';
            signature.value = cfg.signature || '';
        }
        // Telefonos escritos que no sirven, o una fila con nombre y sin telefono (se avisa en vez de descartarlos en silencio)
        function badPhones(raw) {
            return raw.phones.filter((p) => (String(p.phone || '').trim() || String(p.name || '').trim()) && !A().normalizePhone(p.phone));
        }
        const snapshot = (raw) => JSON.stringify(A().cleanConfig(raw));
        function paint() {
            const raw = formConfig();
            const cfg = A().cleanConfig(raw);
            prevStaff.textContent = A().staffMessage(A().sampleAlert('vecino'), condoName || 'Su condominio', ['Familiar de ejemplo'], cfg);
            prevFamily.textContent = A().familyMessage(A().sampleAlert('vecino'), condoName || 'Su condominio', cfg);
            dirty = snapshot(raw) !== JSON.stringify(saved);
            const bad = badPhones(raw);
            addPhone.disabled = phonesList.querySelectorAll('.pc-phone').length >= A().MAX_PHONES;
            btnSave.disabled = !dirty || bad.length > 0;
            btnDiscard.disabled = !dirty;
            btnTest.disabled = dirty || !savedPhonesCount;
            btnTest.title = dirty ? 'Guarde los cambios antes de probar.' : (!savedPhonesCount ? 'Agregue y guarde al menos un teléfono.' : 'Manda un WhatsApp que dice PRUEBA a los teléfonos guardados.');
            // Sin telefonos y sin el personal, del condominio no se entera nadie (solo la central de SISDEL y los familiares)
            const nobody = !cfg.phones.length && !cfg.notifyStaff;
            status.style.color = bad.length || nobody ? 'var(--danger)' : dirty ? 'var(--warning, #d97706)' : 'var(--success, #16a34a)';
            status.textContent = bad.length ? `Revise el teléfono de «${bad[0].name || 'sin nombre'}»: escriba 8 cifras (Guatemala) o el número completo con su código de país.`
                : nobody ? `Así nadie del condominio recibe las alertas (solo la central de SISDEL y los familiares). Agregue el teléfono de la garita o marque «Avisar también al personal».${dirty ? ' Hay cambios sin guardar.' : ''}`
                : dirty ? 'Hay cambios sin guardar.' : (saved.phones.length ? `Guardado: ${saved.phones.length} teléfono(s) reciben cada alerta.` : 'Todavía no hay teléfonos de garita ni de PNC.');
        }
        function changed() { paint(); }
        [staffTitle, staffNote, familyNote, signature].forEach((x) => x.addEventListener('input', changed));
        staffBox.addEventListener('change', changed);
        addPhone.addEventListener('click', () => {
            if (phonesList.querySelectorAll('.pc-phone').length >= A().MAX_PHONES) return;
            const used = [...phonesList.querySelectorAll('.pc-kind')].map((k) => k.value);
            const row = phoneRow({ kind: used.includes('garita') ? (used.includes('pnc') ? 'otro' : 'pnc') : 'garita' });
            phonesList.appendChild(row);
            row.querySelector('.pc-phone-number').focus();
            changed();
        });

        async function load() {
            status.textContent = 'Cargando...';
            try {
                const snap = await docRef.get();
                saved = A().cleanConfig(snap.exists ? snap.data() : null);
            } catch (e) {
                console.error(e);
                saved = A().cleanConfig(null);
                S.showToast('No se pudo leer la configuración del botón de pánico.', 'error');
            }
            savedPhonesCount = saved.phones.length;
            fill(saved);
            paint();
            loadSwitch();
        }
        btnDiscard.addEventListener('click', () => { fill(saved); paint(); });
        btnSave.addEventListener('click', async () => {
            const raw = formConfig();
            if (badPhones(raw).length) { paint(); return; }
            const cfg = A().cleanConfig(raw);
            btnSave.disabled = true;
            try {
                await docRef.set({ ...cfg, updatedAt: new Date().toISOString(), updatedBy: { id: session.userId || '', name: session.userName || '' } });
                saved = cfg;
                savedPhonesCount = cfg.phones.length;
                fill(saved);
                S.showToast('Configuración del botón de pánico guardada.', 'success');
            } catch (e) {
                console.error(e);
                S.showToast(/permission/i.test(String(e && e.code)) ? 'Su usuario no puede configurar el botón de pánico.' : 'No se pudo guardar. Revise su conexión e intente de nuevo.', 'error');
            }
            paint();
        });
        btnTest.addEventListener('click', async () => {
            if (dirty || !savedPhonesCount) return;
            if (!confirm(`¿Enviar un mensaje de PRUEBA por WhatsApp a ${savedPhonesCount} teléfono(s)?\n\nDice claramente que no es una emergencia.`)) return;
            btnTest.disabled = true;
            testOut.textContent = 'Enviando...';
            try {
                const res = await window.sisdelFirebase.functions.httpsCallable('testPanicNotice')({});
                const results = (res.data && res.data.results) || [];
                testOut.textContent = '';
                results.forEach((r) => testOut.appendChild(el('div', { style: `color:${r.sent ? 'var(--success, #16a34a)' : 'var(--danger)'}; font-weight:600;`, text: `${r.sent ? 'Enviado' : 'No salió'}: ${r.name} (…${r.phoneTail})` })));
                testOut.appendChild(el('p', { class: 'text-xs text-muted', style: 'margin:0.4rem 0 0;', text: 'Pida a cada uno que confirme que le llegó. «Enviado» quiere decir que WhatsApp lo aceptó.' }));
            } catch (e) {
                testOut.textContent = String((e && e.message) || 'No se pudo enviar la prueba.').replace(/\s*\[\d{3}\]\s*$/, '');
            }
            paint();
        });

        // ── El boton de los vecinos (rondas_config/general.neighbor_panic_enabled, el mismo de RONDIN) ──
        let neighborOn = null;
        function paintSwitch() {
            const state = document.getElementById('pcNeighborState');
            if (neighborOn === null) { state.textContent = 'No se pudo saber si está activado.'; switchBtn.style.display = 'none'; return; }
            state.textContent = neighborOn ? 'Activado: los vecinos ven el botón en su panel y en su QR.' : 'Apagado: los vecinos no ven el botón (los guardias sí lo tienen en Rondas).';
            state.style.color = neighborOn ? 'var(--success, #16a34a)' : 'var(--warning, #d97706)';
            switchBtn.textContent = neighborOn ? 'Apagar' : 'Activar';
            switchBtn.style.display = canSwitch ? '' : 'none';
        }
        async function loadSwitch() {
            try { const snap = await rondasRef.get(); neighborOn = !!(snap.exists && snap.data().neighbor_panic_enabled); } catch (e) { neighborOn = null; }
            paintSwitch();
        }
        switchBtn.addEventListener('click', async () => {
            if (!canSwitch || neighborOn === null) return;
            const next = !neighborOn;
            if (!confirm(next ? '¿Activar el botón de pánico para los vecinos?' : '¿Apagar el botón de pánico de los vecinos? Dejarán de verlo en su panel y su QR no enviará alertas.')) return;
            switchBtn.disabled = true;
            try {
                await rondasRef.set({ company_id: condoId, neighbor_panic_enabled: next ? 1 : 0, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }, { merge: true });
                neighborOn = next;
                S.showToast(next ? 'Botón de pánico de los vecinos activado.' : 'Botón de pánico de los vecinos apagado.', 'success');
            } catch (e) {
                console.error(e);
                S.showToast('No se pudo cambiar. Revise su conexión y sus privilegios.', 'error');
            }
            switchBtn.disabled = false;
            paintSwitch();
        });

        load();
        return { isDirty: () => dirty, reload: load };
    }

    return { mount };
})();
