// Utilidades compartidas por los scripts
import crypto from 'node:crypto';

export const PROJECT_ID = 'sisdel-datacenter';
export const EMULATOR = { firestore: '127.0.0.1:8080', auth: '127.0.0.1:9099', functions: ['127.0.0.1', 5001] };

export const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
export const normalizePlate = (plate) => String(plate || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
export const normalizeCode = (code) => String(code || '').trim().toUpperCase();

// Fecha local de Guatemala YYYY-MM-DD, con desplazamiento en dias
export function localDate(offsetDays = 0) {
    const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

export function isoDaysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
