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
    // opts: { role, set (Set de claves activas), onChange(set, cascade), disabled, search }
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
                        const state = on && !inRole ? ' is-added' : (!on && inRole ? ' is-removed' : '');
                        const tag = on && !inRole ? '<span class="pv-tag added">Agregado</span>' : (!on && inRole ? '<span class="pv-tag removed">Quitado</span>' : '');
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

    // ── Editor de privilegios de un usuario existente ──
    // user: { id, name, role, cargo, privilegios }; options: { condominioId, templates (propias), isSelf, onSaved() }
    function openEditor(user, options = {}) {
        injectStyles();
        const role = user.role;
        const effective = PRIV.effective(role, user.privilegios);
        const original = new Set(PRIV.KEYS.filter((k) => effective[k]));
        const set = new Set(original);
        let templates = options.templates || [];
        let search = '';
        const readOnly = !!options.isSelf || !SISDEL.can('usuarios.privilegios');

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal pv-modal" role="dialog" aria-modal="true">
                <div class="pv-modal-head">
                    <div>
                        <h3>Privilegios de ${esc(user.name)}</h3>
                        <div class="text-xs text-muted">${esc(SISDEL.getRoleName(role))}${user.cargo ? ' · ' + esc(user.cargo) : ''}</div>
                    </div>
                    <button type="button" class="btn btn-ghost btn-icon" data-act="close" aria-label="Cerrar">&times;</button>
                </div>
                <div class="pv-modal-body">
                    <div class="pv-note ${readOnly ? 'warn' : ''}" id="pvIntro"></div>
                    <div class="pv-bar" id="pvBar"></div>
                    <div id="pvMatrix"></div>
                </div>
                <div class="pv-modal-foot">
                    <span class="grow" id="pvStatus"></span>
                    <button type="button" class="pv-btn" data-act="cancel">Cerrar</button>
                    <button type="button" class="pv-btn primary" data-act="save" ${readOnly ? 'style="display:none;"' : ''}>Guardar privilegios</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const matrix = overlay.querySelector('#pvMatrix');
        const status = overlay.querySelector('#pvStatus');
        const intro = overlay.querySelector('#pvIntro');
        const bar = overlay.querySelector('#pvBar');
        const saveButton = overlay.querySelector('[data-act=save]');

        intro.textContent = options.isSelf
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
            const active = set.size;
            status.innerHTML = `${active} de ${PRIV.KEYS.length} activos${n ? ` · <span class="dirty">${n} cambio${n === 1 ? '' : 's'} sin guardar</span>` : ''}${note ? ' · ' + esc(note) : ''}`;
            saveButton.disabled = readOnly || n === 0;
        }

        function draw(note) {
            renderMatrix(matrix, {
                role, set, disabled: readOnly, search,
                onChange: (_s, change) => { draw(cascadeNote(change)); }
            });
            refreshStatus(note);
        }

        function drawBar() {
            const choices = templateChoices(templates);
            bar.innerHTML = `
                <input type="search" id="pvSearch" placeholder="Buscar privilegio…" aria-label="Buscar privilegio" value="${esc(search)}">
                ${readOnly ? '' : `
                <select id="pvTemplate" aria-label="Plantilla">${templateOptions(choices, '')}</select>
                <button type="button" class="pv-btn" data-act="role" title="Dejar exactamente los privilegios que trae su rol">Valores del rol</button>
                <button type="button" class="pv-btn" data-act="none">Quitar todos</button>
                <button type="button" class="pv-btn" data-act="saveTemplate" title="Guardar los privilegios marcados como plantilla del condominio">Guardar como plantilla</button>
                <button type="button" class="pv-btn danger" data-act="delTemplate" style="display:none;">Eliminar plantilla</button>`}`;
            bar.querySelector('#pvSearch').addEventListener('input', (e) => { search = e.target.value; draw(); });
        }

        overlay.addEventListener('click', async (event) => {
            const act = event.target.closest('[data-act]');
            if (event.target === overlay || (act && (act.dataset.act === 'close' || act.dataset.act === 'cancel'))) {
                if (diffCount() && !readOnly && !confirm('Hay cambios sin guardar. ¿Cerrar de todos modos?')) return;
                overlay.remove();
                return;
            }
            if (!act) return;
            if (act.dataset.act === 'role') {
                set.clear(); Object.keys(PRIV.defaultsOf(role)).forEach((k) => set.add(k));
                draw('Se dejaron los privilegios del rol');
            } else if (act.dataset.act === 'none') {
                set.clear(); draw();
            } else if (act.dataset.act === 'saveTemplate') {
                const name = (prompt('Nombre de la plantilla (por ejemplo: Secretaria de turno noche):') || '').trim();
                if (!name) return;
                const id = await SISDEL.savePrivilegeTemplate(options.condominioId, { name, role, claves: [...set], description: '' });
                if (id) {
                    templates = await SISDEL.getPrivilegeTemplates(options.condominioId);
                    SISDEL.showToast(`Plantilla "${name}" guardada`, 'success');
                    drawBar();
                }
            } else if (act.dataset.act === 'delTemplate') {
                const select = bar.querySelector('#pvTemplate');
                const picked = templates.find((t) => t.id === select.value);
                if (picked && confirm(`¿Eliminar la plantilla "${picked.name}"? Los usuarios que la usaron conservan sus privilegios.`)) {
                    if (await SISDEL.deletePrivilegeTemplate(options.condominioId, picked.id)) {
                        templates = await SISDEL.getPrivilegeTemplates(options.condominioId);
                        drawBar();
                    }
                }
            } else if (act.dataset.act === 'save') {
                saveButton.disabled = true;
                saveButton.textContent = 'Guardando…';
                const ok = await SISDEL.setUserAccess(user.id, { privilegios: PRIV.toOverrides(role, [...set]) });
                saveButton.textContent = 'Guardar privilegios';
                if (ok) {
                    SISDEL.showToast(`Privilegios de ${user.name} actualizados`, 'success');
                    overlay.remove();
                    if (options.onSaved) options.onSaved();
                } else {
                    SISDEL.showToast('No se pudieron guardar los privilegios', 'error');
                    refreshStatus();
                }
            }
        });

        overlay.addEventListener('change', (event) => {
            if (event.target.id !== 'pvTemplate') return;
            const tpl = templateChoices(templates).find((t) => t.id === event.target.value);
            bar.querySelector('[data-act=delTemplate]').style.display = tpl && tpl.custom ? '' : 'none';
            if (!tpl) return;
            set.clear();
            (tpl.claves || []).filter((k) => PRIV.allowedFor(k, role)).forEach((k) => set.add(k));
            draw(`Plantilla "${tpl.name}" aplicada; falta guardar`);
        });

        drawBar();
        draw();
    }

    return { renderMatrix, openEditor, templateChoices, templateOptions, cascadeNote, esc, ICONS };
})();
