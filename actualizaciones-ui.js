/* Actualizacion de datos de los vecinos, del lado de la administracion (admin.html; pedido del usuario el 2026-11-23).
 *
 * Los vecinos confirman o corrigen su lote, telefono, correo, NIT y DPI en su portal (vecino.html) y eso queda en una lista
 * (condominios/{c}/actualizaciones_datos) SIN tocar la base. Aqui la administracion ve esa lista, compara "en el sistema" contra
 * "lo que escribio el vecino" y APLICA con su propia clave (la verifica el servidor, confirmOwnCode, igual que la cuota del mes) o
 * RECHAZA con un motivo. Se aplica dato por dato (se puede dejar fuera lo que no convenza) y de una en una o varias a la vez con
 * una sola clave. Lo aplicado cambia usuarios (lote, telefono, correo) y la ficha de Finanzas (NIT, DPI, propietario, direccion)
 * con los privilegios de quien aplica; la solicitud queda como aplicada, con quien y cuando. Nada se borra.
 * Privilegio: usuarios.actualizaciones (lo exigen las reglas). La logica de datos esta en sisdel-actualizaciones.js.
 */
(function () {
    'use strict';

    const A = window.SisdelActualizaciones;
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const svg = (paths, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const ICON = {
        list: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>', 20),
        check: svg('<polyline points="20 6 9 17 4 12"/>'),
        x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
        print: svg('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
        warn: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>')
    };

    const STYLE = `
.act-bar { display:flex; flex-wrap:wrap; align-items:center; gap:.75rem 1rem; padding:1rem 1.25rem; margin-bottom:1.5rem; }
.act-bar .act-bar-text { flex:1; min-width:14rem; }
.act-bar strong { display:block; font-size:1rem; }
.act-bar .text-xs { margin:.15rem 0 0; }
.act-modal { max-width:980px; padding:1.5rem; }
.act-modal .form-input { padding-left:1rem; }
.act-tools { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0; }
.act-tools .form-input { width:auto; min-width:10rem; flex:1 1 12rem; }
.act-tools select.form-input { flex:0 0 auto; min-width:11rem; }
.act-count { color:var(--text-muted); font-size:.85rem; margin-left:auto; }
.act-card { border:1px solid var(--border-strong); border-radius:var(--radius-md); background:var(--bg-item); padding:1rem 1.1rem; margin-bottom:.9rem; }
.act-head { display:flex; align-items:flex-start; gap:.75rem; flex-wrap:wrap; }
.act-head input[type=checkbox] { width:1.15rem; height:1.15rem; margin-top:.2rem; accent-color:var(--primary); flex-shrink:0; }
.act-who { flex:1; min-width:11rem; }
.act-who strong { font-size:1.02rem; }
.act-who small { display:block; color:var(--text-muted); font-size:.8rem; margin-top:.15rem; }
.act-tag { font-size:.7rem; font-weight:700; padding:.18rem .55rem; border-radius:999px; white-space:nowrap; background:var(--bg-surface); border:1px solid var(--border-strong); color:var(--text-secondary); }
.act-tag.pendiente { color:var(--warning); border-color:var(--warning); background:var(--warning-bg); }
.act-tag.aplicada { color:var(--success); border-color:var(--success); background:rgba(16,185,129,.1); }
.act-tag.rechazada, .act-tag.cancelada { color:var(--danger); border-color:var(--danger); background:var(--danger-bg); }
.act-warn { display:flex; gap:.5rem; align-items:flex-start; margin:.7rem 0 0; padding:.5rem .7rem; border-radius:var(--radius-md); background:var(--warning-bg); color:var(--warning); font-size:.85rem; }
.act-warn svg { flex-shrink:0; margin-top:2px; }
.act-table { width:100%; border-collapse:collapse; margin-top:.8rem; font-size:.9rem; }
.act-table th { text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); padding:.35rem .5rem; border-bottom:1px solid var(--border-strong); }
.act-table td { padding:.5rem; border-bottom:1px solid var(--border-subtle); vertical-align:top; word-break:break-word; }
.act-table td.cur { color:var(--text-secondary); }
.act-table td.new { font-weight:700; color:var(--primary-light); }
.act-table td.empty { color:var(--text-muted); font-style:italic; font-weight:400; }
.act-table input[type=checkbox] { width:1.1rem; height:1.1rem; accent-color:var(--primary); }
.act-same { margin:.7rem 0 0; color:var(--text-secondary); font-size:.9rem; }
.act-actions { display:flex; flex-wrap:wrap; gap:.5rem; margin-top:.9rem; }
.act-actions .btn { padding:.5rem 1rem; font-size:.9rem; }
.act-modal .btn:disabled, .act-dialog .btn:disabled { opacity:.45; cursor:not-allowed; }
.act-done { margin:.7rem 0 0; font-size:.85rem; color:var(--text-secondary); }
.act-empty { text-align:center; color:var(--text-muted); padding:2rem 1rem; }
.act-dialog { max-width:440px; padding:1.5rem; }
.act-dialog .form-input { padding-left:1rem; }
.act-dialog p { margin:.25rem 0 1rem; color:var(--text-secondary); line-height:1.45; font-size:.92rem; }
.act-dialog .act-err { color:var(--danger); font-size:.85rem; min-height:1.2rem; margin:.4rem 0 0; }
`;
    function injectStyle() {
        if (document.getElementById('act-ui-style')) return;
        const el = document.createElement('style');
        el.id = 'act-ui-style';
        el.textContent = STYLE;
        document.head.appendChild(el);
    }
    const toast = (text, kind) => (window.SISDEL && SISDEL.showToast ? SISDEL.showToast(text, kind) : alert(text));
    const when = (iso) => { try { return SISDEL.formatDateTime(iso); } catch (e) { return String(iso || ''); } };

    function mount({ bar, condoId, session }) {
        injectStyle();
        const can = SISDEL.can('usuarios.actualizaciones');
        const reqCol = () => window.sisdelFirebase.db.collection('condominios').doc(condoId).collection('actualizaciones_datos');
        const state = { list: [], users: [], filter: 'pendiente', query: '', picks: new Set(), fields: new Map(), busy: false };
        let unsub = null;
        let modal = null;
        let dialog = null;
        const byId = (id) => state.list.find((r) => r.id === id);

        // ── La barra del panel: cuantas por revisar ──
        function paintBar() {
            if (!can || !bar) return;
            const pending = state.list.filter((r) => r.status === 'pendiente').length;
            bar.style.display = '';
            bar.innerHTML = `<div class="card act-bar">
  <div class="act-bar-text"><strong>Actualización de datos de los vecinos</strong>
    <p class="text-xs text-muted">${pending ? `<b style="color:var(--warning)">${pending}</b> ${pending === 1 ? 'vecino envió' : 'vecinos enviaron'} sus datos para revisar.` : 'No hay datos por revisar.'} Los vecinos confirman su lote, teléfono, NIT y DPI en su portal; usted los revisa y actualiza el sistema con su clave.</p></div>
  <button type="button" class="btn ${pending ? 'btn-primary' : 'btn-ghost'} btn-sm" id="actOpen" style="${pending ? '' : 'border:1px solid var(--border-strong);'}">${ICON.list} Abrir la lista${pending ? ` (${pending})` : ''}</button>
</div>`;
            bar.querySelector('#actOpen').addEventListener('click', open);
        }

        function listen() {
            if (unsub || !can) return;
            try {
                unsub = reqCol().orderBy('createdAt', 'desc').limit(600).onSnapshot((snap) => {
                    state.list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                    // Lo elegido que ya no esta pendiente se suelta
                    [...state.picks].forEach((id) => { const r = byId(id); if (!r || r.status !== 'pendiente') state.picks.delete(id); });
                    paintBar();
                    if (modal && modal.style.display !== 'none' && !state.busy) renderList();
                }, (error) => { console.warn('actualizaciones_datos', error); });
            } catch (e) { /* sin conexion */ }
        }

        // ── La lista ──
        function modalEl() {
            if (modal) return modal;
            modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.id = 'actModal';
            modal.style.display = 'none';
            modal.innerHTML = `
  <div class="modal act-modal" role="dialog" aria-modal="true" aria-labelledby="actTitle">
    <div class="modal-header"><h3 id="actTitle">Actualización de datos de los vecinos</h3>
      <button type="button" class="btn btn-ghost btn-icon modal-close" id="actClose" aria-label="Cerrar">&times;</button></div>
    <p class="text-xs text-muted" style="margin:.4rem 0 0; line-height:1.45;">Esto es lo que cada vecino escribió en su portal. No cambia el sistema hasta que usted lo aplica con su clave. Puede dejar fuera un dato quitándole la marca.</p>
    <div class="act-tools">
      <select class="form-input" id="actFilter" aria-label="Mostrar">
        <option value="pendiente">Por revisar</option><option value="aplicada">Aplicadas</option><option value="rechazada">Rechazadas</option><option value="todas">Todas</option>
      </select>
      <input class="form-input" id="actSearch" placeholder="Buscar por nombre o lote..." aria-label="Buscar">
      <span class="act-count" id="actCount"></span>
    </div>
    <div class="act-tools" id="actBulk"></div>
    <div id="actList"></div>
    <div class="act-tools" id="actExport" style="margin-top:1rem;"></div>
  </div>`;
            document.body.appendChild(modal);
            const close = () => { modal.style.display = 'none'; };
            modal.querySelector('#actClose').addEventListener('click', close);
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display !== 'none' && (!dialog || dialog.style.display === 'none')) close(); });
            modal.querySelector('#actFilter').addEventListener('change', (e) => { state.filter = e.target.value; renderList(); });
            modal.querySelector('#actSearch').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
            modal.addEventListener('click', onClick);
            modal.addEventListener('change', onChange);
            return modal;
        }

        const searchFields = (r) => [r.name, r.casa, A.summarize(r)];
        function visible() {
            let rows = state.list.filter((r) => state.filter === 'todas' || r.status === state.filter);
            if (state.query.trim()) rows = window.SisdelBusqueda ? SisdelBusqueda.filter(rows, state.query, searchFields) : rows.filter((r) => searchFields(r).join(' ').toLowerCase().includes(state.query.toLowerCase()));
            return rows;
        }
        const keysOf = (r) => state.fields.get(r.id) || new Set(r.changed || []);

        function cardHtml(r) {
            const pending = r.status === 'pendiente';
            const rows = A.changedRows(r);
            // Los avisos son para decidir: solo en las que siguen pendientes (en una ya aplicada, lo que cambio en el sistema es lo aplicado)
            const live = (state.users.find((u) => u.id === r.userId)) || null;
            const warns = pending ? A.warnings(r, state.users, live ? { casa: live.casa, phone: live.phone, email: live.email } : null) : [];
            const picked = keysOf(r);
            const table = rows.length ? `<table class="act-table"><thead><tr>${pending ? '<th style="width:2rem"></th>' : ''}<th>Dato</th><th>En el sistema</th><th>Escribió el vecino</th></tr></thead><tbody>${rows.map((row) => `<tr>
        ${pending ? `<td><input type="checkbox" data-field="${esc(r.id)}|${esc(row.key)}" ${picked.has(row.key) ? 'checked' : ''} aria-label="Aplicar ${esc(row.label)}"></td>` : ''}
        <td>${esc(row.label)}</td><td class="cur${row.current ? '' : ' empty'}">${row.current ? esc(row.current) : 'Sin dato'}</td><td class="new${row.proposed ? '' : ' empty'}">${row.proposed ? esc(row.proposed) : '(vacío)'}</td></tr>`).join('')}</tbody></table>`
                : '<p class="act-same">El vecino confirmó que sus datos están correctos (sin cambios).</p>';
            let done = '';
            if (r.status === 'aplicada' && r.review) done = `<p class="act-done">Aplicada el ${esc(when(r.review.at))} por ${esc(r.review.byName || '')}${(r.review.applied || []).length ? ` · ${esc(r.review.applied.map(A.labelOf).join(', '))}` : ''}.</p>`;
            if (r.status === 'rechazada' && r.review) done = `<p class="act-done">Rechazada el ${esc(when(r.review.at))} por ${esc(r.review.byName || '')}: ${esc(r.review.note || '')}</p>`;
            if (r.status === 'cancelada') done = '<p class="act-done">El vecino la canceló.</p>';
            return `<div class="act-card" data-card="${esc(r.id)}">
  <div class="act-head">
    ${pending ? `<input type="checkbox" data-pick="${esc(r.id)}" ${state.picks.has(r.id) ? 'checked' : ''} aria-label="Elegir a ${esc(r.name)}">` : ''}
    <div class="act-who"><strong>${esc(r.name || 'Sin nombre')}</strong><small>Lote o casa: ${esc(r.casa || '—')} · ${esc(when(r.createdAt))}${r.updatedAt ? ` · corregida ${esc(when(r.updatedAt))}` : ''}</small></div>
    <span class="act-tag">${esc(A.ORIGIN_LABEL[r.origin] || r.origin || '')}</span>
    <span class="act-tag ${esc(r.status)}">${esc(A.STATUS_LABEL[r.status] || r.status)}</span>
  </div>
  ${warns.map((w) => `<div class="act-warn">${ICON.warn}<span>${esc(w)}</span></div>`).join('')}
  ${table}${done}
  ${pending ? `<div class="act-actions"><button type="button" class="btn btn-primary" data-apply="${esc(r.id)}">${ICON.check} ${rows.length ? 'Aplicar' : 'Marcar como revisada'}</button><button type="button" class="btn btn-ghost" data-reject="${esc(r.id)}" style="border:1px solid var(--border-strong);">${ICON.x} Rechazar</button></div>` : ''}
</div>`;
        }

        function renderList() {
            if (!modal) return;
            const rows = visible();
            const pendingShown = rows.filter((r) => r.status === 'pendiente');
            modal.querySelector('#actFilter').value = state.filter;
            modal.querySelector('#actCount').textContent = `${rows.length} de ${state.list.length}`;
            modal.querySelector('#actList').innerHTML = rows.length ? rows.map(cardHtml).join('')
                : `<p class="act-empty">${state.list.length ? 'Nadie coincide con lo elegido.' : 'Todavía ningún vecino ha enviado sus datos. Aparecen aquí cuando entran a su portal y confirman sus datos.'}</p>`;
            const picks = state.picks.size;
            modal.querySelector('#actBulk').innerHTML = pendingShown.length ? `
      <button type="button" class="btn btn-ghost btn-sm" data-pickall="1" style="border:1px solid var(--border-strong);">Marcar las ${pendingShown.length} de la lista</button>
      <button type="button" class="btn btn-ghost btn-sm" data-pickall="0" style="border:1px solid var(--border-strong);">Quitar marcas</button>
      <button type="button" class="btn btn-primary btn-sm" data-applypicked="1" ${picks ? '' : 'disabled'}>${ICON.check} Aplicar las marcadas${picks ? ` (${picks})` : ''}</button>` : '';
            modal.querySelector('#actExport').innerHTML = rows.length ? `
      <span class="text-xs text-muted">Esta lista:</span>
      <button type="button" class="btn btn-ghost btn-sm" data-export="print" style="border:1px solid var(--border-strong);">${ICON.print} Imprimir</button>
      <button type="button" class="btn btn-ghost btn-sm" data-export="pdf" style="border:1px solid var(--border-strong);">Descargar PDF</button>
      <button type="button" class="btn btn-primary btn-sm" data-export="excel">Exportar a Excel</button>` : '';
        }

        // ── Clics y casillas ──
        function onChange(e) {
            const pick = e.target.closest && e.target.closest('[data-pick]');
            if (pick) { if (pick.checked) state.picks.add(pick.dataset.pick); else state.picks.delete(pick.dataset.pick); renderList(); return; }
            const field = e.target.closest && e.target.closest('[data-field]');
            if (field) {
                const [id, key] = field.dataset.field.split('|');
                const r = byId(id);
                if (!r) return;
                const set = new Set(keysOf(r));
                if (field.checked) set.add(key); else set.delete(key);
                state.fields.set(id, set);
            }
        }
        function onClick(e) {
            const t = e.target.closest && e.target.closest('button');
            if (!t) return;
            if (t.dataset.pickall !== undefined) {
                if (t.dataset.pickall === '1') visible().filter((r) => r.status === 'pendiente').forEach((r) => state.picks.add(r.id)); else state.picks.clear();
                renderList();
            } else if (t.dataset.apply) startApply([t.dataset.apply]);
            else if (t.dataset.applypicked) startApply([...state.picks]);
            else if (t.dataset.reject) startReject(t.dataset.reject);
            else if (t.dataset.export) exportList(t.dataset.export, t);
        }

        // ── Ventana pequena: la clave del administrador o el motivo de un rechazo ──
        function dialogEl() {
            if (dialog) return dialog;
            dialog = document.createElement('div');
            dialog.className = 'modal-overlay';
            dialog.id = 'actDialog';
            dialog.style.display = 'none';
            dialog.style.zIndex = '1100';
            document.body.appendChild(dialog);
            return dialog;
        }
        // Devuelve el texto escrito o null si se cancela. type: 'password' (la clave) o 'text' (el motivo)
        function ask({ title, text, label, type, button, validate }) {
            return new Promise((resolve) => {
                const el = dialogEl();
                el.innerHTML = `<div class="modal act-dialog" role="dialog" aria-modal="true" aria-labelledby="actDlgTitle">
  <div class="modal-header"><h3 id="actDlgTitle">${esc(title)}</h3><button type="button" class="btn btn-ghost btn-icon modal-close" data-cancel aria-label="Cerrar">&times;</button></div>
  <form novalidate autocomplete="off"><p>${esc(text)}</p>
    <div class="form-group"><label for="actDlgInput">${esc(label)}</label>${type === 'textarea' ? '<textarea class="form-input" id="actDlgInput" rows="3" maxlength="300"></textarea>' : `<input class="form-input" id="actDlgInput" type="${type}" autocomplete="off" ${type === 'password' ? 'name="sisdel-clave-admin" inputmode="text" autocapitalize="characters" spellcheck="false"' : ''}>`}<p class="act-err" id="actDlgErr"></p></div>
    <div style="display:flex; gap:.6rem;"><button type="button" class="btn btn-ghost" data-cancel style="flex:1; border:1px solid var(--border-strong);">Cancelar</button><button type="submit" class="btn btn-primary" style="flex:1;" id="actDlgOk">${esc(button)}</button></div></form></div>`;
                el.style.display = 'flex';
                const input = el.querySelector('#actDlgInput');
                input.focus();
                const finish = (value) => { el.style.display = 'none'; el.innerHTML = ''; resolve(value); };
                el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => finish(null)));
                el.querySelector('form').addEventListener('submit', async (ev) => {
                    ev.preventDefault();
                    const value = input.value;
                    const problem = validate ? await validate(value, el.querySelector('#actDlgOk')) : '';
                    if (problem) { el.querySelector('#actDlgErr').textContent = problem; input.focus(); return; }
                    finish(value);
                });
            });
        }
        // La clave del administrador: la verifica el servidor (solo dice si es la de quien tiene la sesion). Falla cerrado.
        async function confirmKey(count) {
            return ask({
                title: 'Su clave de administrador', type: 'password', label: 'Clave', button: 'Aplicar',
                text: `Escriba su propia clave de acceso para actualizar los datos de ${count} ${count === 1 ? 'vecino' : 'vecinos'}. Se verifica en el servidor y no se guarda.`,
                validate: async (value, okButton) => {
                    if (!String(value).trim()) return 'Escriba su clave.';
                    okButton.disabled = true;
                    try {
                        const result = await window.sisdelFirebase.functions.httpsCallable('confirmOwnCode')({ code: String(value).trim() });
                        return result.data && result.data.ok ? '' : 'Esa no es su clave.';
                    } catch (error) {
                        return String((error && error.message) || 'No se pudo comprobar la clave. Revise su conexión.').replace(/\s*\[\d{3}\]\s*$/, '');
                    } finally { okButton.disabled = false; }
                }
            });
        }

        // ── Aplicar ──
        async function applyOne(r) {
            const keys = [...keysOf(r)].filter((k) => (r.changed || []).includes(k));
            const plan = A.applyPlan(r, keys);
            if (Object.keys(plan.usuarios).length && !(await SISDEL.updateUser(r.userId, plan.usuarios))) throw new Error('No se pudo cambiar al vecino');
            if (Object.keys(plan.finanzas).length) {
                const ficha = await SISDEL.getFinanceResident(condoId, r.userId);
                if (!(await SISDEL.saveFinanceResident(condoId, r.userId, plan.finanzas, ficha))) throw new Error('No se pudo cambiar su ficha');
            }
            await reqCol().doc(r.id).update({ status: 'aplicada', review: { at: new Date().toISOString(), byId: session.userId, byName: session.userName || '', applied: plan.keys, note: '' } });
            return plan.keys.length;
        }
        async function startApply(ids) {
            const rows = ids.map(byId).filter((r) => r && r.status === 'pendiente');
            if (!rows.length) return;
            const noPick = rows.filter((r) => (r.changed || []).length && !keysOf(r).size);
            if (noPick.length) { toast(`Marque al menos un dato de ${noPick[0].name || 'cada vecino'}, o rechácela.`, 'warning'); return; }
            const key = await confirmKey(rows.length);
            if (key === null) return;
            state.busy = true;
            let okCount = 0;
            const failed = [];
            for (const r of rows) {
                try { await applyOne(r); okCount++; state.picks.delete(r.id); } catch (error) { console.error('aplicar', r.id, error); failed.push(r.name || r.id); }
            }
            state.busy = false;
            toast(failed.length ? `${okCount} aplicada(s). No se pudo con: ${failed.join(', ')}. Revise sus privilegios e intente de nuevo.` : `${okCount} ${okCount === 1 ? 'solicitud aplicada' : 'solicitudes aplicadas'}: el sistema ya tiene sus datos.`, failed.length ? 'warning' : 'success');
            state.users = await SISDEL.getUsers(condoId);
            renderList();
        }
        async function startReject(id) {
            const r = byId(id);
            if (!r || r.status !== 'pendiente') return;
            const note = await ask({
                title: 'Rechazar', type: 'textarea', label: 'Motivo (lo ve el vecino)', button: 'Rechazar',
                text: `${r.name || 'El vecino'} verá este motivo y podrá enviar sus datos de nuevo. No se cambia nada en el sistema.`,
                validate: (value) => (String(value).trim().length < 3 ? 'Escriba el motivo (3 letras o más).' : '')
            });
            if (note === null) return;
            try {
                await reqCol().doc(id).update({ status: 'rechazada', review: { at: new Date().toISOString(), byId: session.userId, byName: session.userName || '', applied: [], note: String(note).trim().slice(0, 300) } });
                toast('Solicitud rechazada.', 'warning');
            } catch (error) {
                console.error('rechazar', error);
                toast('No se pudo rechazar. Intente de nuevo.', 'danger');
            }
        }

        // ── Imprimir, PDF y Excel de la lista que se ve (un renglon por dato que cambia) ──
        function exportModel() {
            const rows = visible();
            const out = [];
            rows.forEach((r) => {
                const changes = A.changedRows(r);
                const base = [r.name || '', r.casa || '', when(r.createdAt), A.ORIGIN_LABEL[r.origin] || '', A.STATUS_LABEL[r.status] || r.status];
                if (!changes.length) out.push([...base, 'Confirmó sus datos', '', '']);
                else changes.forEach((c) => out.push([...base, c.label, c.current, c.proposed]));
            });
            const label = { pendiente: 'por revisar', aplicada: 'aplicadas', rechazada: 'rechazadas', todas: 'todas' }[state.filter];
            return {
                title: 'Actualización de datos de los vecinos',
                subtitle: `${session.condominioName || ''} · ${label} · ${rows.length} ${rows.length === 1 ? 'vecino' : 'vecinos'}`,
                kpis: [{ label: 'Vecinos en la lista', value: String(rows.length) }, { label: 'Por revisar', value: String(rows.filter((r) => r.status === 'pendiente').length) }],
                tables: [{ headers: ['Vecino', 'Lote', 'Enviado', 'Origen', 'Estado', 'Dato', 'En el sistema', 'Escribió el vecino'], rows: out }],
                fileName: 'actualizacion-datos-vecinos'
            };
        }
        async function exportList(kind, button) {
            const model = exportModel();
            const X = window.SisdelReportExport;
            try {
                if (kind === 'excel' && X) {
                    const blob = new Blob([X.buildXlsx(model)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = `${model.fileName}.xlsx`;
                    document.body.appendChild(link); link.click(); link.remove();
                    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
                } else if (kind === 'pdf' && X) {
                    button.disabled = true;
                    await X.ensurePdfLibs('');
                    X.makePdf(model).save(`${model.fileName}.pdf`);
                } else if (kind === 'print') {
                    // Una ventana nueva con la tabla (todo lo de la base se escapa)
                    const w = window.open('', '_blank', 'width=1000,height=700');
                    if (!w) { toast('Permita las ventanas emergentes para imprimir.', 'warning'); return; }
                    const t = model.tables[0];
                    w.document.write(`<!DOCTYPE html><html><head><title>${esc(model.title)}</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#1e293b}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#64748b;font-size:13px}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#f1f5f9;text-align:left;padding:6px 8px}td{padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}thead{display:table-header-group}tr{page-break-inside:avoid}@page{size:landscape}</style></head><body><h1>${esc(model.title)}</h1><p>${esc(model.subtitle)}</p><table><thead><tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`);
                    w.document.close();
                    w.focus();
                    setTimeout(() => w.print(), 400);
                }
            } catch (error) {
                console.error('exportar', error);
                toast('No se pudo generar el archivo. Intente de nuevo.', 'danger');
            } finally { if (button) button.disabled = false; }
        }

        async function open() {
            modalEl();
            modal.style.display = 'flex';
            try { state.users = await SISDEL.getUsers(condoId); } catch (e) { state.users = []; }
            renderList();
        }

        listen();
        return { open, count: () => state.list.filter((r) => r.status === 'pendiente').length };
    }

    window.SisdelActualizacionesUI = { mount };
})();
