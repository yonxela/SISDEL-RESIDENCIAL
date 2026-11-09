/* ═══════════════════════════════════════════════════════════════
   SISDEL - Pantalla de privilegios por usuario (admin.html)
   ───────────────────────────────────────────────────────────────
   Adaptada del editor visual de privilegios de MULTISYS: tarjetas por modulo con
   las acciones que el administrador del condominio activa o quita a cada usuario,
   plantillas reutilizables y cambios sin guardar resaltados.

   - renderMatrix(): las tarjetas (tambien se usa dentro del formulario de usuario nuevo).
   - openEditor(): ventana para cambiar los privilegios de un usuario existente.
   - templateChoices(): plantillas del sistema + las propias del condominio.

   Requiere privilegios.js, sisdel-core.js y styles.css.
   ═══════════════════════════════════════════════════════════════ */

const SisdelPrivilegiosUI = (() => {
    const PRIV = window.SisdelPrivilegios;

    const ICONS = {
        on: '<svg class="pv-ico pv-ico-on" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
        off: '<svg class="pv-ico pv-ico-off" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>',
        search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    };

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function injectStyles() {
        if (document.getElementById('pvStyles')) return;
        const style = document.createElement('style');
        style.id = 'pvStyles';
        style.textContent = `
        .pv-bar { display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; margin-bottom:1rem; }
        .pv-bar select, .pv-bar input[type=search] { background:var(--input-bg); border:1px solid var(--border-strong); color:var(--text-primary); border-radius:var(--radius-md); padding:0.55rem 0.8rem; font-size:0.85rem; }
        .pv-bar input[type=search] { flex:1; min-width:160px; }
        .pv-btn { display:inline-flex; align-items:center; gap:0.4rem; padding:0.5rem 0.9rem; border-radius:var(--radius-md); border:1px solid var(--border-strong); background:transparent; color:var(--text-secondary); font-size:0.8rem; font-weight:600; cursor:pointer; }
        .pv-btn:hover:not(:disabled) { border-color:var(--primary); color:var(--text-primary); }
        .pv-btn:disabled { opacity:0.45; cursor:not-allowed; }
        .pv-btn.primary { background:var(--primary); border-color:var(--primary); color:#fff; }
        .pv-btn.primary:hover:not(:disabled) { background:var(--primary-hover); }
        .pv-btn.danger { color:var(--danger); }
        .pv-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(290px, 1fr)); gap:0.9rem; }
        .pv-card { background:var(--bg-surface-solid); border:1px solid var(--border-strong); border-radius:var(--radius-lg); overflow:hidden; }
        .pv-card-head { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; padding:0.7rem 0.9rem; background:var(--info-bg); border-bottom:1px solid var(--border-strong); }
        .pv-card-head strong { font-size:0.78rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-primary); }
        .pv-count { font-size:0.7rem; font-weight:700; color:var(--info); background:var(--info-bg); padding:0.15rem 0.55rem; border-radius:var(--radius-full); }
        .pv-all { font-size:0.68rem; font-weight:700; color:var(--primary-light); background:transparent; border:1px solid var(--primary); border-radius:var(--radius-sm); padding:0.15rem 0.5rem; cursor:pointer; }
        .pv-all:disabled { opacity:0.4; cursor:not-allowed; }
        .pv-rows { padding:0.35rem; display:flex; flex-direction:column; gap:2px; }
        .pv-row { display:flex; align-items:flex-start; gap:0.6rem; padding:0.55rem 0.6rem; border-radius:var(--radius-md); border:1px solid transparent; background:transparent; color:var(--text-primary); text-align:left; cursor:pointer; width:100%; font:inherit; }
        .pv-row:hover:not(:disabled) { background:var(--bg-item); }
        .pv-row:disabled { cursor:default; }
        .pv-row.is-on { background:var(--success-bg); }
        .pv-row.is-added { border-color:var(--primary); }
        .pv-row.is-removed { border-color:var(--warning); }
        .pv-ico { flex-shrink:0; margin-top:1px; }
        .pv-ico-on { color:var(--success); }
        .pv-ico-off { color:var(--text-muted); opacity:0.6; }
        .pv-label { font-size:0.88rem; font-weight:600; line-height:1.25; display:flex; gap:0.4rem; align-items:center; flex-wrap:wrap; }
        .pv-desc { display:block; font-size:0.74rem; color:var(--text-muted); margin-top:0.15rem; line-height:1.35; }
        .pv-tag { font-size:0.62rem; font-weight:700; letter-spacing:0.03em; text-transform:uppercase; padding:0.1rem 0.4rem; border-radius:var(--radius-sm); }
        .pv-tag.sens { background:var(--warning-bg); color:var(--warning); }
        .pv-tag.added { background:var(--info-bg); color:var(--info); }
        .pv-tag.removed { background:var(--warning-bg); color:var(--warning); }
        .pv-modal { max-width:1000px !important; width:calc(100% - 2rem); max-height:92vh; padding:0 !important; display:flex; flex-direction:column; overflow:hidden; }
        .pv-modal-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1.1rem 1.4rem; border-bottom:1px solid var(--border-strong); }
        .pv-modal-head h3 { margin:0; font-size:1.1rem; }
        .pv-modal-body { padding:1.2rem 1.4rem; overflow-y:auto; flex:1; }
        .pv-modal-foot { display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; padding:0.9rem 1.4rem; border-top:1px solid var(--border-strong); background:var(--bg-surface-solid); }
        .pv-modal-foot .grow { flex:1; min-width:180px; font-size:0.82rem; color:var(--text-muted); }
        .pv-modal-foot .dirty { color:var(--warning); font-weight:700; }
        .pv-note { font-size:0.8rem; color:var(--text-secondary); background:var(--info-bg); border:1px solid var(--border-strong); border-radius:var(--radius-md); padding:0.6rem 0.8rem; margin-bottom:0.9rem; }
        .pv-note.warn { background:var(--warning-bg); color:var(--text-primary); }
        .pv-page { display:grid; grid-template-columns:280px 1fr; gap:1rem; align-items:start; }
        .pv-side { background:var(--bg-surface-solid); border:1px solid var(--border-strong); border-radius:var(--radius-lg); overflow:hidden; display:flex; flex-direction:column; max-height:calc(100vh - 230px); position:sticky; top:0.5rem; }
        .pv-side-search { display:flex; align-items:center; gap:0.5rem; padding:0.65rem 0.8rem; border-bottom:1px solid var(--border-strong); color:var(--text-muted); }
        .pv-side-search input { flex:1; background:transparent; border:none; outline:none; color:var(--text-primary); font-size:0.85rem; min-width:0; }
        .pv-side-count { padding:0.45rem 0.9rem; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); background:var(--info-bg); }
        .pv-userlist { overflow-y:auto; padding:0.3rem; flex:1; }
        .pv-user { display:flex; align-items:center; gap:0.5rem; width:100%; text-align:left; padding:0.6rem 0.7rem; margin:2px 0; border-radius:var(--radius-md); border:1px solid transparent; background:transparent; color:var(--text-primary); cursor:pointer; font:inherit; }
        .pv-user:hover { background:var(--bg-item); }
        .pv-user.is-active { background:var(--info-bg); border-color:var(--primary); }
        .pv-user.is-off { opacity:0.55; }
        .pv-user strong { display:block; font-size:0.85rem; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .pv-user small { display:block; font-size:0.7rem; color:var(--text-muted); margin-top:1px; }
        .pv-user-count { font-size:0.68rem; font-weight:800; color:var(--info); background:var(--info-bg); padding:0.1rem 0.5rem; border-radius:var(--radius-full); flex-shrink:0; }
        .pv-user-count.custom { color:var(--warning); background:var(--warning-bg); }
        .pv-main { min-width:0; }
        .pv-userhead { margin-bottom:0.8rem; }
        .pv-userhead h3 { margin:0; font-size:1.15rem; }
        .pv-userhead small { color:var(--text-muted); font-size:0.8rem; }
        .pv-empty { background:var(--bg-surface-solid); border:1px dashed var(--border-strong); border-radius:var(--radius-lg); padding:3rem 1.5rem; text-align:center; color:var(--text-muted); }
        .pv-empty svg { color:var(--primary-light); margin-bottom:0.5rem; width:44px; height:44px; }
        .pv-empty h3 { margin:0.3rem 0; color:var(--text-primary); }
        .pv-foot { position:sticky; bottom:0; display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; padding:0.8rem 1rem; margin-top:1rem; background:var(--bg-surface-solid); border:1px solid var(--border-strong); border-radius:var(--radius-lg); z-index:2; }
        .pv-foot .grow { flex:1; min-width:180px; font-size:0.82rem; color:var(--text-muted); }
        .pv-foot .dirty { color:var(--warning); font-weight:700; }
        .pv-fields { display:grid; grid-template-columns:1fr 1fr; gap:0.8rem; margin-bottom:1rem; }
        .pv-fields label { display:flex; flex-direction:column; gap:0.3rem; font-size:0.78rem; font-weight:600; color:var(--text-secondary); }
        .pv-fields .wide { grid-column:1 / -1; }
        .pv-input { background:var(--input-bg); border:1px solid var(--border-strong); color:var(--text-primary); border-radius:var(--radius-md); padding:0.6rem 0.8rem; font-size:0.9rem; width:100%; font-family:inherit; }
        .pv-input:disabled { opacity:0.75; }
        @media (max-width: 800px) { .pv-page { grid-template-columns:1fr; } .pv-side { position:static; max-height:260px; } .pv-fields { grid-template-columns:1fr; } }
        @media (max-width: 640px) { .pv-cards { grid-template-columns:1fr; } .pv-modal { max-height:96vh; } }
        `;
        document.head.appendChild(style);
    }

    // Plantillas disponibles: las del sistema y las propias del condominio (campo `claves`)
    function templateChoices(custom) {
        const own = (custom || []).map((t) => ({ ...t, custom: true }));
        return [...PRIV.TEMPLATES.map((t) => ({ ...t, custom: false })), ...own];
    }

    function templateOptions(choices, selected) {
        const group = (label, list) => list.length
            ? `<optgroup label="${label}">${list.map((t) => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>`
            : '';
        return '<option value="">Elegir plantilla…</option>'
            + group('Del sistema', choices.filter((t) => !t.custom))
            + group('Del condominio', choices.filter((t) => t.custom));
    }

    // ── Tarjetas por modulo ──
    // opts: { role, set (Set de claves activas), onChange(set, cascade), disabled, search, marks (false: sin etiquetas Agregado/Quitado) }
    function renderMatrix(container, opts) {
        injectStyles();
        const defaults = PRIV.defaultsOf(opts.role);
        const filter = String(opts.search || '').trim().toLowerCase();

        const groups = PRIV.GROUPS.map((g) => ({
            ...g,
            items: g.items.filter((i) => !filter || (i.label + ' ' + i.description + ' ' + g.title).toLowerCase().includes(filter))
        })).filter((g) => g.items.length);

        container.innerHTML = groups.length
            ? `<div class="pv-cards">${groups.map((g) => {
                const full = PRIV.GROUPS.find((x) => x.id === g.id);
                // Los privilegios que su rol no puede tener (onlyRoles) no cuentan ni se activan
                const usable = full.items.filter((i) => PRIV.allowedFor(i.key, opts.role));
                const active = usable.filter((i) => opts.set.has(i.key)).length;
                const allOn = active === usable.length;
                return `<section class="pv-card">
                    <div class="pv-card-head">
                        <strong>${esc(g.title)}</strong>
                        <span style="display:flex; gap:0.4rem; align-items:center;">
                            <span class="pv-count">${active} / ${usable.length}</span>
                            ${opts.disabled || !usable.length ? '' : `<button type="button" class="pv-all" data-group="${g.id}" data-on="${allOn ? '0' : '1'}">${allOn ? 'Quitar todo' : 'Marcar todo'}</button>`}
                        </span>
                    </div>
                    <div class="pv-rows">${g.items.map((i) => {
                        const locked = !PRIV.allowedFor(i.key, opts.role);
                        const on = !locked && opts.set.has(i.key);
                        const inRole = defaults[i.key] === true;
                        const marks = opts.marks !== false;
                        const state = marks && on && !inRole ? ' is-added' : (marks && !on && inRole ? ' is-removed' : '');
                        const tag = marks && on && !inRole ? '<span class="pv-tag added">Agregado</span>' : (marks && !on && inRole ? '<span class="pv-tag removed">Quitado</span>' : '');
                        const lockTag = locked ? '<span class="pv-tag removed">Solo administradores y operadores</span>' : '';
                        return `<button type="button" class="pv-row${on ? ' is-on' : ''}${state}" data-key="${i.key}" ${opts.disabled || locked ? 'disabled' : ''} aria-pressed="${on}">
                            ${on ? ICONS.on : ICONS.off}
                            <span style="flex:1; min-width:0;">
                                <span class="pv-label">${esc(i.label)}${i.sensitive ? '<span class="pv-tag sens">Sensible</span>' : ''}${tag}${lockTag}</span>
                                <span class="pv-desc">${esc(i.description)}</span>
                            </span>
                        </button>`;
                    }).join('')}</div>
                </section>`;
            }).join('')}</div>`
            : '<p class="text-center text-muted" style="padding:1.5rem;">Ningún privilegio coincide con la búsqueda.</p>';

        container.querySelectorAll('.pv-row').forEach((button) => {
            button.addEventListener('click', () => {
                const key = button.dataset.key;
                const turnOn = !opts.set.has(key);
                const cascade = PRIV.cascade(opts.set, key, turnOn);
                PRIV.toggle(opts.set, key, turnOn);
                opts.onChange(opts.set, { key, on: turnOn, cascade });
            });
        });
        container.querySelectorAll('.pv-all').forEach((button) => {
            button.addEventListener('click', () => {
                const turnOn = button.dataset.on === '1';
                PRIV.GROUPS.find((g) => g.id === button.dataset.group).items
                    .filter((i) => PRIV.allowedFor(i.key, opts.role))
                    .forEach((i) => PRIV.toggle(opts.set, i.key, turnOn));
                opts.onChange(opts.set, { group: button.dataset.group, on: turnOn, cascade: [] });
            });
        });
    }

    function cascadeNote(change) {
        if (!change || !change.cascade || !change.cascade.length) return '';
        const names = change.cascade.map((k) => (PRIV.itemOf(k) || { label: k }).label).join(', ');
        return change.on ? `Se activó también lo que necesita: ${names}.` : `Se quitó también lo que depende de ello: ${names}.`;
    }

    // ── Editor de privilegios de un usuario, dentro de cualquier contenedor ──
    // Se usa en la pestana Privilegios de Configuracion (en linea) y en la ventana del escudo de cada usuario.
    // user: { id, name, role, cargo, privilegios }
    // options: { condominioId, templates (propias del condominio), isSelf, readOnly, onSaved(), onDirty(boolean) }
    // Devuelve { isDirty(), destroy() }
    function mountEditor(container, user, options = {}) {
        injectStyles();
        const role = user.role;
        const effective = PRIV.effective(role, user.privilegios);
        const original = new Set(PRIV.KEYS.filter((k) => effective[k]));
        const set = new Set(original);
        let templates = options.templates || [];
        let search = '';
        const readOnly = !!options.isSelf || !!options.readOnly || !SISDEL.can('usuarios.privilegios');

        const root = document.createElement('div');
        root.className = 'pv-editor';
        root.innerHTML = `
            <div class="pv-note ${readOnly ? 'warn' : ''}" data-ref="intro"></div>
            <div class="pv-bar" data-ref="bar"></div>
            <div data-ref="matrix"></div>
            <div class="pv-foot">
                <span class="grow" data-ref="status"></span>
                ${readOnly ? '' : `<button type="button" class="pv-btn" data-act="discard">Descartar</button>
                <button type="button" class="pv-btn primary" data-act="save">Guardar privilegios</button>`}
            </div>`;
        container.innerHTML = '';
        container.appendChild(root);

        const ref = (name) => root.querySelector(`[data-ref=${name}]`);
        const matrix = ref('matrix');
        const status = ref('status');
        const bar = ref('bar');
        const saveButton = root.querySelector('[data-act=save]');
        const discardButton = root.querySelector('[data-act=discard]');

        ref('intro').textContent = options.isSelf
            ? 'Estos son sus propios privilegios. Nadie puede cambiarse los suyos: pídaselo a otro administrador.'
            : readOnly
                ? 'Usted puede ver los privilegios, pero no cambiarlos.'
                : 'Marque lo que este usuario puede ver o usar. Lo que se marca de más o se quita respecto a su rol aparece resaltado. Los cambios se aplican apenas se guardan.';

        function diffCount() {
            let n = 0;
            PRIV.KEYS.forEach((k) => { if (set.has(k) !== original.has(k)) n++; });
            return n;
        }

        function refreshStatus(note) {
            const n = diffCount();
            status.innerHTML = `${set.size} de ${PRIV.KEYS.length} activos${n ? ` · <span class="dirty">${n} cambio${n === 1 ? '' : 's'} sin guardar</span>` : ''}${note ? ' · ' + esc(note) : ''}`;
            if (saveButton) saveButton.disabled = n === 0;
            if (discardButton) discardButton.disabled = n === 0;
            if (options.onDirty) options.onDirty(n > 0);
        }

        function draw(note) {
            renderMatrix(matrix, { role, set, disabled: readOnly, search, onChange: (_s, change) => { draw(cascadeNote(change)); } });
            refreshStatus(note);
        }

        function drawBar() {
            const choices = templateChoices(templates);
            bar.innerHTML = `
                <input type="search" data-ref="search" placeholder="Buscar privilegio…" aria-label="Buscar privilegio" value="${esc(search)}">
                ${readOnly ? '' : `
                <select data-ref="template" aria-label="Plantilla">${templateOptions(choices, '')}</select>
                <button type="button" class="pv-btn" data-act="all">Marcar todos</button>
                <button type="button" class="pv-btn" data-act="none">Limpiar</button>
                <button type="button" class="pv-btn" data-act="role" title="Dejar exactamente los privilegios que trae su rol">Valores del rol</button>
                <button type="button" class="pv-btn" data-act="saveTemplate" title="Guardar los privilegios marcados como plantilla del condominio">Guardar como plantilla</button>
                <button type="button" class="pv-btn danger" data-act="delTemplate" style="display:none;">Eliminar plantilla</button>`}`;
            bar.querySelector('[data-ref=search]').addEventListener('input', (e) => { search = e.target.value; draw(); });
        }

        root.addEventListener('click', async (event) => {
            const act = event.target.closest('[data-act]');
            if (!act || !root.contains(act)) return;
            const kind = act.dataset.act;
            if (kind === 'role') {
                set.clear(); Object.keys(PRIV.defaultsOf(role)).forEach((k) => set.add(k));
                draw('Se dejaron los privilegios del rol');
            } else if (kind === 'all') {
                PRIV.KEYS.filter((k) => PRIV.allowedFor(k, role)).forEach((k) => set.add(k));
                draw();
            } else if (kind === 'none') {
                set.clear(); draw();
            } else if (kind === 'discard') {
                set.clear(); original.forEach((k) => set.add(k));
                draw('Se descartaron los cambios');
            } else if (kind === 'saveTemplate') {
                const name = (prompt('Nombre de la plantilla (por ejemplo: Secretaria de turno noche):') || '').trim();
                if (!name) return;
                const id = await SISDEL.savePrivilegeTemplate(options.condominioId, { name, role, claves: [...set], description: '' });
                if (id) {
                    templates = await SISDEL.getPrivilegeTemplates(options.condominioId);
                    SISDEL.showToast(`Plantilla "${name}" guardada`, 'success');
                    drawBar();
                    if (options.onTemplatesChanged) options.onTemplatesChanged(templates);
                }
            } else if (kind === 'delTemplate') {
                const picked = templates.find((t) => t.id === bar.querySelector('[data-ref=template]').value);
                if (picked && confirm(`¿Eliminar la plantilla "${picked.name}"? Los usuarios que la usaron conservan sus privilegios.`)) {
                    if (await SISDEL.deletePrivilegeTemplate(options.condominioId, picked.id)) {
                        templates = await SISDEL.getPrivilegeTemplates(options.condominioId);
                        drawBar();
                        if (options.onTemplatesChanged) options.onTemplatesChanged(templates);
                    }
                }
            } else if (kind === 'save') {
                saveButton.disabled = true;
                saveButton.textContent = 'Guardando…';
                const ok = await SISDEL.setUserAccess(user.id, { privilegios: PRIV.toOverrides(role, [...set]) });
                saveButton.textContent = 'Guardar privilegios';
                if (ok) {
                    SISDEL.showToast(`Privilegios de ${user.name} actualizados`, 'success');
                    original.clear(); set.forEach((k) => original.add(k));
                    refreshStatus();
                    if (options.onSaved) options.onSaved();
                } else {
                    SISDEL.showToast('No se pudieron guardar los privilegios', 'error');
                    refreshStatus();
                }
            }
        });

        root.addEventListener('change', (event) => {
            if (event.target.dataset.ref !== 'template') return;
            const tpl = templateChoices(templates).find((t) => t.id === event.target.value);
            bar.querySelector('[data-act=delTemplate]').style.display = tpl && tpl.custom ? '' : 'none';
            if (!tpl) return;
            set.clear();
            (tpl.claves || []).filter((k) => PRIV.allowedFor(k, role)).forEach((k) => set.add(k));
            draw(`Plantilla "${tpl.name}" aplicada; falta guardar`);
        });

        drawBar();
        draw();
        return { isDirty: () => diffCount() > 0, destroy: () => root.remove() };
    }

    // ── Ventana con el editor (escudo de cada usuario) ──
    function openEditor(user, options = {}) {
        injectStyles();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal pv-modal" role="dialog" aria-modal="true">
                <div class="pv-modal-head">
                    <div>
                        <h3>Privilegios de ${esc(user.name)}</h3>
                        <div class="text-xs text-muted">${esc(SISDEL.getRoleName(user.role))}${user.cargo ? ' · ' + esc(user.cargo) : ''}</div>
                    </div>
                    <button type="button" class="btn btn-ghost btn-icon" data-act="close" aria-label="Cerrar">&times;</button>
                </div>
                <div class="pv-modal-body" data-ref="body"></div>
            </div>`;
        document.body.appendChild(overlay);
        const editor = mountEditor(overlay.querySelector('[data-ref=body]'), user, {
            ...options,
            onSaved: () => { overlay.remove(); if (options.onSaved) options.onSaved(); }
        });
        overlay.addEventListener('click', (event) => {
            if (event.target !== overlay && !event.target.closest('.pv-modal-head [data-act=close]')) return;
            if (editor.isDirty() && !confirm('Hay cambios sin guardar. ¿Cerrar de todos modos?')) return;
            overlay.remove();
        });
    }

    // ── Pestana Privilegios: usuarios a la izquierda, tarjetas por modulo a la derecha ──
    // options: { condominioId, users, templates (propias), currentUserId, readOnly, onSaved(), onTemplatesChanged(lista) }
    // Devuelve { setUsers(lista), setTemplates(lista), select(id), isDirty() }
    function mountPrivilegesTab(container, options = {}) {
        injectStyles();
        let users = options.users || [];
        let templates = options.templates || [];
        let selectedId = null;
        let query = '';
        let editor = null;

        container.innerHTML = `
            <div class="pv-page">
                <aside class="pv-side">
                    <div class="pv-side-search">${ICONS.search}<input type="search" placeholder="Buscar usuario…" aria-label="Buscar usuario"></div>
                    <div class="pv-side-count" data-ref="count"></div>
                    <div class="pv-userlist" data-ref="list"></div>
                </aside>
                <section class="pv-main" data-ref="main"></section>
            </div>`;
        const list = container.querySelector('[data-ref=list]');
        const main = container.querySelector('[data-ref=main]');
        const count = container.querySelector('[data-ref=count]');

        const activeCount = (u) => { const e = PRIV.effective(u.role, u.privilegios); return PRIV.KEYS.filter((k) => e[k]).length; };
        const custom = (u) => Object.keys(PRIV.cleanOverrides(u.privilegios)).length > 0;

        function visibleUsers() {
            const q = query.trim().toLowerCase();
            return users
                .filter((u) => !q || `${u.name} ${u.cargo || ''} ${u.casa || ''} ${SISDEL.getRoleName(u.role)}`.toLowerCase().includes(q))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        }

        function drawList() {
            const shown = visibleUsers();
            count.textContent = `${shown.length} usuario${shown.length === 1 ? '' : 's'}`;
            list.innerHTML = shown.length ? shown.map((u) => `
                <button type="button" class="pv-user${u.id === selectedId ? ' is-active' : ''}${u.active === false ? ' is-off' : ''}" data-id="${esc(u.id)}">
                    <span style="flex:1; min-width:0;">
                        <strong>${esc(u.name)}</strong>
                        <small>${esc(SISDEL.getRoleName(u.role))}${u.cargo ? ' · ' + esc(u.cargo) : ''}${u.active === false ? ' · inactivo' : ''}</small>
                    </span>
                    <span class="pv-user-count${custom(u) ? ' custom' : ''}" title="${custom(u) ? 'Privilegios distintos a los de su rol' : 'Privilegios de su rol'}">${activeCount(u)}</span>
                </button>`).join('') : '<p class="text-center text-muted text-xs" style="padding:1rem;">Sin coincidencias.</p>';
        }

        function mountMain() {
            const user = users.find((u) => u.id === selectedId);
            if (editor) { editor.destroy(); editor = null; }
            if (!user) {
                main.innerHTML = `<div class="pv-empty">${ICONS.shield}<h3>Elija un usuario</h3><p>Seleccione una persona de la lista para ver y cambiar lo que puede ver o usar.</p></div>`;
                return;
            }
            main.innerHTML = `
                <div class="pv-userhead">
                    <h3>${esc(user.name)}</h3>
                    <small>${esc(SISDEL.getRoleName(user.role))}${user.cargo ? ' · ' + esc(user.cargo) : ''}${user.active === false ? ' · inactivo' : ''}</small>
                </div>
                <div data-ref="ed"></div>`;
            editor = mountEditor(main.querySelector('[data-ref=ed]'), user, {
                condominioId: options.condominioId, templates,
                isSelf: user.id === options.currentUserId, readOnly: !!options.readOnly,
                onSaved: () => { if (options.onSaved) options.onSaved(); },
                onTemplatesChanged: (list) => { templates = list; if (options.onTemplatesChanged) options.onTemplatesChanged(list); }
            });
        }

        function select(id) {
            if (id === selectedId) return;
            if (editor && editor.isDirty() && !confirm('Hay cambios sin guardar en este usuario. ¿Descartarlos?')) return;
            selectedId = id;
            drawList();
            mountMain();
        }

        list.addEventListener('click', (event) => {
            const button = event.target.closest('.pv-user');
            if (button) select(button.dataset.id);
        });
        container.querySelector('.pv-side-search input').addEventListener('input', (event) => { query = event.target.value; drawList(); });

        // Como en MULTISYS: si hay usuarios, ya viene uno elegido
        if (users.length) selectedId = visibleUsers()[0].id;
        drawList();
        mountMain();

        return {
            // Lista nueva (despues de guardar o de crear un usuario). Si hay cambios sin guardar solo se refresca la lista.
            setUsers(next) {
                users = next || [];
                if (!users.some((u) => u.id === selectedId)) selectedId = null;
                if (!selectedId && users.length) selectedId = visibleUsers()[0] ? visibleUsers()[0].id : users[0].id;
                drawList();
                if (!editor || !editor.isDirty()) mountMain();
            },
            setTemplates(next) { templates = next || []; },
            select,
            isDirty: () => !!(editor && editor.isDirty())
        };
    }

    // ── Pestana Plantillas: las del sistema (solo lectura) y las del condominio (crear, editar, borrar) ──
    // options: { condominioId, templates (propias), canManage, onChanged(lista) }
    // Devuelve { setTemplates(lista), isDirty() }
    function mountTemplatesTab(container, options = {}) {
        injectStyles();
        const canManage = !!options.canManage;
        let own = options.templates || [];
        let selectedId = null; // id de plantilla o 'new'
        let dirty = () => false;

        container.innerHTML = `
            <div class="pv-page">
                <aside class="pv-side">
                    <div class="pv-userlist" data-ref="list"></div>
                    ${canManage ? '<div style="padding:0.6rem;"><button type="button" class="pv-btn primary" data-act="new" style="width:100%; justify-content:center;">Nueva plantilla</button></div>' : ''}
                </aside>
                <section class="pv-main" data-ref="main"></section>
            </div>`;
        const list = container.querySelector('[data-ref=list]');
        const main = container.querySelector('[data-ref=main]');

        const row = (t, system) => `
            <button type="button" class="pv-user${t.id === selectedId ? ' is-active' : ''}" data-id="${esc(t.id)}">
                <span style="flex:1; min-width:0;">
                    <strong>${esc(t.name)}</strong>
                    <small>${esc(PRIV.ROLE_LABELS[t.role] || t.role)} · ${(t.claves || []).length} privilegios</small>
                </span>
            </button>`;

        function drawList() {
            list.innerHTML = `
                <div class="pv-side-count">Del sistema (solo lectura)</div>
                ${PRIV.TEMPLATES.map((t) => row(t, true)).join('')}
                <div class="pv-side-count">Del condominio</div>
                ${canManage
                    ? (own.length ? own.map((t) => row(t, false)).join('') : '<p class="text-muted text-xs" style="padding:0.6rem 0.9rem;">Aún no hay plantillas propias.</p>')
                    : '<p class="text-muted text-xs" style="padding:0.6rem 0.9rem;">Las plantillas del condominio las ve quien puede asignar privilegios.</p>'}`;
        }

        function find(id) {
            const system = PRIV.TEMPLATES.find((t) => t.id === id);
            if (system) return { ...system, system: true };
            const mine = own.find((t) => t.id === id);
            return mine ? { ...mine, system: false } : null;
        }

        function mountForm(tpl) {
            const readOnly = tpl.system || !canManage;
            const form = { name: tpl.name || '', role: PRIV.ROLES.includes(tpl.role) ? tpl.role : 'operador', description: tpl.description || '' };
            const set = new Set((tpl.claves || []).filter((k) => PRIV.itemOf(k) && PRIV.allowedFor(k, form.role)));
            const snap = () => JSON.stringify([form.name, form.role, form.description, [...set].sort()]);
            const baseline = snap();
            dirty = () => !readOnly && snap() !== baseline;
            let search = '';

            main.innerHTML = `
                <div class="pv-form">
                    <div class="pv-note ${readOnly ? 'warn' : ''}">${tpl.system
                        ? 'Plantilla del sistema: solo se puede ver. Use "Duplicar" para crear una propia a partir de ella.'
                        : (readOnly ? 'Usted puede ver las plantillas, pero no cambiarlas.' : 'Una plantilla es un conjunto completo de privilegios que se aplica al crear un usuario o desde el editor de privilegios.')}</div>
                    <div class="pv-fields">
                        <label>Nombre<input class="pv-input" data-f="name" maxlength="60" ${readOnly ? 'disabled' : ''} value="${esc(form.name)}" placeholder="Ej. Secretaria de turno noche"></label>
                        <label>Rol sugerido<select class="pv-input" data-f="role" ${readOnly ? 'disabled' : ''}>${PRIV.ROLES.map((r) => `<option value="${r}" ${r === form.role ? 'selected' : ''}>${esc(PRIV.ROLE_LABELS[r])}</option>`).join('')}</select></label>
                        <label class="wide">Descripción<input class="pv-input" data-f="description" maxlength="200" ${readOnly ? 'disabled' : ''} value="${esc(form.description)}" placeholder="Para qué sirve esta plantilla"></label>
                    </div>
                    <div class="pv-bar">
                        <input type="search" data-ref="search" placeholder="Buscar privilegio…" aria-label="Buscar privilegio">
                        ${readOnly ? '' : '<button type="button" class="pv-btn" data-act="all">Marcar todos</button><button type="button" class="pv-btn" data-act="none">Limpiar</button>'}
                    </div>
                    <div data-ref="matrix"></div>
                    <div class="pv-foot">
                        <span class="grow" data-ref="status"></span>
                        ${tpl.system && canManage ? '<button type="button" class="pv-btn" data-act="duplicate">Duplicar como plantilla propia</button>' : ''}
                        ${!readOnly && tpl.id ? '<button type="button" class="pv-btn danger" data-act="delete">Eliminar</button>' : ''}
                        ${readOnly ? '' : '<button type="button" class="pv-btn" data-act="discard">Descartar</button><button type="button" class="pv-btn primary" data-act="save">Guardar plantilla</button>'}
                    </div>
                </div>`;
            const root = main.querySelector('.pv-form');
            const matrix = root.querySelector('[data-ref=matrix]');
            const status = root.querySelector('[data-ref=status]');
            const saveButton = root.querySelector('[data-act=save]');
            const discardButton = root.querySelector('[data-act=discard]');

            function refresh(note) {
                const changed = dirty();
                status.innerHTML = `${set.size} privilegios${changed ? ' · <span class="dirty">cambios sin guardar</span>' : ''}${note ? ' · ' + esc(note) : ''}`;
                if (saveButton) saveButton.disabled = !changed && !!tpl.id;
                if (discardButton) discardButton.disabled = !changed;
            }
            function draw(note) {
                renderMatrix(matrix, { role: form.role, set, disabled: readOnly, search, marks: false, onChange: (_s, change) => draw(cascadeNote(change)) });
                refresh(note);
            }

            root.querySelector('[data-ref=search]').addEventListener('input', (e) => { search = e.target.value; draw(); });
            root.addEventListener('input', (event) => {
                const field = event.target.dataset.f;
                if (field === 'name' || field === 'description') { form[field] = event.target.value; refresh(); }
            });
            root.addEventListener('change', (event) => {
                if (event.target.dataset.f !== 'role') return;
                form.role = event.target.value;
                // Los privilegios que el nuevo rol no puede tener se quitan
                [...set].forEach((k) => { if (!PRIV.allowedFor(k, form.role)) set.delete(k); });
                draw();
            });
            root.addEventListener('click', async (event) => {
                const act = event.target.closest('[data-act]');
                if (!act) return;
                const kind = act.dataset.act;
                if (kind === 'all') { PRIV.KEYS.filter((k) => PRIV.allowedFor(k, form.role)).forEach((k) => set.add(k)); draw(); }
                else if (kind === 'none') { set.clear(); draw(); }
                else if (kind === 'discard') { mountForm(tpl); }
                else if (kind === 'duplicate') {
                    selectedId = 'new'; drawList();
                    mountForm({ name: `${tpl.name} (copia)`, role: tpl.role, description: tpl.description, claves: tpl.claves, system: false });
                } else if (kind === 'delete') {
                    if (!confirm(`¿Eliminar la plantilla "${tpl.name}"? Los usuarios que la usaron conservan sus privilegios.`)) return;
                    if (await SISDEL.deletePrivilegeTemplate(options.condominioId, tpl.id)) {
                        SISDEL.showToast('Plantilla eliminada', 'success');
                        await reload(null);
                    }
                } else if (kind === 'save') {
                    const name = form.name.trim();
                    if (!name) { SISDEL.showToast('Escriba el nombre de la plantilla', 'warning'); return; }
                    if (!set.size) { SISDEL.showToast('Marque al menos un privilegio', 'warning'); return; }
                    saveButton.disabled = true;
                    const id = await SISDEL.savePrivilegeTemplate(options.condominioId, { id: tpl.id || undefined, name, role: form.role, claves: [...set], description: form.description });
                    if (id) {
                        SISDEL.showToast(`Plantilla "${name}" guardada`, 'success');
                        await reload(id);
                    } else {
                        SISDEL.showToast('No se pudo guardar la plantilla', 'error');
                        refresh();
                    }
                }
            });
            draw();
        }

        async function reload(nextSelected) {
            own = await SISDEL.getPrivilegeTemplates(options.condominioId);
            if (options.onChanged) options.onChanged(own);
            select(nextSelected, true);
        }

        function select(id, force) {
            if (!force && id === selectedId) return;
            if (!force && dirty() && !confirm('Hay cambios sin guardar en esta plantilla. ¿Descartarlos?')) return;
            selectedId = id;
            drawList();
            if (!id) {
                dirty = () => false;
                main.innerHTML = `<div class="pv-empty">${ICONS.shield}<h3>Elija una plantilla</h3><p>Las del sistema son de solo lectura${canManage ? '; cree las del condominio con "Nueva plantilla" o duplique una del sistema' : ''}.</p></div>`;
            } else if (id === 'new') {
                mountForm({ name: '', role: 'operador', description: '', claves: [], system: false });
            } else {
                const tpl = find(id);
                if (tpl) mountForm(tpl); else select(null, true);
            }
        }

        list.addEventListener('click', (event) => {
            const button = event.target.closest('.pv-user');
            if (button) select(button.dataset.id);
        });
        const newButton = container.querySelector('[data-act=new]');
        if (newButton) newButton.addEventListener('click', () => select('new'));

        select(null, true);
        return {
            setTemplates(next) { own = next || []; drawList(); },
            isDirty: () => dirty()
        };
    }

    return { renderMatrix, mountEditor, openEditor, mountPrivilegesTab, mountTemplatesTab, templateChoices, templateOptions, cascadeNote, esc, ICONS };
})();
