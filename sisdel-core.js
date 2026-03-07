/* ═══════════════════════════════════════════════════════════════
   SISDEL Core Cloud - Supabase Async Version
   ═══════════════════════════════════════════════════════════════ */

const SISDEL = (() => {
    // ── Constants ──
    const MASTER_CODE = '1122';
    const STORAGE_KEYS = { session: 'sisdel_session' };

    const ROLES = { MASTER: 'master', ADMIN: 'admin', VECINO: 'vecino', POLICIA: 'policia' };
    const PAYMENT_STATUS = { AL_DIA: 'al_dia', MOROSO: 'moroso' };
    const VISIT_STATUS = { PENDING: 'pending', ENTERED: 'entered', COMPLETED: 'completed' };

    // ── Database Helper ──
    function db() {
        if (!window.supabaseDb) throw new Error("Supabase client not initialized or loaded.");
        return window.supabaseDb;
    }

    // ── Tools ──
    function generateAccessCode(condominioName, userName) {
        const letter1 = (condominioName || 'X').charAt(0).toUpperCase();
        const letter2 = (userName || 'X').charAt(0).toUpperCase();
        const numbers = String(Math.floor(100 + Math.random() * 900));
        return letter1 + letter2 + numbers;
    }

    function isValidCodeFormat(code) { return /^[A-Z]{2}\d{3}$/i.test(code); }

    // ══════════════════════════════════
    //  Condominio CRUD
    // ══════════════════════════════════
    async function getCondominios() {
        const { data, error } = await db().from('sisdel_condominios').select('*').order('createdAt', { ascending: false });
        if (error) { console.error('getCondominios error:', error); return []; }
        return data || [];
    }

    async function getCondominio(id) {
        const { data, error } = await db().from('sisdel_condominios').select('*').eq('id', id).single();
        if (error) { console.error('getCondominio error:', error); return null; }
        return data;
    }

    async function createCondominio(name, address, phone) {
        const { data, error } = await db().from('sisdel_condominios').insert([{
            name: name.trim(), address: address || '', phone: phone || '', active: true,
            hasQR: true, hasManual: true, hasLPR: false
        }]).select().single();
        if (error) { console.error('createCondominio error:', error); return null; }
        return data;
    }

    async function updateCondominio(id, updates) {
        const { data, error } = await db().from('sisdel_condominios').update(updates).eq('id', id).select().single();
        if (error) { console.error('updateCondominio error:', error); return null; }
        return data;
    }

    async function deactivateCondominio(id) { return updateCondominio(id, { active: false }); }
    async function activateCondominio(id) { return updateCondominio(id, { active: true }); }
    async function toggleCondoSetting(id, settingName, value) {
        return updateCondominio(id, { [settingName]: value });
    }
    async function deleteCondominio(id) {
        const { error } = await db().from('sisdel_condominios').delete().eq('id', id);
        if (error) { console.error('deleteCondominio error:', error); return false; }
        return true;
    }

    // ══════════════════════════════════
    //  User CRUD
    // ══════════════════════════════════
    async function getUsers(condominioId) {
        let query = db().from('sisdel_users').select('*').order('createdAt', { ascending: false });
        if (condominioId) query = query.eq('condominioId', condominioId);
        const { data, error } = await query;
        if (error) { console.error('getUsers error:', error); return []; }
        return data || [];
    }

    async function getUserByCode(code) {
        const { data, error } = await db().from('sisdel_users').select('*').eq('accessCode', code.toUpperCase()).maybeSingle();
        if (error) { console.error('getUserByCode error:', error); return null; }
        return data;
    }

    async function getUserById(id) {
        const { data, error } = await db().from('sisdel_users').select('*').eq('id', id).single();
        if (error) { console.error('getUserById error:', error); return null; }
        return data;
    }

    async function createUser(condominioId, name, role, casa, phone, email) {
        const condo = await getCondominio(condominioId);
        if (!condo) return null;

        let finalCode = generateAccessCode(condo.name, name);
        let isUnique = false;

        while (!isUnique) {
            const { count, error } = await db().from('sisdel_users').select('*', { count: 'exact', head: true }).eq('accessCode', finalCode);
            if (error) { console.error('Validation error:', error); return null; }
            if (count === 0) {
                isUnique = true;
            } else {
                finalCode = generateAccessCode(condo.name, name);
            }
        }

        const { data, error } = await db().from('sisdel_users').insert([{
            condominioId, name: name.trim(), role, accessCode: finalCode,
            casa: casa || '', phone: phone || '', email: email || '',
            paymentStatus: role === ROLES.VECINO ? PAYMENT_STATUS.AL_DIA : null, active: true
        }]).select().single();

        if (error) { console.error('createUser error:', error); return null; }
        return data;
    }

    async function updateUser(userId, updates) {
        delete updates.id;
        const { data, error } = await db().from('sisdel_users').update(updates).eq('id', userId).select().single();
        if (error) { console.error('updateUser error:', error); return null; }
        return data;
    }

    async function deleteUser(userId) {
        const { error } = await db().from('sisdel_users').delete().eq('id', userId);
        if (error) { console.error('deleteUser error:', error); return false; }
        return true;
    }

    async function getUsersByPaymentStatus(condominioId, status) {
        const { data, error } = await db().from('sisdel_users').select('*').eq('condominioId', condominioId).eq('paymentStatus', status);
        if (error) { console.error('getUsersByPaymentStatus error:', error); return []; }
        return data || [];
    }

    // ══════════════════════════════════
    //  Visit CRUD
    // ══════════════════════════════════
    async function getVisits(condominioId) {
        let query = db().from('sisdel_visits').select('*').order('createdAt', { ascending: false });
        if (condominioId) query = query.eq('condominioId', condominioId);
        const { data, error } = await query;
        if (error) { console.error('getVisits error:', error); return []; }
        return data || [];
    }

    async function getVisitsByUser(userId) {
        const { data, error } = await db().from('sisdel_visits').select('*').eq('userId', userId).order('createdAt', { ascending: false });
        if (error) { console.error('getVisitsByUser error:', error); return []; }
        return data || [];
    }

    async function getTodayVisits(condominioId) {
        const todayStr = new Date().toISOString().split('T')[0];
        let query = db().from('sisdel_visits').select('*').eq('visitDate', todayStr);
        if (condominioId) query = query.eq('condominioId', condominioId);
        const { data, error } = await query;
        if (error) { console.error('getTodayVisits error:', error); return []; }
        return data || [];
    }

    async function createVisit(condominioId, userId, visitorName, visitorInfo, vehiclePlate, visitDate, visitTime, casa) {
        const visitCode = 'VIS' + Date.now().toString(36).toUpperCase();
        let timeFormatted = visitTime;
        if (timeFormatted && timeFormatted.length === 5) {
            timeFormatted = timeFormatted + ":00"; // Supabase time format requires seconds
        }

        const { data, error } = await db().from('sisdel_visits').insert([{
            condominioId, userId, visitorName: visitorName.trim(), visitorInfo: visitorInfo || '',
            vehiclePlate: (vehiclePlate || '').toUpperCase(), visitDate: visitDate || new Date().toISOString().split('T')[0],
            visitTime: timeFormatted || null, casa: casa || '', qrCode: visitCode, status: VISIT_STATUS.PENDING
        }]).select().single();

        if (error) { console.error('createVisit error:', error); return null; }
        return data;
    }

    async function updateVisit(visitId, updates) {
        delete updates.id;
        const { data, error } = await db().from('sisdel_visits').update(updates).eq('id', visitId).select().single();
        if (error) { console.error('updateVisit error:', error); return null; }
        return data;
    }

    async function getVisitByQR(qrCode) {
        const { data, error } = await db().from('sisdel_visits').select('*').eq('qrCode', qrCode).maybeSingle();
        if (error) { console.error('getVisitByQR error:', error); return null; }
        return data;
    }

    async function markVisitAsEntered(visitId) {
        return updateVisit(visitId, { status: VISIT_STATUS.ENTERED, enteredAt: new Date().toISOString() });
    }

    // ══════════════════════════════════
    //  Vehicle / Marbete
    // ══════════════════════════════════
    async function getVehicles(userId) {
        let query = db().from('sisdel_vehicles').select('*');
        if (userId) query = query.eq('userId', userId);
        const { data, error } = await query;
        if (error) { console.error('getVehicles error:', error); return []; }
        return data || [];
    }

    async function createVehicle(userId, condominioId, plate, brand, model, color) {
        const marbeteCode = 'MAR' + Date.now().toString(36).toUpperCase();
        const { data, error } = await db().from('sisdel_vehicles').insert([{
            condominioId, userId, plate: (plate || '').toUpperCase(),
            brand: brand || '', model: model || '', color: color || '', marbeteCode
        }]).select().single();
        if (error) { console.error('createVehicle error:', error); return null; }
        return data;
    }

    async function getVehicleByQR(qrCode) {
        const { data, error } = await db().from('sisdel_vehicles').select('*').eq('marbeteCode', qrCode).maybeSingle();
        if (error) { console.error('getVehicleByQR error:', error); return null; }
        return data;
    }

    async function deleteVehicle(vehicleId) {
        const { error } = await db().from('sisdel_vehicles').delete().eq('id', vehicleId);
        if (error) console.error('deleteVehicle error:', error);
    }

    // ══════════════════════════════════
    //  Messages
    // ══════════════════════════════════
    async function getMessages(condominioId) {
        let query = db().from('sisdel_messages').select('*').order('createdAt', { ascending: false });
        if (condominioId) {
            query = query.or(`condominioId.eq.${condominioId},condominioId.eq.all`);
        }
        const { data, error } = await query;
        if (error) { console.error('getMessages error:', error); return []; }
        return data || [];
    }

    async function createMessage(condominioId, fromName, toRole, subject, body) {
        const { data, error } = await db().from('sisdel_messages').insert([{
            condominioId: condominioId || 'all', fromName: fromName || 'SISDEL',
            toRole: toRole || 'all', subject: subject || '', body, read: false
        }]).select().single();
        if (error) { console.error('createMessage error:', error); return null; }
        return data;
    }

    // ══════════════════════════════════
    //  Auth / Session
    // ══════════════════════════════════
    async function login(code) {
        const trimmed = code.trim().toUpperCase();

        if (trimmed === MASTER_CODE) {
            const session = { role: ROLES.MASTER, code: MASTER_CODE, loggedAt: new Date().toISOString() };
            sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
            return { success: true, role: ROLES.MASTER, redirect: 'master.html' };
        }

        const user = await getUserByCode(trimmed);
        if (!user) return { success: false, error: 'Código de acceso no válido' };

        const condo = await getCondominio(user.condominioId);
        if (!condo || !condo.active) return { success: false, error: 'El condominio no está activo' };
        if (!user.active) return { success: false, error: 'Usuario inactivo. Contacte al administrador.' };

        const session = {
            role: user.role, userId: user.id, userName: user.name,
            userCasa: user.casa,
            condominioId: user.condominioId, condominioName: condo.name,
            code: user.accessCode, loggedAt: new Date().toISOString()
        };
        sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));

        let redirect;
        switch (user.role) {
            case ROLES.ADMIN: redirect = 'admin.html'; break;
            case ROLES.VECINO: redirect = 'vecino.html'; break;
            case ROLES.POLICIA: redirect = 'garita.html'; break;
            default: redirect = 'index.html';
        }

        return { success: true, role: user.role, redirect, user };
    }

    function getSession() {
        try { return JSON.parse(sessionStorage.getItem(STORAGE_KEYS.session)); } catch { return null; }
    }

    function logout() {
        sessionStorage.removeItem(STORAGE_KEYS.session);
        window.location.href = 'index.html';
    }

    async function requireAuth(allowedRoles) {
        const session = getSession();
        if (!session) { window.location.href = 'index.html'; return null; }
        if (allowedRoles && !allowedRoles.includes(session.role)) { window.location.href = 'index.html'; return null; }
        return session;
    }

    // ══════════════════════════════════
    //  UI Helpers
    // ══════════════════════════════════
    function showToast(message, type = 'info') {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const icons = {
            success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
            error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<div class="toast-icon" style="color: var(--${type === 'error' ? 'danger' : type})">${icons[type] || icons.info}</div><span class="toast-message">${message}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        // Reemplazamos guiones por barras para que JS no lo interprete como UTC midnight
        // y se asigne a la zona horaria local, evitando el desfase de un día.
        const normalizedDate = typeof dateStr === 'string' ? dateStr.replace(/-/g, '/') : dateStr;
        return new Date(normalizedDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function formatDateTime(dateStr) {
        if (!dateStr) return '';
        const normalizedDate = typeof dateStr === 'string' ? dateStr.replace(/-/g, '/') : dateStr;
        return new Date(normalizedDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function getRoleName(role) {
        const names = { [ROLES.ADMIN]: 'Administrador', [ROLES.VECINO]: 'Vecino', [ROLES.POLICIA]: 'Policía / Guardia', [ROLES.MASTER]: 'Master' };
        return names[role] || role;
    }

    function getPaymentBadge(status) {
        if (status === PAYMENT_STATUS.AL_DIA) return '<span class="badge badge-success">Al día</span>';
        if (status === PAYMENT_STATUS.MOROSO) return '<span class="badge badge-danger">Moroso</span>';
        return '';
    }

    function confirmDialog(message) { return confirm(message); }

    // Seed Demo Data
    async function seedDemoData() {
        const existing = await getCondominios();
        if (existing && existing.length > 0) return;

        console.log('🚀 Seeding rich demo data to Supabase...');

        // 1. Condominios
        const condo1 = await createCondominio('Villa Ferrer', 'Km 14.5 Carretera al Salvador', '2222-3333');
        const condo2 = await createCondominio('Residencial Los Olivos', 'Zona 16, Ciudad de Guatemala', '4444-5555');

        if (!condo1 || !condo2) return;

        // 2. Usuarios - Villa Ferrer
        await createUser(condo1.id, 'Fernando López', ROLES.ADMIN, '', '5555-1234', 'admin1@villaferrer.com');
        const v1_1 = await createUser(condo1.id, 'Ana García', ROLES.VECINO, 'Casa 12', '5555-5678', 'ana@mail.com');
        const v1_2 = await createUser(condo1.id, 'Carlos Martínez', ROLES.VECINO, 'Casa 5', '5555-9012', '');
        const v1_3 = await createUser(condo1.id, 'María Rodríguez', ROLES.VECINO, 'Casa 23', '5555-3456', '');
        const p1_1 = await createUser(condo1.id, 'Pedro Ramírez', ROLES.POLICIA, '', '5555-7890', '');

        // 3. Usuarios - Los Olivos
        await createUser(condo2.id, 'Lucía Méndez', ROLES.ADMIN, '', '5555-0001', 'lucia@olivos.com');
        const v2_1 = await createUser(condo2.id, 'Juan Pérez', ROLES.VECINO, 'Lote 45', '5555-0002', '');
        const p2_1 = await createUser(condo2.id, 'Ramiro Sosa', ROLES.POLICIA, '', '5555-0003', '');

        // 4. Estados de Pago y Detalles
        await updateUser(v1_3.id, { paymentStatus: PAYMENT_STATUS.MOROSO });
        await updateUser(v2_1.id, { paymentStatus: PAYMENT_STATUS.MOROSO });

        // 5. Vehículos
        await createVehicle(v1_1.id, condo1.id, 'P-987XYZ', 'Toyota', 'Corolla', 'Blanco');
        await createVehicle(v1_2.id, condo1.id, 'M-111BBB', 'Yamaha', 'R6', 'Negro');
        await createVehicle(v2_1.id, condo2.id, 'P-555AAA', 'Honda', 'Civic', 'Gris');

        // 6. Visitas (Hoy y Recientes)
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        // Villa Ferrer Visitas
        await createVisit(condo1.id, v1_1.id, 'Roberto Herrera', 'Plomero', 'P-123ABC', today, '10:00:00', 'Casa 12');
        const visit2 = await createVisit(condo1.id, v1_2.id, 'Luis Pérez', 'Familiar', 'M-456DEF', today, '14:30:00', 'Casa 5');
        await markVisitAsEntered(visit2.id); // Esta ya ingresó

        await createVisit(condo1.id, v1_1.id, 'Sonia Valle', 'Delivery Pizza', 'P-888GGG', yesterday, '19:00:00', 'Casa 12');

        // Los Olivos Visitas
        await createVisit(condo2.id, v2_1.id, 'Instalador Internet', 'Claro', 'P-000WWW', today, '09:00:00', 'Lote 45');

        // 7. Mensajes Globales
        await createMessage('all', 'SISDEL Central', 'all', 'Mantenimiento del Sistema', 'Estimados usuarios, el sistema estará en mantenimiento el domingo a las 2:00 AM.');
        await createMessage(condo1.id, 'Administración Villa Ferrer', ROLES.POLICIA, 'Revisión de Cámaras', 'Por favor reportar cualquier fallo en el domo de la entrada principal.');

        console.log('✅ Rich Demo data successfully seeded to Supabase.');
    }

    // Public API
    return {
        ROLES, PAYMENT_STATUS, VISIT_STATUS, MASTER_CODE,
        getCondominios, getCondominio, createCondominio, updateCondominio, deactivateCondominio, activateCondominio, deleteCondominio, toggleCondoSetting,
        getUsers, getUserByCode, getUserById, createUser, updateUser, deleteUser, getUsersByPaymentStatus, generateAccessCode, isValidCodeFormat,
        getVisits, getVisitsByUser, getTodayVisits, createVisit, updateVisit, getVisitByQR, markVisitAsEntered,
        getVehicles, createVehicle, getVehicleByQR, deleteVehicle,
        getMessages, createMessage,
        login, getSession, logout, requireAuth,
        showToast, formatDate, formatDateTime, getRoleName, getPaymentBadge, confirmDialog, seedDemoData
    };
})();
