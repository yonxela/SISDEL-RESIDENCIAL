// Migra los datos de Supabase a Firestore.
//
//   node migrate-supabase.mjs                         prueba contra el emulador
//   node migrate-supabase.mjs --dry-run               solo cuenta, no escribe
//   node migrate-supabase.mjs --target=prod --confirm escribe en la nube
//   node migrate-supabase.mjs --from-file=ruta.json   usa un respaldo ya descargado
//   --all-logs                                        trae todo el historial de camara (por defecto 90 dias)
//   --merge                                           permite escribir aunque ya existan condominios
//
// Siempre guarda un respaldo completo fuera del repositorio (el repo es publico).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, parseArgs, writeAll } from './admin.mjs';
import { normalizePlate, normalizeCode } from './lib.mjs';

const SUPABASE_URL = 'https://rxrodfskmvldozpznyrp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4cm9kZnNrbXZsZG96cHpueXJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4ODY4MTQsImV4cCI6MjA4NzQ2MjgxNH0.A9GVR_rOnoH2pjz0ByZEMvtWfGe7FOI9C6j1_D-fTos';
const TABLES = ['sisdel_condominios', 'sisdel_users', 'sisdel_visits', 'sisdel_vehicles', 'sisdel_messages', 'sisdel_camera_logs'];
const BACKUP_DIR = path.join(os.homedir(), 'Desktop', 'Sisdel Programas', 'Backups', 'garita-supabase');
const LOG_DAYS = 90;
const PAGE = 1000;

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const dryRun = !!args['dry-run'];

async function fetchTable(table) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
            headers: {
                apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items'
            }
        });
        if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
        const page = await res.json();
        rows.push(...page);
        if (page.length < PAGE) return rows;
    }
}

