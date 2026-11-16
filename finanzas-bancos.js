/* ═══════════════════════════════════════════════════════════════
   SISDEL - Bancos del Sistema Financiero: datos en Firestore
   ───────────────────────────────────────────────────────────────
   finanzas.html lo arranca (si el usuario puede ver bancos) y OIKOS lo usa desde su iframe (window.parent.sisdelBancos).
   Escucha en tiempo real las cuentas (finanzas_bancos), los movimientos hechos a mano (finanzas_bancos_movs) y el
   historial de la cuenta favorita (finanzas_config/bancos), y escribe lo que las reglas permiten:
   - abrir una cuenta (la fecha de apertura es la de ahora: desde ahi entran los pagos y gastos a la favorita),
   - cambiar sus datos (nunca su saldo ni su fecha de apertura) o desactivarla,
   - registrar un movimiento o una transferencia entre cuentas (dos movimientos con el mismo transferId),
   - anular un movimiento con su motivo (una transferencia se anula entera).
   Nada se borra. La cuenta favorita solo la cambia el servidor (setFavoriteBank) con el codigo del administrador.
   Los calculos (saldo, libro, que le toca a cada cuenta) estan en finanzas/sisdel-bancos.js.
   ═══════════════════════════════════════════════════════════════ */

const SisdelFinanzasBancos = (() => {
    const ACCOUNT_FIELDS = ['bankName', 'accountName', 'accountNumber', 'accountType', 'accountTypeCustom', 'currency', 'notes', 'active'];
    const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    const money = (value) => Math.round((parseFloat(value) || 0) * 100) / 100;

    // Documento de una cuenta nueva (sin campos vacios: Firestore no admite undefined y las reglas piden texto)
    function accountDoc(data, id, who, now) {
        const doc = {
            id, bankName: text(data.bankName, 80), accountNumber: text(data.accountNumber, 40),
            accountType: text(data.accountType || 'monetaria', 30), currency: text(data.currency || 'GTQ', 5).toUpperCase(),
            openingBalance: money(data.openingBalance), openedAt: now, active: true,
            created_at: now, updated_at: now, created_by: who.uid, created_by_name: text(who.name, 80)
        };
        if (text(data.accountName, 80)) doc.accountName = text(data.accountName, 80);
        if (doc.accountType === 'otro' && text(data.accountTypeCustom, 40)) doc.accountTypeCustom = text(data.accountTypeCustom, 40);
        if (text(data.notes, 300)) doc.notes = text(data.notes, 300);
        return doc;
    }

    // Documento de un movimiento hecho a mano
    function movementDoc(data, id, who, now) {
        const doc = {
            id, accountId: String(data.accountId), direction: data.direction === 'out' ? 'out' : 'in', amount: money(data.amount),
            type: text(data.type, 30), concept: text(data.concept, 200), date: String(data.date || now),
            created_at: now, updated_at: now, created_by: who.uid, created_by_name: text(who.name, 80)
        };
        if (text(data.reference, 60)) doc.reference = text(data.reference, 60);
        if (data.transferId) doc.transferId = text(data.transferId, 60);
        return doc;
    }

    function start(condoId, opts = {}) {
        const fb = window.sisdelFirebase;
        const ref = fb.db.collection('condominios').doc(condoId);
        const col = { accounts: ref.collection('finanzas_bancos'), movements: ref.collection('finanzas_bancos_movs') };
        const who = { uid: opts.userId || '', name: opts.userName || '' };
        const state = { accounts: [], movements: [], favorites: [], ready: false, error: null };
        const loaded = { accounts: false, movements: false, config: false };
        const listeners = new Set();
        const emit = () => {
            state.ready = loaded.accounts && loaded.movements && loaded.config;
            listeners.forEach((cb) => { try { cb(state); } catch (error) { console.error('bancos: aviso a la pantalla', error); } });
        };
        const failed = (what) => (error) => {
            console.error('bancos: no se pudo leer', what, error);
            state.error = 'No se pudieron leer los datos de bancos. Revise su conexión.';
            emit();
        };
        const stops = [
            col.accounts.onSnapshot((snap) => {
                state.accounts = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
                loaded.accounts = true;
                emit();
            }, failed('cuentas')),
            col.movements.onSnapshot((snap) => {
                state.movements = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
                loaded.movements = true;
                emit();
            }, failed('movimientos')),
            ref.collection('finanzas_config').doc('bancos').onSnapshot((doc) => {
                const data = doc.exists ? doc.data() : {};
                state.favorites = Array.isArray(data.favorites) ? data.favorites : [];
                loaded.config = true;
                emit();
            }, failed('cuenta favorita'))
        ];

        async function createAccount(data) {
            const now = new Date().toISOString();
            const doc = accountDoc(data, col.accounts.doc().id, who, now);
            if (!doc.bankName) throw new Error('Escriba el nombre del banco.');
            await col.accounts.doc(doc.id).set(doc);
            return doc;
        }

        async function updateAccount(id, changes) {
            const patch = {};
            ACCOUNT_FIELDS.forEach((field) => {
                if (!(field in changes)) return;
                if (field === 'active') patch.active = changes.active !== false;
                else if (field === 'currency') patch.currency = text(changes.currency, 5).toUpperCase();
                else patch[field] = text(changes[field], field === 'notes' ? 300 : (field === 'accountNumber' ? 40 : 80));
            });
            if ('bankName' in patch && !patch.bankName) throw new Error('Escriba el nombre del banco.');
            patch.updated_at = new Date().toISOString();
            await col.accounts.doc(String(id)).update(patch);
        }

        async function addMovement(data) {
            const now = new Date().toISOString();
            const doc = movementDoc(data, col.movements.doc().id, who, now);
            if (!(doc.amount > 0)) throw new Error('El monto debe ser mayor que cero.');
            if (!doc.concept) throw new Error('Escriba el concepto.');
            await col.movements.doc(doc.id).set(doc);
            return doc;
        }

        // Transferencia entre dos cuentas: sale de una y entra a la otra, en una sola escritura
        async function addTransfer(data) {
            if (!data.fromId || !data.toId || data.fromId === data.toId) throw new Error('Elija dos cuentas distintas.');
            const now = new Date().toISOString();
            const transferId = col.movements.doc().id;
            const base = { amount: data.amount, date: data.date, reference: data.reference, transferId };
            const concept = text(data.concept, 200) || 'Transferencia entre cuentas';
            const out = movementDoc({ ...base, accountId: data.fromId, direction: 'out', type: 'transferencia_salida', concept }, col.movements.doc().id, who, now);
            const into = movementDoc({ ...base, accountId: data.toId, direction: 'in', type: 'transferencia_entrada', concept }, col.movements.doc().id, who, now);
            if (!(out.amount > 0)) throw new Error('El monto debe ser mayor que cero.');
            const batch = fb.db.batch();
            batch.set(col.movements.doc(out.id), out);
            batch.set(col.movements.doc(into.id), into);
            await batch.commit();
            return { out, into };
        }

        // Anular (nunca borrar): queda el motivo, quien y cuando. Una transferencia se anula en sus dos cuentas.
        async function annulMovement(id, reason) {
            const why = text(reason, 200);
            if (!why) throw new Error('Escriba el motivo de la anulación.');
            const movement = state.movements.find((m) => m.id === id);
            if (!movement) throw new Error('El movimiento no existe.');
            const targets = movement.transferId ? state.movements.filter((m) => m.transferId === movement.transferId && !m.deleted) : [movement];
            const now = new Date().toISOString();
            const batch = fb.db.batch();
            targets.forEach((m) => batch.update(col.movements.doc(m.id), {
                deleted: true, deleted_at: now, deleted_reason: why, deleted_by: who.uid, deleted_by_name: text(who.name, 80), updated_at: now
            }));
            await batch.commit();
        }

        // Cambiar la cuenta favorita: solo el administrador, con su codigo (lo verifica el servidor)
        async function setFavorite(accountId, code) {
            const result = await fb.functions.httpsCallable('setFavoriteBank')({ accountId, code: String(code || '') });
            return result.data;
        }

        return {
            available: true,
            state,
            isAdmin: opts.role === 'admin',
            subscribe(cb) { listeners.add(cb); cb(state); return () => listeners.delete(cb); },
            createAccount, updateAccount, addMovement, addTransfer, annulMovement, setFavorite,
            stop() { stops.forEach((s) => { try { s(); } catch (e) { /* ya detenido */ } }); listeners.clear(); }
        };
    }

    return { start, internals: { accountDoc, movementDoc } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SisdelFinanzasBancos;
