// Lectura del cuerpo que envia la camara (Dahua ITMS y variantes)
const Busboy = require('busboy');
const { normalizePlate } = require('../util');

// Lee multipart/form-data: campos de texto y nombres de archivo (las imagenes se descartan)
function readMultipart(req) {
    return new Promise((resolve, reject) => {
        const fields = [];
        const files = [];
        let bb;
        try {
            bb = Busboy({ headers: req.headers, limits: { fileSize: 30 * 1024 * 1024 } });
        } catch (e) { reject(e); return; }

        bb.on('field', (name, value) => fields.push({ name, value: String(value) }));
        bb.on('file', (name, stream, info) => {
            let size = 0;
            stream.on('data', (chunk) => { size += chunk.length; });
            stream.on('end', () => files.push({ field: name, filename: info.filename || '', size }));
        });
        bb.on('error', reject);
        bb.on('close', () => resolve({ fields, files }));
        bb.end(req.rawBody || Buffer.alloc(0));
    });
}

// Dahua nombra las fotos asi: P642DPH-20260310114824-plate.jpg
function plateFromFileName(name) {
    const first = String(name || '').split('-')[0];
    return first.length >= 5 ? first : '';
}

function plateFromJson(data) {
    return data?.PlateNumber
        || data?.Picture?.Plate?.PlateNumber
        || data?.Events?.[0]?.PlateNumber
        || data?.plate
        || data?.info?.PlateNumber
        || data?.TrafficCar?.PlateNumber
        || data?.trafficCar?.plateNumber
        || data?.AlarmInfoPlate?.plateNumber
        || data?.VehicleInfo?.PlateNumber
        || '';
}

function plateFromText(text) {
    const match = text.match(/<PlateNumber>(.*?)<\/PlateNumber>/i)
        || text.match(/<plate>(.*?)<\/plate>/i)
        || text.match(/"PlateNumber"\s*:\s*"(.*?)"/i);
    return match ? match[1] : '';
}

function bodyText(req) {
    if (req.rawBody) return req.rawBody.toString('utf8');
    if (typeof req.body === 'string') return req.body;
    return '';
}

// Devuelve { rawData, plateNumber } con la placa ya normalizada ('' si no hay placa)
async function parseRequest(req) {
    const contentType = String(req.headers['content-type'] || '');
    let rawData = {};
    let plate = '';

    if (contentType.includes('multipart/form-data')) {
        try {
            const { fields, files } = await readMultipart(req);
            for (const file of files) {
                if (!plate) plate = plateFromFileName(file.filename);
            }
            for (const field of fields) {
                try {
                    const json = JSON.parse(field.value);
                    if (json && typeof json === 'object') {
                        rawData = { ...rawData, ...json };
                        plate = plateFromJson(json) || plate;
                        continue;
                    }
                } catch { /* no es JSON */ }
                rawData[field.name] = field.value;
            }
            rawData._files = files.map((f) => ({ name: f.filename, size: f.size }));
        } catch (e) {
            rawData = { rawText: bodyText(req).slice(0, 4000), parseError: e.message };
        }
    } else if (contentType.includes('application/json')) {
        const text = bodyText(req);
        try { rawData = text.trim() ? JSON.parse(text) : {}; }
        catch { rawData = { rawText: text.slice(0, 4000) }; plate = plateFromText(text); }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(bodyText(req));
        for (const [key, value] of params.entries()) rawData[key] = value;
    } else {
        const text = bodyText(req);
        if (!text.trim()) {
            rawData = { emptyBody: true };
        } else {
            try { rawData = JSON.parse(text); }
            catch { rawData = { rawText: text.slice(0, 4000) }; plate = plateFromText(text); }
        }
    }

    if (!rawData || typeof rawData !== 'object') rawData = { value: rawData };
    if (!plate) plate = plateFromJson(rawData);
    if (!plate) plate = plateFromFileName(rawData?.PicName || rawData?.Picture?.CutoutPic?.PicName);

    return { rawData, plateNumber: normalizePlate(plate) };
}

// El condominio viene en la URL (?condominioId= o ?id=) o como DeviceID de la camara
function condominioFromRequest(req, rawData) {
    const fromUrl = req.query?.condominioId || req.query?.id;
    const value = fromUrl
        || rawData?.DeviceID
        || rawData?.deviceID
        || rawData?.info?.DeviceID
        || rawData?.Picture?.SnapInfo?.DeviceID
        || '';
    const clean = String(Array.isArray(value) ? value[0] : value).trim();
    return clean.includes('/') ? '' : clean;
}

module.exports = { parseRequest, condominioFromRequest };