async function loadSource() {
    if (args['from-file']) return JSON.parse(fs.readFileSync(args['from-file'], 'utf8'));
    const data = {};
    for (const table of TABLES) {
        data[table] = await fetchTable(table);
        console.log(`  leido ${table}: ${data[table].length}`);
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `supabase-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    console.log(`  respaldo guardado en: ${file}`);
    return data;
}

// Fechas con hora a formato ISO UTC uniforme. Las fechas sin hora (YYYY-MM-DD) no se tocan
function iso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeId(value) {
    const id = String(value || '').trim();
    return id && !id.includes('/') ? id : '';
}

function transform(source) {
    const writes = [];
    const issues = [];
    const condoIds = new Set();
    const userCondo = new Map();
    const seenCodes = new Map();

    for (const c of source.sisdel_condominios || []) {
        const id = safeId(c.id);
        if (!id) { issues.push(`condominio sin id: ${c.name}`); continue; }
        condoIds.add(id);
        writes.push({
            path: `condominios/${id}`,
            data: {
                hasQR: true, hasManual: true, hasLPR: false, reminderEnabled: false, gracePeriodDays: 15,
                ...c, id, active: c.active !== false,
                createdAt: iso(c.createdAt) || new Date().toISOString(),
                serviceExpiry: iso(c.serviceExpiry)
            }
        });
    }

    for (const u of source.sisdel_users || []) {
        const id = safeId(u.id);
        const condominioId = safeId(u.condominioId);
        if (!id || !condoIds.has(condominioId)) { issues.push(`usuario sin condominio valido: ${u.name}`); continue; }
        userCondo.set(id, condominioId);

        const { accessCode, ...rest } = u;
        writes.push({
            path: `condominios/${condominioId}/usuarios/${id}`,
            data: {
                ...rest, id, condominioId, active: u.active !== false,
                createdAt: iso(u.createdAt) || new Date().toISOString(),
                morosoSince: iso(u.morosoSince)
            }
        });

        const code = normalizeCode(accessCode);
        if (!safeId(code)) { issues.push(`usuario sin codigo valido: ${u.name}`); continue; }
        if (seenCodes.has(code)) { issues.push(`codigo repetido ${code}: ${u.name} y ${seenCodes.get(code)}. Se conserva el primero`); continue; }
        seenCodes.set(code, u.name);
        writes.push({
            path: `codigos/${code}`,
            data: { condominioId, userId: id, role: u.role, createdAt: iso(u.createdAt) || new Date().toISOString() }
        });
    }

    for (const v of source.sisdel_visits || []) {
        const id = safeId(v.id);
        const condominioId = safeId(v.condominioId);
        if (!id || !condoIds.has(condominioId)) { issues.push(`visita sin condominio valido: ${v.visitorName}`); continue; }
        writes.push({
            path: `condominios/${condominioId}/visitas/${id}`,
            data: {
                visitType: null, endDate: null,
                ...v, id, condominioId, plateNorm: normalizePlate(v.vehiclePlate),
                createdAt: iso(v.createdAt) || new Date().toISOString(),
                enteredAt: iso(v.enteredAt)
            }
        });
    }

    for (const v of source.sisdel_vehicles || []) {
        const id = safeId(v.id);
        const condominioId = safeId(v.condominioId);
        if (!id || !condoIds.has(condominioId)) { issues.push(`vehiculo sin condominio valido: ${v.plate}`); continue; }
        writes.push({
            path: `condominios/${condominioId}/vehiculos/${id}`,
            data: {
                ...v, id, condominioId, plateNorm: normalizePlate(v.plate),
                createdAt: iso(v.createdAt) || new Date().toISOString()
            }
        });
    }

    for (const m of source.sisdel_messages || []) {
        const id = safeId(m.id);
        if (!id) continue;
        const condominioId = safeId(m.condominioId);
        const data = { ...m, id, read: m.read === true, createdAt: iso(m.createdAt) || new Date().toISOString() };
        if (!condominioId || condominioId === 'all') {
            writes.push({ path: `mensajes_globales/${id}`, data: { ...data, condominioId: 'all' } });
        } else if (condoIds.has(condominioId)) {
            writes.push({ path: `condominios/${condominioId}/mensajes/${id}`, data });
        } else {
            issues.push(`mensaje de condominio inexistente: ${m.subject}`);
        }
    }

    const cutoff = args['all-logs'] ? '' : new Date(Date.now() - LOG_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let skippedLogs = 0;
    for (const log of source.sisdel_camera_logs || []) {
        const id = safeId(log.id);
        if (!id) continue;
        const createdAt = iso(log.createdAt) || new Date().toISOString();
        if (cutoff && createdAt < cutoff) { skippedLogs++; continue; }
        const condominioId = safeId(log.condominioId);
        const { rawPayload, ...rest } = log;
        const data = {
            ...rest, id, createdAt,
            rawPayload: rawPayload ? JSON.stringify(rawPayload).slice(0, 8000) : null
        };
        if (condoIds.has(condominioId)) {
            writes.push({ path: `condominios/${condominioId}/camera_logs/${id}`, data });
        } else {
            writes.push({ path: `camera_logs_huerfanos/${id}`, data });
        }
    }
    if (skippedLogs) issues.push(`historial de camara anterior a ${LOG_DAYS} dias no importado: ${skippedLogs} registros (siguen en el respaldo)`);

    return { writes, issues };
}

function summary(writes) {
    const counts = {};
    for (const { path: p } of writes) {
        const parts = p.split('/');
        const kind = parts.length === 2 ? parts[0] : parts[2];
        counts[kind] = (counts[kind] || 0) + 1;
    }
    return counts;
}

console.log(`Origen: ${args['from-file'] || SUPABASE_URL}`);
const source = await loadSource();
const { writes, issues } = transform(source);
console.log('Documentos a escribir:', summary(writes));
if (issues.length) { console.log('Avisos:'); issues.forEach((i) => console.log(`  - ${i}`)); }

if (dryRun) { console.log('Simulacion: no se escribio nada.'); process.exit(0); }
if (target === 'prod' && !args.confirm) {
    console.error('Para escribir en la nube agregue --confirm');
    process.exit(1);
}

const db = connect(target);
const existing = await db.collection('condominios').limit(1).get();
if (!existing.empty && !args.merge) {
    console.error(`Ya hay condominios en ${target}. Use --merge para agregar encima.`);
    process.exit(1);
}
await writeAll(db, writes);
console.log(`Migracion completa en ${target}: ${writes.length} documentos`);
process.exit(0);
