/* ═══════════════════════════════════════════════════════════════
   SISDEL - Bancos del Sistema Financiero (OIKOS): calculos
   ───────────────────────────────────────────────────────────────
   Funciones puras (navegador y Node; se prueban en scripts/test-finanzas-bancos.mjs). Los datos viven en Firestore:
   finanzas_bancos (cuentas), finanzas_bancos_movs (movimientos hechos a mano) y finanzas_config/bancos (historial de la
   cuenta favorita, que solo escribe el servidor). Ver finanzas-bancos.js.

   - El saldo de una cuenta NUNCA se guarda: se calcula siempre (saldo de apertura + ingresos - egresos), como en MULTISYS.
   - Los pagos (type 'income') y gastos (type 'expense') de OIKOS no se copian: se leen. Cada uno va a la cuenta que era
     la favorita cuando se REGISTRO (created_at), si se registro despues de abrir esa cuenta ("los siguientes ingresos").
     Un pago o gasto anulado deja de contar solo. Las cuotas y cargos no son dinero: no van al banco.
   - La favorita: la primera cuenta que se abrio, hasta que el administrador la cambia (cada cambio vale desde su fecha;
     lo de antes se queda en la cuenta donde entro).
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelBancos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // Tipos de cuenta (los de MULTISYS) y de movimiento hecho a mano, con su sentido
    const ACCOUNT_TYPES = [
        { id: 'monetaria', label: 'Monetaria' },
        { id: 'ahorros', label: 'Ahorros' },
        { id: 'corriente', label: 'Corriente / Cheques' },
        { id: 'plazo_fijo', label: 'Plazo fijo' },
        { id: 'dolares', label: 'Dólares (USD)' },
        { id: 'tarjeta_credito', label: 'Tarjeta de crédito' },
        { id: 'otro', label: 'Otro' }
    ];
    const MOVEMENT_TYPES = [
        { id: 'deposito', label: 'Depósito', direction: 'in' },
        { id: 'cheque_depositado', label: 'Cheque depositado', direction: 'in' },
        { id: 'intereses', label: 'Intereses', direction: 'in' },
        { id: 'ajuste_entrada', label: 'Ajuste (entra)', direction: 'in' },
        { id: 'retiro', label: 'Retiro', direction: 'out' },
        { id: 'cheque_emitido', label: 'Cheque emitido', direction: 'out' },
        { id: 'comision', label: 'Comisión bancaria', direction: 'out' },
        { id: 'ajuste_salida', label: 'Ajuste (sale)', direction: 'out' },
        { id: 'transferencia_entrada', label: 'Transferencia recibida', direction: 'in', transfer: true },
        { id: 'transferencia_salida', label: 'Transferencia enviada', direction: 'out', transfer: true }
    ];
    const typeLabel = (list, id, custom) => (id === 'otro' && custom ? custom : (list.find((t) => t.id === id) || {}).label || String(id || ''));
    const accountTypeLabel = (id, custom) => typeLabel(ACCOUNT_TYPES, id, custom);
    const movementTypeLabel = (id) => typeLabel(MOVEMENT_TYPES, id);
    const directionOf = (type) => (MOVEMENT_TYPES.find((t) => t.id === type) || {}).direction || null;

    const cents = (amount) => Math.round((parseFloat(amount) || 0) * 100);
    const fromCents = (value) => value / 100;
    const iso = (value) => String(value || '');

    // Cuentas en el orden en que se abrieron
    function byOpening(accounts) {
        return (accounts || []).filter((a) => a && a.id).slice()
            .sort((a, b) => iso(a.openedAt).localeCompare(iso(b.openedAt)) || String(a.id).localeCompare(String(b.id)));
    }

    // Historial de favoritas en orden (el del servidor); sin historial, la primera cuenta desde que se abrio
    function favoriteTimeline(accounts, favorites) {
        const list = (Array.isArray(favorites) ? favorites : []).filter((f) => f && f.accountId && f.from)
            .slice().sort((a, b) => iso(a.from).localeCompare(iso(b.from)));
        if (list.length) return list;
        const first = byOpening(accounts)[0];
        return first ? [{ accountId: first.id, from: iso(first.openedAt) }] : [];
    }

    // La cuenta favorita en un momento (texto ISO); null si todavia no habia cuentas
    function favoriteAt(accounts, favorites, when) {
        let found = null;
        favoriteTimeline(accounts, favorites).forEach((f) => { if (iso(f.from) <= iso(when)) found = f.accountId; });
        return found;
    }
    const currentFavorite = (accounts, favorites) => {
        const timeline = favoriteTimeline(accounts, favorites);
        return timeline.length ? timeline[timeline.length - 1].accountId : null;
    };

    // Los pagos y gastos de OIKOS que le tocan a cada cuenta: Map(accountId -> [movimiento])
    function automaticByAccount(accounts, favorites, txs) {
        const opened = new Map(byOpening(accounts).map((a) => [a.id, iso(a.openedAt)]));
        const timeline = favoriteTimeline(accounts, favorites);
        const out = new Map();
        if (!timeline.length) return out;
        (txs || []).forEach((t) => {
            // El saldo a favor inicial de una carga de saldos (openingCredit) y un ajuste de saldo que baja lo que debe un residente
            // (saldoAjuste, "Actualizar saldo") no son dinero que entro: no van al banco
            if (!t || t.deleted || (t.type !== 'income' && t.type !== 'expense') || !t.created_at || t.openingCredit === true || t.saldoAjuste === true) return;
            const when = iso(t.created_at);
            let accountId = null;
            for (let i = 0; i < timeline.length && iso(timeline[i].from) <= when; i++) accountId = timeline[i].accountId;
            // Solo lo que se registro despues de abrir la cuenta que lo recibe
            if (!accountId || !opened.has(accountId) || when < opened.get(accountId)) return;
            if (!out.has(accountId)) out.set(accountId, []);
            out.get(accountId).push(t);
        });
        return out;
    }

    // Libro de una cuenta: saldo de apertura y cada movimiento (automatico o a mano) con su saldo despues.
    // opts: { from, to } ('AAAA-MM-DD', opcionales: el saldo anterior al rango se acumula en "Saldo anterior"),
    // dayKey(fecha ISO) -> dia local, residentName(id) -> nombre para el concepto de un pago.
    function ledger(account, data, opts) {
        const options = opts || {};
        const dayKey = typeof options.dayKey === 'function' ? options.dayKey : (v) => iso(v).slice(0, 10);
        const from = options.from || '';
        const to = options.to || '';
        const auto = (data.automatic || automaticByAccount(data.accounts, data.favorites, data.txs)).get(account.id) || [];
        const entries = [];
        auto.forEach((t) => {
            const isIn = t.type === 'income';
            const who = isIn && typeof options.residentName === 'function' ? options.residentName(t.resiId) : '';
            entries.push({
                source: 'oikos', id: t.id, date: t.date || t.created_at, created_at: t.created_at,
                type: isIn ? 'pago' : 'gasto', typeLabel: isIn ? 'Pago registrado' : 'Gasto registrado',
                concept: [t.concept || (isIn ? 'Pago' : 'Gasto'), who].filter(Boolean).join(' · '),
                reference: t.receiptNum ? String(t.receiptNum) : '', in: isIn ? cents(t.amount) : 0, out: isIn ? 0 : cents(t.amount)
            });
        });
        (data.manual || []).forEach((m) => {
            if (!m || m.deleted || m.accountId !== account.id) return;
            const amount = cents(m.amount);
            if (amount <= 0) return;
            entries.push({
                source: 'banco', id: m.id, date: m.date, created_at: m.created_at, type: m.type, typeLabel: movementTypeLabel(m.type),
                concept: m.concept || movementTypeLabel(m.type), reference: m.reference || '', transferId: m.transferId || '',
                in: m.direction === 'in' ? amount : 0, out: m.direction === 'out' ? amount : 0
            });
        });
        entries.sort((a, b) => dayKey(a.date).localeCompare(dayKey(b.date)) || iso(a.created_at).localeCompare(iso(b.created_at)) || String(a.id).localeCompare(String(b.id)));
        let balance = cents(account.openingBalance);
        let before = balance;
        let totalIn = 0;
        let totalOut = 0;
        const rows = [];
        entries.forEach((e) => {
            balance += e.in - e.out;
            const day = dayKey(e.date);
            if (from && day < from) { before = balance; return; }
            if (to && day > to) return;
            totalIn += e.in;
            totalOut += e.out;
            rows.push({ ...e, day, in: fromCents(e.in), out: fromCents(e.out), balance: fromCents(balance) });
        });
        // Saldo al final del rango (con 'to', lo que vino despues no cuenta)
        const closing = rows.length ? rows[rows.length - 1].balance : fromCents(before);
        return {
            opening: fromCents(cents(account.openingBalance)), previous: fromCents(before), rows,
            totalIn: fromCents(totalIn), totalOut: fromCents(totalOut), closing,
            balance: fromCents(balance)
        };
    }

    // Saldo de hoy de cada cuenta: Map(accountId -> saldo)
    function balances(accounts, favorites, txs, manual) {
        const automatic = automaticByAccount(accounts, favorites, txs);
        const out = new Map();
        byOpening(accounts).forEach((a) => { out.set(a.id, ledger(a, { automatic, manual }).balance); });
        return out;
    }

    return {
        ACCOUNT_TYPES, MOVEMENT_TYPES, accountTypeLabel, movementTypeLabel, directionOf,
        byOpening, favoriteTimeline, favoriteAt, currentFavorite, automaticByAccount, ledger, balances
    };
});
