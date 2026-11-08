// Utilidades compartidas
const crypto = require('crypto');

const TIME_ZONE = 'America/Guatemala';
const ROLES = { MASTER: 'master', ADMIN: 'admin', VECINO: 'vecino', POLICIA: 'policia', AUDITOR: 'auditor', SUPERVISOR: 'supervisor' };

// Codigo de acceso normalizado. Devuelve '' si no sirve como id de documento
function normalizeCode(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean || clean.length > 64 || clean.includes('/') || clean === '.' || clean === '..') return '';
    return clean;
}

// Placa normalizada: solo letras y numeros, en mayuscula
function normalizePlate(plate) {
    return String(plate || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Comparacion en tiempo constante para no filtrar informacion por tiempos de respuesta
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Fecha local de Guatemala en formato YYYY-MM-DD
function localDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

function daysAgo(days, from = new Date()) {
    return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

function clientIp(rawRequest) {
    const forwarded = String(rawRequest?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || rawRequest?.ip || 'unknown';
}

module.exports = { ROLES, TIME_ZONE, normalizeCode, normalizePlate, sha256, safeEqual, localDate, daysAgo, clientIp };
