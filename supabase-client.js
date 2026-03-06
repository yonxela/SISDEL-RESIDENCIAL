// ═══════════════════════════════════════════════════════════════
// SISDEL Cloud Connection (Supabase)
// ═══════════════════════════════════════════════════════════════

// 1. REEMPLAZAR ESTOS VALORES CON LOS DE TU PROYECTO SUPABASE
// En Supabase ve a: Project Settings -> API -> Project URL & Project API Keys (anon/public)
const SUPABASE_URL = 'https://TU_PROYECTO.supabase.co';
const SUPABASE_ANON_KEY = 'ey.....TU_KEY_PUBLICA......';

// 2. Inicializar cliente global
// Nota: Requiere que la librería de Supabase sea importada en HTML antes que este archivo.
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

if (typeof supabase !== 'undefined') {
    window.supabaseDb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("✅ Supabase Client Initialized");
} else {
    console.error("❌ Error: Supabase CDN not loaded. Please include the script tag in HTML.");
}
