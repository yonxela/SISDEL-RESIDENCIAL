// ═══════════════════════════════════════════════════════════════
// SISDEL Cloud Connection (Supabase)
// ═══════════════════════════════════════════════════════════════

// 1. REEMPLAZAR ESTOS VALORES CON LOS DE TU PROYECTO SUPABASE
// En Supabase ve a: Project Settings -> API -> Project URL & Project API Keys (anon/public)
const SUPABASE_URL = 'https://rxrodfskmvldozpznyrp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4cm9kZnNrbXZsZG96cHpueXJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4ODY4MTQsImV4cCI6MjA4NzQ2MjgxNH0.A9GVR_rOnoH2pjz0ByZEMvtWfGe7FOI9C6j1_D-fTos';

// 2. Inicializar cliente global
// Nota: Requiere que la librería de Supabase sea importada en HTML antes que este archivo.
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

if (typeof supabase !== 'undefined') {
    window.supabaseDb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("✅ Supabase Client Initialized");
} else {
    console.error("❌ Error: Supabase CDN not loaded. Please include the script tag in HTML.");
}
