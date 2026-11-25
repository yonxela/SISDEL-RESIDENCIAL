// Maneja un Chrome sin ventana (perfil temporal) por su protocolo de depuracion, sin instalar nada.
// Lo usan medir-carga-grande.mjs y test-finanzas-navegador.mjs. Solo para paginas locales (emuladores).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_PATHS = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

export function findChrome(preferred) {
    return [preferred, ...CHROME_PATHS].filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = [];
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
                return;
            }
            this.listeners.forEach((fn) => fn(message));
        });
    }
    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

// Abre Chrome. Devuelve { newPage, close }.
// extraArgs: opciones de Chrome de mas (por ejemplo, un microfono de prueba para el audio del boton de panico)
export async function launch(chromePath, extraArgs = []) {
    const executable = findChrome(chromePath);
    if (!executable) throw new Error('No se encontro Chrome. Indique la ruta con --chrome= o la variable CHROME_PATH.');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sisdel-chrome-'));
    const child = spawn(executable, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
        '--no-default-browser-check', '--window-size=1280,900', ...extraArgs, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chrome no arranco')), 20000);
        let buffer = '';
        child.stderr.on('data', (chunk) => {
            buffer += chunk;
            const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    const connection = new Connection(socket);

    // Una pestana nueva. Cada pestana comparte el perfil (localStorage, IndexedDB) pero no la sesion (sessionStorage).
    async function newPage({ stepTimeoutMs = 180000 } = {}) {
        const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
        const send = (method, params) => connection.send(method, params, sessionId);
        const page = { errors: [], dialogs: [], networkBytes: 0, requests: 0, send };
        connection.listeners.push((message) => {
            if (message.sessionId !== sessionId) return;
            const p = message.params || {};
            if (message.method === 'Runtime.exceptionThrown') {
                const d = p.exceptionDetails || {};
                page.errors.push(String((d.exception && d.exception.description) || d.text || 'error').split('\n')[0]);
            }
            if (message.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
                page.errors.push(p.args.map((a) => a.value || a.description || '').join(' ').split('\n')[0].slice(0, 300));
            }
            // alert(), confirm() y prompt(): se aceptan
            if (message.method === 'Page.javascriptDialogOpening') {
                page.dialogs.push(p.message.slice(0, 200));
                send('Page.handleJavaScriptDialog', { accept: true, promptText: 'prueba' }).catch(() => {});
            }
            if (message.method === 'Network.dataReceived') page.networkBytes += p.dataLength || 0;
            if (message.method === 'Network.requestWillBeSent') page.requests++;
        });
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Network.enable');
        await send('Performance.enable');

        // Evalua una expresion en la pagina y devuelve su valor (espera promesas)
        page.evaluate = async (expression) => {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: stepTimeoutMs });
            if (result.exceptionDetails) {
                const d = result.exceptionDetails;
                throw new Error(String((d.exception && d.exception.description) || d.text).split('\n')[0]);
            }
            return result.result.value;
        };
        page.waitFor = async (expression, label, timeoutMs = stepTimeoutMs) => {
            const until = Date.now() + timeoutMs;
            while (Date.now() < until) {
                try { const value = await page.evaluate(expression); if (value) return value; } catch { /* la pagina esta cambiando */ }
                await sleep(100);
            }
            throw new Error('Se agoto el tiempo esperando: ' + label);
        };
        page.goto = async (url) => { page.networkBytes = 0; await send('Page.navigate', { url }); };
        // Memoria de JavaScript en uso, despues de recoger la basura (para que el numero sea estable)
        page.heapMb = async () => {
            await send('HeapProfiler.collectGarbage').catch(() => {});
            const { metrics } = await send('Performance.getMetrics');
            const used = metrics.find((m) => m.name === 'JSHeapUsedSize');
            return used ? Math.round(used.value / 1048576) : null;
        };
        page.close = () => connection.send('Target.closeTarget', { targetId }).catch(() => {});
        // Entra con un codigo de acceso de prueba y espera a la pagina de inicio del usuario
        page.login = async (baseUrl, code) => {
            await page.goto(`${baseUrl}/index.html`);
            await page.waitFor(`!!document.getElementById('accessCode') && typeof SISDEL !== 'undefined'`, 'pantalla de ingreso');
            await page.evaluate(`(() => { document.getElementById('accessCode').value = ${JSON.stringify(code)}; document.getElementById('btnSubmit').click(); })()`);
            await page.waitFor(`!location.pathname.endsWith('/index.html') && location.pathname !== '/' && document.readyState === 'complete'`, 'pagina de inicio tras el ingreso');
        };
        return page;
    }

    // Antes de cerrar, cada pestana sale de la pagina: asi Firestore cierra sus escuchas. Si Chrome se mata con una
    // escucha grande abierta, el emulador de Firestore se queda reintentando y llena el disco con su registro.
    const pages = [];
    const openPage = async (options) => { const page = await newPage(options); pages.push(page); return page; };
    const close = async () => {
        try {
            await Promise.all(pages.map((page) => page.send('Page.navigate', { url: 'about:blank' }).catch(() => {})));
            await sleep(700);
        } catch { /* se cierra igual */ }
        try { child.kill(); } catch { /* ya cerrado */ }
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* se borra despues */ }
    };
    return { newPage: openPage, close };
}
