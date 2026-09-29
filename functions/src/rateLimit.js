// Limite de intentos por ventana de tiempo, guardado en Firestore
const { db } = require('./firebase');
const { sha256 } = require('./util');

function ref(bucket, key) {
    return db.doc(`_privado/rate/${bucket}/${sha256(key).slice(0, 32)}`);
}

// Devuelve true si la llave ya supero el limite dentro de la ventana
async function isBlocked(bucket, key, { max, windowMs }) {
    const snap = await ref(bucket, key).get();
    if (!snap.exists) return false;
    const { count = 0, windowStart = 0 } = snap.data();
    if (Date.now() - windowStart > windowMs) return false;
    return count >= max;
}

// Suma un intento. Reinicia la ventana si ya vencio
async function hit(bucket, key, { windowMs }) {
    const docRef = ref(bucket, key);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        const now = Date.now();
        const data = snap.exists ? snap.data() : null;
        if (!data || now - data.windowStart > windowMs) {
            tx.set(docRef, { count: 1, windowStart: now });
        } else {
            tx.update(docRef, { count: (data.count || 0) + 1 });
        }
    });
}

async function reset(bucket, key) {
    await ref(bucket, key).delete().catch(() => {});
}

module.exports = { isBlocked, hit, reset };
