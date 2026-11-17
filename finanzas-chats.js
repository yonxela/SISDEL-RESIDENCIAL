/* ═══════════════════════════════════════════════════════════════
   SISDEL - Chat de WhatsApp con los residentes: datos en Firestore
   ───────────────────────────────────────────────────────────────
   finanzas.html lo arranca (si el usuario tiene finanzas.whatsapp_chat) y OIKOS lo usa desde su iframe
   (window.parent.sisdelChats). Escucha en tiempo real la lista de chats del condominio (whatsapp_chats, el mas reciente
   primero) y los mensajes del chat abierto (wa_mensajes). No escribe nada en la base: enviar, marcar como leido y traer
   los mensajes de antes los hace el servidor (functions/src/whatsapp-chat.js), que toma el telefono del chat o de la
   ficha del residente, nunca uno que mande el navegador.
   ═══════════════════════════════════════════════════════════════ */

const SisdelFinanzasChats = (() => {
    const MAX_CHATS = 1000;
    const MAX_MESSAGES = 400;

    function start(condoId) {
        const fb = window.sisdelFirebase;
        const chatsCol = fb.db.collection('condominios').doc(condoId).collection('whatsapp_chats');
        const state = { chats: [], unread: 0, ready: false, error: null };
        const listeners = new Set();
        const emit = () => listeners.forEach((cb) => { try { cb(state); } catch (error) { console.error('chats: aviso a la pantalla', error); } });
        const stopList = chatsCol.orderBy('lastAt', 'desc').limit(MAX_CHATS).onSnapshot((snap) => {
            state.chats = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
            state.unread = state.chats.reduce((sum, c) => sum + (c.unread > 0 ? 1 : 0), 0);
            state.ready = true;
            state.error = null;
            emit();
        }, (error) => {
            console.error('chats: no se pudo leer la lista', error);
            state.error = 'No se pudieron leer los chats. Revise su conexión.';
            state.ready = true;
            emit();
        });

        // Mensajes de un chat (los ultimos 400, del mas viejo al mas nuevo). Devuelve la funcion para dejar de escuchar.
        function watchMessages(chatId, cb) {
            return chatsCol.doc(String(chatId)).collection('wa_mensajes').orderBy('at').limitToLast(MAX_MESSAGES).onSnapshot((snap) => {
                cb(snap.docs.map((d) => ({ ...d.data(), id: d.id })), null);
            }, (error) => {
                console.error('chats: no se pudieron leer los mensajes', error);
                cb(null, error);
            });
        }

        const call = (name, data) => fb.functions.httpsCallable(name)(data).then((r) => r.data);
        // target: { chatId } o { residentId }
        const send = (target, text) => call('sendChatMessage', { ...target, text: String(text || '') });
        const markRead = (chatId) => call('markChatRead', { chatId: String(chatId) });
        const loadHistory = (chatId) => call('loadChatHistory', { chatId: String(chatId) });

        return {
            available: true,
            state,
            subscribe(cb) { listeners.add(cb); cb(state); return () => listeners.delete(cb); },
            watchMessages, send, markRead, loadHistory,
            stop() { try { stopList(); } catch (e) { /* ya detenido */ } listeners.clear(); }
        };
    }

    return { start };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SisdelFinanzasChats;
