// ═══════════════════════════════════════════
// SISDEL RONDÍN — Main Application
// ═══════════════════════════════════════════

const App = {
  currentPage: 'dashboard',
  socket: null,
  map: null,
  guardMarkers: {},
  trackingInterval: null,
  activeShift: null,
  activeRound: null,

  // Función para determinar si el guardia labora en una fecha dada basado en shift_type (rotación 24x24)
  isAssignmentActiveOnDate: function(a, targetDateStr) {
    if (a.status !== 'ACTIVE' || targetDateStr < a.date_start || targetDateStr > a.date_end) return false;
    if (a.shift_type === '24x24') {
      var start = new Date(a.date_start + 'T12:00:00Z');
      var target = new Date(targetDateStr + 'T12:00:00Z');
      var diffDays = Math.floor((target.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      return diffDays % 2 === 0; // Trabaja días pares desde la fecha de inicio
    }
    return true;
  },

  // Verifica si una asignación está activa AHORA (considera fecha Y hora actual)
  isAssignmentActiveNow: function(a) {
    if (a.status !== 'ACTIVE') return false;
    var now = new Date();
    var todayStr = now.toLocaleDateString('en-CA');
    if (todayStr < a.date_start || todayStr > a.date_end) return false;

    // Construir datetime de inicio y fin del turno
    var shiftStart = new Date(a.date_start + 'T' + a.hour_start + ':00');
    var shiftEnd;
    if (a.shift_type === '24x24') {
      shiftEnd = new Date(shiftStart.getTime() + 24 * 60 * 60 * 1000);
      // Para 24x24: verificar que sea día par desde inicio
      var startRef = new Date(a.date_start + 'T12:00:00Z');
      var todayRef = new Date(todayStr + 'T12:00:00Z');
      var diffDays = Math.floor((todayRef - startRef) / (1000 * 60 * 60 * 24));
      if (diffDays % 2 !== 0) return false;
    } else if (a.shift_type === '12H_NOCHE' || a.hour_end < a.hour_start) {
      shiftEnd = new Date(shiftStart.getTime() + 12 * 60 * 60 * 1000);
    } else {
      shiftEnd = new Date(a.date_end + 'T' + a.hour_end + ':00');
    }
    return now >= shiftStart && now < shiftEnd;
  },

  async init() {
    if (!API.isLoggedIn()) { this.renderLogin(); return; }
    // Fetch fresh user profile to keep local storage sync'd
    try {
      const u = await API.get('/api/auth/me');
      if (u && u.id) {
        API.user = u;
        localStorage.setItem('sisdel_user', JSON.stringify(u));
      }
    } catch(e) {
      if (e.status === 401) { API.logout(); return; }
    }
    // Check if this is a neighbor session (stored separately)
    const neighborSession = sessionStorage.getItem('sisdel_neighbor');
    if (neighborSession) { this.renderNeighborPanicView(JSON.parse(neighborSession)); return; }
    this.socket = io();
    if (API.user.company_id !== 'ALL') this.socket.emit('join:company', API.user.company_id);
    this.setupSocketListeners();
    if (API.user.role === 'SUPER_ADMIN') { this.renderSuperAdminLayout(); this.navigate('companies'); }
    else if (API.user.role === 'GUARDIA') { this.renderGuardView(); }
    else if (API.user.role === 'OPERADOR_PIPA') { if (this.renderOperatorView) this.renderOperatorView(); else this.renderGuardView(); }
    else { this.renderAdminLayout(); this.navigate('dashboard'); this.checkNeighborPanicEnabled(); if (this.checkPipaModuleEnabled) this.checkPipaModuleEnabled(); }
    // Join user-specific socket room for OPERADOR_PIPA targeted events
    if (this.socket && API.user.id) this.socket.emit('join:user', API.user.id);
    // Init FCM push for supervisors/directors
    if (['DIRECTOR_GENERAL','SUPERVISOR','ADMIN'].includes(API.user.role)) {
      this._initFcm();
    }
  },

  async _initFcm() {
    try {
      // Get Firebase web config from backend
      const cfg = await API.get('/api/fcm/config');
      if (!cfg.projectId) return; // FCM not configured yet
      // Register service worker
      if (!('serviceWorker' in navigator)) return;
      const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      // Load Firebase SDK dynamically
      if (!window.firebase) {
        await new Promise((res, rej) => {
          const s1 = document.createElement('script');
          s1.src = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js';
          s1.onload = () => {
            const s2 = document.createElement('script');
            s2.src = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js';
            s2.onload = res; s2.onerror = rej;
            document.head.appendChild(s2);
          };
          s1.onerror = rej;
          document.head.appendChild(s1);
        });
      }
      if (!window.firebase.apps?.length) firebase.initializeApp(cfg);
      const messaging = firebase.messaging();
      messaging.useServiceWorker(swReg);
      // Request permission & get token
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const token = await messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: swReg });
      if (token) {
        await API.post('/api/fcm/token', { token });
        console.log('[FCM] Token registered ✅');
        // Handle foreground messages
        messaging.onMessage((payload) => {
          const n = payload.notification || {};
          this.showToast(`${n.title || '🔔'}: ${n.body || ''}`, 'warning');
        });
      }
    } catch(e) { console.warn('[FCM] Init skipped:', e.message); }
  },

  setupSocketListeners() {
    // Unlock AudioContext on first user gesture (required by iOS/Android)
    const unlockAudio = () => {
      if (!App._audioCtx) App._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (App._audioCtx.state === 'suspended') App._audioCtx.resume();
    };
    document.addEventListener('touchstart', unlockAudio, { once: true });
    document.addEventListener('click', unlockAudio, { once: true });

    this.socket.on('alert:panic', (d) => this.showPanicAlert(d));
    this.socket.on('alert:new', (d) => this.showToast(d.message, d.type));

    // Drone Dispatch Listener (Phase 3)
    this.socket.on('drone:panic_dispatch', (d) => {
      this.playAlertBeep();
      this.showToast('🚁 RONDÍN AIR: DESPLIEGUE AUTÓNOMO', 'DANGER');
      if (this.currentPage === 'drones') {
        const titleEl = document.querySelector('#page-content .card-header h3');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-helicopter" style="color:#ef4444;animation:pulse 0.5s infinite"></i> Rondín Air - CÓDIGO ROJO';
        
        const statusEl = document.getElementById('drone-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;animation:pulse 1s infinite">💥 EN RUTA A EMERGENCIA</span>';
        
        Swal.fire({
          title: '🚨 DESPLIEGUE TÁCTICO 🚨',
          html: `<b>Gatillo de Pánico Recibido</b><br><br>Dron <b>${d.drone_name || 'Unidad 1'}</b> en ruta.<br>Prioridad: ${d.emergency_type}<br>Coordenadas: ${d.latitude}, ${d.longitude}`,
          icon: 'warning',
          background: '#450a0a',
          color: '#fca5a5',
          confirmButtonColor: '#dc2626'
        });
      }
    });

    // New incident from guard → notify director/supervisor with sound
    this.socket.on('incident:new', (d) => {
      if (!d || !d.incident) return;
      const role = API.user?.role;
      if (role === 'DIRECTOR_GENERAL' || role === 'SUPERVISOR' || role === 'ADMIN') {
        this.playAlertBeep();
        const inc = d.incident;
        const reporter = d.reporter?.name || 'Guardia';
        this.showToast(`⚠️ ${reporter}: ${inc.title || inc.incident_type}`, 'WARNING');
        // Refresh DG alerts panel if visible
        if ((this.currentPage === 'dashboard' || this.currentPage === 'dg_dashboard') && typeof this.loadDgAlerts === 'function') {
          setTimeout(() => this.loadDgAlerts(), 800);
        }
      }
    });

    // PIPA listeners — delegan en métodos definidos en pipa.js si están disponibles
    this.socket.on('pipa:location:update', (d) => this.pipa_handleLocationUpdate && this.pipa_handleLocationUpdate(d));
    this.socket.on('pipa:alert:triggered', (d) => this.pipa_handleAlert && this.pipa_handleAlert(d));
    this.socket.on('pipa:trip:assigned', (d) => this.pipa_handleTripAssigned && this.pipa_handleTripAssigned(d));
    this.socket.on('pipa:trip:accepted', (d) => this.pipa_handleTripAccepted && this.pipa_handleTripAccepted(d));
    this.socket.on('pipa:trip:started', (d) => this.pipa_handleTripStarted && this.pipa_handleTripStarted(d));
    this.socket.on('pipa:trip:completed', (d) => this.pipa_handleTripCompleted && this.pipa_handleTripCompleted(d));
    this.socket.on('pipa:trip:cancelled', (d) => this.pipa_handleTripCancelled && this.pipa_handleTripCancelled(d));
    this.socket.on('pipa:trip:config:updated', (d) => this.pipa_handleTripConfigUpdated && this.pipa_handleTripConfigUpdated(d));
    this.socket.on('pipa:trip:message', (d) => this.pipa_handleTripMessage && this.pipa_handleTripMessage(d));
    this.socket.on('pipa:waypoint:reached', (d) => this.pipa_handleWaypointReached && this.pipa_handleWaypointReached(d));
    this.socket.on('pipa:waypoint:updated', (d) => this.pipa_handleWaypointUpdated && this.pipa_handleWaypointUpdated(d));
    this.socket.on('pipa:capture:waypoint', (d) => this.pipa_handleCaptureWaypoint && this.pipa_handleCaptureWaypoint(d));
    this.socket.on('pipa:module:status', () => this.checkPipaModuleEnabled && this.checkPipaModuleEnabled());
    this.socket.on('pipa:config:updated', (d) => this.pipa_handleConfigUpdated && this.pipa_handleConfigUpdated(d));
    this.socket.on('pipa:no_signal', (d) => this.pipa_handleNoSignal && this.pipa_handleNoSignal(d));
    this.socket.on('pipa:signal_recovered', (d) => this.pipa_handleSignalRecovered && this.pipa_handleSignalRecovered(d));
    this.socket.on('pipa:live_capture:permission', (d) => {
      if (API.user) {
        API.user.live_capture_enabled = d.enabled ? 1 : 0;
        localStorage.setItem('sisdel_user', JSON.stringify(API.user));
        if (this.currentPage === 'pipa_operator_dashboard') {
          this.page_pipa_operator_dashboard();
        }
      }
    });

    this.socket.on('guard:location:update', (d) => this.updateGuardMarker(d));
    this.socket.on('checkpoint:visited', (d) => {
      const guardName = d.guard_name || d.guard?.name || 'Guardia';
      const cpName = d.checkpoint_name || d.checkpoint?.name || 'Punto';
      this.showToast(`${guardName} → ${cpName}`, 'INFO');
      try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2JkZqTjHhjaF54ipqjn5J8ZWVsgZOkt7Kkg3JtcIWXq7q0pIp2b3OFl6u6tKSKdm9zhZerurSkig==').play(); } catch(e){}
      this.addLiveVisitEntry(d);
      const dot = document.getElementById('alert-dot');
      if (dot) dot.style.display = 'block';
    });
  },

  addLiveVisitEntry(d) {
    const panel = document.getElementById('live-panel');
    if (!panel) return;
    const emptyState = panel.querySelector('.empty-state');
    if (emptyState) panel.innerHTML = '<div style="font-size:12px;color:#64748b;margin-bottom:8px"><i class="fas fa-history"></i> Visitas en tiempo real</div>';
    const guardName = d.guard_name || 'Guardia';
    const cpName = d.checkpoint_name || 'Punto';
    const ts = d.timestamp || new Date().toLocaleString();
    const entry = document.createElement('div');
    entry.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid #1e293b;animation:slideIn 0.5s ease-out;background:rgba(16,185,129,0.05);border-left:3px solid #10b981;margin-bottom:4px;border-radius:0 8px 8px 0';
    entry.innerHTML = `<div style="width:40px;height:40px;background:rgba(16,185,129,0.15);border-radius:50%;display:flex;align-items:center;justify-content:center"><i class="fas fa-check-circle" style="color:#10b981;font-size:18px"></i></div>
      <div style="flex:1"><b style="color:#f1f5f9;font-size:14px">${guardName}</b> → <span style="color:#3b82f6;font-weight:600">${cpName}</span>
        <br><small style="color:#64748b"><i class="fas fa-clock"></i> ${ts}</small>
        ${d.latitude ? '<br><small style="color:#475569;font-family:monospace;font-size:10px">📍 ' + parseFloat(d.latitude).toFixed(6) + ', ' + parseFloat(d.longitude).toFixed(6) + '</small>' : ''}
      </div>
      <div style="background:rgba(16,185,129,0.2);color:#10b981;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:bold">VISITADO</div>`;
    panel.insertBefore(entry, panel.children[1] || null);
  },

  renderLogin() {
    document.getElementById('app').innerHTML = `
    <div class="login-container">
      <div class="login-card">
        <div class="login-logo">
          <i class="fas fa-shield-halved shield-icon"></i>
          <h1>${t('app_name')}</h1>
          <p>${t('app_subtitle')}</p>
        </div>
        <div id="login-form-pin">
          <div class="form-group">
            <label style="text-align:center;display:block;font-size:13px;color:#94a3b8;margin-bottom:12px">CÓDIGO DE ACCESO</label>
            <input type="password" id="pin-input" maxlength="6" placeholder="••••••"
              style="width:100%;text-align:center;font-size:28px;letter-spacing:10px;padding:16px;background:var(--bg-card);border:2px solid var(--border-color);border-radius:12px;color:var(--text-primary);outline:none;font-weight:bold"
              onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--border-color)'"
              onkeydown="if(event.key==='Enter') App.loginPin()">
            <div style="text-align:center;margin-top:10px;font-size:11px;color:#475569"><i class="fas fa-info-circle"></i> Ingresa tu código de acceso</div>
          </div>
          <button class="btn btn-primary" onclick="App.loginPin()">
            <i class="fas fa-arrow-right"></i> ${t('login_btn')}
          </button>
        </div>
        <div style="text-align:center;margin-top:20px">
          <select onchange="setLanguage(this.value);App.renderLogin()" style="background:transparent;border:1px solid var(--border-color);color:var(--text-muted);padding:6px 12px;border-radius:6px;font-size:12px">
            <option value="es" ${currentLang==='es'?'selected':''}>🇲🇽 Español</option>
            <option value="en" ${currentLang==='en'?'selected':''}>🇺🇸 English</option>
            <option value="pt" ${currentLang==='pt'?'selected':''}>🇧🇷 Português</option>
          </select>
        </div>
      </div>
    </div>`;
    setTimeout(() => document.getElementById('pin-input')?.focus(), 100);
  },

  async loginPin() {
    const pin = (document.getElementById('pin-input').value || '').trim();
    if (pin.length < 4) return Swal.fire('Error','Ingresa al menos 4 caracteres','warning');

    // Check if it looks like a neighbor access code (has letters)
    const hasLetters = /[a-zA-Z]/.test(pin);
    if (hasLetters && pin.length === 6) {
      try {
        const res = await fetch(`/api/neighbors/by-code/${encodeURIComponent(pin.toUpperCase())}`);
        if (res.ok) {
          const neighbor = await res.json();
          sessionStorage.setItem('sisdel_neighbor', JSON.stringify(neighbor));
          this.renderNeighborPanicView(neighbor);
          return;
        }
      } catch(e) { /* not a neighbor code, continue */ }
    }

    try {
      // Try regular PIN login first
      await API.login({ pin }); this.init();
    } catch(e) {
      // If PIN login fails, try as master key
      try {
        const res = await fetch('/api/companies/master-login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({master_key:pin}) });
        const ct = res.headers.get('content-type');
        if (!ct || !ct.includes('application/json')) throw new Error('PIN incorrecto');
        const data = await res.json();
        if (!res.ok) throw new Error('PIN incorrecto');
        API.token = data.token; API.user = data.user;
        localStorage.setItem('sisdel_token', data.token);
        localStorage.setItem('sisdel_user', JSON.stringify(data.user));
        this.init();
      } catch(e2) {
        Swal.fire('Acceso Denegado', 'El código ingresado no es válido', 'error');
      }
    }
  },

  // ═══════════ ADMIN LAYOUT ═══════════
  renderAdminLayout() {
    const initials = API.user.name.split(' ').map(w=>w[0]).join('').substring(0,2);
    document.getElementById('app').innerHTML = `
    <div class="app-layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header" style="align-items:flex-start">
          <i class="fas fa-shield-halved shield"></i>
          <div style="flex:1">
            <h2>SISDEL</h2>
            <small>RONDÍN</small>
            ${API.user.company_name ? '<div style="margin-top:8px;font-size:15px;color:#f8fafc;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;border-top:1px solid rgba(255,255,255,0.1);padding-top:6px;line-height:1.2;font-family:\'Georgia\',serif;font-style:italic">'+API.user.company_name+'</div>' : ''}
          </div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section-title">${t('nav_operations')}</div>
          <a class="nav-item active" data-page="dashboard" onclick="App.navigate('dashboard')"><i class="fas fa-chart-pie"></i>${t('nav_dashboard')}</a>
          <a class="nav-item" data-page="monitoreo_ruta" onclick="App.navigate('monitoreo_ruta')" style="font-size:15.6px;font-weight:600"><i class="fas fa-map-marked-alt"></i>Ruta de Monitoreo</a>
          <a class="nav-item" data-page="drones" onclick="App.navigate('drones')" style="font-size:15px;color:#3b82f6"><i class="fas fa-helicopter"></i>Rondín Air</a>
          <a class="nav-item" data-page="monitoring" onclick="App.navigate('monitoring')"><i class="fas fa-map-location-dot"></i>${t('nav_monitoring')}<span class="badge" id="live-count">0</span></a>
          <a class="nav-item" data-page="alerts" onclick="App.navigate('alerts')"><i class="fas fa-bell"></i>${t('nav_alerts')}<span class="badge" id="alert-count">0</span></a>
          <div class="nav-section-title">${t('nav_management')}</div>
          <a class="nav-item" data-page="guardias" onclick="App.navigate('guardias')"><i class="fas fa-user-shield"></i>Guardias</a>
          ${API.user.role === 'DIRECTOR_GENERAL' ? '<a class="nav-item" data-page="supervisores" onclick="App.navigate(\'supervisores\')"><i class="fas fa-user-tie"></i>Supervisores</a>' : ''}
          <a class="nav-item" data-page="incidents" onclick="App.navigate('incidents')"><i class="fas fa-triangle-exclamation"></i>${t('nav_incidents')}</a>
          <a class="nav-item" data-page="vecinos" onclick="App.navigate('vecinos')" id="nav-vecinos" style="display:none"><i class="fas fa-people-roof"></i>Vecinos</a>
          <div class="nav-section-title" id="nav-section-pipa" style="display:none;color:#f59e0b">MONITOREO DE PIPA</div>
          <a class="nav-item" data-page="pipa_dashboard" id="nav-pipa-dashboard" style="display:none" onclick="App.navigate('pipa_dashboard')"><i class="fas fa-truck-droplet" style="color:#f59e0b"></i>Panel Central <span class="badge" id="pipa-active-count">0</span></a>
          <a class="nav-item" data-page="pipa_trips" id="nav-pipa-trips" style="display:none" onclick="App.navigate('pipa_trips')"><i class="fas fa-route" style="color:#f59e0b"></i>Viajes <span class="badge" id="pipa-pending-count">0</span></a>
          <a class="nav-item" data-page="pipa_vehicles" id="nav-pipa-vehicles" style="display:none" onclick="App.navigate('pipa_vehicles')"><i class="fas fa-truck" style="color:#f59e0b"></i>Pipas</a>
          <a class="nav-item" data-page="pipa_operators" id="nav-pipa-operators" style="display:none" onclick="App.navigate('pipa_operators')"><i class="fas fa-id-badge" style="color:#f59e0b"></i>Operadores</a>
          <a class="nav-item" data-page="pipa_routes" id="nav-pipa-routes" style="display:none" onclick="App.navigate('pipa_routes')"><i class="fas fa-map-marked-alt" style="color:#f59e0b"></i>Rutas de Pipa</a>
          <a class="nav-item" data-page="pipa_alerts" id="nav-pipa-alerts" style="display:none" onclick="App.navigate('pipa_alerts')"><i class="fas fa-bell-exclamation" style="color:#ef4444"></i>Alertas Pipa <span class="badge" id="pipa-alert-count">0</span></a>
          <a class="nav-item" data-page="pipa_history" id="nav-pipa-history" style="display:none" onclick="App.navigate('pipa_history')"><i class="fas fa-clock-rotate-left" style="color:#f59e0b"></i>Historial</a>
          <a class="nav-item" data-page="pipa_config" id="nav-pipa-config" style="display:none" onclick="App.navigate('pipa_config')"><i class="fas fa-sliders" style="color:#f59e0b"></i>Config. Pipa</a>
          <div class="nav-section-title">SISTEMA</div>
          <a class="nav-item" data-page="config" onclick="App.navigate('config')"><i class="fas fa-cog"></i>Configuración</a>
        </nav>
        <div class="sidebar-footer">
          <div class="user-info">
            <div class="user-avatar">${initials}</div>
            <div class="user-info-text"><span style="font-size:15px;font-weight:700;letter-spacing:0.3px">${API.user.name}</span><small style="color:#8b5cf6;font-size:11px;font-weight:600;letter-spacing:0.5px">${{DIRECTOR_GENERAL:'Director General',SUPERVISOR:'Supervisor',GUARDIA:'Guardia',ADMIN:'Administrador',JEFE_GUARDIA:'Jefe de Guardia'}[API.user.role]||API.user.role}</small></div>
          </div>
          <button class="btn btn-outline btn-sm" style="width:100%;margin-top:10px" onclick="API.logout()"><i class="fas fa-sign-out-alt"></i> ${t('nav_logout')}</button>
        </div>
      </aside>
      <main class="main-content">
        <div class="topbar">
          <button class="topbar-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')"><i class="fas fa-bars"></i></button>
          <span class="topbar-title" id="page-title">${t('nav_dashboard')}</span>
          <div class="topbar-right">
            <button class="alert-bell" onclick="App.navigate('alerts')"><i class="fas fa-bell"></i><span class="dot" id="alert-dot" style="display:none"></span></button>
            <select onchange="setLanguage(this.value);App.renderAdminLayout();App.navigate(App.currentPage)" style="background:var(--bg-card);border:1px solid var(--border-color);color:var(--text-secondary);padding:6px;border-radius:6px;font-size:11px">
              <option value="es" ${currentLang==='es'?'selected':''}>ES</option>
              <option value="en" ${currentLang==='en'?'selected':''}>EN</option>
              <option value="pt" ${currentLang==='pt'?'selected':''}>PT</option>
            </select>
          </div>
        </div>
        <div class="page-content" id="page-content">${t('loading')}</div>
      </main>
    </div>`;
  },

  // ═══════════ SUPER ADMIN LAYOUT ═══════════
  renderSuperAdminLayout() {
    document.getElementById('app').innerHTML = `
    <div class="app-layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header" style="border-left:3px solid #7c3aed">
          <i class="fas fa-terminal shield" style="background:linear-gradient(135deg,#7c3aed,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent"></i>
          <div><h2>SISDEL</h2><small style="color:#a855f7">PROGRAMADOR</small></div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section-title">MULTI-TENANT</div>
          <a class="nav-item active" data-page="companies" onclick="App.navigate('companies')"><i class="fas fa-building"></i>Empresas</a>
        </nav>
        <div class="sidebar-footer">
          <div class="user-info">
            <div class="user-avatar" style="background:linear-gradient(135deg,#7c3aed,#a855f7)">🔧</div>
            <div class="user-info-text"><small style="color:#a855f7">SUPER_ADMIN</small><span>Programador</span></div>
          </div>
          <button class="btn btn-outline btn-sm" style="width:100%;margin-top:10px" onclick="API.logout()"><i class="fas fa-sign-out-alt"></i> Cerrar Sesión</button>
        </div>
      </aside>
      <main class="main-content">
        <div class="topbar" style="border-top:2px solid #7c3aed">
          <button class="topbar-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')"><i class="fas fa-bars"></i></button>
          <span class="topbar-title" id="page-title">Gestión de Empresas</span>
          <div class="topbar-right"><span class="badge-status" style="background:rgba(124,58,237,0.2);color:#a855f7">🔐 Master Access</span></div>
        </div>
        <div class="page-content" id="page-content">Cargando...</div>
      </main>
    </div>`;
  },

  navigate(page) {
    this.currentPage = page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    const titles = { dashboard: t('nav_dashboard'), monitoring: t('nav_monitoring'), routes: t('nav_routes'), users: t('nav_users'), shifts: t('nav_shifts'), incidents: t('nav_incidents'), alerts: t('nav_alerts'), companies: 'Gestión de Empresas', guardias: 'Expediente de Guardias', monitoreo_ruta: 'Ruta de Monitoreo', config: 'Configuración', vecinos: 'Vecinos', drones: 'Rondín Air (Drones)',
      pipa_dashboard: 'Monitoreo de Pipa — Panel Central',
      pipa_trips: 'Viajes de Pipa',
      pipa_vehicles: 'Pipas (Vehículos)',
      pipa_operators: 'Operadores de Pipa',
      pipa_routes: 'Rutas de Pipa',
      pipa_route_editor: 'Editor de Ruta de Pipa',
      pipa_route_capture: 'Capturar Ruta de Carretera',
      pipa_alerts: 'Alertas de Pipa',
      pipa_history: 'Historial de Viajes de Pipa',
      pipa_config: 'Configuración Monitoreo de Pipa',
      pipa_trip_detail: 'Detalle de Viaje',
      pipa_operator_dashboard: 'Operador de Pipa',
      pipa_operator_trip: 'Viaje en curso'
    };
    document.getElementById('page-title').textContent = titles[page] || page;
    this[`page_${page}`]?.();
  },

  // ═══════════ RONDÍN AIR (DRONES) ═══════════
  async page_drones() {
    const el = document.getElementById('page-content');
    el.innerHTML = `
      <div class="card">
        <div class="card-header" style="background:#0c1222;border-bottom:1px solid #1e293b">
          <h3><i class="fas fa-helicopter" style="color:#3b82f6"></i> Rondín Air - Centro de Control</h3>
          <div><span class="badge-status badge-active" style="background:rgba(16,185,129,0.2);color:#10b981"><i class="fas fa-wifi"></i> Dron Conectado</span></div>
        </div>
        <div class="card-body" style="padding:16px;background:#0f172a">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
            
            <!-- VIDEO FEED -->
            <div style="background:#000;border-radius:12px;border:1px solid #334155;overflow:hidden;position:relative;min-height:450px;display:flex;align-items:center;justify-content:center">
              <div style="position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.6);color:#ef4444;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:bold;z-index:10"><i class="fas fa-circle" style="animation:pulse 1.5s infinite"></i> LIVE REC</div>
              <div id="drone-alt" style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.6);color:#10b981;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:bold;z-index:10;font-family:monospace">ALT: 45m | VEL: 12km/h</div>
              
              <!-- Crosshair overlay -->
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:60px;height:60px;border:1px solid rgba(255,255,255,0.4);z-index:5">
                <div style="position:absolute;top:50%;left:-15px;right:-15px;height:1px;background:rgba(255,255,255,0.4)"></div>
                <div style="position:absolute;left:50%;top:-15px;bottom:-15px;width:1px;background:rgba(255,255,255,0.4)"></div>
              </div>
              
              <!-- Mock Video Background -->
              <div style="width:100%;height:100%;background:url('https://images.unsplash.com/photo-1549421253-5d75d65406bf?q=80&w=1000&auto=format&fit=crop') center/cover;opacity:0.7;filter:grayscale(10%) contrast(1.1)"></div>
            </div>

            <!-- CONTROLES Y MAPA -->
            <div style="display:flex;flex-direction:column;gap:16px">
              
              <!-- Telemetry -->
              <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px">
                <h4 style="margin:0 0 12px 0;color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:1px"><i class="fas fa-satellite"></i> Telemetría</h4>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#64748b;font-size:12.5px">Batería:</span>
                  <span id="drone-bat" style="color:#10b981;font-weight:bold;font-size:12.5px">84% <i class="fas fa-battery-three-quarters"></i></span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#64748b;font-size:12.5px">Señal GPS:</span>
                  <span style="color:#3b82f6;font-weight:bold;font-size:12.5px">Fuerte (14 sat)</span>
                </div>
                <div style="display:flex;justify-content:space-between">
                  <span style="color:#64748b;font-size:12.5px">Modo:</span>
                  <span id="drone-status" style="color:#f59e0b;font-weight:bold;font-size:12.5px">Patrulla Autónoma</span>
                </div>
              </div>

              <!-- BOTONES DIRECTOS -->
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <button class="btn" style="padding:14px;background:#1e293b;border:1px solid #334155;color:#f1f5f9;font-weight:600" onclick="Swal.fire('Comando Enviado','El dron regresará al Docking Station automáticamente.','success')"><i class="fas fa-home" style="color:#3b82f6"></i> Volver a Base</button>
                <button class="btn" style="padding:14px;background:#1e293b;border:1px solid #334155;color:#f1f5f9;font-weight:600" onclick="Swal.fire('Atención','Descenso inmediato en posición actual iniciado.','warning')"><i class="fas fa-arrow-down" style="color:#ef4444"></i> Aterrizaje</button>
                <button class="btn btn-outline" style="padding:14px;grid-column:1/-1;color:#a855f7;border-color:#a855f7;font-weight:700;letter-spacing:0.5px" onclick="Swal.fire({title:'SmartTrack Activado',text:'Haz clic en el objeto sospechoso en la cámara para iniciar el seguimiento autónomo.',icon:'info',background:'#1e293b',color:'#f1f5f9'})"><i class="fas fa-crosshairs"></i> Activar Seguimiento IA</button>
              </div>

              <!-- MINI MAPA -->
              <div style="flex:1;background:#1e293b;border:1px solid #334155;border-radius:10px;position:relative;overflow:hidden;min-height:160px">
                <div style="position:absolute;top:10px;left:10px;background:rgba(15,23,42,0.8);padding:4px 8px;border-radius:4px;font-size:11px;color:#f1f5f9;z-index:2;font-weight:600;letter-spacing:0.5px">RADAR</div>
                <!-- Mock Map -->
                <div style="width:100%;height:100%;background:url('https://upload.wikimedia.org/wikipedia/commons/a/a9/OpenStreetMap_default_map_zoom_10.png') center/cover;opacity:0.6;filter:invert(1) hue-rotate(180deg) brightness(0.8)"></div>
                <!-- Dron Icon -->
                <i class="fas fa-helicopter" style="position:absolute;top:40%;left:45%;transform:translate(-50%,-50%);color:#3b82f6;font-size:26px;filter:drop-shadow(0 0 8px rgba(59,130,246,1));z-index:5"></i>
                <div style="position:absolute;top:40%;left:45%;width:150px;height:150px;border:1px dashed rgba(59,130,246,0.5);border-radius:50%;transform:translate(-50%,-50%);animation:pulse 2s infinite"></div>
              </div>

            </div>
          </div>
        </div>
      </div>
    `;

    // Mock Live Telemetry Connection Data
    if (this.droneSim) clearInterval(this.droneSim);
    let mAlt = 45.0, mVel = 12.0;
    this.droneSim = setInterval(() => {
      const altEl = document.getElementById('drone-alt');
      if (!altEl) return clearInterval(this.droneSim);
      mAlt = 45 + (Math.random() * 2 - 1);
      mVel = 12 + (Math.random() * 4 - 2);
      altEl.innerText = `ALT: ${mAlt.toFixed(1)}m | VEL: ${mVel.toFixed(1)}km/h`;
    }, 1500);
  },

  // ═══════════ COMPANIES (SUPER_ADMIN) ═══════════
  async page_companies() {
    const el = document.getElementById('page-content');
    el.innerHTML = `<div class="stats-grid" id="comp-stats"></div>
      <div class="card"><div class="card-header"><h3><i class="fas fa-building"></i> Empresas Registradas</h3>
      <button class="btn btn-sm" style="background:linear-gradient(135deg,#7c3aed,#4c1d95);color:white" onclick="App.showCompanyModal()"><i class="fas fa-plus"></i> Nueva Empresa</button></div>
      <div class="card-body table-container"><table class="data-table"><thead><tr><th>Empresa</th><th>País</th><th>Idioma</th><th>Usuarios</th><th>Guardias</th><th>Rutas</th><th>Turnos Activos</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody id="comp-tbody">${t('loading')}</tbody></table></div></div>`;
    try {
      const companies = await API.get('/api/companies/all');
      const flags = {MX:'🇲🇽',US:'🇺🇸',CO:'🇨🇴',BR:'🇧🇷',AR:'🇦🇷',CL:'🇨🇱',PE:'🇵🇪',ES:'🇪🇸',GT:'🇬🇹',HN:'🇭🇳',SV:'🇸🇻',CR:'🇨🇷',PA:'🇵🇦'};
      document.getElementById('comp-stats').innerHTML = `
        <div class="stat-card" style="border-top:3px solid #7c3aed"><div class="stat-icon" style="background:rgba(124,58,237,0.15);color:#a855f7"><i class="fas fa-building"></i></div><div class="stat-value">${companies.length}</div><div class="stat-label">EMPRESAS</div></div>
        <div class="stat-card success"><div class="stat-icon green"><i class="fas fa-users"></i></div><div class="stat-value">${companies.reduce((a,c)=>a+(c.total_users||0),0)}</div><div class="stat-label">TOTAL USUARIOS</div></div>
        <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-user-shield"></i></div><div class="stat-value">${companies.reduce((a,c)=>a+(c.total_guards||0),0)}</div><div class="stat-label">TOTAL GUARDIAS</div></div>
        <div class="stat-card warning"><div class="stat-icon yellow"><i class="fas fa-route"></i></div><div class="stat-value">${companies.reduce((a,c)=>a+(c.total_routes||0),0)}</div><div class="stat-label">TOTAL RUTAS</div></div>`;
      document.getElementById('comp-tbody').innerHTML = companies.length ? companies.map(c => `<tr>
        <td><b>${c.name}</b>${c.dg_pin ? `<br><span style="font-family:monospace;font-size:11px;color:#10b981;letter-spacing:2px;font-weight:700" title="Código Director General">🔑 ${c.dg_pin}</span>` : ''}</td><td>${flags[c.country]||'🌎'} ${c.country}</td><td>${c.language?.toUpperCase()}</td>
        <td>${c.total_users||0}</td><td>${c.total_guards||0}</td><td>${c.total_routes||0}</td>
        <td><span class="badge-status ${c.active_shifts>0?'badge-active':'badge-pending'}">${c.active_shifts||0}</span></td>
        <td><span class="badge-status ${c.status==='ACTIVE'?'badge-active':'badge-danger'}">${c.status}</span></td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="App.editCompany('${c.id}')" title="Editar"><i class="fas fa-edit"></i></button>
          <button class="btn btn-sm" style="background:${c.status==='ACTIVE'?'#dc2626':'#16a34a'};color:white;margin-left:4px" onclick="App.toggleCompanyStatus('${c.id}','${c.name}','${c.status}')" title="${c.status==='ACTIVE'?'Desactivar':'Activar'}">${c.status==='ACTIVE'?'<i class="fas fa-ban"></i>':'<i class="fas fa-check-circle"></i>'}</button>
          <button class="btn btn-sm" style="background:${c.pipa_monitoring_enabled?'#f59e0b':'#475569'};color:white;margin-left:4px" onclick="App.togglePipaForCompany('${c.id}','${c.name}',${c.pipa_monitoring_enabled?1:0})" title="${c.pipa_monitoring_enabled?'Desactivar Monitoreo de Pipa':'Activar Monitoreo de Pipa'}"><i class="fas fa-truck-droplet"></i></button>
          <button class="btn btn-sm" style="background:#d97706;color:white;margin-left:4px" onclick="App.resetDgPin('${c.id}','${c.name}')" title="Reset PIN Director"><i class="fas fa-key"></i></button>
          <button class="btn btn-sm" style="background:var(--danger);color:white;margin-left:4px" onclick="App.deleteCompany('${c.id}','${c.name}')" title="Eliminar"><i class="fas fa-trash"></i></button>
        </td></tr>`).join('') : `<tr><td colspan="9" class="empty-state">${t('no_data')}</td></tr>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async showCompanyModal() {
    const { value } = await Swal.fire({
      title: '🏢 Nueva Empresa', background: '#1e293b', color: '#f1f5f9', width: 500,
      html: `<input id="swal-cname" class="swal2-input" placeholder="Nombre de la empresa" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <select id="swal-country" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;flex:1;margin:0">
            <option value="MX">🇲🇽 México</option><option value="GT">🇬🇹 Guatemala</option><option value="HN">🇭🇳 Honduras</option><option value="SV">🇸🇻 El Salvador</option>
            <option value="CR">🇨🇷 Costa Rica</option><option value="PA">🇵🇦 Panamá</option><option value="CO">🇨🇴 Colombia</option><option value="PE">🇵🇪 Perú</option>
            <option value="CL">🇨🇱 Chile</option><option value="AR">🇦🇷 Argentina</option><option value="BR">🇧🇷 Brasil</option><option value="US">🇺🇸 USA</option><option value="ES">🇪🇸 España</option>
          </select>
          <select id="swal-lang" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;flex:1;margin:0">
            <option value="es">Español</option><option value="en">English</option><option value="pt">Português</option>
          </select>
        </div>
        <div style="text-align:left;color:#94a3b8;font-size:13px;font-weight:600;margin-top:16px;margin-bottom:-8px">Datos del Director General</div>
        <input id="swal-dg-name" class="swal2-input" placeholder="Nombre completo" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="swal-dg-phone" class="swal2-input" placeholder="Teléfono" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="swal-dg-email" class="swal2-input" placeholder="Correo Electrónico" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <div style="display:flex;align-items:center;margin-top:8px;gap:8px">
          <input id="swal-dg-pin" class="swal2-input" placeholder="PIN de acceso" value="${Math.floor(100000 + Math.random() * 900000)}" maxlength="6" style="margin:0;background:#0f172a;border-color:#334155;color:#10b981;font-weight:bold;letter-spacing:4px;flex:1">
          <button type="button" class="btn btn-outline" style="padding:10px" onclick="navigator.clipboard.writeText(document.getElementById('swal-dg-pin').value); Swal.fire({toast:true,position:'top-end',icon:'success',title:'Copiado',showConfirmButton:false,timer:1500,background:'#1e293b',color:'#fff'})"><i class="fas fa-copy"></i> Copiar</button>
        </div>
        <div style="margin-top:12px;padding:12px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.3);border-radius:8px;font-size:12px;color:#a855f7;text-align:left">
          <i class="fas fa-info-circle"></i> Puedes modificar el PIN sugerido, pero asegúrate de que tenga 6 números. Cópialo para entregárselo al Director.
        </div>
        <div style="text-align:left;font-size:12px;color:#8b5cf6;font-weight:700;margin:16px 0 4px;letter-spacing:1px;border-top:1px solid #334155;padding-top:12px">MÓDULOS ADICIONALES</div>
        <label style="display:flex;align-items:center;gap:12px;padding:12px;background:#0f172a;border:1px solid #334155;border-radius:8px;cursor:pointer;text-align:left">
          <input type="checkbox" id="swal-pipa-enabled" style="width:20px;height:20px;accent-color:#f59e0b;cursor:pointer">
          <div style="flex:1">
            <div style="font-weight:600;color:#f59e0b;display:flex;align-items:center;gap:8px"><i class="fas fa-truck-droplet"></i> Activar Monitoreo de PIPA</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px">Permite a esta empresa monitorear transporte pesado con GPS, geocercas y alertas WhatsApp.</div>
          </div>
        </label>`,
      confirmButtonText: '<i class="fas fa-plus"></i> Crear Empresa', confirmButtonColor: '#7c3aed', showCancelButton: true, cancelButtonText: t('cancel'),
      preConfirm: () => {
        const name = document.getElementById('swal-cname').value;
        const dgName = document.getElementById('swal-dg-name').value;
        const dgPin = document.getElementById('swal-dg-pin').value;
        if (!name || !dgName || !/^\d{6}$/.test(dgPin)) { Swal.showValidationMessage('La empresa, nombre del Director y el PIN de 6 dígitos son obligatorios'); return false; }
        return {
          name,
          country: document.getElementById('swal-country').value,
          language: document.getElementById('swal-lang').value,
          dg_name: dgName,
          dg_phone: document.getElementById('swal-dg-phone').value,
          dg_email: document.getElementById('swal-dg-email').value,
          dg_pin: dgPin,
          pipa_monitoring_enabled: document.getElementById('swal-pipa-enabled').checked
        };
      }
    });
    if (value) {
      try {
        const pipaEnabled = value.pipa_monitoring_enabled;
        delete value.pipa_monitoring_enabled;
        const res = await API.post('/api/companies', value);
        // Si el usuario marcó la casilla, activar el módulo PIPA inmediatamente
        if (pipaEnabled && res.company?.id) {
          try { await API.put('/api/pipa-config/enable', { company_id: res.company.id, enabled: true }); } catch(e) { console.warn('No se pudo activar PIPA:', e.message); }
        }
        await Swal.fire({title:'✅ Empresa Creada', icon:'success', background:'#1e293b', color:'#f1f5f9',
          html:`<div style="text-align:left;padding:12px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px;margin-top:8px">
            <div style="font-size:16px;font-weight:700;margin-bottom:8px">${res.company.name}</div>
            <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">Director General:</div>
            <div style="font-size:14px;font-weight:600">${res.director.name}</div>
            <div style="margin-top:8px;font-size:13px;color:#94a3b8">PIN de acceso:</div>
            <div style="font-size:28px;font-weight:800;letter-spacing:6px;color:#10b981;margin-top:4px">${res.director.pin}</div>
            <div style="margin-top:8px;font-size:11px;color:#f59e0b"><i class="fas fa-exclamation-triangle"></i> Guarda este PIN, no se mostrará de nuevo.</div>
          </div>`});
        this.page_companies();
      } catch(e) { Swal.fire('Error',e.message,'error'); }
    }
  },

  async editCompany(id) {
    try {
      const companies = await API.get('/api/companies/all');
      const c = companies.find(x => x.id === id);
      if (!c) return;
      // Fetch DG user
      let dg = null;
      try {
        const users = await API.get('/api/users');
        dg = null; // users endpoint is company-scoped, won't work from SUPER_ADMIN
      } catch(e) {}
      const flags = {MX:'🇲🇽',US:'🇺🇸',CO:'🇨🇴',BR:'🇧🇷',AR:'🇦🇷',CL:'🇨🇱',PE:'🇵🇪',ES:'🇪🇸',GT:'🇬🇹',HN:'🇭🇳',SV:'🇸🇻',CR:'🇨🇷',PA:'🇵🇦'};
      const { value } = await Swal.fire({
        title: '✏️ Editar Empresa', background: '#1e293b', color: '#f1f5f9', width: 540,
        html: `
          <div style="text-align:left;font-size:12px;color:#8b5cf6;font-weight:700;margin:8px 0 4px;letter-spacing:1px">DATOS DE LA EMPRESA</div>
          <input id="ec-name" class="swal2-input" value="${c.name}" placeholder="Nombre" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <select id="ec-country" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;flex:1;margin:0">
              ${Object.entries(flags).map(([k,v])=>`<option value="${k}" ${c.country===k?'selected':''}>${v} ${k}</option>`).join('')}
            </select>
            <select id="ec-lang" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;flex:1;margin:0">
              <option value="es" ${c.language==='es'?'selected':''}>Español</option>
              <option value="en" ${c.language==='en'?'selected':''}>English</option>
              <option value="pt" ${c.language==='pt'?'selected':''}>Português</option>
            </select>
          </div>
          <select id="ec-status" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;width:100%;margin-bottom:4px">
            <option value="ACTIVE" ${c.status==='ACTIVE'?'selected':''}>✅ Activa</option>
            <option value="SUSPENDED" ${c.status==='SUSPENDED'?'selected':''}>⏸️ Suspendida</option>
            <option value="INACTIVE" ${c.status==='INACTIVE'?'selected':''}>🔴 Inactiva</option>
          </select>

          <div style="text-align:left;font-size:12px;color:#8b5cf6;font-weight:700;margin:16px 0 4px;letter-spacing:1px;border-top:1px solid #334155;padding-top:12px">DIRECTOR GENERAL</div>
          <input id="ec-dg-name" class="swal2-input" value="${c.dg_name||''}" placeholder="Nombre del Director General" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
          <input id="ec-dg-phone" class="swal2-input" placeholder="Teléfono" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
          <input id="ec-dg-email" class="swal2-input" placeholder="Correo electrónico" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
            <div style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:11px 14px;font-family:monospace;font-size:16px;font-weight:700;color:#10b981;letter-spacing:4px">
              🔑 ${c.dg_pin || '(no disponible)'}
            </div>
            ${c.dg_pin ? `<button type="button" class="btn btn-outline" style="padding:10px" onclick="navigator.clipboard.writeText('${c.dg_pin}');Swal.fire({toast:true,position:'top-end',icon:'success',title:'PIN copiado',showConfirmButton:false,timer:1200,background:'#1e293b',color:'#fff'})"><i class="fas fa-copy"></i></button>` : ''}
          </div>
          <div style="margin-top:6px;font-size:11px;color:#64748b;text-align:left"><i class="fas fa-info-circle"></i> Para cambiar el PIN usa el botón 🔑 en la tabla.</div>

          <div style="text-align:left;font-size:12px;color:#8b5cf6;font-weight:700;margin:16px 0 4px;letter-spacing:1px;border-top:1px solid #334155;padding-top:12px">MÓDULOS ADICIONALES</div>
          <label style="display:flex;align-items:center;gap:12px;padding:12px;background:#0f172a;border:1px solid ${c.pipa_monitoring_enabled?'#f59e0b':'#334155'};border-radius:8px;cursor:pointer;text-align:left">
            <input type="checkbox" id="ec-pipa-enabled" ${c.pipa_monitoring_enabled?'checked':''} style="width:20px;height:20px;accent-color:#f59e0b;cursor:pointer">
            <div style="flex:1">
              <div style="font-weight:600;color:#f59e0b;display:flex;align-items:center;gap:8px"><i class="fas fa-truck-droplet"></i> Monitoreo de PIPA ${c.pipa_monitoring_enabled?'<span style="background:#f59e0b;color:#1e293b;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">ACTIVO</span>':''}</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:2px">Permite a esta empresa monitorear transporte pesado con GPS, geocercas y alertas WhatsApp.</div>
            </div>
          </label>`,
        confirmButtonText: '<i class="fas fa-save"></i> Guardar Cambios', confirmButtonColor: '#7c3aed', showCancelButton: true, cancelButtonText: 'Cancelar',
        preConfirm: () => ({
          name: document.getElementById('ec-name').value,
          country: document.getElementById('ec-country').value,
          language: document.getElementById('ec-lang').value,
          status: document.getElementById('ec-status').value,
          dg_name: document.getElementById('ec-dg-name').value,
          dg_phone: document.getElementById('ec-dg-phone').value,
          dg_email: document.getElementById('ec-dg-email').value,
          pipa_monitoring_enabled: document.getElementById('ec-pipa-enabled').checked
        })
      });
      if (!value) return;
      await API.put(`/api/companies/${id}`, { name: value.name, country: value.country, language: value.language, status: value.status });
      // Update DG if name provided
      if (value.dg_name) {
        await fetch(`/api/companies/${id}/update-dg`, {
          method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${API.token}` },
          body: JSON.stringify({ name: value.dg_name, phone: value.dg_phone, email: value.dg_email })
        });
      }
      // Toggle del módulo PIPA si cambió
      const desiredPipa = !!value.pipa_monitoring_enabled;
      const currentPipa = !!c.pipa_monitoring_enabled;
      if (desiredPipa !== currentPipa) {
        try {
          await API.put('/api/pipa-config/enable', { company_id: id, enabled: desiredPipa });
        } catch(e) { console.warn('No se pudo cambiar PIPA:', e.message); }
      }
      this.page_companies();
    } catch(e) { Swal.fire('Error',e.message,'error'); }
  },


  async deleteCompany(id, name) {
    const { isConfirmed } = await Swal.fire({title:`⚠️ Eliminar "${name}"?`,text:'Esto eliminará TODOS los datos de la empresa (usuarios, rutas, turnos, etc). Esta acción NO se puede deshacer.',icon:'warning',showCancelButton:true,confirmButtonColor:'#dc2626',confirmButtonText:'Sí, ELIMINAR',background:'#1e293b',color:'#f1f5f9'});
    if (!isConfirmed) return;
    const { value: confirm } = await Swal.fire({title:'Confirma escribiendo el nombre:',input:'text',inputPlaceholder:name,background:'#1e293b',color:'#f1f5f9',confirmButtonColor:'#dc2626',confirmButtonText:'Eliminar definitivamente',showCancelButton:true,
      inputValidator:(v) => { if(v!==name) return 'El nombre no coincide'; }});
    if (confirm) { try { await API.del(`/api/companies/${id}`); Swal.fire({title:'Eliminada',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); this.page_companies(); } catch(e) { Swal.fire('Error',e.message,'error'); } }
  },

  async resetDgPin(id, companyName) {
    const { isConfirmed } = await Swal.fire({
      title: '🔑 Resetear PIN Director',
      html: `¿Generar un nuevo PIN de acceso para el Director General de <b>${companyName}</b>?<br><small style="color:#f59e0b">El PIN anterior quedará inválido.</small>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#d97706',
      confirmButtonText: 'Sí, generar nuevo PIN', cancelButtonText: 'Cancelar',
      background: '#1e293b', color: '#f1f5f9'
    });
    if (!isConfirmed) return;
    try {
      const res = await API.post(`/api/companies/${id}/reset-dg-pin`, {});
      await Swal.fire({
        title: '✅ PIN Generado', background: '#1e293b', color: '#f1f5f9',
        html: `<div style="text-align:left;padding:16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px">
          <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">Empresa:</div>
          <div style="font-size:15px;font-weight:700;margin-bottom:12px">${companyName}</div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">Director General:</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:12px">${res.director_name}</div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">Nuevo PIN de acceso:</div>
          <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#10b981;margin:8px 0">${res.pin}</div>
          <button onclick="navigator.clipboard.writeText('${res.pin}');this.textContent='¡Copiado!';this.style.background='#10b981'" style="margin-top:8px;padding:8px 20px;background:#1e293b;border:1px solid #10b981;color:#10b981;border-radius:8px;cursor:pointer;font-weight:600;width:100%">
            <i class="fas fa-copy"></i> Copiar PIN
          </button>
          <div style="margin-top:10px;font-size:11px;color:#f59e0b"><i class="fas fa-exclamation-triangle"></i> Guarda este PIN, no se mostrará de nuevo.</div>
        </div>`
      });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async toggleCompanyStatus(id, name, currentStatus) {
    const activate = currentStatus !== 'ACTIVE';
    const { isConfirmed } = await Swal.fire({
      title: activate ? '✅ Activar empresa' : '🚫 Desactivar empresa',
      html: `¿Deseas <b>${activate ? 'activar' : 'desactivar'}</b> la empresa <b>${name}</b>?`,
      icon: activate ? 'question' : 'warning',
      showCancelButton: true,
      confirmButtonColor: activate ? '#16a34a' : '#dc2626',
      confirmButtonText: activate ? 'Sí, activar' : 'Sí, desactivar',
      cancelButtonText: 'Cancelar',
      background: '#1e293b', color: '#f1f5f9'
    });
    if (!isConfirmed) return;
    try {
      await API.put(`/api/companies/${id}`, { status: activate ? 'ACTIVE' : 'SUSPENDED' });
      this.page_companies();
      Swal.fire({ toast: true, position: 'top-end', icon: 'success',
        title: activate ? 'Empresa activada' : 'Empresa desactivada',
        showConfirmButton: false, timer: 2000, background: '#1e293b', color: '#fff' });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  // ═══════════ DG INTELLIGENCE DASHBOARD ═══════════
  async page_dg_dashboard() {
    const el = document.getElementById('page-content');
    el.innerHTML = `
      <div id="dg-kpis" class="stats-grid" style="margin-bottom:18px">
        <div style="grid-column:1/-1;text-align:center;color:#64748b;padding:20px"><i class="fas fa-spinner fa-spin"></i> Cargando inteligencia operativa...</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-exclamation-triangle" style="color:#ef4444"></i> Alertas Críticas</h3>
            <button class="btn btn-outline btn-sm" onclick="App.loadDgAlerts()"><i class="fas fa-sync"></i></button>
          </div>
          <div class="card-body" id="dg-alerts" style="max-height:340px;overflow-y:auto">Cargando...</div>
        </div>
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-chart-line" style="color:#a855f7"></i> Tendencia Semanal</h3></div>
          <div class="card-body"><div class="chart-container"><canvas id="dgTrendChart"></canvas></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-brain" style="color:#a855f7"></i> Inteligencia Operativa — Últimos 7 días</h3>
          <button class="btn btn-sm" style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:white" onclick="App.printDgReport()"><i class="fas fa-print"></i> Imprimir / Descargar</button>
        </div>
        <div class="card-body" id="dg-ai-report">Cargando análisis...</div>
      </div>`;
    await Promise.all([this.loadDgSummary(), this.loadDgAlerts(), this.loadDgAiReport()]);
    // Auto-refresh alerts + KPIs every 30 seconds
    if (this._dgRefreshInterval) clearInterval(this._dgRefreshInterval);
    this._dgRefreshInterval = setInterval(() => {
      if (document.getElementById('dg-alerts')) {
        this.loadDgSummary();
        this.loadDgAlerts();
      } else {
        clearInterval(this._dgRefreshInterval);
      }
    }, 30000);
  },

  async loadDgSummary() {
    try {
      const s = await API.get('/api/dg/summary');
      const scoreColor = s.operational_score >= 80 ? '#10b981' : s.operational_score >= 60 ? '#f59e0b' : '#ef4444';
      document.getElementById('dg-kpis').innerHTML = `
        <div class="stat-card" style="border-top:3px solid ${scoreColor}">
          <div class="stat-icon" style="background:rgba(124,58,237,0.15);color:#a855f7"><i class="fas fa-gauge-high"></i></div>
          <div class="stat-value" style="color:${scoreColor}">${s.operational_score}%</div>
          <div class="stat-label">SCORE OPERACIONAL</div>
        </div>
        <div class="stat-card ${s.coverage_pct>=80?'success':'danger'}">
          <div class="stat-icon ${s.coverage_pct>=80?'green':'red'}"><i class="fas fa-map-location-dot"></i></div>
          <div class="stat-value">${s.coverage_pct}%</div>
          <div class="stat-label">COBERTURA RUTAS (${s.covered_routes}/${s.total_routes})</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><i class="fas fa-user-shield"></i></div>
          <div class="stat-value">${s.guards_on_shift}<span style="font-size:16px;color:#64748b">/${s.total_guards}</span></div>
          <div class="stat-label">GUARDIAS EN TURNO</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><i class="fas fa-rotate"></i></div>
          <div class="stat-value">${s.round_compliance_pct}%</div>
          <div class="stat-label">RONDAS HOY (${s.rounds_completed}/${s.rounds_today})</div>
        </div>
        ${s.active_panics > 0 ? `<div class="stat-card danger"><div class="stat-icon red"><i class="fas fa-siren-on"></i></div><div class="stat-value">${s.active_panics}</div><div class="stat-label">🆘 PÁNICO ACTIVO</div></div>` : ''}
        <div class="stat-card ${s.open_incidents>0?'warning':'success'}">
          <div class="stat-icon ${s.open_incidents>0?'yellow':'green'}"><i class="fas fa-triangle-exclamation"></i></div>
          <div class="stat-value">${s.open_incidents}</div>
          <div class="stat-label">INCIDENTES ABIERTOS${s.high_incidents>0?` <span style="color:#ef4444;font-size:11px">(${s.high_incidents} críticos)</span>`:''}</div>
        </div>`;
    } catch(e) { document.getElementById('dg-kpis').innerHTML = `<p style="color:#ef4444">Error KPI: ${e.message}</p>`; }
  },

  async loadDgAlerts() {
    try {
      const alerts = await API.get('/api/dg/critical-alerts');
      const el = document.getElementById('dg-alerts');
      if (!alerts.length) { el.innerHTML = `<div class="empty-state" style="padding:20px"><i class="fas fa-check-circle" style="color:#10b981;font-size:28px"></i><p style="color:#10b981;margin-top:8px">Sin alertas críticas activas</p></div>`; return; }
      const colors = { CRITICAL:'#ef4444', HIGH:'#f59e0b', MEDIUM:'#3b82f6' };
      el.innerHTML = alerts.map(a => {
        const ts = a.time ? (() => { try { const d = new Date(a.time.includes('T')||a.time.includes(' ') ? a.time.replace(' ','T')+'Z' : a.time+'T00:00:00Z'); return d.toLocaleString('es-GT',{timeZone:'America/Guatemala',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}); } catch(e){ return a.time; } })() : '';
        return `
        <div style="display:flex;gap:12px;padding:14px;border-left:4px solid ${colors[a.level]||'#64748b'};margin-bottom:10px;background:rgba(0,0,0,0.25);border-radius:0 10px 10px 0">
          <div style="font-size:22px;min-width:30px;text-align:center;margin-top:2px">${a.icon}</div>
          <div style="flex:1">
            <div style="font-weight:700;font-size:15px;color:#f1f5f9;margin-bottom:4px">${a.title}</div>
            <div style="font-size:13px;color:#cbd5e1;margin-top:2px;line-height:1.5">${a.detail}</div>
            ${(a.lat && a.lng) ? `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:12px;color:#94a3b8;font-family:monospace">📍 ${Number(a.lat).toFixed(6)}, ${Number(a.lng).toFixed(6)}</span>
              <button onclick="navigator.clipboard.writeText('${a.lat},${a.lng}').then(()=>{this.innerHTML='<i class=\'fas fa-check\'></i> Copiado';setTimeout(()=>{this.innerHTML='<i class=\'fas fa-copy\'></i> Copiar GPS'},2000)}).catch(()=>{})" style="background:#1e3a5f;border:1px solid #3b82f6;color:#60a5fa;padding:4px 10px;border-radius:7px;font-size:11px;cursor:pointer"><i class='fas fa-copy'></i> Copiar GPS</button>
              <a href="https://www.google.com/maps?q=${a.lat},${a.lng}" target="_blank" style="background:#0f2d1a;border:1px solid #10b981;color:#10b981;padding:4px 10px;border-radius:7px;font-size:11px;text-decoration:none"><i class='fas fa-map-marker-alt'></i> Ver mapa</a>
            </div>` : ''}
            <div style="font-size:12px;color:#64748b;margin-top:6px"><i class="fas fa-clock"></i> ${ts}</div>
          </div>
          <div style="background:${colors[a.level]||'#64748b'};color:white;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:700;height:fit-content;white-space:nowrap">${a.level}</div>
        </div>`;
      }).join('');
    } catch(e) { document.getElementById('dg-alerts').innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async loadDgAiReport() {
    try {
      const r = await API.get('/api/dg/ai-report');
      // Trend chart
      if (r.trend.length > 0) {
        const ctx = document.getElementById('dgTrendChart');
        if (ctx) {
          new Chart(ctx, {
            type: 'line',
            data: {
              labels: r.trend.map(d => d.day.slice(5)),
              datasets: [
                { label: 'Rondas', data: r.trend.map(d => d.total), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', tension: 0.4, fill: true },
                { label: 'Completadas', data: r.trend.map(d => d.completed), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0.4, fill: true }
              ]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } }, x: { grid: { display: false }, ticks: { color: '#64748b' } } } }
          });
        }
      }
      // AI Report content
      document.getElementById('dg-ai-report').innerHTML = `
        <div style="padding:14px;background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.25);border-radius:10px;margin-bottom:18px">
          <div style="font-size:11px;color:#a855f7;font-weight:700;margin-bottom:6px"><i class="fas fa-robot"></i> ANÁLISIS AUTOMÁTICO</div>
          <div style="font-size:14px;color:#e2e8f0;line-height:1.7">${r.narrative}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px">
          <div>
            <div style="font-size:12px;color:#8b5cf6;font-weight:700;margin-bottom:10px;letter-spacing:1px"><i class="fas fa-ranking-star"></i> RANKING DE GUARDIAS</div>
            <table class="data-table" style="font-size:12px">
              <thead><tr><th>#</th><th>Guardia</th><th>Score</th><th>Rondas</th><th>Estado</th></tr></thead>
              <tbody>${r.ranking.map((g,i) => `<tr>
                <td style="color:#64748b">${i+1}</td>
                <td><b>${g.name}</b></td>
                <td><b style="color:${g.color}">${g.ai_score}/100</b></td>
                <td>${g.completed}/${g.total_rounds}</td>
                <td><span style="background:${g.color}20;color:${g.color};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">${g.rating}</span></td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div>
            <div style="font-size:12px;color:#8b5cf6;font-weight:700;margin-bottom:10px;letter-spacing:1px"><i class="fas fa-route"></i> SALUD DE RUTAS</div>
            ${r.route_health.map(rt => {
              const c = rt.health_pct >= 80 ? '#10b981' : rt.health_pct >= 50 ? '#f59e0b' : '#ef4444';
              return `<div style="margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                  <span style="color:#e2e8f0">${rt.name}</span>
                  <b style="color:${c}">${rt.health_pct}%</b>
                </div>
                <div style="width:100%;height:6px;background:#1e293b;border-radius:3px">
                  <div style="width:${rt.health_pct}%;height:100%;background:${c};border-radius:3px;transition:width 0.8s ease"></div>
                </div>
              </div>`;
            }).join('') || '<p style="color:#475569;font-size:12px">Sin rutas activas</p>'}
          </div>
        </div>

        <div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px;padding:14px">
          <div style="font-size:11px;color:#10b981;font-weight:700;margin-bottom:8px"><i class="fas fa-lightbulb"></i> RECOMENDACIONES IA</div>
          ${r.recommendations.map(rec => `<div style="font-size:13px;color:#e2e8f0;padding:6px 0;border-bottom:1px solid #1e293b">${rec}</div>`).join('')}
        </div>`;
    } catch(e) { document.getElementById('dg-ai-report').innerHTML = `<p>Error AI: ${e.message}</p>`; }
  },

  async printDgReport() {
    try {
      const r = await API.get('/api/dg/weekly-report');
      const s = await API.get('/api/dg/summary');
      const scoreColor = s.operational_score >= 80 ? '#16a34a' : s.operational_score >= 60 ? '#d97706' : '#dc2626';
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reporte Semanal — ${r.company?.name||''}</title>
      <style>body{font-family:Arial,sans-serif;color:#1e293b;padding:30px;max-width:900px;margin:0 auto}h1{color:#1e293b;border-bottom:3px solid #7c3aed;padding-bottom:8px}h2{color:#4c1d95;margin-top:24px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#7c3aed;color:white;padding:8px;text-align:left;font-size:12px}td{padding:8px;border-bottom:1px solid #e2e8f0;font-size:12px}.kpi{display:inline-block;text-align:center;padding:12px 20px;margin:6px;border:2px solid #7c3aed;border-radius:8px;min-width:110px}.kpi b{display:block;font-size:22px;color:#7c3aed}.badge{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}@media print{body{padding:10px}button{display:none}}</style></head>
      <body>
        <h1>🛡️ Reporte Semanal de Operaciones</h1>
        <p><b>Empresa:</b> ${r.company?.name||''} &nbsp;|&nbsp; <b>País:</b> ${r.company?.country||''} &nbsp;|&nbsp; <b>Período:</b> Últimos 7 días &nbsp;|&nbsp; <b>Generado:</b> ${new Date().toLocaleString('es-MX')}</p>
        <div style="margin:16px 0">
          <div class="kpi"><b style="color:${scoreColor}">${s.operational_score}%</b>Score Global</div>
          <div class="kpi"><b>${s.coverage_pct}%</b>Cobertura</div>
          <div class="kpi"><b>${s.guards_on_shift}/${s.total_guards}</b>Guardias</div>
          <div class="kpi"><b>${s.round_compliance_pct}%</b>Rondas</div>
          <div class="kpi"><b>${s.open_incidents}</b>Incidentes</div>
        </div>
        <h2>Desempeño por Guardia</h2>
        <table><thead><tr><th>#</th><th>Guardia</th><th>Rondas</th><th>Completadas</th><th>% Cumplimiento</th><th>Score Prom.</th><th>Días trabajados</th></tr></thead>
        <tbody>${r.guards.map((g,i)=>`<tr><td>${i+1}</td><td><b>${g.name}</b></td><td>${g.total_rounds}</td><td>${g.completed}</td><td><b style="color:${g.compliance_pct>=80?'#16a34a':g.compliance_pct>=60?'#d97706':'#dc2626'}">${g.compliance_pct}%</b></td><td>${g.avg_score}</td><td>${g.days_worked}</td></tr>`).join('')}</tbody></table>
        <h2>Estado de Rutas</h2>
        <table><thead><tr><th>Ruta</th><th>Días Activos</th><th>Total Rondas</th><th>Completadas</th></tr></thead>
        <tbody>${r.routes.map(rt=>`<tr><td>${rt.name}</td><td>${rt.active_days}</td><td>${rt.rounds}</td><td>${rt.completed}</td></tr>`).join('')}</tbody></table>
        <h2>Incidentes de la Semana (${r.incidents.length})</h2>
        ${r.incidents.length ? `<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Gravedad</th><th>Título</th><th>Reportado por</th><th>Estado</th></tr></thead>
        <tbody>${r.incidents.map(i=>`<tr><td>${i.created_at?.slice(0,10)||''}</td><td>${i.incident_type}</td><td>${i.severity}</td><td>${i.title}</td><td>${i.reporter}</td><td>${i.status}</td></tr>`).join('')}</tbody></table>` : '<p>Sin incidentes registrados.</p>'}
        <p style="margin-top:30px;color:#64748b;font-size:11px;border-top:1px solid #e2e8f0;padding-top:10px">Reporte generado automáticamente por SISDEL RONDÍN • ${new Date().toLocaleString('es-MX')}</p>
        <script>window.onload=()=>window.print()<\/script>
      </body></html>`;
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  // ═══════════ SUPERVISORES ═══════════

  async page_supervisores() {
    const el = document.getElementById('page-content');
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-user-tie"></i> Supervisores</h3>
          <button class="btn btn-primary btn-sm" onclick="App.showSupervisorModal()"><i class="fas fa-plus"></i> Nuevo Supervisor</button>
        </div>
        <div class="card-body" id="supervisores-list">Cargando...</div>
      </div>`;
    await this.loadSupervisores();
  },

  async loadSupervisores() {
    try {
      const supervisors = await API.get('/api/users/supervisors');
      const el = document.getElementById('supervisores-list');
      if (!supervisors.length) {
        el.innerHTML = `<div class="empty-state"><i class="fas fa-user-tie"></i><p>No hay supervisores registrados.</p></div>`;
        return;
      }
      el.innerHTML = supervisors.map(s => `
        <div style="border:1px solid #334155;border-radius:12px;padding:18px;margin-bottom:14px;background:#0f172a">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:12px">
              <div class="user-avatar" style="background:linear-gradient(135deg,#7c3aed,#a855f7);font-size:16px">${s.name[0]}</div>
              <div>
                <b style="color:#f1f5f9;font-size:15px">${s.name}</b>
                ${s.pin_plain ? `<br><span style="font-family:monospace;font-size:12px;color:#10b981;letter-spacing:2px">🔑 ${s.pin_plain}</span>` : ''}
                ${s.phone ? `<br><small style="color:#64748b"><i class="fas fa-phone"></i> ${s.phone}</small>` : ''}
              </div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <span class="badge-status ${s.status==='ACTIVE'?'badge-active':'badge-danger'}">${s.status}</span>
              <button class="btn btn-primary btn-sm" onclick="App.assignGuardToSupervisor('${s.id}','${s.name}')"><i class="fas fa-user-plus"></i> Asignar Guardia</button>
            </div>
          </div>
          <div style="background:#0c1222;border:1px solid #1e3a5f;border-radius:8px;padding:12px">
            <div style="font-size:11px;color:#8b5cf6;font-weight:700;margin-bottom:8px"><i class="fas fa-users"></i> AGENTES ASIGNADOS (${s.guards.length})</div>
            ${s.guards.length ? s.guards.map(g => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid #1e293b;font-size:13px">
                <div><i class="fas fa-user-shield" style="color:#3b82f6;margin-right:6px"></i><b style="color:#e2e8f0">${g.name}</b>${g.phone?` <small style="color:#64748b">· ${g.phone}</small>`:''}</div>
                <button class="btn btn-outline btn-sm" style="padding:3px 8px;color:#ef4444;border-color:#ef4444;font-size:11px" onclick="App.unassignGuard('${g.id}')" title="Quitar"><i class="fas fa-times"></i></button>
              </div>`).join('') : '<div style="text-align:center;color:#475569;font-size:13px;padding:8px"><i class="fas fa-user-slash"></i> Sin agentes asignados</div>'}
          </div>
        </div>`).join('');
    } catch(e) { document.getElementById('supervisores-list').innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async showSupervisorModal() {
    const autoPin = String(Math.floor(100000 + Math.random() * 900000));
    const { value } = await Swal.fire({
      title: '👔 Nuevo Supervisor', background: '#1e293b', color: '#f1f5f9', width: 500,
      html: `
        <input id="sv-name" class="swal2-input" placeholder="Nombre completo" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="sv-phone" class="swal2-input" placeholder="Teléfono" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="sv-email" class="swal2-input" placeholder="Correo electrónico" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <input id="sv-pin" class="swal2-input" value="${autoPin}" maxlength="6" placeholder="PIN de acceso" style="margin:0;flex:1;background:#0f172a;border-color:#334155;color:#10b981;font-weight:bold;letter-spacing:4px">
          <button type="button" class="btn btn-outline" style="padding:10px" onclick="navigator.clipboard.writeText(document.getElementById('sv-pin').value);Swal.fire({toast:true,position:'top-end',icon:'success',title:'Copiado',showConfirmButton:false,timer:1200,background:'#1e293b',color:'#fff'})"><i class="fas fa-copy"></i></button>
        </div>
        <div style="margin-top:10px;padding:10px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.3);border-radius:8px;font-size:12px;color:#a855f7;text-align:left">
          <i class="fas fa-info-circle"></i> El supervisor verá la misma plataforma que el Director General. Guarda su PIN.
        </div>`,
      confirmButtonText: '<i class="fas fa-save"></i> Crear Supervisor', confirmButtonColor: '#7c3aed', showCancelButton: true,
      preConfirm: () => {
        const name = document.getElementById('sv-name').value;
        const pin = document.getElementById('sv-pin').value;
        if (!name || !/^\d{6}$/.test(pin)) { Swal.showValidationMessage('Nombre y PIN de 6 dígitos son obligatorios'); return false; }
        return { name, phone: document.getElementById('sv-phone').value, email: document.getElementById('sv-email').value, pin, role: 'SUPERVISOR' };
      }
    });
    if (!value) return;
    try {
      const res = await API.post('/api/users', value);
      const pin = res.pin_raw || value.pin;
      await Swal.fire({
        title: '✅ Supervisor Creado', background: '#1e293b', color: '#f1f5f9',
        html: `<div style="text-align:left;padding:14px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px">
          <b style="font-size:15px">${value.name}</b>
          <div style="margin-top:10px;font-size:13px;color:#94a3b8">PIN de acceso:</div>
          <div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#10b981">${pin}</div>
          <div style="margin-top:8px;font-size:11px;color:#f59e0b"><i class="fas fa-exclamation-triangle"></i> Entrega este PIN al supervisor. No se mostrará de nuevo.</div>
        </div>`
      });
      this.loadSupervisores();
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async assignGuardToSupervisor(supervisorId, supervisorName) {
    try {
      const users = await API.get('/api/users');
      const guards = users.filter(u => u.role === 'GUARDIA' && u.status === 'ACTIVE');
      if (!guards.length) { Swal.fire('Sin guardias', 'No hay guardias activos disponibles.', 'info'); return; }
      const opts = guards.map(g => `<option value="${g.id}">${g.name}${g.supervisor_id === supervisorId ? ' ✓' : ''}</option>`).join('');
      const { value } = await Swal.fire({
        title: `👔 Asignar Guardia a<br><small>${supervisorName}</small>`,
        background: '#1e293b', color: '#f1f5f9',
        html: `<select id="sv-guard" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;width:100%">${opts}</select>`,
        confirmButtonText: 'Asignar', confirmButtonColor: '#7c3aed', showCancelButton: true,
        preConfirm: () => document.getElementById('sv-guard').value
      });
      if (!value) return;
      await API.put(`/api/users/${value}/assign-supervisor`, { supervisor_id: supervisorId });
      this.loadSupervisores();
      Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Guardia asignado', showConfirmButton: false, timer: 1800, background: '#1e293b', color: '#fff' });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async unassignGuard(guardId) {
    try {
      await API.put(`/api/users/${guardId}/assign-supervisor`, { supervisor_id: null });
      this.loadSupervisores();
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  // ═══════════ DASHBOARD ═══════════
  async page_dashboard() {
    if (API.user.role === 'DIRECTOR_GENERAL') { return this.page_dg_dashboard(); }
    const el = document.getElementById('page-content');
    el.innerHTML = `<div class="stats-grid" id="stats-grid">${t('loading')}</div>
      <div class="grid-2"><div class="card"><div class="card-header"><h3>${t('dash_compliance')}</h3></div><div class="card-body"><div class="chart-container"><canvas id="complianceChart"></canvas></div></div></div>
      <div class="card"><div class="card-header"><h3>${t('dash_recent')}</h3></div><div class="card-body" id="recent-activity">${t('loading')}</div></div></div>`;
    try {
      const [stats, compliance, activity] = await Promise.all([
        API.get('/api/dashboard/stats'), API.get('/api/dashboard/compliance'), API.get('/api/dashboard/recent-activity')
      ]);
      document.getElementById('stats-grid').innerHTML = `
        <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-user-shield"></i></div><div class="stat-value">${stats.total_guards}</div><div class="stat-label">${t('dash_active_guards')}</div></div>
        <div class="stat-card success"><div class="stat-icon green"><i class="fas fa-clock"></i></div><div class="stat-value">${stats.active_shifts}</div><div class="stat-label">${t('dash_active_shifts')}</div></div>
        <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-rotate"></i></div><div class="stat-value">${stats.today_rounds}</div><div class="stat-label">${t('dash_today_rounds')}</div></div>
        <div class="stat-card warning"><div class="stat-icon yellow"><i class="fas fa-star"></i></div><div class="stat-value">${Math.round(stats.avg_score)}%</div><div class="stat-label">${t('dash_avg_score')}</div></div>
        <div class="stat-card danger"><div class="stat-icon red"><i class="fas fa-bell"></i></div><div class="stat-value">${stats.pending_alerts}</div><div class="stat-label">${t('dash_pending_alerts')}</div></div>
        <div class="stat-card"><div class="stat-icon red"><i class="fas fa-triangle-exclamation"></i></div><div class="stat-value">${stats.open_incidents}</div><div class="stat-label">${t('dash_open_incidents')}</div></div>`;
      // Compliance chart
      if (compliance.length > 0) {
        new Chart(document.getElementById('complianceChart'), {
          type: 'bar', data: { labels: compliance.map(c=>c.name), datasets: [{ label: '%', data: compliance.map(c=>c.compliance_pct||0), backgroundColor: 'rgba(59,130,246,0.6)', borderRadius: 6 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { max: 100, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { display: false } } } }
        });
      }
      // Recent activity
      document.getElementById('recent-activity').innerHTML = activity.length ? activity.map(a => `<div style="padding:10px 0;border-bottom:1px solid var(--border-color);font-size:13px">
        <span class="badge-status ${a.type==='EMERGENCY'?'badge-danger':a.type==='WARNING'?'badge-pending':'badge-info'}">${a.type}</span>
        <span style="margin-left:8px">${a.title}</span><br><small style="color:var(--text-muted)">${new Date(a.created_at+'Z').toLocaleString('es-GT',{timeZone:'America/Guatemala'})}</small></div>`).join('') : `<div class="empty-state"><i class="fas fa-check-circle"></i><p>${t('no_data')}</p></div>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  // ═══════════ MONITORING MAP ═══════════
  async page_monitoring() {
    const el = document.getElementById('page-content');
    // Load routes for selector
    let routes = [];
    try { routes = await API.get('/api/routes'); } catch(e) {}

    el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header" style="flex-wrap:wrap;gap:12px">
        <h3><i class="fas fa-satellite-dish"></i> Monitoreo en Tiempo Real</h3>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <select id="mon-route-sel" onchange="App.loadMonitoringRoute()" style="background:#0f172a;border:1px solid #334155;color:#f1f5f9;padding:8px 14px;border-radius:10px;font-size:13px;min-width:200px">
            <option value="">— Todas las rutas —</option>
            ${routes.map(r=>`<option value="${r.id}" data-color="${r.color||'#3b82f6'}" ${r.id === (App._currentMonitorRouteId||'') ? 'selected' : ''}>${r.name}</option>`).join('')}
          </select>
          <button onclick="App.loadMonitoringRoute()" style="background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);color:#60a5fa;padding:8px 14px;border-radius:10px;font-size:13px;cursor:pointer"><i class="fas fa-sync"></i> Actualizar</button>
        </div>
      </div>
      <div class="card-body" style="padding:0">
        <div style="position:relative">
          <div class="map-container" id="live-map" style="height:650px;border-radius:0 0 12px 12px"></div>
          <!-- Leyenda -->
          <div style="position:absolute;bottom:20px;left:12px;z-index:1000;background:rgba(15,23,42,0.9);backdrop-filter:blur(8px);border:1px solid #334155;border-radius:12px;padding:12px 16px;font-size:12px;color:#f1f5f9">
            <div style="font-weight:700;margin-bottom:8px;color:#a855f7;letter-spacing:1px">LEYENDA</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><div style="width:14px;height:14px;border-radius:50%;background:#10b981;border:2px solid white"></div> Guardia activo</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><div style="width:14px;height:14px;border-radius:50%;background:#64748b;border:2px solid white"></div> Guardia inactivo</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><div style="width:14px;height:14px;border-radius:4px;background:#f59e0b;border:2px solid white;font-size:10px;text-align:center;line-height:10px;color:#000;font-weight:700">1</div> Checkpoint</div>
            <div style="display:flex;align-items:center;gap:8px"><div style="width:20px;height:3px;background:linear-gradient(90deg,#a855f7,#3b82f6);border-radius:2px"></div> Ruta</div>
          </div>
          <!-- Panel de info lateral -->
          <div id="mon-info-panel" style="position:absolute;top:12px;right:12px;z-index:1000;background:rgba(15,23,42,0.92);backdrop-filter:blur(8px);border:1px solid #334155;border-radius:12px;padding:14px;font-size:12px;color:#f1f5f9;min-width:180px;display:none">
            <div id="mon-info-title" style="font-weight:700;font-size:13px;margin-bottom:8px;color:#a855f7"></div>
            <div id="mon-info-body"></div>
          </div>
        </div>
      </div>
    </div>`;

    // Init map
    await new Promise(r => setTimeout(r, 100));
    this.map = L.map('live-map', { minZoom: 2, maxZoom: 22, scrollWheelZoom: true, zoomControl: true }).setView([14.8594, -91.536], 14);
    
    // Map Layers
    const baseLayers = {
      "Modo Oscuro": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© CARTO', maxZoom: 22, maxNativeZoom: 19 }),
      "Modo Claro": L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© CARTO', maxZoom: 22, maxNativeZoom: 19 }),
      "Calles": L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { attribution: '© Google', maxZoom: 22, maxNativeZoom: 20 }),
      "Satélite": L.tileLayer('https://mt1.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', { attribution: '© Google', maxZoom: 22, maxNativeZoom: 20 })
    };
    
    // Default
    baseLayers["Calles"].addTo(this.map);
    L.control.layers(baseLayers, null, { position: 'bottomright' }).addTo(this.map);
    
    L.control.zoom({ position: 'topleft' }).addTo(this.map);
    this._checkpointMarkers = [];
    this._routePolyline = null;

    // Load live guards
    try {
      const guards = await API.get('/api/tracking/live');
      guards.forEach(g => this.updateGuardMarker(g));
      if (guards.length > 0) this.map.fitBounds(guards.map(g=>[g.latitude,g.longitude]), {padding:[60,60]});
    } catch(e) {}
    // Auto-load the previously selected route if available
    if (this._currentMonitorRouteId) this.loadMonitoringRoute();
  },

  async loadMonitoringRoute() {
    if (!this.map) return;
    const sel = document.getElementById('mon-route-sel');
    if (!sel) return;
    const routeId = sel.value;
    const routeColor = sel.options[sel.selectedIndex]?.dataset?.color || '#a855f7';

    // Clear previous checkpoint markers and polyline
    (this._checkpointMarkers || []).forEach(m => m.remove());
    this._checkpointMarkers = [];
    if (this._routePolyline) { this._routePolyline.remove(); this._routePolyline = null; }
    (this._allRoutesPolylines || []).forEach(p => p.remove());
    this._allRoutesPolylines = [];
    (this._allRoutesCheckpoints || []).forEach(m => m.remove());
    this._allRoutesCheckpoints = [];

    const infoPanel = document.getElementById('mon-info-panel');
    const infoTitle = document.getElementById('mon-info-title');
    const infoBody = document.getElementById('mon-info-body');

    if (!routeId) {
      if (infoPanel) infoPanel.style.display = 'none';
      try {
        const routes = await API.get('/api/routes');
        const routesDetails = await Promise.all(routes.map(r => API.get('/api/routes/' + r.id).catch(() => null)));
        const validRoutes = routesDetails.filter(r => r && r.checkpoints && r.checkpoints.length > 0);
        let allCps = [];
        validRoutes.forEach(route => {
            const cps = route.checkpoints || [];
            allCps = allCps.concat(cps);
            const rColor = route.color || '#a855f7';
            if (cps.length > 1) {
                const latlngs = cps.map(cp => [parseFloat(cp.latitude), parseFloat(cp.longitude)]);
                const routeLine = L.polyline(latlngs, {
                  color: rColor, weight: 3, opacity: 0.7,
                  dashArray: '8, 6'
                }).addTo(this.map);
                this._allRoutesPolylines.push(routeLine);
            }
            cps.forEach((cp, i) => {
                const cir = L.circleMarker([parseFloat(cp.latitude), parseFloat(cp.longitude)], {
                    radius: 5, color: '#fff', fillColor: rColor, fillOpacity: 1, weight: 1
                }).addTo(this.map).bindPopup(`<b>${route.name}</b><br>${cp.name}`);
                this._allRoutesCheckpoints.push(cir);
            });
        });
        if (allCps.length > 0) {
            this.map.fitBounds(allCps.map(cp => [parseFloat(cp.latitude), parseFloat(cp.longitude)]), {padding:[40,40]});
        }
      } catch(e) { console.error('Error loading all routes', e); }
      return;
    }

    try {
      const route = await API.get(`/api/routes/${routeId}`);
      const cps = route.checkpoints || [];

      // Load active shift to determine visit window
      const assignments = await API.get('/api/route-assignments?route_id=' + routeId).catch(()=>[]);
      const activeAssignment = assignments.find(a => App.isAssignmentActiveNow(a));
      let shiftStartMs = 0;
      if (activeAssignment) {
        shiftStartMs = new Date(activeAssignment.date_start + 'T' + (activeAssignment.hour_start||'00:00') + ':00').getTime();
      }

      // Load today's visits and filter to current shift
      const today = new Date().toLocaleDateString('en-CA');
      const todayVisits = await API.get('/api/checkpoint-visits/by-route/' + routeId + '?date=' + today).catch(()=>[]);
      const visitCountMap = {};
      todayVisits.forEach(v => {
        const arrivedMs = new Date(v.arrived_at.replace(' ','T')).getTime();
        if (!activeAssignment || arrivedMs >= shiftStartMs) {
          visitCountMap[v.checkpoint_id] = (visitCountMap[v.checkpoint_id] || 0) + 1;
        }
      });

      // Draw polyline for the route path
      if (cps.length > 1) {
        const latlngs = cps.map(cp => [parseFloat(cp.latitude), parseFloat(cp.longitude)]);
        this._routePolyline = L.polyline(latlngs, {
          color: routeColor, weight: 3, opacity: 0.7,
          dashArray: '8, 6'
        }).addTo(this.map);
      }

      // Draw checkpoint markers — color by visit status, number = visit count
      cps.forEach((cp, i) => {
        const visitCount = visitCountMap[cp.id] || 0;
        const pinColor = visitCount > 0 ? '#10b981' : '#3b82f6';
        const icon = L.divIcon({ className: '', html: `
          <div style="position:relative;width:36px;height:44px">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 44" width="36" height="44">
              <ellipse cx="18" cy="42" rx="7" ry="3" fill="rgba(0,0,0,0.35)"/>
              <path d="M18 2C10.268 2 4 8.268 4 16c0 10 14 26 14 26S32 26 32 16C32 8.268 25.732 2 18 2z" fill="${pinColor}" stroke="white" stroke-width="2"/>
              <circle cx="18" cy="16" r="8" fill="white" opacity="0.95"/>
              <text x="18" y="21" text-anchor="middle" font-size="11" font-weight="900" fill="#000">${visitCount}</text>
            </svg>
            <div style="position:absolute;top:-26px;left:50%;transform:translateX(-50%);background:#fff;color:#0f172a;padding:3px 8px;border-radius:5px;font-size:12px;white-space:nowrap;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.5)">${cp.name}</div>
          </div>
        `, iconSize: [36,44], iconAnchor: [18,44] });
        const m = L.marker([parseFloat(cp.latitude), parseFloat(cp.longitude)], { icon })
          .addTo(this.map)
          .bindPopup(`<b>${cp.name}</b><br>Visitas en turno: <b style="color:${pinColor}">${visitCount}</b><br>Riesgo: <b>${cp.risk_level}</b><br>Radio: ${cp.radius_meters}m`);
        this._checkpointMarkers.push(m);
      });

      // Fit map to route
      if (cps.length > 0) {
        const bounds = cps.map(cp=>[parseFloat(cp.latitude),parseFloat(cp.longitude)]);
        this.map.fitBounds(bounds, { padding: [60,60] });
      }

      // Update info panel
      if (infoPanel && infoTitle && infoBody) {
        infoPanel.style.display = 'block';
        infoTitle.textContent = route.name;
        infoBody.innerHTML = `
          <div style="color:#94a3b8;margin-bottom:6px">${route.description||''}</div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#64748b">Checkpoints</span><b>${cps.length}</b></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#64748b">Duración est.</span><b>${route.estimated_duration_min||'—'} min</b></div>
          <div style="margin-top:8px;font-size:11px;color:#64748b">Checkpoints:</div>
          ${cps.map((cp,i)=>{
            const vc = visitCountMap[cp.id] || 0;
            const col = vc > 0 ? '#10b981' : '#3b82f6';
            return `<div style="padding:3px 0;border-bottom:1px solid #1e293b;font-size:11px;display:flex;justify-content:space-between"><span><span style="color:${col}">${i+1}.</span> ${cp.name}</span><b style="color:${col}">${vc} vis.</b></div>`;
          }).join('')}`;
      }
    } catch(e) {
      console.error('Route load error:', e);
    }
  },


  updateGuardMarker(data) {
    if (!this.map) return;
    const color = data.shift_status === 'ACTIVE' ? '#10b981' : '#64748b';
    const isWalking = data.shift_status === 'ACTIVE';
    
    const iconHtml = `
      <div style="position:relative;width:40px;height:48px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 44" width="40" height="48" style="filter:drop-shadow(0 4px 6px rgba(0,0,0,0.5))">
          <ellipse cx="18" cy="42" rx="7" ry="3" fill="rgba(0,0,0,0.35)"/>
          <path d="M18 2C10.268 2 4 8.268 4 16c0 10 14 26 14 26S32 26 32 16C32 8.268 25.732 2 18 2z" fill="${color}" stroke="white" stroke-width="2"/>
        </svg>
        <div style="position:absolute;top:7px;left:0;width:100%;text-align:center;color:white;font-size:16px;">
          <i class="fas fa-person-walking"></i>
        </div>
        <div style="position:absolute;top:-24px;left:50%;transform:translateX(-50%);background:#fff;color:#0f172a;padding:3px 8px;border-radius:5px;font-size:11px;white-space:nowrap;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.5)">
          ${(data.name||'?').split(' ')[0]}
        </div>
      </div>
    `;
    
    const icon = L.divIcon({ className: '', html: iconHtml, iconSize: [40, 48], iconAnchor: [20, 48] });

    if (this.guardMarkers[data.user_id]) {
      this.guardMarkers[data.user_id].setLatLng([data.latitude, data.longitude]);
      this.guardMarkers[data.user_id].setIcon(icon);
      this.guardMarkers[data.user_id].getPopup().setContent(`<b>${data.name}</b><br>${data.route_name||''}<br>🔋 ${data.battery_level||'?'}%`);
    } else {
      this.guardMarkers[data.user_id] = L.marker([data.latitude, data.longitude], { icon }).addTo(this.map).bindPopup(`<b>${data.name}</b><br>${data.route_name||''}<br>🔋 ${data.battery_level||'?'}%`);
    }
  },

  // ═══════════ ROUTES ═══════════
  async page_routes() {
    const el = document.getElementById('page-content');
    el.innerHTML = `<div class="card"><div class="card-header"><h3>${t('nav_routes')}</h3><button class="btn btn-primary btn-sm" onclick="App.showRouteModal()"><i class="fas fa-plus"></i> ${t('create')}</button></div><div class="card-body table-container"><table class="data-table"><thead><tr><th>${t('name')}</th><th>Checkpoints</th><th>Duración</th><th>${t('status')}</th><th>${t('actions')}</th></tr></thead><tbody id="routes-tbody">${t('loading')}</tbody></table></div></div>`;
    try {
      const routes = await API.get('/api/routes');
      document.getElementById('routes-tbody').innerHTML = routes.length ? routes.map(r => `<tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${r.color};margin-right:8px"></span>${r.name}</td>
        <td>${r.checkpoint_count} puntos</td><td>${r.estimated_duration_min} min</td>
        <td><span class="badge-status ${r.status==='ACTIVE'?'badge-active':'badge-danger'}">${r.status}</span></td>
        <td><button class="btn btn-outline btn-sm" onclick="App.viewRoute('${r.id}')"><i class="fas fa-eye"></i></button></td></tr>`).join('') : `<tr><td colspan="5" class="empty-state">${t('no_data')}</td></tr>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async showRouteModal() {
    const { value } = await Swal.fire({
      title: 'Nueva Ruta', background: '#1e293b', color: '#f1f5f9',
      html: `<input id="swal-name" class="swal2-input" placeholder="Nombre de la ruta" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <textarea id="swal-desc" class="swal2-textarea" placeholder="Descripción" style="background:#0f172a;border-color:#334155;color:#f1f5f9"></textarea>
        <input id="swal-dur" class="swal2-input" type="number" placeholder="Duración (min)" value="30" style="background:#0f172a;border-color:#334155;color:#f1f5f9">`,
      confirmButtonText: t('save'), showCancelButton: true, cancelButtonText: t('cancel'),
      preConfirm: () => ({ name: document.getElementById('swal-name').value, description: document.getElementById('swal-desc').value, estimated_duration_min: parseInt(document.getElementById('swal-dur').value) || 30 })
    });
    if (value) { try { await API.post('/api/routes', value); this.page_routes(); Swal.fire({title:t('success'),icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); } catch(e) { Swal.fire('Error',e.message,'error'); } }
  },

  async viewRoute(id) {
    try {
      const route = await API.get(`/api/routes/${id}`);
      let html = `<h4>${route.name}</h4><p>${route.description||''}</p><hr style="border-color:var(--border-color);margin:12px 0"><h5>Checkpoints (${route.checkpoints.length}):</h5>`;
      route.checkpoints.forEach((cp,i) => { html += `<div style="padding:8px 0;border-bottom:1px solid var(--border-color)"><b>${i+1}. ${cp.name}</b> <span class="badge-status badge-info">${cp.checkpoint_type}</span> <span class="badge-status ${cp.risk_level==='HIGH'||cp.risk_level==='CRITICAL'?'badge-danger':'badge-active'}">${cp.risk_level}</span><br><small>📍 ${cp.latitude}, ${cp.longitude} | Radio: ${cp.radius_meters}m</small></div>`; });
      Swal.fire({ title: 'Ruta', html, background: '#1e293b', color: '#f1f5f9', width: 600, confirmButtonText: 'Cerrar' });
    } catch(e) { Swal.fire('Error',e.message,'error'); }
  },

  // ═══════════ USERS ═══════════
  async page_users() {
    const el = document.getElementById('page-content');
    el.innerHTML = `<div class="card"><div class="card-header"><h3>${t('nav_users')}</h3><button class="btn btn-primary btn-sm" onclick="App.showUserModal()"><i class="fas fa-plus"></i> ${t('create')}</button></div><div class="card-body table-container"><table class="data-table"><thead><tr><th>${t('name')}</th><th>Email</th><th>${t('role')}</th><th>${t('status')}</th><th>${t('actions')}</th></tr></thead><tbody id="users-tbody">${t('loading')}</tbody></table></div></div>`;
    try {
      const users = await API.get('/api/users');
      document.getElementById('users-tbody').innerHTML = users.map(u => `<tr>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="user-avatar" style="width:32px;height:32px;font-size:12px">${u.name[0]}</div>${u.name}</div></td>
        <td>${u.email||'-'}</td><td><span class="badge-status badge-info">${u.role}</span></td>
        <td><span class="badge-status ${u.status==='ACTIVE'?'badge-active':'badge-danger'}">${u.status}</span></td>
        <td><button class="btn btn-outline btn-sm" onclick="App.editUser('${u.id}')"><i class="fas fa-edit"></i></button></td></tr>`).join('');
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async showUserModal() {
    const { value } = await Swal.fire({
      title: 'Nuevo Usuario', background: '#1e293b', color: '#f1f5f9',
      html: `<input id="swal-name" class="swal2-input" placeholder="${t('name')}" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="swal-email" class="swal2-input" placeholder="Email" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="swal-phone" class="swal2-input" placeholder="Teléfono" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="swal-pin" class="swal2-input" placeholder="PIN (6 dígitos)" maxlength="6" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <select id="swal-role" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;border-radius:4px;width:100%">
          <option value="GUARDIA">${t('role_guard')}</option><option value="SUPERVISOR">${t('role_supervisor')}</option>
          <option value="JEFE_GUARDIA">${t('role_chief')}</option><option value="ADMIN">${t('role_admin')}</option>
          <option value="OPERADOR_PIPA">🚛 Operador de Pipa</option></select>`,
      confirmButtonText: t('save'), showCancelButton: true, cancelButtonText: t('cancel'),
      preConfirm: () => ({ name: document.getElementById('swal-name').value, email: document.getElementById('swal-email').value, phone: document.getElementById('swal-phone').value, pin: document.getElementById('swal-pin').value, role: document.getElementById('swal-role').value })
    });
    if (value) { try { await API.post('/api/users', value); this.page_users(); Swal.fire({title:t('success'),icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); } catch(e) { Swal.fire('Error',e.message,'error'); } }
  },

  editUser(id) { Swal.fire({title:'Editar usuario',text:'Proximamente',icon:'info',background:'#1e293b',color:'#f1f5f9'}); },

  // ═══════════ GUARDIAS (PERFILES EXTENDIDOS) ═══════════
  async page_guardias() {
    const el = document.getElementById('page-content');
    el.innerHTML = `<div class="card"><div class="card-header"><h3><i class="fas fa-user-shield"></i> Expediente de Guardias</h3><button class="btn btn-primary btn-sm" onclick="App.showGuardiaModal()"><i class="fas fa-plus"></i> Nuevo Guardia</button></div><div class="card-body table-container"><table class="data-table"><thead><tr><th>Nombre</th><th>Teléfono</th><th>Tipo Sangre</th><th>Edad/Sexo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody id="guardias-tbody">${t('loading')}</tbody></table></div></div>`;
    try {
      const users = await API.get('/api/users');
      const guardias = users.filter(u => u.role === 'GUARDIA');
      
      document.getElementById('guardias-tbody').innerHTML = guardias.length ? guardias.map(u => {
        let profile = {};
        try { profile = JSON.parse(u.profile || '{}'); } catch(e) {}
        return `<tr>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="user-avatar" style="width:32px;height:32px;font-size:12px;background:rgba(59,130,246,0.2);color:#3b82f6">${u.name[0]}</div><div><b>${u.name}</b><br><span style="font-family:monospace;font-weight:bold;letter-spacing:2px;color:#10b981;font-size:12px">${profile.access_code||''}</span></div></div></td>
        <td>${u.phone||'-'}</td><td>${profile.blood_type||'-'}</td><td>${profile.age||'-'} años / ${profile.gender||'-'}</td>
        <td><span class="badge-status ${u.status==='ACTIVE'?'badge-active':'badge-danger'}">${u.status}</span></td>
        <td><button class="btn btn-outline btn-sm" onclick="App.viewGuardia('${u.id}')"><i class="fas fa-eye"></i> Perfil</button></td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty-state">${t('no_data')}</td></tr>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async showGuardiaModal() {
    // Obtener primera letra del nombre de la empresa
    let companyLetter = 'X';
    try {
      const company = await API.get('/api/companies');
      if (company && company.name) companyLetter = company.name[0].toUpperCase();
    } catch(e) {}
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const autoPin = companyLetter + letters[Math.floor(Math.random()*26)] + letters[Math.floor(Math.random()*26)] + letters[Math.floor(Math.random()*26)] + Math.floor(Math.random()*10) + Math.floor(Math.random()*10);

    const { value } = await Swal.fire({
      title: '🛡️ Registrar Guardia', background: '#1e293b', color: '#f1f5f9', width: 700,
      html: `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:left">
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Nombre completo</label><input id="g-name" class="swal2-input" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Teléfono / Celular</label><input id="g-phone" type="tel" class="swal2-input" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          <div style="grid-column:1/-1"><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Número de Documento de Identificación (DPI/INE)</label><input id="g-docid" class="swal2-input" placeholder="Ej: 1234567890101" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Código de Acceso</label><input id="g-pin" type="text" maxlength="6" class="swal2-input" value="${autoPin}" readonly style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#10b981;font-weight:bold;letter-spacing:4px;cursor:default"></div>
          <div style="display:flex;align-items:flex-end"><button type="button" class="btn btn-outline" style="padding:10px;width:100%;height:48px" onclick="navigator.clipboard.writeText(document.getElementById('g-pin').value); Swal.fire({toast:true,position:'top-end',icon:'success',title:'Código copiado',showConfirmButton:false,timer:1500,background:'#1e293b',color:'#fff'})"><i class="fas fa-copy"></i> Copiar Código</button></div>
          
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Tipo de Sangre</label><select id="g-blood" class="swal2-select" style="margin:0;padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px"><option value="">Seleccionar...</option><option>O+</option><option>O-</option><option>A+</option><option>A-</option><option>B+</option><option>B-</option><option>AB+</option><option>AB-</option></select></div>
          
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Edad</label><input id="g-age" type="number" class="swal2-input" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Sexo</label><select id="g-gender" class="swal2-select" style="margin:0;padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px"><option value="Masculino">Masculino</option><option value="Femenino">Femenino</option></select></div>
          
          <div style="grid-column:1/-1"><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Dirección permanente</label><input id="g-address" class="swal2-input" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          <div style="grid-column:1/-1"><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Familiar para Contacto en Emergencia (Nombre y Tel)</label><input id="g-fam" class="swal2-input" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Grado Académico</label><select id="g-academic" class="swal2-select" style="margin:0;padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px"><option>Secundaria</option><option>Preparatoria/Bachillerato</option><option>Técnico</option><option>Licenciatura Trunca</option><option>Licenciatura</option><option>Ninguno</option></select></div>
          <div><label style="font-size:11px;color:#94a3b8;font-weight:bold;margin-left:4px">Alergias o Condiciones médicas</label><input id="g-allergies" class="swal2-input" placeholder="Ninguna" style="margin:0;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
        </div>
      `,
      confirmButtonText: '<i class="fas fa-save"></i> Guardar Guardia', confirmButtonColor: '#3b82f6', showCancelButton: true, cancelButtonText: t('cancel'),
      preConfirm: () => {
        const name = document.getElementById('g-name').value;
        const phone = document.getElementById('g-phone').value;
        const pin = document.getElementById('g-pin').value;
        const docid = document.getElementById('g-docid').value;
        if (!name || pin.length !== 6) { Swal.showValidationMessage('El nombre y el PIN de 6 dígitos son obligatorios'); return false; }
        if (!docid) { Swal.showValidationMessage('El Documento de Identificación es obligatorio'); return false; }
        
        return { 
          name, phone, pin, role: 'GUARDIA', email: '', document_id: docid,
          profile: {
            access_code: pin,
            blood_type: document.getElementById('g-blood').value,
            age: document.getElementById('g-age').value,
            gender: document.getElementById('g-gender').value,
            address: document.getElementById('g-address').value,
            emergency_contact: document.getElementById('g-fam').value,
            academic_degree: document.getElementById('g-academic').value,
            allergies: document.getElementById('g-allergies').value
          }
        };
      }
    });

    if (value) { 
      try { 
        await API.post('/api/users', value); 
        this.page_guardias(); 
        Swal.fire({title:'Guardia Registrado',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); 
      } catch(e) { Swal.fire('Error',e.message,'error'); } 
    }
  },

  async viewGuardia(id) {
    try {
      const users = await API.get('/api/users');
      const u = users.find(x => x.id === id);
      if(!u) return;
      const pr = JSON.parse(u.profile || '{}');
      const html = `<div style="text-align:left;font-size:15px;background:#0f172a;padding:24px;border-radius:12px;border:1px solid #334155">
        <h3 style="margin-top:0;color:#3b82f6;border-bottom:1px solid #334155;padding-bottom:12px;margin-bottom:16px">${u.name}</h3>
        <p style="margin-bottom:8px"><b>📱 Teléfono:</b> ${u.phone || '-'}</p>
        <p style="margin-bottom:8px"><b>🎂 Edad / Sexo:</b> ${pr.age||'-'} años / ${pr.gender||'-'}</p>
        <p style="margin-bottom:8px"><b>🩸 Tipo de Sangre:</b> <span style="color:#ef4444;font-weight:bold;background:rgba(239,68,68,0.1);padding:2px 8px;border-radius:4px">${pr.blood_type||'-'}</span></p>
        <p style="margin-bottom:8px"><b>📍 Dirección:</b> ${pr.address||'-'}</p>
        <p style="margin-bottom:8px"><b>🎓 Escolaridad:</b> ${pr.academic_degree||'-'}</p>
        <div style="background:rgba(239,68,68,0.05);border-left:4px solid #ef4444;padding:12px;margin-top:16px;border-radius:0 8px 8px 0">
          <p style="margin:0 0 8px 0;color:#ef4444"><b>🆘 Contacto de Emergencia:</b><br><span style="color:#f1f5f9">${pr.emergency_contact||'No especificado'}</span></p>
          <p style="margin:0;color:#ef4444"><b>⚠️ Alergias/Enfermedades:</b><br><span style="color:#f1f5f9">${pr.allergies||'Ninguna reportada'}</span></p>
        </div>
      </div>`;
      Swal.fire({ html, background: '#1e293b', color: '#f1f5f9', confirmButtonColor: '#3b82f6', confirmButtonText: 'Cerrar', width: 500, customClass: { htmlContainer: 'swal-no-padding' } });
    } catch(e){}
  },

  // ═══════════ RUTA DE MONITOREO ═══════════
  async page_monitoreo_ruta() {
    const el = document.getElementById('page-content');
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-map-marked-alt"></i> Rutas de Monitoreo</h3>
          <button class="btn btn-primary btn-sm" onclick="App.showNewMonitorRoute()"><i class="fas fa-plus"></i> Nueva Ruta</button>
        </div>
        <div style="padding:14px 18px;border-bottom:1px solid #1e293b;background:#0c1222">
          <div style="position:relative;display:flex;gap:8px;align-items:center">
            <div style="position:relative;flex:1">
              <i class="fas fa-search" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#64748b;font-size:13px"></i>
              <input id="route-search" autocomplete="off" onclick="this.select(); App.filterMonitorRoutes(true)" oninput="App.filterMonitorRoutes()" onfocus="App.filterMonitorRoutes(true)" onkeydown="App.handleRouteNavigation(event)" onblur="setTimeout(()=>{var d=document.getElementById('route-search-dropdown');if(d)d.style.display='none';},200)" placeholder="Buscar por nombre o código (ej: R-004, Taller...)" style="width:100%;background:#0f172a;border:1px solid #334155;color:#f1f5f9;padding:9px 34px 9px 34px;border-radius:10px;font-size:13px;box-sizing:border-box;cursor:pointer;">
              <i class="fas fa-chevron-down" style="position:absolute;right:14px;top:50%;transform:translateY(-50%);color:#64748b;font-size:13px;pointer-events:none"></i>
              <div id="route-search-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#0f172a;border:1px solid #334155;border-top:none;border-radius:0 0 10px 10px;z-index:999;max-height:260px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.5)"></div>
            </div>
            <button class="btn btn-outline btn-sm" onclick="App.showAllMonitorRoutes()" title="Ver todas las rutas" style="width:40px;height:40px;padding:0;flex-shrink:0;border-radius:10px">
              <i class="fas fa-list"></i>
            </button>
          </div>
        </div>
        <div class="card-body" id="monitor-routes-list" style="max-height:80vh;overflow-y:auto">Cargando...</div>
      </div>
      <div id="live-panel" style="display:none"></div>
      <style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}</style>`;
    this._allMonitorRoutes = null;
    this.loadMonitorRoutes();
  },

  filterMonitorRoutes(showAll = false) {
    const q = showAll ? '' : (document.getElementById('route-search')?.value || '').toLowerCase().trim();
    const dropdown = document.getElementById('route-search-dropdown');
    if (!dropdown || !this._allMonitorRoutes) return;
    const matches = q
      ? this._allMonitorRoutes.filter(r => r.name.toLowerCase().includes(q) || (r.route_code||'').toLowerCase().includes(q))
      : this._allMonitorRoutes;
    if (!matches.length) {
      dropdown.innerHTML = '<div style="padding:12px 16px;color:#64748b;font-size:13px"><i class="fas fa-search-minus"></i> Sin resultados</div>';
      dropdown.style.display = 'block';
      return;
    }
    dropdown.innerHTML = matches.map(r => `
      <div onclick="App.selectMonitorRoute('${r.id}','${r.name.replace(/'/g,"\\'")}')"
           style="padding:10px 16px;cursor:pointer;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:10px;transition:background 0.15s"
           onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background=''">
        <span style="background:#1e293b;border:1px solid #334155;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:11px;color:#94a3b8;min-width:52px;text-align:center">${r.route_code||'---'}</span>
        <span style="color:#f1f5f9;font-size:13px;font-weight:600">${r.name}</span>
        <span style="margin-left:auto;color:#64748b;font-size:11px">${r.checkpoint_count||0} puntos</span>
      </div>`).join('');
    dropdown.style.display = 'block';
  },

  selectMonitorRoute(routeId, routeName) {
    const inp = document.getElementById('route-search');
    if (inp) inp.value = routeName;
    const dropdown = document.getElementById('route-search-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    this.loadSingleMonitorRoute(routeId);
  },

  showAllMonitorRoutes() {
    const inp = document.getElementById('route-search');
    if (inp) {
      inp.value = '';
      inp.focus();
      this.filterMonitorRoutes();
    }
  },

  handleRouteNavigation(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!this._allMonitorRoutes || !this._allMonitorRoutes.length) return;

    let currentIndex = this._allMonitorRoutes.findIndex(r => r.id === this._currentMonitorRouteId);
    if (e.key === 'ArrowDown') {
      currentIndex = (currentIndex + 1) % this._allMonitorRoutes.length;
    } else if (e.key === 'ArrowUp') {
      currentIndex = (currentIndex - 1 + this._allMonitorRoutes.length) % this._allMonitorRoutes.length;
    }

    const nextRoute = this._allMonitorRoutes[currentIndex];
    if (nextRoute) {
      this.selectMonitorRoute(nextRoute.id, nextRoute.name);
    }
  },

  async loadMonitorRoutes() {
    try {
      const routes = await API.get('/api/routes');
      const container = document.getElementById('monitor-routes-list');
      if (!routes.length) {
        container.innerHTML = '<div class="empty-state"><p>No hay rutas creadas. Crea una nueva ruta de monitoreo.</p></div>';
        return;
      }
      // Store basic list for autocomplete dropdown
      this._allMonitorRoutes = routes;

      // Use previously selected route if user already chose one; otherwise auto-detect active shift
      let defaultRoute = routes[0];
      if (this._currentMonitorRouteId) {
        // Respect manual selection
        const prev = routes.find(function(r){ return r.id === App._currentMonitorRouteId; });
        if (prev) defaultRoute = prev;
      } else {
        // First visit: auto-select the route that has an active guard right now
        try {
          const allAssignments = await API.get('/api/route-assignments');
          const activeNow = allAssignments.find(function(a){ return App.isAssignmentActiveNow(a); });
          if (activeNow) {
            const activeRoute = routes.find(function(r){ return r.id === activeNow.route_id; });
            if (activeRoute) defaultRoute = activeRoute;
          }
        } catch(e) { /* fallback to first */ }
      }

      const inp = document.getElementById('route-search');
      if (inp) inp.value = defaultRoute.name;
      this.loadSingleMonitorRoute(defaultRoute.id);
    } catch(e) {
      const container = document.getElementById('monitor-routes-list');
      if (container) container.innerHTML = '<p>Error: ' + e.message + '</p>';
    }
  },

  async loadSingleMonitorRoute(routeId) {
    this._currentMonitorRouteId = routeId; // Remember for Monitoreo map
    const container = document.getElementById('monitor-routes-list');
    if (!container) return;
    container.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b"><i class="fas fa-spinner fa-spin"></i> Cargando ruta...</div>';
    try {
      const r = (this._allMonitorRoutes || []).find(function(x){ return x.id === routeId; }) || { id: routeId, name: '', route_code: '' };
      const todayVisits = await API.get('/api/checkpoint-visits/today').catch(function(){ return []; });
      const detail = await API.get('/api/routes/' + routeId);
      const cps = detail.checkpoints || [];
      const rName = detail.name || r.name;
      const rCode = detail.route_code || r.route_code || '---';
      const assignments = await API.get('/api/route-assignments?route_id=' + routeId);
      const today = new Date().toLocaleDateString('en-CA');
      const activeAssignment = assignments.find(function(a){ return App.isAssignmentActiveNow(a); });
      const routeIdx = 'sched_' + routeId.replace(/-/g,'');

      // Count visits per checkpoint ONLY for the current active shift
      // Determine shift start datetime to exclude visits from previous shifts
      var shiftStartMs = 0;
      if (activeAssignment) {
        // Build the shift start as a comparable timestamp
        var shiftStartStr = activeAssignment.date_start + 'T' + (activeAssignment.hour_start || '00:00') + ':00';
        shiftStartMs = new Date(shiftStartStr).getTime();
      }

      var routeVisits = todayVisits.filter(function(v){
        if (!cps.some(function(cp){ return cp.id === v.checkpoint_id; })) return false;
        if (!activeAssignment) return false; // No active shift → don't show previous shift visits
        // Only count visits that happened AFTER the current shift started
        var arrivedMs = new Date(v.arrived_at.replace(' ', 'T')).getTime();
        return arrivedMs >= shiftStartMs;
      });
      var visitCountByCp = {};
      var visitedCpIds = {};
      routeVisits.forEach(function(v){
        visitCountByCp[v.checkpoint_id] = (visitCountByCp[v.checkpoint_id] || 0) + 1;
        if (!visitedCpIds[v.checkpoint_id] || v.arrived_at > visitedCpIds[v.checkpoint_id].arrived_at) {
          visitedCpIds[v.checkpoint_id] = v;
        }
      });
      var visitedCount = Object.keys(visitedCpIds).length;
      var totalCps = cps.length;
      var pct = totalCps > 0 ? Math.round((visitedCount / totalCps) * 100) : 0;

      let html = '<div style="border:1px solid #334155;border-radius:12px;padding:16px;background:#0f172a">';

      // Header row
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<h4 style="margin:0;color:#3b82f6;font-size:1.25em;text-transform:uppercase;letter-spacing:1px"><i class="fas fa-route"></i> RUTA: ' + rName.toUpperCase() + '</h4>';
      html += '<span style="background:#1e293b;border:1px solid #334155;padding:2px 8px;border-radius:4px;font-family:monospace;font-size:11px;color:#94a3b8">' + rCode + '</span>';
      html += '</div></div>';
      html += '<small style="color:#64748b;display:block;margin-bottom:10px">' + cps.length + ' punto(s) | ' + assignments.length + ' guardia(s)</small>';

      // Action buttons row
      html += '<div style="display:flex;gap:6px;margin-bottom:8px">';
      html += '<button class="btn btn-outline btn-sm" style="flex:1;color:#8b5cf6;border-color:#8b5cf6;white-space:nowrap" onclick="App.showRouteTimeline(\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-table-columns"></i> Timeline</button>';
      html += '<button class="btn btn-outline btn-sm" style="flex:1;color:#10b981;border-color:#10b981;white-space:nowrap" onclick="App.showRouteVisits(\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-clipboard-list"></i> Visitas</button>';
      html += '<button class="btn btn-outline btn-sm" style="flex:1;color:#f59e0b;border-color:#f59e0b;white-space:nowrap" onclick="App.showRouteMap(\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-map"></i> Mapa</button>';
      html += '</div>';
      html += '<div style="display:flex;gap:6px;margin-bottom:12px">';
      html += '<button class="btn btn-primary btn-sm" style="flex:1" onclick="App.addCheckpoint(\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-map-pin"></i> + Punto</button>';
      html += '<button class="btn btn-outline btn-sm" style="width:40px;color:#ef4444;border-color:#ef4444" onclick="App.deleteRoute(\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-trash"></i></button>';
      html += '</div>';

      // Progress bar
      if (totalCps > 0) {
        var barColor = pct === 100 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
        html += '<div style="margin-bottom:10px;padding:10px;background:#0c1222;border:1px solid #1e3a5f;border-radius:8px">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
        html += '<span style="font-size:12px;color:#94a3b8"><i class="fas fa-chart-pie"></i> Avance de hoy</span>';
        html += '<span style="font-size:13px;font-weight:bold;color:' + barColor + '">' + visitedCount + '/' + totalCps + ' puntos (' + pct + '%)</span>';
        html += '</div><div style="width:100%;height:6px;background:#1e293b;border-radius:3px;overflow:hidden">';
        html += '<div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:3px;transition:width 0.5s ease"></div>';
        html += '</div></div>';
      }

      // Assign guard button
      html += '<button class="btn btn-outline btn-sm" style="width:100%;margin-bottom:10px;border-color:#8b5cf6;color:#8b5cf6" onclick="App.assignGuardToRoute(\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-user-plus"></i> Asignar Guardia</button>';

      // Schedule panel (expanded by default)
      html += '<div id="' + routeIdx + '" style="background:#0c1222;border:1px solid #1e3a5f;border-radius:10px;padding:14px;margin-bottom:10px">';
      html += '<div style="font-size:12px;color:#8b5cf6;font-weight:bold;margin-bottom:10px;border-bottom:1px solid #1e3a5f;padding-bottom:6px"><i class="fas fa-calendar-check"></i> PROGRAMACIÓN DE COBERTURA</div>';
      if (assignments.length) {
        var months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        assignments.forEach(function(a) {
          var isActive = App.isAssignmentActiveNow(a);
          var entryDate = new Date(a.date_start + 'T' + a.hour_start + ':00');
          var exitDate;
          if (a.shift_type === '24x24') {
            exitDate = new Date(entryDate.getTime() + 24*60*60*1000);
          } else if (a.shift_type === '12H_NOCHE' || a.hour_end < a.hour_start) {
            exitDate = new Date(entryDate.getTime() + 12*60*60*1000);
          } else {
            exitDate = new Date(a.date_start + 'T' + a.hour_end + ':00');
          }
          var to12h = function(t) { var p = t.split(':'); var h = parseInt(p[0]); var m = p[1]; var ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12; return h + ':' + m + ' ' + ampm; };
          var entryStr = to12h(a.hour_start) + ' del ' + entryDate.getDate() + '-' + months[entryDate.getMonth()] + '-' + entryDate.getFullYear();
          var exitTime12 = to12h(exitDate.toTimeString().substring(0,5));
          var exitStr = exitTime12 + ' del ' + exitDate.getDate() + '-' + months[exitDate.getMonth()] + '-' + exitDate.getFullYear();
          var shiftLabel = a.shift_type==='24x24'?'24×24':a.shift_type==='12H_DIA'?'12H Día':a.shift_type==='12H_NOCHE'?'12H Noche':a.shift_type;

          html += '<div style="padding:10px;margin-bottom:8px;background:rgba(59,130,246,0.05);border:1px solid ' + (isActive?'#10b981':'#1e3a5f') + ';border-radius:8px">';
          html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
          html += '<div><span style="width:8px;height:8px;border-radius:50%;background:' + (isActive?'#10b981':'#64748b') + ';display:inline-block;margin-right:6px"></span>';
          html += '<b style="color:' + (isActive?'#10b981':'#e2e8f0') + ';font-size:0.84em">' + a.guard_name + '</b>';
          html += '<span style="background:#1e293b;border:1px solid #334155;padding:1px 6px;border-radius:4px;font-size:10px;color:#8b5cf6;margin-left:6px">' + shiftLabel + '</span>';
          if (isActive) html += '<span style="background:rgba(16,185,129,0.2);color:#10b981;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700;margin-left:6px">EN TURNO</span>';
          if (!isActive) html += '<span style="background:rgba(100,116,139,0.2);color:#94a3b8;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-left:6px">DESCANSO</span>';
          html += '</div><div style="display:flex;gap:4px">';
          html += '<button class="btn btn-outline btn-sm" style="padding:2px 6px;color:#f59e0b;border-color:#f59e0b" onclick="App.editAssignment(\'' + a.id + '\',\'' + a.guard_id + '\',\'' + a.shift_type + '\',\'' + a.date_start + '\',\'' + a.date_end + '\',\'' + a.hour_start + '\',\'' + a.hour_end + '\',\'' + routeId + '\',\'' + rName.replace(/'/g,"\\'") + '\')"><i class="fas fa-pen"></i></button>';
          html += '<button class="btn btn-outline btn-sm" style="padding:2px 6px;color:#ef4444;border-color:#ef4444" onclick="App.deleteAssignment(\'' + a.id + '\',\'' + routeId + '\')"><i class="fas fa-times"></i></button>';
          html += '</div></div>';
          html += '<div style="display:flex;gap:20px;font-size:12px">';
          html += '<div><span style="color:#64748b">Entrada:</span> <b style="color:#10b981">' + entryStr + '</b></div>';
          html += '<div><span style="color:#64748b">Salida:</span> <b style="color:#f59e0b">' + exitStr + '</b></div>';
          html += '</div>';
          html += '<div style="font-size:11px;color:#475569;margin-top:4px">Cobertura: ' + a.date_start + ' → ' + a.date_end + '</div>';
          html += '</div>';
        });
      } else {
        html += '<div style="text-align:center;color:#64748b;padding:10px"><i class="fas fa-user-slash"></i> Sin guardias asignados a esta ruta</div>';
      }
      html += '</div>';

      // Checkpoints
      if (cps.length) {
        html += '<div style="display:grid;gap:6px;margin-top:10px">';
        cps.forEach(function(cp, i) {
          var visit = visitedCpIds[cp.id];
          var isVisited = !!visit;
          var borderColor = isVisited ? '#10b981' : '#1e3a5f';
          var bgColor = isVisited ? 'rgba(16,185,129,0.08)' : 'rgba(59,130,246,0.05)';
          var numBg = isVisited ? '#10b981' : '#475569';
          var vCount = visitCountByCp[cp.id] || 0;

          html += '<div style="display:flex;align-items:center;gap:10px;padding:12px;background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;transition:all 0.3s" id="cp-row-' + cp.id + '">';
          html += '<div style="min-width:38px;height:38px;background:' + numBg + ';border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#fff;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,0.3)">';
          html += vCount;
          html += '<span style="font-size:8px;font-weight:600;opacity:0.85;line-height:1">vis</span>';
          html += '</div>';
          html += '<div style="flex:1"><b style="color:#e2e8f0;font-size:13px">' + cp.name + '</b>';
          if (isVisited) {
            var visitTime = visit.arrived_at ? new Date(visit.arrived_at.replace(' ','T')).toLocaleString('es-MX', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}) : '';
            var visitDate = visit.arrived_at ? new Date(visit.arrived_at.replace(' ','T')).toLocaleDateString('es-MX', {day:'2-digit',month:'short'}) : '';
            html += '<br><span style="color:#10b981;font-size:12px;font-weight:600"><i class="fas fa-check-circle"></i> Visitado por <b>' + (visit.guard_name||'Guardia') + '</b></span>';
            html += '<br><small style="color:#64748b"><i class="fas fa-clock"></i> ' + visitDate + ' ' + visitTime + '</small>';
            if (visit.latitude) html += ' <small style="color:#475569;font-family:monospace;font-size:10px">📍 ' + parseFloat(visit.latitude).toFixed(5) + ', ' + parseFloat(visit.longitude).toFixed(5) + '</small>';
          } else {
            html += '<br><span style="color:#f59e0b;font-size:11px"><i class="fas fa-hourglass-half"></i> Pendiente de visita</span>';
            html += '<br><small style="color:#64748b;font-family:monospace">Lat: ' + cp.latitude + ' | Lng: ' + cp.longitude + '</small>';
          }
          html += '</div>';
          html += '<small style="color:#94a3b8;white-space:nowrap">Radio: ' + cp.radius_meters + 'm</small>';
          html += '<button class="btn btn-outline btn-sm" style="padding:4px 8px;color:#3b82f6;border-color:#3b82f6;margin-right:4px" onclick="App.editCheckpointName(\'' + cp.id + '\',\'' + routeId + '\',\'' + cp.name.replace(/'/g,"\\\\'") + '\')" title="Editar nombre"><i class="fas fa-edit"></i></button>';
          html += '<button class="btn btn-outline btn-sm" style="padding:4px 8px;color:#ef4444;border-color:#ef4444" onclick="App.deleteCheckpoint(\'' + cp.id + '\',\'' + routeId + '\')"><i class="fas fa-trash"></i></button>';
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      container.innerHTML = html;
    } catch(e) {
      if (container) container.innerHTML = `
        <div style="padding:32px;text-align:center;background:#0f172a;border:1px solid #334155;border-radius:12px">
          <i class="fas fa-wifi" style="font-size:40px;color:#ef4444;margin-bottom:12px;display:block"></i>
          <p style="color:#f1f5f9;font-size:15px;font-weight:600;margin:0 0 6px">Sin conexión con el servidor</p>
          <p style="color:#64748b;font-size:12px;margin:0 0 18px">El servidor puede estar iniciando, espera unos segundos e intenta de nuevo.</p>
          <button class="btn btn-primary" onclick="App.loadSingleMonitorRoute('${routeId}')" style="padding:10px 24px">
            <i class="fas fa-redo"></i> Reintentar
          </button>
        </div>`;
    }
  },

  async showRouteTimeline(routeId, routeName) {
    try {
      var detail = await API.get('/api/routes/' + routeId);
      var cps = detail.checkpoints || [];
      if (!cps.length) { Swal.fire({title:'Sin puntos',text:'Esta ruta no tiene puntos de control.',icon:'info',background:'#1e293b',color:'#f1f5f9'}); return; }
      var visits = await API.get('/api/checkpoint-visits/history/' + routeId + '?days=15');
      var assignments = await API.get('/api/route-assignments?route_id=' + routeId);
      // Agrupar visitas por fecha (soportar múltiples visitas por punto por día)
      var dateMap = {};
      visits.forEach(function(v) {
        var d = v.arrived_at ? v.arrived_at.split(' ')[0].split('T')[0] : null;
        if (!d) return;
        if (!dateMap[d]) dateMap[d] = { visits: {}, guards: {} };
        if (!dateMap[d].visits[v.checkpoint_id]) dateMap[d].visits[v.checkpoint_id] = [];
        dateMap[d].visits[v.checkpoint_id].push(v);
        dateMap[d].guards[v.guard_name] = true;
      });
      // Generar últimos 15 días (incluir hoy)
      var allDates = [];
      for (var i = 14; i >= 0; i--) {
        var dt = new Date(); dt.setDate(dt.getDate() - i);
        allDates.push(dt.toISOString().split('T')[0]);
      }
      var months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      var days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
      // Construir tabla
      var tbl = '<div id="timeline-scroll" style="overflow-x:auto;max-width:100%;border-radius:8px;border:1px solid #334155">';
      tbl += '<table style="border-collapse:collapse;min-width:100%;font-size:12px">';
      // Header: Fechas
      tbl += '<thead><tr style="background:#0c1222;position:sticky;top:0;z-index:2">';
      tbl += '<th style="padding:8px 12px;text-align:left;color:#94a3b8;position:sticky;left:0;background:#0c1222;z-index:3;min-width:140px;border-right:2px solid #334155"><i class="fas fa-map-pin"></i> Punto</th>';
      allDates.forEach(function(d) {
        var dt = new Date(d + 'T12:00:00');
        var isToday = d === new Date().toLocaleDateString('en-CA');
        var dayName = days[dt.getDay()];
        var dayNum = dt.getDate();
        var monthName = months[dt.getMonth()];
        var bg = isToday ? 'background:#1e3a5f' : '';
        tbl += '<th style="padding:6px 4px;text-align:center;min-width:80px;border-right:1px solid #1e293b;' + bg + '">';
        tbl += '<div style="color:' + (isToday ? '#3b82f6' : '#64748b') + ';font-size:10px;font-weight:' + (isToday ? '800' : '400') + '">' + dayName + '</div>';
        tbl += '<div style="color:' + (isToday ? '#f1f5f9' : '#94a3b8') + ';font-size:13px;font-weight:700">' + dayNum + '</div>';
        tbl += '<div style="color:#475569;font-size:9px">' + monthName + '</div>';
        tbl += '</th>';
      });
      tbl += '</tr>';
      // Sub-header: Guardia asignado por fecha
      tbl += '<tr style="background:#0f172a;border-bottom:2px solid #334155">';
      tbl += '<th style="padding:4px 12px;text-align:left;color:#64748b;font-size:10px;position:sticky;left:0;background:#0f172a;z-index:3;border-right:2px solid #334155"><i class="fas fa-user-shield"></i> Guardia</th>';
      allDates.forEach(function(d) {
        var data = dateMap[d];
        var guardNames = data ? Object.keys(data.guards).join(', ') : '';
        // Check assignment for this date
        if (!guardNames) {
          var a = assignments.find(function(a){ return App.isAssignmentActiveOnDate(a, d); });
          if (a) guardNames = a.guard_name;
        }
        tbl += '<th style="padding:4px;text-align:center;font-size:10px;color:#8b5cf6;font-weight:600;border-right:1px solid #1e293b;white-space:nowrap">' + (guardNames || '<span style="color:#334155">—</span>') + '</th>';
      });
      tbl += '</tr></thead>';
      // Rows: Checkpoints
      tbl += '<tbody>';
      cps.forEach(function(cp, idx) {
        tbl += '<tr style="border-bottom:1px solid #1e293b">';
        tbl += '<td style="padding:8px 12px;color:#e2e8f0;font-weight:600;position:sticky;left:0;background:#0f172a;z-index:1;border-right:2px solid #334155;white-space:nowrap">';
        tbl += '<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;background:#3b82f6;border-radius:50%;color:white;font-size:10px;font-weight:bold;margin-right:6px">' + (idx+1) + '</span>';
        tbl += cp.name + '</td>';
        allDates.forEach(function(d) {
          var data = dateMap[d];
          var visitList = data ? data.visits[cp.id] : null;
          var isToday = d === new Date().toLocaleDateString('en-CA');
          var cellBg = isToday ? 'rgba(59,130,246,0.05)' : 'transparent';
          if (visitList && visitList.length) {
            var count = visitList.length;
            var lastVisit = visitList[visitList.length - 1];
            var time = lastVisit.arrived_at ? new Date(lastVisit.arrived_at.replace(' ','T') + 'Z').toLocaleTimeString('es-MX', {hour:'2-digit',minute:'2-digit',hour12:true}) : '';
            tbl += '<td style="padding:4px;text-align:center;background:rgba(16,185,129,0.08);border-right:1px solid #1e293b">';
            tbl += '<div style="color:#10b981;font-size:16px"><i class="fas fa-check-circle"></i></div>';
            if (count > 1) {
              tbl += '<div style="color:#10b981;font-size:9px;font-weight:700">' + count + ' rondas</div>';
              // Mostrar todas las horas
              var allTimes = visitList.map(function(vv){ return vv.arrived_at ? new Date(vv.arrived_at.replace(' ','T') + 'Z').toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',hour12:true}) : ''; }).join(', ');
              tbl += '<div style="color:#64748b;font-size:8px" title="' + allTimes + '">' + allTimes + '</div>';
            } else {
              tbl += '<div style="color:#10b981;font-size:10px;font-weight:600">' + time + '</div>';
            }
            tbl += '</td>';
          } else {
            // Check if this date has passed or is future
            var isPast = d < new Date().toLocaleDateString('en-CA');
            tbl += '<td style="padding:4px;text-align:center;background:' + cellBg + ';border-right:1px solid #1e293b">';
            if (isPast) {
              tbl += '<div style="color:#ef4444;font-size:14px;opacity:0.4"><i class="fas fa-times-circle"></i></div>';
            } else if (isToday) {
              tbl += '<div style="color:#f59e0b;font-size:14px"><i class="fas fa-hourglass-half"></i></div>';
              tbl += '<div style="color:#f59e0b;font-size:9px">Pendiente</div>';
            } else {
              tbl += '<div style="color:#334155;font-size:14px">—</div>';
            }
            tbl += '</td>';
          }
        });
        tbl += '</tr>';
      });
      tbl += '</tbody></table></div>';
      // Resumen
      var todayKey = new Date().toLocaleDateString('en-CA');
      var todayData = dateMap[todayKey];
      var todayVisited = todayData ? Object.keys(todayData.visits).length : 0;
      var todayTotal = todayData ? Object.values(todayData.visits).reduce(function(s,arr){return s+arr.length;},0) : 0;
      var summary = '<div style="display:flex;gap:16px;justify-content:center;margin-top:12px;font-size:12px">';
      summary += '<span><i class="fas fa-check-circle" style="color:#10b981"></i> Puntos hoy: <b style="color:#10b981">' + todayVisited + '/' + cps.length + '</b> | Rondas: <b style="color:#3b82f6">' + todayTotal + '</b></span>';
      summary += '<span><i class="fas fa-calendar-alt" style="color:#8b5cf6"></i> Últimos 15 días</span>';
      summary += '<span style="color:#64748b"><i class="fas fa-arrows-alt-h"></i> Desliza para navegar ←→</span>';
      summary += '</div>';
      Swal.fire({
        title: '📊 Timeline: ' + routeName,
        background: '#1e293b', color: '#f1f5f9', width: 1330,
        html: tbl + summary,
        confirmButtonText: 'Cerrar', confirmButtonColor: '#334155',
        didOpen: function() {
          // Auto-scroll al día de hoy (derecha)
          var scroll = document.getElementById('timeline-scroll');
          if (scroll) scroll.scrollLeft = scroll.scrollWidth;
        }
      });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async showRouteVisits(routeId, routeName) {
    var today = new Date().toLocaleDateString('en-CA');
    var { value: date } = await Swal.fire({
      title: '📋 Visitas de: ' + routeName,
      background: '#1e293b', color: '#f1f5f9',
      html: '<input type="date" id="visit-date" value="' + today + '" style="width:100%;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f1f5f9;font-size:16px">',
      confirmButtonText: '<i class="fas fa-search"></i> Buscar', confirmButtonColor: '#3b82f6',
      showCancelButton: true, cancelButtonText: 'Cerrar',
      preConfirm: function() { return document.getElementById('visit-date').value; }
    });
    if (!date) return;
    try {
      var visits = await API.get('/api/checkpoint-visits/by-route/' + routeId + '?date=' + date);
      if (!visits.length) {
        Swal.fire({ title: 'Sin visitas', text: 'No hay visitas registradas para ' + routeName + ' en ' + date, icon: 'info', background: '#1e293b', color: '#f1f5f9' });
        return;
      }
      var tableRows = visits.map(function(v, i) {
        var time = v.arrived_at ? new Date(v.arrived_at.replace(' ','T') + 'Z').toLocaleTimeString('es-MX', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}) : '-';
        var dateStr = v.arrived_at ? new Date(v.arrived_at.replace(' ','T') + 'Z').toLocaleDateString('es-MX', {day:'2-digit',month:'short',year:'numeric'}) : '-';
        return '<tr style="border-bottom:1px solid #1e293b">' +
          '<td style="padding:10px;color:#f1f5f9;font-weight:600"><i class="fas fa-user-shield" style="color:#3b82f6;margin-right:6px"></i>' + (v.guard_name||'---') + '</td>' +
          '<td style="padding:10px;color:#10b981;font-weight:600">' + (v.checkpoint_name||'---') + '</td>' +
          '<td style="padding:10px;color:#94a3b8">' + dateStr + '</td>' +
          '<td style="padding:10px;color:#f59e0b;font-weight:bold">' + time + '</td>' +
          '<td style="padding:10px;font-family:monospace;font-size:11px;color:#64748b">' + (v.latitude ? parseFloat(v.latitude).toFixed(5) + ', ' + parseFloat(v.longitude).toFixed(5) : '-') + '</td>' +
          '</tr>';
      }).join('');
      Swal.fire({
        title: '📋 ' + visits.length + ' visita(s) — ' + routeName,
        background: '#1e293b', color: '#f1f5f9', width: 800,
        html: '<div style="max-height:400px;overflow-y:auto;border-radius:8px;border:1px solid #334155">' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
          '<thead><tr style="background:#0f172a;position:sticky;top:0">' +
          '<th style="padding:10px;text-align:left;color:#3b82f6"><i class="fas fa-user"></i> Guardia</th>' +
          '<th style="padding:10px;text-align:left;color:#10b981"><i class="fas fa-map-marker"></i> Punto</th>' +
          '<th style="padding:10px;text-align:left;color:#94a3b8"><i class="fas fa-calendar"></i> Fecha</th>' +
          '<th style="padding:10px;text-align:left;color:#f59e0b"><i class="fas fa-clock"></i> Hora</th>' +
          '<th style="padding:10px;text-align:left;color:#64748b"><i class="fas fa-crosshairs"></i> Coordenadas</th>' +
          '</tr></thead><tbody>' + tableRows + '</tbody></table></div>' +
          '<div style="margin-top:12px;text-align:center"><button class="btn btn-outline btn-sm" style="color:#f59e0b;border-color:#f59e0b" onclick="Swal.close();App.showRouteMap(\'' + routeId + '\',\'' + routeName + '\',\'' + date + '\')"><i class="fas fa-map"></i> Ver en Mapa</button></div>',
        confirmButtonText: 'Cerrar', confirmButtonColor: '#334155'
      });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async showRouteMap(routeId, routeName, date) {
    date = date || new Date().toLocaleDateString('en-CA');
    try {
      var detail = await API.get('/api/routes/' + routeId);
      var cps = detail.checkpoints || [];
      var visits = await API.get('/api/checkpoint-visits/by-route/' + routeId + '?date=' + date);
      var visitedCpIds = {};
      visits.forEach(function(v) { visitedCpIds[v.checkpoint_id] = v; });
      // Center map on first checkpoint
      var centerLat = cps.length ? parseFloat(cps[0].latitude) : 14.6;
      var centerLng = cps.length ? parseFloat(cps[0].longitude) : -90.5;
      Swal.fire({
        title: '🗺️ Mapa: ' + routeName + ' (' + date + ')',
        background: '#1e293b', color: '#f1f5f9', width: 900,
        html: '<div id="route-map" style="height:450px;border-radius:12px;border:1px solid #334155"></div>' +
          '<div style="margin-top:10px;display:flex;gap:16px;justify-content:center;font-size:12px">' +
          '<span><span style="display:inline-block;width:12px;height:12px;background:#10b981;border-radius:50%;margin-right:4px"></span> Visitado</span>' +
          '<span><span style="display:inline-block;width:12px;height:12px;background:#ef4444;border-radius:50%;margin-right:4px"></span> Pendiente</span>' +
          '<span><span style="display:inline-block;width:12px;height:12px;background:#3b82f6;border-radius:2px;margin-right:4px"></span> Posición del guardia</span>' +
          '</div>',
        confirmButtonText: 'Cerrar', confirmButtonColor: '#334155',
        didOpen: function() {
          // Load Leaflet CSS+JS dynamically
          if (!document.getElementById('leaflet-css')) {
            var css = document.createElement('link');
            css.id = 'leaflet-css'; css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(css);
          }
          var loadMap = function() {
            var map = L.map('route-map').setView([centerLat, centerLng], 16);
            var baseLayers = {
              "Calles": L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { attribution: '© Google', maxZoom: 22, maxNativeZoom: 20 }),
              "Satélite": L.tileLayer('https://mt1.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', { attribution: '© Google', maxZoom: 22, maxNativeZoom: 20 }),
              "Modo Oscuro": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© CARTO', maxZoom: 22, maxNativeZoom: 19 }),
              "Modo Claro": L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© CARTO', maxZoom: 22, maxNativeZoom: 19 })
            };
            baseLayers["Calles"].addTo(map);
            L.control.layers(baseLayers, null, { position: 'bottomright' }).addTo(map);
            var bounds = [];
            // Dibujar checkpoints
            cps.forEach(function(cp, i) {
              var lat = parseFloat(cp.latitude); var lng = parseFloat(cp.longitude);
              var visit = visitedCpIds[cp.id];
              var color = visit ? '#10b981' : '#ef4444';
              var pinColor = visit ? '#10b981' : '#ef4444';
              var icon = L.divIcon({ className: '', html: '<div style="position:relative;width:36px;height:44px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 44" width="36" height="44"><ellipse cx="18" cy="42" rx="7" ry="3" fill="rgba(0,0,0,0.35)"/><path d="M18 2C10.268 2 4 8.268 4 16c0 10 14 26 14 26S32 26 32 16C32 8.268 25.732 2 18 2z" fill="' + pinColor + '" stroke="white" stroke-width="2"/><circle cx="18" cy="16" r="8" fill="white" opacity="0.95"/><text x="18" y="21" text-anchor="middle" font-size="11" font-weight="900" fill="#000">' + (i+1) + '</text></svg><div style="position:absolute;top:-26px;left:50%;transform:translateX(-50%);background:#fff;color:#0f172a;padding:3px 8px;border-radius:5px;font-size:12px;white-space:nowrap;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.5)">' + cp.name + '</div></div>', iconSize: [36,44], iconAnchor: [18,44] });
              var popup = '<b style="font-size:14px">' + cp.name + '</b><br>';
              if (visit) {
                var time = visit.arrived_at ? new Date(visit.arrived_at.replace(' ','T')).toLocaleTimeString('es-MX', {hour:'2-digit',minute:'2-digit',hour12:true}) : '';
                popup += '<span style="color:green">✅ Visitado por ' + (visit.guard_name||'') + '</span><br>🕐 ' + time;
              } else { popup += '<span style="color:red">⏳ Pendiente</span>'; }
              L.marker([lat, lng], { icon: icon }).bindPopup(popup).addTo(map);
              // Radio
              L.circle([lat, lng], { radius: parseFloat(cp.radius_meters)||15, color: color, fillColor: color, fillOpacity: 0.1, weight: 1 }).addTo(map);
              bounds.push([lat, lng]);
              // Si fue visitado, mostrar posición real del guardia
              if (visit && visit.latitude) {
                var gLat = parseFloat(visit.latitude); var gLng = parseFloat(visit.longitude);
                L.marker([gLat, gLng], { icon: L.divIcon({ className: '', html: '<div style="width:10px;height:10px;background:#3b82f6;border-radius:2px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3)"></div>', iconSize: [10,10], iconAnchor: [5,5] }) }).bindPopup('📍 Posición real de ' + (visit.guard_name||'guardia')).addTo(map);
                bounds.push([gLat, gLng]);
              }
            });
            // Línea de ruta
            if (bounds.length > 1) {
              L.polyline(bounds, { color: '#8b5cf6', weight: 2, dashArray: '8,8', opacity: 0.6 }).addTo(map);
            }
            if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
            setTimeout(function() { map.invalidateSize(); }, 300);
          };
          // Ensure Leaflet JS is loaded
          if (typeof L !== 'undefined') { loadMap(); }
          else {
            var js = document.createElement('script');
            js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            js.onload = loadMap;
            document.head.appendChild(js);
          }
        }
      });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async showNewMonitorRoute() {
    const { value } = await Swal.fire({
      title: '📍 Nueva Ruta de Monitoreo', background: '#1e293b', color: '#f1f5f9',
      html: `<input id="mr-name" class="swal2-input" placeholder="Nombre de la ruta (ej: Perímetro Norte)" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="mr-desc" class="swal2-input" placeholder="Descripción (opcional)" style="background:#0f172a;border-color:#334155;color:#f1f5f9">`,
      confirmButtonText: '<i class="fas fa-save"></i> Crear Ruta', confirmButtonColor: '#3b82f6', showCancelButton: true, cancelButtonText: t('cancel'),
      preConfirm: () => {
        const name = document.getElementById('mr-name').value;
        if (!name) { Swal.showValidationMessage('El nombre es obligatorio'); return false; }
        return { name, description: document.getElementById('mr-desc').value };
      }
    });
    if (value) {
      try { await API.post('/api/routes', value); this.loadMonitorRoutes(); Swal.fire({title:'Ruta creada',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); }
      catch(e) { Swal.fire('Error',e.message,'error'); }
    }
  },

  async addCheckpoint(routeId, routeName) {
    const { value } = await Swal.fire({
      title: `<i class="fas fa-map-pin" style="color:#ef4444"></i> Agregar Punto`, background: '#1e293b', color: '#f1f5f9', width: 500,
      html: `<div style="text-align:left;margin-bottom:12px;padding:10px;background:rgba(59,130,246,0.1);border-radius:8px;font-size:13px;color:#93c5fd"><i class="fas fa-info-circle"></i> Ruta: <b>${routeName}</b></div>
        <input id="cp-name" class="swal2-input" placeholder="Nombre del punto (ej: Entrada Principal)" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="cp-lat" type="hidden"><input id="cp-lng" type="hidden">
        <div id="gps-status" style="margin:12px 0;padding:16px;border:2px dashed #334155;border-radius:12px;text-align:center">
          <i class="fas fa-satellite-dish" style="font-size:24px;color:#64748b"></i>
          <p style="color:#94a3b8;margin:8px 0 0">Presiona el botón o pega coordenadas abajo</p>
        </div>
        <button type="button" class="btn btn-primary" style="width:100%;padding:14px;font-size:15px" onclick="
          document.getElementById('gps-status').innerHTML='<i class=\\'fas fa-spinner fa-spin\\' style=\\'font-size:24px;color:#f59e0b\\'></i><p style=\\'color:#f59e0b;margin:8px 0 0\\'>Obteniendo ubicación...</p>';
          if(navigator.geolocation){navigator.geolocation.getCurrentPosition(p=>{
            document.getElementById('cp-lat').value=p.coords.latitude.toFixed(6);
            document.getElementById('cp-lng').value=p.coords.longitude.toFixed(6);
            document.getElementById('cp-paste').value=p.coords.latitude.toFixed(6)+', '+p.coords.longitude.toFixed(6);
            document.getElementById('gps-status').innerHTML='<i class=\\'fas fa-check-circle\\' style=\\'font-size:24px;color:#10b981\\'></i><p style=\\'color:#10b981;margin:8px 0 4px;font-weight:bold\\'>Ubicación capturada ✓</p><small style=\\'color:#64748b;font-family:monospace\\'>'+p.coords.latitude.toFixed(6)+', '+p.coords.longitude.toFixed(6)+'</small>';
            document.getElementById('gps-status').style.borderColor='#10b981';
          },e=>{document.getElementById('gps-status').innerHTML='<i class=\\'fas fa-exclamation-triangle\\' style=\\'font-size:24px;color:#ef4444\\'></i><p style=\\'color:#ef4444;margin:8px 0 0\\'>Error GPS: '+e.message+'</p>';},{enableHighAccuracy:true,timeout:15000})}
        "><i class="fas fa-crosshairs"></i> Capturar Ubicación desde mi Celular</button>
        <label style="font-size:12px;color:#94a3b8;font-weight:bold;margin-top:14px;display:block;text-align:left">O pega el enlace de Google Maps o coordenadas (lat, lng)</label>
        <input id="cp-paste" class="swal2-input" placeholder="Ej: 14.6349, -90.5069 o enlace de Google Maps" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#10b981;font-family:monospace;letter-spacing:1px" oninput="
          var v=this.value.trim();var la=NaN,lo=NaN;
          var mUrl=v.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/)||v.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/)||v.match(/ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
          if(mUrl){la=parseFloat(mUrl[1]);lo=parseFloat(mUrl[2]);}
          else{var parts=v.split(',');if(parts.length===2){la=parseFloat(parts[0].trim());lo=parseFloat(parts[1].trim());}}
          if(!isNaN(la)&&!isNaN(lo)){document.getElementById('cp-lat').value=la;document.getElementById('cp-lng').value=lo;
          document.getElementById('gps-status').innerHTML='<i class=\\'fas fa-check-circle\\' style=\\'font-size:24px;color:#10b981\\'></i><p style=\\'color:#10b981;margin:8px 0 4px;font-weight:bold\\'>Coordenadas válidas ✓</p><small style=\\'color:#64748b;font-family:monospace\\'>'+la.toFixed(6)+', '+lo.toFixed(6)+'</small>';
          document.getElementById('gps-status').style.borderColor='#10b981';}">
        <label style="font-size:12px;color:#94a3b8;font-weight:bold;margin-top:14px;display:block;text-align:left">Proximidad al punto (metros)</label>
        <input id="cp-radius" type="number" class="swal2-input" value="15" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9">
        <div style="margin-top:4px;font-size:11px;color:#64748b;text-align:left"><i class="fas fa-info-circle"></i> Distancia máxima a la que debe estar el guardia para registrar su paso. 15 metros es lo recomendado.</div>`,
      confirmButtonText: '<i class="fas fa-save"></i> Guardar Punto', confirmButtonColor: '#3b82f6', showCancelButton: true, cancelButtonText: t('cancel'),
      preConfirm: () => {
        const name = document.getElementById('cp-name').value;
        const pasteVal = document.getElementById('cp-paste').value.trim();
        let lat = parseFloat(document.getElementById('cp-lat').value);
        let lng = parseFloat(document.getElementById('cp-lng').value);
        // Parse Google Maps URL or plain coordinates if hidden fields not set
        if ((isNaN(lat) || isNaN(lng)) && pasteVal) {
          const mUrl = pasteVal.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/) || pasteVal.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/) || pasteVal.match(/ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
          if (mUrl) { lat = parseFloat(mUrl[1]); lng = parseFloat(mUrl[2]); }
          else { const parts = pasteVal.split(','); if (parts.length === 2) { lat = parseFloat(parts[0].trim()); lng = parseFloat(parts[1].trim()); } }
        }
        if (!name) { Swal.showValidationMessage('El nombre del punto es obligatorio'); return false; }
        if (isNaN(lat) || isNaN(lng)) { Swal.showValidationMessage('Debes capturar ubicación con GPS o pegar coordenadas/enlace de Google Maps'); return false; }
        return { name, latitude: lat, longitude: lng, radius_meters: parseInt(document.getElementById('cp-radius').value)||15 };
      }
    });
    if (value) {
      try {
        const route = await API.get('/api/routes/' + routeId);
        const existingCps = route.checkpoints || [];
        value.checkpoint_order = existingCps.length + 1;
        await API.post('/api/routes/' + routeId + '/checkpoints', value);
        this.loadSingleMonitorRoute(routeId);
        Swal.fire({title:'Punto agregado',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'});
      } catch(e) { Swal.fire('Error',e.message,'error'); }
    }
  },

  async deleteRoute(routeId, routeName) {
    const r = await Swal.fire({title:'¿Eliminar ruta "'+routeName+'"?',text:'Se eliminarán también todos sus puntos de control.',icon:'warning',showCancelButton:true,confirmButtonText:'Sí, eliminar',cancelButtonText:'Cancelar',confirmButtonColor:'#ef4444',background:'#1e293b',color:'#f1f5f9'});
    if (r.isConfirmed) {
      try { await API.del('/api/routes/' + routeId); this.loadMonitorRoutes(); Swal.fire({title:'Ruta eliminada',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); }
      catch(e) { Swal.fire('Error',e.message,'error'); }
    }
  },

  async deleteCheckpoint(cpId, routeId) {
    const r = await Swal.fire({title:'¿Eliminar este punto?',icon:'warning',showCancelButton:true,confirmButtonText:'Sí, eliminar',cancelButtonText:'Cancelar',confirmButtonColor:'#ef4444',background:'#1e293b',color:'#f1f5f9'});
    if (r.isConfirmed) {
      try { await API.del('/api/routes/checkpoints/' + cpId); this.loadSingleMonitorRoute(routeId); }
      catch(e) { Swal.fire('Error',e.message,'error'); }
    }
  },

  async editCheckpointName(cpId, routeId, currentName) {
    const { value: newName } = await Swal.fire({
      title: 'Editar Nombre de Punto',
      input: 'text',
      inputValue: currentName,
      background: '#1e293b',
      color: '#f1f5f9',
      showCancelButton: true,
      confirmButtonText: '<i class="fas fa-save"></i> Guardar',
      cancelButtonText: t('cancel'),
      confirmButtonColor: '#3b82f6',
      inputValidator: (val) => {
        if (!val || !val.trim()) return 'El nombre es obligatorio';
      }
    });
    if (newName && newName.trim() !== currentName) {
      try {
        await API.put('/api/routes/checkpoints/' + cpId, { name: newName.trim() });
        this.loadSingleMonitorRoute(routeId);
        Swal.fire({title:'Guardado',icon:'success',timer:1000,showConfirmButton:false,background:'#1e293b',color:'#f1f5f9'});
      } catch(e) {
        Swal.fire('Error', e.message, 'error');
      }
    }
  },

  async assignGuardToRoute(routeId, routeName) {
    try {
      const users = await API.get('/api/users');
      const guards = users.filter(u => u.role === 'GUARDIA' && u.status === 'ACTIVE');
      if (!guards.length) { Swal.fire({title:'Sin guardias',text:'Primero registra al menos un guardia.',icon:'warning',background:'#1e293b',color:'#f1f5f9'}); return; }
      const today = new Date().toLocaleDateString('en-CA');
      const { value } = await Swal.fire({
        title: '<i class="fas fa-user-plus" style="color:#8b5cf6"></i> Asignar Guardia', background: '#1e293b', color: '#f1f5f9', width: 550,
        html: `<div style="text-align:left;margin-bottom:12px;padding:10px;background:rgba(59,130,246,0.1);border-radius:8px;font-size:13px;color:#93c5fd"><i class="fas fa-route"></i> Ruta: <b>${routeName}</b></div>
          <label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Guardia</label>
          <select id="ra-guard" class="swal2-select" style="padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px">
            ${guards.map(g=>`<option value="${g.id}">${g.name} ${g.document_id?'('+g.document_id+')':''}</option>`).join('')}
          </select>
          <label style="font-size:12px;color:#94a3b8;font-weight:bold;margin-top:12px;display:block;text-align:left">Tipo de Turno</label>
          <select id="ra-shift" class="swal2-select" style="padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px" onchange="
            var h=this.value;var hs=document.getElementById('ra-hstart');var he=document.getElementById('ra-hend');var ds=document.getElementById('ra-dstart');var de=document.getElementById('ra-dend');
            if(h==='24x24'){hs.value='08:00';he.value='08:00';if(ds.value){var nd=new Date(ds.value+'T12:00:00');nd.setDate(nd.getDate()+1);de.value=nd.toISOString().split('T')[0]}}
            else if(h==='12H_DIA'){hs.value='08:00';he.value='20:00';de.value=ds.value}
            else if(h==='12H_NOCHE'){hs.value='20:00';he.value='08:00';if(ds.value){var nd=new Date(ds.value+'T12:00:00');nd.setDate(nd.getDate()+1);de.value=nd.toISOString().split('T')[0]}}
          ">
            <option value="12H_DIA">12 Horas — Día (08:00 - 20:00)</option>
            <option value="12H_NOCHE">12 Horas — Noche (20:00 - 08:00)</option>
            <option value="24x24">24 × 24 (08:00 - 08:00)</option>
            <option value="PERSONALIZADO">Personalizado</option>
          </select>
          <div style="display:flex;gap:8px;margin-top:12px">
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Fecha inicio</label>
              <input id="ra-dstart" type="date" value="${today}" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Fecha fin</label>
              <input id="ra-dend" type="date" value="${today}" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Hora inicio</label>
              <input id="ra-hstart" type="time" value="08:00" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Hora fin</label>
              <input id="ra-hend" type="time" value="20:00" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          </div>`,
        confirmButtonText: '<i class="fas fa-check"></i> Asignar', confirmButtonColor: '#8b5cf6', showCancelButton: true, cancelButtonText: t('cancel'),
        preConfirm: () => {
          const ds = document.getElementById('ra-dstart').value;
          const de = document.getElementById('ra-dend').value;
          if (!ds || !de) { Swal.showValidationMessage('Las fechas son obligatorias'); return false; }
          if (de < ds) { Swal.showValidationMessage('La fecha fin no puede ser anterior a la fecha inicio'); return false; }
          return {
            route_id: routeId,
            guard_id: document.getElementById('ra-guard').value,
            shift_type: document.getElementById('ra-shift').value,
            date_start: ds, date_end: de,
            hour_start: document.getElementById('ra-hstart').value,
            hour_end: document.getElementById('ra-hend').value
          };
        }
      });
      if (value) {
        try { await API.post('/api/route-assignments', value); this.loadSingleMonitorRoute(routeId); Swal.fire({title:'Guardia asignado',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); }
        catch(e) { Swal.fire({title:'No se puede asignar',html:e.message,icon:'error',background:'#1e293b',color:'#f1f5f9'}); }
      }
    } catch(e) { Swal.fire('Error',e.message,'error'); }
  },

  async deleteAssignment(id, routeId) {
    const r = await Swal.fire({title:'¿Quitar esta asignación?',icon:'warning',showCancelButton:true,confirmButtonText:'Sí, quitar',cancelButtonText:'Cancelar',confirmButtonColor:'#ef4444',background:'#1e293b',color:'#f1f5f9'});
    if (r.isConfirmed) {
      try { await API.del('/api/route-assignments/' + id); if (routeId) { this.loadSingleMonitorRoute(routeId); } else { this.loadMonitorRoutes(); } }
      catch(e) { Swal.fire('Error',e.message,'error'); }
    }
  },

  async editAssignment(id, guardId, shiftType, dateStart, dateEnd, hourStart, hourEnd, routeId, routeName) {
    try {
      const users = await API.get('/api/users');
      const guards = users.filter(u => u.role === 'GUARDIA' && u.status === 'ACTIVE');
      const { value } = await Swal.fire({
        title: '<i class="fas fa-pen" style="color:#f59e0b"></i> Editar Asignación', background: '#1e293b', color: '#f1f5f9', width: 550,
        html: `<div style="text-align:left;margin-bottom:12px;padding:10px;background:rgba(59,130,246,0.1);border-radius:8px;font-size:13px;color:#93c5fd"><i class="fas fa-route"></i> Ruta: <b>${routeName}</b></div>
          <label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Guardia</label>
          <select id="ea-guard" class="swal2-select" style="padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px">
            ${guards.map(g=>`<option value="${g.id}" ${g.id===guardId?'selected':''}>${g.name} ${g.document_id?'('+g.document_id+')':''}</option>`).join('')}
          </select>
          <label style="font-size:12px;color:#94a3b8;font-weight:bold;margin-top:12px;display:block;text-align:left">Tipo de Turno</label>
          <select id="ea-shift" class="swal2-select" style="padding:10px;width:100%;background:#0f172a;border-color:#334155;color:#f1f5f9;height:48px" onchange="
            var h=this.value;var hs=document.getElementById('ea-hstart');var he=document.getElementById('ea-hend');var ds=document.getElementById('ea-dstart');var de=document.getElementById('ea-dend');
            if(h==='24x24'){hs.value='08:00';he.value='08:00';if(ds.value){var nd=new Date(ds.value+'T12:00:00');nd.setDate(nd.getDate()+1);de.value=nd.toISOString().split('T')[0]}}
            else if(h==='12H_DIA'){hs.value='08:00';he.value='20:00';de.value=ds.value}
            else if(h==='12H_NOCHE'){hs.value='20:00';he.value='08:00';if(ds.value){var nd=new Date(ds.value+'T12:00:00');nd.setDate(nd.getDate()+1);de.value=nd.toISOString().split('T')[0]}}
          ">
            <option value="12H_DIA" ${shiftType==='12H_DIA'?'selected':''}>12 Horas — Día (08:00 - 20:00)</option>
            <option value="12H_NOCHE" ${shiftType==='12H_NOCHE'?'selected':''}>12 Horas — Noche (20:00 - 08:00)</option>
            <option value="24x24" ${shiftType==='24x24'?'selected':''}>24 × 24 (08:00 - 08:00)</option>
            <option value="PERSONALIZADO" ${shiftType==='PERSONALIZADO'?'selected':''}>Personalizado</option>
          </select>
          <div style="display:flex;gap:8px;margin-top:12px">
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Fecha inicio</label>
              <input id="ea-dstart" type="date" value="${dateStart}" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Fecha fin</label>
              <input id="ea-dend" type="date" value="${dateEnd}" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Hora inicio</label>
              <input id="ea-hstart" type="time" value="${hourStart}" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
            <div style="flex:1"><label style="font-size:12px;color:#94a3b8;font-weight:bold;display:block;text-align:left">Hora fin</label>
              <input id="ea-hend" type="time" value="${hourEnd}" class="swal2-input" style="margin-top:4px;background:#0f172a;border-color:#334155;color:#f1f5f9"></div>
          </div>`,
        confirmButtonText: '<i class="fas fa-save"></i> Guardar Cambios', confirmButtonColor: '#f59e0b', showCancelButton: true, cancelButtonText: t('cancel'),
        preConfirm: () => {
          const ds = document.getElementById('ea-dstart').value;
          const de = document.getElementById('ea-dend').value;
          if (!ds || !de) { Swal.showValidationMessage('Las fechas son obligatorias'); return false; }
          if (de < ds) { Swal.showValidationMessage('La fecha fin no puede ser anterior a la fecha inicio'); return false; }
          return {
            guard_id: document.getElementById('ea-guard').value,
            shift_type: document.getElementById('ea-shift').value,
            date_start: ds, date_end: de,
            hour_start: document.getElementById('ea-hstart').value,
            hour_end: document.getElementById('ea-hend').value
          };
        }
      });
      if (value) {
        try { await API.put('/api/route-assignments/' + id, value); this.loadSingleMonitorRoute(routeId); Swal.fire({title:'Asignación actualizada',icon:'success',timer:1500,background:'#1e293b',color:'#f1f5f9'}); }
        catch(e) { Swal.fire({title:'Error al actualizar',html:e.message,icon:'error',background:'#1e293b',color:'#f1f5f9'}); }
      }
    } catch(e) { Swal.fire('Error',e.message,'error'); }
  },

  // ═══════════ SHIFTS ═══════════
  async page_shifts() {
    const el = document.getElementById('page-content');
    el.innerHTML = `<div class="card"><div class="card-header"><h3>${t('nav_shifts')}</h3><button class="btn btn-primary btn-sm" onclick="App.showShiftModal()"><i class="fas fa-plus"></i> ${t('create')}</button></div><div class="card-body table-container"><table class="data-table"><thead><tr><th>Guardia</th><th>Ruta</th><th>Inicio</th><th>Fin</th><th>${t('status')}</th></tr></thead><tbody id="shifts-tbody">${t('loading')}</tbody></table></div></div>`;
    try {
      const shifts = await API.get('/api/shifts');
      document.getElementById('shifts-tbody').innerHTML = shifts.length ? shifts.map(s => `<tr>
        <td>${s.guard_name}</td><td>${s.route_name}</td>
        <td>${s.scheduled_start ? new Date(s.scheduled_start.replace(' ','T')).toLocaleString() : '-'}</td><td>${s.scheduled_end ? new Date(s.scheduled_end.replace(' ','T')).toLocaleString() : '-'}</td>
        <td><span class="badge-status ${s.status==='ACTIVE'?'badge-active':s.status==='COMPLETED'?'badge-completed':'badge-pending'}">${s.status}</span></td></tr>`).join('') : `<tr><td colspan="5" class="empty-state">${t('no_data')}</td></tr>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async showShiftModal() {
    try {
      const [users, routes] = await Promise.all([API.get('/api/users'), API.get('/api/routes')]);
      const guards = users.filter(u => u.role === 'GUARDIA' && u.status === 'ACTIVE');
      if (!guards.length || !routes.length) { Swal.fire({title:'Atención',text:'Necesitas al menos un Guardia y una Ruta creados para programar un turno.',icon:'warning',background:'#1e293b',color:'#f1f5f9'}); return; }
      // Generar fechas por defecto: hoy a las 8pm y mañana a las 8am
      const now = new Date();
      const startDefault = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0).toISOString().slice(0,16);
      const endDefault = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 8, 0).toISOString().slice(0,16);
      const { value } = await Swal.fire({
        title: 'Nuevo Turno', background: '#1e293b', color: '#f1f5f9',
        html: `<select id="swal-guard" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;width:100%">
            ${guards.map(g=>`<option value="${g.id}">${g.name}</option>`).join('')}</select>
          <select id="swal-route" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;width:100%;margin-top:8px">
            ${routes.map(r=>`<option value="${r.id}">${r.name}</option>`).join('')}</select>
          <label style="font-size:12px;color:#94a3b8;margin-top:12px;display:block;text-align:left">Inicio del turno</label>
          <input id="swal-start" type="datetime-local" value="${startDefault}" class="swal2-input" style="background:#0f172a;border-color:#334155;color:#f1f5f9;margin-top:4px">
          <label style="font-size:12px;color:#94a3b8;margin-top:8px;display:block;text-align:left">Fin del turno</label>
          <input id="swal-end" type="datetime-local" value="${endDefault}" class="swal2-input" style="background:#0f172a;border-color:#334155;color:#f1f5f9;margin-top:4px">`,
        confirmButtonText: t('save'), showCancelButton: true, cancelButtonText: t('cancel'),
        preConfirm: () => {
          const start = document.getElementById('swal-start').value;
          const end = document.getElementById('swal-end').value;
          if (!start || !end) { Swal.showValidationMessage('Las fechas de inicio y fin son obligatorias'); return false; }
          return { guard_id: document.getElementById('swal-guard').value, route_id: document.getElementById('swal-route').value, scheduled_start: start.replace('T',' ')+':00', scheduled_end: end.replace('T',' ')+':00' };
        }
      });
      if (value) { await API.post('/api/shifts', value); this.page_shifts(); }
    } catch(e) { Swal.fire('Error',e.message,'error'); }
  },

  // ═══════════ ALERTS ═══════════
  async page_alerts() {
    const el = document.getElementById('page-content');
    try {
      const alerts = await API.get('/api/alerts');
      el.innerHTML = `<div class="card"><div class="card-header"><h3><i class="fas fa-bell"></i> ${t('nav_alerts')} (${alerts.length})</h3></div><div class="card-body">${alerts.length ? alerts.map(a => `
        <div style="padding:14px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:50%;background:${a.alert_type==='EMERGENCY'?'var(--danger-bg)':a.alert_type==='URGENT'?'var(--warning-bg)':'var(--info-bg)'};display:flex;align-items:center;justify-content:center">
            <i class="fas ${a.alert_type==='EMERGENCY'?'fa-skull-crossbones':a.alert_type==='URGENT'?'fa-exclamation-triangle':'fa-info-circle'}" style="color:${a.alert_type==='EMERGENCY'?'var(--danger)':a.alert_type==='URGENT'?'var(--warning)':'var(--info)'}"></i></div>
          <div style="flex:1"><b>${a.title}</b><br><small style="color:var(--text-muted)">${a.message||''} — ${new Date(a.created_at+'Z').toLocaleString('es-GT',{timeZone:'America/Guatemala'})}</small>
          ${(()=>{
            let lat = a.latitude, lng = a.longitude;
            if (!lat || !lng) { const m=String(a.message||'').match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/); if(m){lat=m[1];lng=m[2];} }
            if (!lat || !lng || (parseFloat(lat)===0 && parseFloat(lng)===0)) return '';
            const coords = `${parseFloat(lat).toFixed(6)},${parseFloat(lng).toFixed(6)}`;
            return `<div style="display:inline-flex;gap:6px;align-items:center;margin-top:4px">
              <span style="font-size:11px;color:#64748b;font-family:monospace">📍${coords}</span>
              <button onclick="navigator.clipboard.writeText('${coords}').then(()=>{this.innerHTML='✅ Copiado';setTimeout(()=>{this.innerHTML='<i class=\\'fas fa-copy\\'></i> Copiar GPS'},2000)}).catch(()=>{})" style="background:#1e3a5f;border:1px solid #3b82f6;color:#60a5fa;padding:3px 9px;border-radius:6px;font-size:11px;cursor:pointer"><i class='fas fa-copy'></i> Copiar GPS</button>
              <a href="https://www.google.com/maps?q=${coords}" target="_blank" style="background:#0f2d1a;border:1px solid #10b981;color:#10b981;padding:3px 9px;border-radius:6px;font-size:11px;text-decoration:none"><i class='fas fa-map-marker-alt'></i> Mapa</a>
            </div>`;
          })()}
          </div>
          ${!a.acknowledged?`<button class="btn btn-outline btn-sm" onclick="App.ackAlert('${a.id}')"><i class="fas fa-check"></i></button>`:''}</div>`).join('') : `<div class="empty-state"><i class="fas fa-check-circle"></i><p>${t('no_data')}</p></div>`}</div></div>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  async ackAlert(id) { try { await API.put(`/api/alerts/${id}/acknowledge`); this.page_alerts(); } catch(e) {} },

  // ═══════════ INCIDENTS ═══════════
  async page_incidents() {
    const el = document.getElementById('page-content');
    try {
      const incidents = await API.get('/api/incidents');
      el.innerHTML = `<div class="card"><div class="card-header"><h3>${t('nav_incidents')}</h3></div><div class="card-body table-container"><table class="data-table"><thead><tr><th>Tipo</th><th>Título</th><th>Reportado por</th><th>Severidad</th><th>${t('status')}</th><th>${t('date')}</th></tr></thead><tbody>${incidents.length ? incidents.map(i => `<tr>
        <td>${i.incident_type}</td><td><b>${i.title}</b>${i.description ? `<br><span style="font-size:12px;color:#94a3b8;font-style:italic">${i.description}</span>` : ''}</td><td>${i.reporter_name}</td>
        <td><span class="badge-status ${i.severity==='CRITICAL'?'badge-danger':i.severity==='HIGH'?'badge-pending':'badge-info'}">${i.severity}</span></td>
        <td><span class="badge-status ${i.status==='OPEN'?'badge-danger':'badge-active'}">${i.status}</span></td>
        <td>${new Date(i.created_at+'Z').toLocaleString('es-GT',{timeZone:'America/Guatemala'})}</td></tr>`).join('') : `<tr><td colspan="6" class="empty-state">${t('no_data')}</td></tr>`}</tbody></table></div></div>`;
    } catch(e) { el.innerHTML = `<p>Error: ${e.message}</p>`; }
  },

  // ═══════════ GUARD MOBILE VIEW ═══════════
  renderGuardView() {
    document.getElementById('app').innerHTML = `
    <div class="guard-layout" style="background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%); min-height: 100vh; padding-bottom: 40px;">
      <div class="guard-header" style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-bottom: 1px solid rgba(255,255,255,0.05); padding: 25px 20px 35px; text-align: center; border-radius: 0 0 30px 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
         <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:15px; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.05);">
           <div style="text-align: left;">
              <div style="font-weight: 800; font-size: 18px; letter-spacing: 1px; color:#f8fafc; line-height:1;">SISDEL</div>
              <div style="color:#10b981; font-size: 11px; font-weight: 600; letter-spacing: 1px;">RONDÍN MÓVIL</div>
           </div>
           <button class="btn btn-outline btn-sm" style="color:#ef4444;border:1px solid rgba(239,68,68,0.3); background:rgba(239,68,68,0.1); border-radius: 10px; padding: 6px 14px; font-size: 13px;" onclick="API.logout()"><i class="fas fa-sign-out-alt"></i> Salir</button>
         </div>
         <div class="user-avatar" style="width:70px;height:70px;font-size:28px;margin:0 auto;box-shadow: 0 0 25px rgba(59,130,246,0.3);border:2px solid #3b82f6;">${API.user.name[0]}</div>
         <div style="margin-top:16px;">
           <div class="guard-name" style="font-size:22px; font-weight:700; letter-spacing:0.5px; color:#f8fafc; margin:0;">${API.user.name}</div>
         </div>
         ${API.user.company_name ? '<div style="margin-top:8px;font-size:15px;color:#f8fafc;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;line-height:1.2;font-family:\'Georgia\',serif;font-style:italic">'+API.user.company_name+'</div>' : ''}
         
         <div class="guard-route" id="guard-route" style="margin-top:16px; background: rgba(59,130,246,0.15); padding: 8px 18px; border-radius: 20px; font-size: 14px; color: #60a5fa; display: inline-block; font-weight:500; border:1px solid rgba(59,130,246,0.3)">Cargando ruta...</div>
         <div style="margin-top:14px"><span class="badge-status badge-pending" id="guard-duty-status" style="padding: 6px 16px; border-radius: 20px; font-size: 13px; letter-spacing: 1px; font-weight:600;">${t('guard_status_off_duty')}</span></div>
      </div>
      
      <div class="guard-status-bar" id="guard-stats" style="margin: -25px 20px 25px; background: rgba(30,41,59,0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; padding: 18px 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); display: flex; justify-content: space-around; position: relative; z-index: 10;">
        <div class="guard-status-item" style="text-align: center;"><div class="value" id="g-rounds" style="font-size: 26px; font-weight: 800; color: #f8fafc;">0</div><div class="label" style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; font-weight:600">Rondas</div></div>
        <div style="width: 1px; background: linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%);"></div>
        <div class="guard-status-item" style="text-align: center;"><div class="value" id="g-checks" style="font-size: 26px; font-weight: 800; color: #f8fafc;">0</div><div class="label" style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; font-weight:600">Checks</div></div>
        <div style="width: 1px; background: linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%);"></div>
        <div class="guard-status-item" style="text-align: center;"><div class="value" id="g-score" style="font-size: 26px; font-weight: 800; color: #f8fafc;">-</div><div class="label" style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; font-weight:600">Score</div></div>
      </div>

      <div id="guard-proximity-info" style="display:none;padding:18px;background:linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.05) 100%);border:1px solid rgba(59,130,246,0.3);border-radius:20px;margin:0 20px 20px;text-align:center;box-shadow: 0 4px 20px rgba(0,0,0,0.2);">
        <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;letter-spacing:1px;font-weight:700;"><i class="fas fa-satellite-dish" style="color:#60a5fa;margin-right:6px;"></i> PUNTO MÁS CERCANO</div>
        <div id="nearest-cp-name" style="color:#60a5fa;font-weight:800;font-size:20px;margin-bottom:6px;letter-spacing:0.5px;">---</div>
        <div id="nearest-cp-dist" style="color:#cbd5e1;font-size:15px;font-weight:600;">--- m</div>
      </div>

      <div class="guard-actions" id="guard-actions" style="padding: 0 20px;">
        <button class="guard-action-btn" onclick="App.guardStartRound()" id="btn-start-round" style="background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); border-radius: 20px; padding: 18px; display: flex; align-items: center; text-align: left; margin-bottom: 15px; width: 100%; transition: all 0.3s ease;">
           <i style="background: rgba(16,185,129,0.15); color: #10b981; width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 22px; margin-right: 18px;"><i class="fas fa-play"></i></i>
           <div style="flex: 1;">
              <div style="color: #10b981; font-weight: 700; font-size: 17px; margin-bottom: 5px;">Iniciar Ronda</div>
              <div class="action-desc" style="color: #94a3b8; font-size: 13px; line-height: 1.4;">Registra el punto de partida oficial</div>
           </div>
        </button>
        <button class="guard-action-btn" onclick="App.guardEndRound()" id="btn-end-round" style="display:none; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 20px; padding: 18px; align-items: center; text-align: left; margin-bottom: 15px; width: 100%; transition: all 0.3s ease;">
           <i style="background: rgba(239,68,68,0.15); color: #ef4444; width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 22px; margin-right: 18px;"><i class="fas fa-stop"></i></i>
           <div style="flex: 1;">
              <div style="color: #ef4444; font-weight: 700; font-size: 17px; margin-bottom: 5px;">Terminar Ronda</div>
              <div class="action-desc" style="color: #94a3b8; font-size: 13px; line-height: 1.4;">Concluye la patrulla actual</div>
           </div>
        </button>
        <button onclick="App.guardReportIncident()" style="background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); border-radius: 20px; padding: 18px; display: flex; align-items: center; text-align: left; margin-bottom: 15px; width: 100%; transition: all 0.3s ease;">
           <i style="background: rgba(245,158,11,0.15); color: #f59e0b; width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 22px; margin-right: 18px;"><i class="fas fa-triangle-exclamation"></i></i>
           <div style="flex: 1;">
              <div style="color: #f59e0b; font-weight: 700; font-size: 17px; margin-bottom: 5px;">${t('guard_report_incident')}</div>
              <div class="action-desc" style="color: #94a3b8; font-size: 13px; line-height: 1.4;">Reporta irregularidad o solicita auxilio</div>
           </div>
        </button>
        <button onclick="App.activatePanic()" style="width:100%;padding:20px;border-radius:20px;border:2px solid #ef4444;background:linear-gradient(135deg,rgba(239,68,68,0.18) 0%,rgba(185,28,28,0.18) 100%);color:#ef4444;font-size:18px;font-weight:800;letter-spacing:2px;display:flex;align-items:center;justify-content:center;gap:14px;cursor:pointer;margin-bottom:30px;box-shadow:0 4px 24px rgba(239,68,68,0.25);transition:all 0.2s ease;">
          <i class="fas fa-radiation" style="font-size:26px;animation:pulse 2s infinite;"></i>
          🆘 BOTÓN DE PÁNICO
        </button>
      </div>
    </div>
    <div id="checkpoint-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.95);display:none;flex-direction:column;align-items:center;justify-content:center;padding:30px"></div>
    <style>@keyframes slideIn{from{transform:translateY(-20px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes pulseGreen{0%,100%{box-shadow:0 0 20px rgba(16,185,129,0.3)}50%{box-shadow:0 0 40px rgba(16,185,129,0.7)}}</style>`;
    this.routeCheckpoints = [];
    this.notifiedCheckpoints = {};
    this.checkGuardShift();
  },

  async checkGuardShift() {
    try {
      // Check active shifts first
      const shifts = await API.get('/api/shifts?guard_id=' + API.user.id + '&status=ACTIVE');
      if (shifts.length > 0) {
        this.activeShift = shifts[0];
        document.getElementById('guard-duty-status').textContent = 'EN SERVICIO';
        document.getElementById('guard-duty-status').className = 'badge-status badge-active';
        document.getElementById('guard-route').textContent = this.activeShift.route_name;
        document.getElementById('btn-end-round').style.display = 'flex';
        document.getElementById('btn-start-round').style.display = 'none';
        try {
          var detail = await API.get('/api/routes/' + this.activeShift.route_id);
          this.routeCheckpoints = detail.checkpoints || [];
        } catch(e2) { this.routeCheckpoints = []; }
        this.startTracking();
        return;
      }
      // Check route assignment
      var assignment = await API.get('/api/my-assignment');
      if (assignment) {
        this.currentAssignment = assignment;
        document.getElementById('guard-duty-status').textContent = 'EN SERVICIO';
        document.getElementById('guard-duty-status').className = 'badge-status badge-active';
        document.getElementById('guard-route').textContent = assignment.route_name + ' (' + assignment.shift_type + ')';
        // Load checkpoints
        try {
          var detail = await API.get('/api/routes/' + assignment.route_id);
          this.routeCheckpoints = detail.checkpoints || [];
        } catch(e2) { this.routeCheckpoints = []; }
        this.startTracking();
      } else {
        document.getElementById('guard-route').textContent = 'Sin ruta asignada hoy';
      }
    } catch(e) { console.error(e); }
  },

  async guardStartRound() {
    var pos = await this.getLocation();
    if (!pos) return Swal.fire({title:'GPS requerido',text:'No se pudo obtener tu ubicación. Activa el GPS.',icon:'warning',background:'#1e293b',color:'#f1f5f9'});
    // Camera photo
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.capture = 'environment';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async function() {
      var file = fileInput.files[0];
      document.body.removeChild(fileInput);
      var photoData = null;
      if (file) {
        photoData = await new Promise(function(resolve) {
          var reader = new FileReader();
          reader.onload = function(e) { resolve(e.target.result); };
          reader.readAsDataURL(file);
        });
      }
      // Get or create shift from assignment
      var routeId = App.activeShift ? App.activeShift.route_id : (App.currentAssignment ? App.currentAssignment.route_id : null);
      var routeName = App.activeShift ? App.activeShift.route_name : (App.currentAssignment ? App.currentAssignment.route_name : 'Ruta');
      if (!routeId) return Swal.fire({title:'Sin ruta',text:'No tienes ruta asignada',icon:'warning',background:'#1e293b',color:'#f1f5f9'});
      try {
        // Auto-create shift if needed
        if (!App.activeShift || App.activeShift.id.startsWith('assignment_')) {
          var now = new Date();
          var shiftType = App.currentAssignment ? App.currentAssignment.shift_type : '24x24';
          var endTime = new Date(now.getTime() + (shiftType === '24x24' ? 24 : 12) * 60 * 60 * 1000);
          var newShift = await API.post('/api/shifts', {
            guard_id: API.user.id,
            route_id: routeId,
            scheduled_start: now.toISOString(),
            scheduled_end: endTime.toISOString()
          });
          await API.post('/api/shifts/' + newShift.id + '/checkin', { latitude: pos.lat, longitude: pos.lng, photo: photoData, battery_level: 100 });
          App.activeShift = newShift;
        }
        // Start round
        var round = await API.post('/api/rounds/start', { shift_id: App.activeShift.id, route_id: routeId });
        App.activeRound = round;
        Swal.fire({title:'🚶 Ronda Iniciada',html:'<b>' + routeName + '</b><br><small style="color:#94a3b8">📍 ' + pos.lat.toFixed(6) + ', ' + pos.lng.toFixed(6) + '</small>' + (photoData ? '<br><small style="color:#10b981">📷 Foto registrada</small>' : ''),icon:'success',timer:3000,background:'#1e293b',color:'#f1f5f9'});
        document.getElementById('btn-start-round').style.display = 'none';
        document.getElementById('btn-end-round').style.display = 'flex';
        var el = document.getElementById('g-rounds');
        if (el) el.textContent = parseInt(el.textContent || '0') + 1;
      } catch(e) { Swal.fire('Error', e.message, 'error'); }
    });
    fileInput.click();
  },

  async guardEndRound() {
    var pos = await this.getLocation();
    if (!pos) return Swal.fire({title:'GPS requerido',text:'No se pudo obtener tu ubicación. Activa el GPS.',icon:'warning',background:'#1e293b',color:'#f1f5f9'});
    // Camera photo
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.capture = 'environment';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async function() {
      var file = fileInput.files[0];
      document.body.removeChild(fileInput);
      var photoData = null;
      if (file) {
        photoData = await new Promise(function(resolve) {
          var reader = new FileReader();
          reader.onload = function(e) { resolve(e.target.result); };
          reader.readAsDataURL(file);
        });
      }
      try {
        if (App.activeShift && !App.activeShift.id.startsWith('assignment_')) {
          await API.post('/api/shifts/' + App.activeShift.id + '/checkout', { latitude: pos.lat, longitude: pos.lng, photo: photoData });
        }
        App.activeRound = null;
        Swal.fire({title:'✅ Ronda Finalizada',html:'<small style="color:#94a3b8">📍 ' + pos.lat.toFixed(6) + ', ' + pos.lng.toFixed(6) + '</small>' + (photoData ? '<br><small style="color:#10b981">📷 Foto registrada</small>' : ''),icon:'success',timer:3000,background:'#1e293b',color:'#f1f5f9'});
        document.getElementById('btn-start-round').style.display = 'flex';
        document.getElementById('btn-end-round').style.display = 'none';
      } catch(e) { Swal.fire('Error', e.message, 'error'); }
    });
    fileInput.click();
  },

  async guardReportIncident() {
    const { value } = await Swal.fire({
      title: '⚠️ Reportar Incidente', background: '#1e293b', color: '#f1f5f9', width: 420,
      html:
        '<div style="text-align:left;font-size:12px;color:#f59e0b;font-weight:700;margin:4px 0 6px;letter-spacing:1px">TIPO DE INCIDENTE</div>' +
        '<select id="swal-type" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;width:100%;margin-bottom:10px">' +
          '<option value="SUSPICIOUS_PERSON">👤 Persona sospechosa</option>' +
          '<option value="INTRUSION">🚪 Intrusión</option>' +
          '<option value="PROPERTY_DAMAGE">🔨 Daño a propiedad</option>' +
          '<option value="MEDICAL">🏥 Emergencia médica</option>' +
          '<option value="EQUIPMENT_FAILURE">⚙️ Falla de equipo</option>' +
          '<option value="OTHER">📋 Otro</option>' +
        '</select>' +
        '<div style="text-align:left;font-size:12px;color:#f59e0b;font-weight:700;margin:4px 0 6px;letter-spacing:1px">GRAVEDAD</div>' +
        '<select id="swal-sev" class="swal2-select" style="background:#0f172a;border-color:#334155;color:#f1f5f9;padding:10px;width:100%;margin-bottom:10px">' +
          '<option value="LOW">🟢 Baja</option>' +
          '<option value="MEDIUM" selected>🟡 Media</option>' +
          '<option value="HIGH">🔴 Alta</option>' +
          '<option value="CRITICAL">🆘 Crítica</option>' +
        '</select>' +
        '<div style="text-align:left;font-size:12px;color:#f59e0b;font-weight:700;margin:4px 0 6px;letter-spacing:1px">TÍTULO BREVE</div>' +
        '<input id="swal-title" class="swal2-input" placeholder="Ej: Puerta trasera abierta" style="background:#0f172a;border-color:#334155;color:#f1f5f9;margin-bottom:10px">' +
        '<div style="text-align:left;font-size:12px;color:#f59e0b;font-weight:700;margin:4px 0 6px;letter-spacing:1px">DESCRIPCIÓN (visible para supervisor y director)</div>' +
        '<textarea id="swal-desc" class="swal2-textarea" placeholder="Describe lo que ves con detalle: personas, objetos, ubicación exacta..." style="background:#0f172a;border-color:#334155;color:#f1f5f9;min-height:100px;font-size:14px"></textarea>',
      confirmButtonText: '📤 Enviar Reporte', confirmButtonColor: '#f59e0b', showCancelButton: true, cancelButtonText: 'Cancelar',
      preConfirm: () => {
        const title = document.getElementById('swal-title').value.trim();
        const desc = document.getElementById('swal-desc').value.trim();
        if (!title && !desc) { Swal.showValidationMessage('Escribe al menos un título o descripción'); return false; }
        return {
          incident_type: document.getElementById('swal-type').value,
          severity: document.getElementById('swal-sev').value,
          title: title || document.getElementById('swal-type').options[document.getElementById('swal-type').selectedIndex].text,
          description: desc
        };
      }
    });
    if (!value) return;
    const pos = await this.getLocation();
    try {
      await API.post('/api/incidents', { ...value, latitude: pos?.lat, longitude: pos?.lng, shift_id: this.activeShift?.id });
      Swal.fire({ title: '✅ Reporte Enviado', text: 'Tu supervisor y director lo verán ahora', icon: 'success', timer: 2500, background: '#1e293b', color: '#f1f5f9', showConfirmButton: false });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },


  async activatePanic() {
    const confirm = await Swal.fire({ title: '🆘 ¿ACTIVAR PÁNICO?', text: 'Se alertará a todos los supervisores y administradores', icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626', confirmButtonText: 'SÍ, ACTIVAR', background: '#1e293b', color: '#f1f5f9' });
    if (!confirm.isConfirmed) return;
    const pos = await this.getLocation();
    try {
      await API.post('/api/panic', { latitude: pos?.lat || 0, longitude: pos?.lng || 0, trigger_method: 'BUTTON', shift_id: this.activeShift?.id });
      Swal.fire({title:'🆘 Alerta Enviada',text:'Ayuda en camino',icon:'warning',background:'#1e293b',color:'#f1f5f9'});
    } catch(e) { Swal.fire('Error',e.message,'error'); }
  },

  // ═══════════ TRACKING + CHECKPOINT PROXIMITY ═══════════
  haversineDistance(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  startTracking() {
    if (this.trackingInterval || this.watchId) return;
    var checkProximity = function(pos) {
      if (!pos || !App.routeCheckpoints || !App.routeCheckpoints.length) return;
      // Send tracking data if we have a shift
      if (App.activeShift) {
        API.post('/api/tracking', { latitude: pos.lat, longitude: pos.lng, accuracy: pos.accuracy, shift_id: App.activeShift.id, battery_level: 100 }).catch(function(){});
      }
      // Calcular distancia a todos los puntos y mostrar el más cercano
      var nearest = null;
      var nearestDist = Infinity;
      App.routeCheckpoints.forEach(function(cp) {
        var dist = App.haversineDistance(pos.lat, pos.lng, parseFloat(cp.latitude), parseFloat(cp.longitude));
        var radius = parseFloat(cp.radius_meters) || 15;
        if (dist < nearestDist) { nearestDist = dist; nearest = cp; }
        if (dist <= radius && !App.notifiedCheckpoints[cp.id]) {
          App.notifiedCheckpoints[cp.id] = true;
          App.showCheckpointOverlay(cp, pos, dist);
          // Resetear después de 5 minutos para permitir múltiples rondas
          setTimeout(function() { delete App.notifiedCheckpoints[cp.id]; }, 5 * 60 * 1000);
        }
      });
      // Actualizar indicador de punto más cercano
      App.updateNearestCheckpointUI(nearest, nearestDist);
    };
    // Usar watchPosition para detección GPS más precisa y continua
    if (navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        function(p) {
          var pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
          checkProximity(pos);
        },
        function(err) { console.warn('GPS watch error:', err.message); },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    }
    // Fallback: también usar intervalo para enviar tracking periódicamente
    this.trackingInterval = setInterval(async function() {
      var pos = await App.getLocation();
      if (pos && App.activeShift) {
        API.post('/api/tracking', { latitude: pos.lat, longitude: pos.lng, accuracy: pos.accuracy, shift_id: App.activeShift.id, battery_level: 100 }).catch(function(){});
      }
    }, 30000);
  },

  updateNearestCheckpointUI(cp, dist) {
    var container = document.getElementById('guard-proximity-info');
    var nameEl = document.getElementById('nearest-cp-name');
    var distEl = document.getElementById('nearest-cp-dist');
    if (!container || !nameEl || !distEl || !cp) return;
    container.style.display = 'block';
    nameEl.textContent = cp.name;
    var radius = parseFloat(cp.radius_meters) || 15;
    if (dist <= radius) {
      distEl.innerHTML = '<span style="color:#10b981;font-weight:bold"><i class="fas fa-check-circle"></i> ¡ESTÁS AQUÍ! (' + Math.round(dist) + 'm)</span>';
      container.style.borderColor = 'rgba(16,185,129,0.5)';
      container.style.background = 'rgba(16,185,129,0.1)';
    } else if (dist <= 50) {
      distEl.innerHTML = '<span style="color:#f59e0b"><i class="fas fa-walking"></i> A ' + Math.round(dist) + 'm — ¡Casi llegas!</span>';
      container.style.borderColor = 'rgba(245,158,11,0.5)';
      container.style.background = 'rgba(245,158,11,0.1)';
    } else {
      distEl.textContent = 'A ' + Math.round(dist) + ' metros';
      container.style.borderColor = 'rgba(59,130,246,0.3)';
      container.style.background = 'rgba(59,130,246,0.1)';
    }
  },

  stopTracking() {
    clearInterval(this.trackingInterval); this.trackingInterval = null;
    if (this.watchId) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
  },

  playCheckpointSound() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Tono de éxito: dos notas ascendentes
      [523.25, 659.25, 783.99].forEach(function(freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i*0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i*0.15 + 0.3);
        osc.start(ctx.currentTime + i*0.15);
        osc.stop(ctx.currentTime + i*0.15 + 0.3);
      });
    } catch(e) {}
  },

  showCheckpointOverlay(cp, pos, dist) {
    var overlay = document.getElementById('checkpoint-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    var now = new Date();
    var dateStr = now.toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    var timeStr = now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true });
    var distText = dist ? Math.round(dist) + 'm' : '';
    overlay.innerHTML = '<div style="text-align:center;animation:slideIn 0.5s ease-out;max-width:400px;width:100%">' +
      '<div style="width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);margin:0 auto 20px;display:flex;align-items:center;justify-content:center;animation:pulseGreen 1.5s infinite;box-shadow:0 0 40px rgba(16,185,129,0.5)">' +
      '<i class="fas fa-map-marker-alt" style="font-size:50px;color:white"></i></div>' +
      '<h1 style="color:#10b981;font-size:26px;font-weight:800;margin-bottom:6px">📍 PUNTO VISITADO</h1>' +
      '<h2 style="color:#f1f5f9;font-size:22px;font-weight:700;margin-bottom:4px">' + cp.name + '</h2>' +
      (distText ? '<div style="color:#64748b;font-size:13px;margin-bottom:12px"><i class="fas fa-location-arrow"></i> Distancia: ' + distText + '</div>' : '') +
      '<div style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:12px;padding:16px;margin-bottom:20px;text-align:left">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;border-bottom:1px solid rgba(16,185,129,0.2);padding-bottom:8px"><i class="fas fa-user-shield" style="color:#3b82f6"></i><b style="color:#f1f5f9;font-size:14px">' + API.user.name + '</b></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">' +
      '<div><span style="color:#64748b">Lat:</span> <b style="color:#10b981">' + (pos.lat).toFixed(6) + '</b></div>' +
      '<div><span style="color:#64748b">Lng:</span> <b style="color:#10b981">' + (pos.lng).toFixed(6) + '</b></div>' +
      '</div>' +
      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(16,185,129,0.2)">' +
      '<div style="color:#94a3b8;font-size:13px"><i class="fas fa-calendar"></i> ' + dateStr + '</div>' +
      '<div style="color:#f1f5f9;font-size:16px;font-weight:700;margin-top:2px"><i class="fas fa-clock"></i> ' + timeStr + '</div>' +
      '</div></div>' +
      '<div style="color:#64748b;font-size:11px;margin-bottom:16px;padding:8px;background:rgba(59,130,246,0.1);border-radius:8px"><i class="fas fa-info-circle"></i> Al presionar ENVIAR se notificará automáticamente al panel central con tu nombre, ubicación y hora exacta.</div>' +
      '<button id="btn-send-checkpoint" onclick="App.confirmCheckpointVisit(\'' + cp.id + '\',\'' + cp.name + '\',' + pos.lat + ',' + pos.lng + ')" style="width:100%;padding:20px;background:linear-gradient(135deg,#10b981,#059669);border:none;border-radius:16px;color:white;font-size:20px;font-weight:800;cursor:pointer;box-shadow:0 8px 30px rgba(16,185,129,0.4);display:flex;align-items:center;justify-content:center;gap:12px;transition:transform 0.2s">' +
      '<i class="fas fa-paper-plane" style="font-size:24px"></i> ENVIAR</button>' +
      '<button onclick="document.getElementById(\'checkpoint-overlay\').style.display=\'none\'" style="margin-top:12px;background:transparent;border:1px solid #334155;color:#64748b;padding:12px 24px;border-radius:8px;font-size:14px;cursor:pointer;width:100%"><i class="fas fa-times"></i> Cerrar</button>' +
      '</div>';
    // Vibración fuerte + sonido
    if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 500]);
    this.playCheckpointSound();
  },

  async confirmCheckpointVisit(cpId, cpName, lat, lng) {
    // Deshabilitar botón para evitar doble envío
    var btn = document.getElementById('btn-send-checkpoint');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...'; }
    try {
      var routeId = this.activeShift?.route_id || this.currentAssignment?.route_id;
      var result = await API.post('/api/checkpoint-visits', {
        checkpoint_id: cpId,
        route_id: routeId,
        shift_id: this.activeShift?.id,
        round_id: this.activeRound?.id,
        latitude: lat,
        longitude: lng
      });
      document.getElementById('checkpoint-overlay').style.display = 'none';
      // Mostrar confirmación detallada con resumen de lo enviado
      var ts = result.timestamp || new Date().toLocaleString();
      Swal.fire({
        title: '✅ Enviado al Panel Central',
        icon: 'success',
        background: '#1e293b',
        color: '#f1f5f9',
        html: '<div style="text-align:left;padding:16px;background:#0f172a;border-radius:12px;border:1px solid #334155;margin-top:8px">' +
          '<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e293b"><span style="color:#64748b;font-size:12px">Guardia:</span><br><b style="color:#f1f5f9;font-size:15px">' + API.user.name + '</b></div>' +
          '<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e293b"><span style="color:#64748b;font-size:12px">Punto de control:</span><br><b style="color:#3b82f6;font-size:15px">' + cpName + '</b></div>' +
          '<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e293b"><span style="color:#64748b;font-size:12px">Coordenadas:</span><br><span style="color:#10b981;font-family:monospace">' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</span></div>' +
          '<div><span style="color:#64748b;font-size:12px">Fecha y hora:</span><br><b style="color:#f59e0b">' + ts + '</b></div>' +
          '</div>' +
          '<div style="margin-top:12px;font-size:12px;color:#10b981"><i class="fas fa-check-double"></i> Datos enviados correctamente al panel central</div>',
        timer: 5000,
        timerProgressBar: true
      });
      // Vibración de confirmación
      if (navigator.vibrate) navigator.vibrate([300, 200, 300, 200, 300]);
      // Update checks count
      var el = document.getElementById('g-checks');
      if (el) el.textContent = parseInt(el.textContent || '0') + 1;
    } catch(e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane" style="font-size:24px"></i> ENVIAR'; }
      Swal.fire('Error', e.message, 'error');
    }
  },

  getLocation() {
    return new Promise(function(resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function(p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
        function() { resolve(null); }, { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  },

  // ═══════════ TOASTS ═══════════
  showToast(msg, type) {
    var t2 = document.createElement('div');
    t2.className = 'alert-toast';
    t2.innerHTML = '<h4>' + (type || 'INFO') + '</h4><p>' + msg + '</p>';
    document.body.appendChild(t2);
    setTimeout(function() { t2.remove(); }, 5000);
  },

  playAlertBeep() {
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      const resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
      resume.then(() => {
        [0, 0.35, 0.7].forEach((delay, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = i === 1 ? 660 : 880;
          g.gain.setValueAtTime(0.6, ctx.currentTime + delay);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.28);
          o.start(ctx.currentTime + delay);
          o.stop(ctx.currentTime + delay + 0.3);
        });
      });
    } catch(e) { console.warn('Audio beep error:', e); }
  },

  showPanicAlert(data) {
    if (this._panicSirenInterval) clearInterval(this._panicSirenInterval);
    if (this._panicOsc1) { try { this._panicOsc1.stop(); this._panicOsc1=null; } catch(e){} }
    if (this._panicOsc2) { try { this._panicOsc2.stop(); this._panicOsc2=null; } catch(e){} }
    if (this._panicGain) { try { this._panicGain.disconnect(); this._panicGain=null; } catch(e){} }

    // === SIREN SOUND via Web Audio API ===
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioCtx = this._audioCtx;
      
      this._panicGain = audioCtx.createGain();
      this._panicGain.gain.value = 0.5;
      this._panicGain.connect(audioCtx.destination);
      
      this._panicOsc1 = audioCtx.createOscillator();
      this._panicOsc1.type = 'sawtooth'; this._panicOsc1.frequency.value = 800;
      this._panicOsc1.connect(this._panicGain); this._panicOsc1.start();
      
      this._panicOsc2 = audioCtx.createOscillator();
      this._panicOsc2.type = 'square'; this._panicOsc2.frequency.value = 600;
      this._panicOsc2.connect(this._panicGain); this._panicOsc2.start();
      
      var sweepUp = true;
      this._panicSirenInterval = setInterval(() => {
        if (!this._panicOsc1) { clearInterval(this._panicSirenInterval); return; }
        if (sweepUp) { this._panicOsc1.frequency.value = 1200; this._panicOsc2.frequency.value = 900; }
        else { this._panicOsc1.frequency.value = 600; this._panicOsc2.frequency.value = 400; }
        sweepUp = !sweepUp;
      }, 500);

      // Attempt to resume immediately if suspended (may be blocked until user taps)
      if (audioCtx.state === 'suspended') {
        const p = audioCtx.resume();
        if (p) p.catch(()=>{});
      }
    } catch(e) { console.warn('Siren error:', e); }

    // === VIBRATION ===
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500, 200, 500, 200, 500, 200, 500]);

    // === FULL-SCREEN OVERLAY ===
    var guardName = (data.guard && data.guard.name) || 'Guardia';
    var lat = data.latitude || 0;
    var lng = data.longitude || 0;
    var mapsUrl = data.mapsUrl || ('https://www.google.com/maps?q=' + lat + ',' + lng);
    var overlay = document.getElementById('panic-overlay');
    if (overlay) overlay.remove(); // Remove existing if any
    overlay = document.createElement('div');
    overlay.id = 'panic-overlay';
    // Make overlay trigger resume on tap just in case
    overlay.onclick = () => { if (this._audioCtx && this._audioCtx.state === 'suspended') this._audioCtx.resume(); };
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(139,0,0,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;animation:panicFlash 1s infinite;';
    overlay.innerHTML = '<style>@keyframes panicFlash{0%,100%{background:rgba(139,0,0,0.97)}50%{background:rgba(220,38,38,0.97)}}@keyframes panicPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}</style>' +
      '<div style="font-size:80px;animation:panicPulse 1s infinite;">🆘</div>' +
      '<div style="font-size:28px;font-weight:900;color:white;margin:20px 0 10px;letter-spacing:3px;text-transform:uppercase;">EMERGENCIA</div>' +
      '<div style="font-size:22px;font-weight:700;color:#fca5a5;margin-bottom:20px;">' + guardName + ' pide auxilio</div>' +
      '<div style="background:rgba(0,0,0,0.4);border-radius:16px;padding:20px;width:100%;max-width:350px;text-align:center;margin-bottom:20px;">' +
        '<div style="color:#fca5a5;font-size:13px;margin-bottom:8px;letter-spacing:1px;">COORDENADAS</div>' +
        '<div style="color:white;font-size:16px;font-weight:600;margin-bottom:12px;">' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</div>' +
        '<a href="' + mapsUrl + '" target="_blank" style="display:inline-block;background:#10b981;color:white;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;" onclick="event.stopPropagation()"><i class="fas fa-map-marker-alt"></i> VER EN GOOGLE MAPS</a>' +
      '</div>' +
      '<button id="dismiss-panic-btn" style="background:rgba(255,255,255,0.2);border:2px solid white;color:white;padding:14px 40px;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:1px;position:relative;z-index:999999;" onclick="event.stopPropagation()">ENTERADO — CERRAR ALERTA</button>';
    document.body.appendChild(overlay);

    document.getElementById('dismiss-panic-btn').onclick = (e) => {
      e.stopPropagation();
      clearInterval(this._panicSirenInterval);
      if (this._panicOsc1) { try { this._panicOsc1.stop(); this._panicOsc1 = null; } catch(err){} }
      if (this._panicOsc2) { try { this._panicOsc2.stop(); this._panicOsc2 = null; } catch(err){} }
      if (this._panicGain) { try { this._panicGain.disconnect(); this._panicGain = null; } catch(err){} }
      if (navigator.vibrate) navigator.vibrate(0);
      overlay.remove();
    };

    // Auto-stop siren after 60 seconds
    setTimeout(function() {
      try { if (osc1) { osc1.stop(); osc1 = null; } if (osc2) { osc2.stop(); osc2 = null; } if (gainNode) gainNode.disconnect(); } catch(e){}
    }, 60000);
  },

  // ═══════════ CONFIGURACIÓN ═══════════
  async page_config() {
    const el = document.getElementById('page-content');
    el.innerHTML = '<div style="text-align:center;padding:40px"><i class="fas fa-spinner fa-spin"></i> Cargando configuración...</div>';
    try {
      const company = await API.get('/api/companies');
      const cfg = Array.isArray(company) ? company[0] : company;
      const panicEnabled = cfg.neighbor_panic_enabled ? true : false;
      el.innerHTML = `
      <div class="card" style="max-width:700px">
        <div class="card-header"><h3><i class="fas fa-cog"></i> Configuración del Sistema</h3></div>
        <div class="card-body">
          <div style="padding:20px;background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div style="display:flex;align-items:center;gap:14px">
                <div style="width:48px;height:48px;border-radius:12px;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center;font-size:22px">🆘</div>
                <div>
                  <div style="font-weight:700;font-size:16px;color:#f1f5f9">Vecinos Usarán Botón de Pánico</div>
                  <div style="font-size:13px;color:#64748b;margin-top:4px">Habilita el módulo de vecinos con botón de pánico y alertas a familiares</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:14px;font-weight:700;color:${panicEnabled?'#10b981':'#64748b'}">${panicEnabled?'SÍ':'NO'}</span>
                <label style="position:relative;display:inline-block;width:52px;height:28px;cursor:pointer">
                  <input type="checkbox" id="cfg-panic-toggle" ${panicEnabled?'checked':''}
                    onchange="App.toggleNeighborPanic(this.checked)"
                    style="opacity:0;width:0;height:0">
                  <span style="position:absolute;cursor:pointer;inset:0;background:${panicEnabled?'#10b981':'#334155'};border-radius:28px;transition:.3s"></span>
                  <span style="position:absolute;left:${panicEnabled?'26px':'3px'};top:3px;width:22px;height:22px;background:white;border-radius:50%;transition:.3s"></span>
                </label>
              </div>
            </div>
          </div>
          <div style="padding:14px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:10px;font-size:13px;color:#94a3b8">
            <i class="fas fa-info-circle" style="color:#3b82f6"></i> 
            Al activar esta opción, aparecerá la sección <b>"Vecinos"</b> en el menú lateral donde podrás registrar vecinos.
            Cada vecino recibirá un <b>código de acceso único de 6 caracteres</b> para ingresar al botón de pánico desde su celular.
            Al presionar el botón, la alerta llegará al panel central y se generarán enlaces de WhatsApp para notificar a sus 5 familiares de emergencia.
          </div>
        </div>
      </div>`;
    } catch(e) { el.innerHTML = `<p style="color:#ef4444">Error: ${e.message}</p>`; }
  },

  async toggleNeighborPanic(enabled) {
    try {
      const company = await API.get('/api/companies');
      const cfg = Array.isArray(company) ? company[0] : company;
      await API.put(`/api/companies/${cfg.id}/config`, { neighbor_panic_enabled: enabled });
      // Show/hide vecinos nav item
      const navVecinos = document.getElementById('nav-vecinos');
      if (navVecinos) navVecinos.style.display = enabled ? 'flex' : 'none';
      // Refresh the config page to update toggle visual
      this.page_config();
      Swal.fire({ toast:true, position:'top-end', icon:'success',
        title: enabled ? 'Botón de Pánico activado' : 'Botón de Pánico desactivado',
        showConfirmButton:false, timer:2000, background:'#1e293b', color:'#fff' });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  // Check and show vecinos nav on init
  async checkNeighborPanicEnabled() {
    try {
      const company = await API.get('/api/companies');
      const cfg = Array.isArray(company) ? company[0] : company;
      const navVecinos = document.getElementById('nav-vecinos');
      if (navVecinos && cfg.neighbor_panic_enabled) navVecinos.style.display = 'flex';
    } catch(e) {}
  },

  // ═══════════ COUNTRY CODE HELPER ═══════════
  _countryLadas: {GT:'502',MX:'52',SV:'503',HN:'504',NI:'505',CR:'506',PA:'507',CO:'57',US:'1',ES:'34',PE:'51',AR:'54',CL:'56',EC:'593',BO:'591',VE:'58',UY:'598',PY:'595',BR:'55',DO:'1'},
  _countryFlags: {GT:'🇬🇹',MX:'🇲🇽',SV:'🇸🇻',HN:'🇭🇳',NI:'🇳🇮',CR:'🇨🇷',PA:'🇵🇦',CO:'🇨🇴',US:'🇺🇸',ES:'🇪🇸',PE:'🇵🇪',AR:'🇦🇷',CL:'🇨🇱',EC:'🇪🇨',BO:'🇧🇴',VE:'🇻🇪',UY:'🇺🇾',PY:'🇵🇾',BR:'🇧🇷',DO:'🇩🇴'},
  getCompanyLada() {
    try {
      const user = JSON.parse(localStorage.getItem('sisdel_user')||'{}');
      const country = user.company_country || this._currentCompanyCountry || 'GT';
      return this._countryLadas[country] || '502';
    } catch(e) { return '502'; }
  },
  getCompanyFlag() {
    try {
      const user = JSON.parse(localStorage.getItem('sisdel_user')||'{}');
      const country = user.company_country || this._currentCompanyCountry || 'GT';
      return this._countryFlags[country] || '🇬🇹';
    } catch(e) { return '🇬🇹'; }
  },
  stripLada(phone, lada) { if (!phone) return ''; const re = new RegExp('^\\+?' + lada); return phone.replace(re, ''); },
  prependLada(phone, lada) { if (!phone) return ''; const digits = phone.replace(/\D/g,''); if (digits.startsWith(lada)) return digits; return lada + digits; },

  // ═══════════ VECINOS ═══════════
  async page_vecinos() {
    const el = document.getElementById('page-content');
    el.innerHTML = '<div style="text-align:center;padding:40px"><i class="fas fa-spinner fa-spin"></i> Cargando vecinos...</div>';
    try {
      const neighbors = await API.get('/api/neighbors');
      el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-people-roof"></i> Vecinos Registrados (${neighbors.length})</h3>
          <button class="btn btn-primary btn-sm" onclick="App.showNeighborModal()"><i class="fas fa-plus"></i> Nuevo Vecino</button>
        </div>
        <div class="card-body table-container">
          <table class="data-table">
            <thead><tr><th>Nombre</th><th>Identificación</th><th>Teléfono</th><th>Referencia</th><th>Código de Acceso</th><th>Familiares</th><th>Acciones</th></tr></thead>
            <tbody id="neighbors-tbody">
              ${neighbors.length ? neighbors.map(n => `<tr>
                <td><b>${n.name}</b></td>
                <td style="font-family:monospace;font-size:12px">${n.document_id}</td>
                <td>${n.phone}</td>
                <td style="font-size:12px;color:#94a3b8">${n.reference || '—'}</td>
                <td>
                  <span style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:800;letter-spacing:3px;color:#10b981;background:rgba(16,185,129,0.1);padding:4px 10px;border-radius:8px;border:1px solid rgba(16,185,129,0.25)">${n.access_code}</span>
                  <button onclick="navigator.clipboard.writeText('${n.access_code}');Swal.fire({toast:true,position:'top-end',icon:'success',title:'Código copiado',showConfirmButton:false,timer:1200,background:'#1e293b',color:'#fff'})" style="background:none;border:none;color:#3b82f6;cursor:pointer;margin-left:4px" title="Copiar"><i class="fas fa-copy"></i></button>
                </td>
                <td>
                  <span class="badge-status ${[n.fam_phone_1,n.fam_phone_2,n.fam_phone_3,n.fam_phone_4,n.fam_phone_5].filter(f=>f).length>0?'badge-active':'badge-pending'}">
                    ${[n.fam_phone_1,n.fam_phone_2,n.fam_phone_3,n.fam_phone_4,n.fam_phone_5].filter(f=>f).length} / 5
                  </span>
                </td>
                <td>
                  <button class="btn btn-outline btn-sm" onclick="App.editNeighbor('${n.id}')" title="Editar"><i class="fas fa-edit"></i></button>
                  <button class="btn btn-sm" style="background:var(--danger);color:white;margin-left:4px" onclick="App.deleteNeighbor('${n.id}','${n.name}')" title="Eliminar"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('') : '<tr><td colspan="7" class="empty-state"><i class="fas fa-people-roof"></i><p>No hay vecinos registrados</p></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
    } catch(e) { el.innerHTML = `<p style="color:#ef4444">Error: ${e.message}</p>`; }
  },

  async showNeighborModal(editData) {
    const isEdit = !!editData;
    // Fetch company country for lada
    let lada = '502', flag = '🇬🇹';
    try {
      const company = await API.get('/api/companies');
      const cfg = Array.isArray(company) ? company[0] : company;
      this._currentCompanyCountry = cfg.country || 'GT';
      lada = this._countryLadas[cfg.country] || '502';
      flag = this._countryFlags[cfg.country] || '🇬🇹';
    } catch(e) {}
    const ladaBadge = `<span style="background:#1a1f3e;border:1px solid #2d3366;border-radius:8px;padding:6px 10px;font-size:13px;color:#4da6ff;font-weight:700;white-space:nowrap">${flag} +${lada}</span>`;
    // Strip lada from phone values for display
    const stripPhone = (p) => this.stripLada(p||'', lada);
    const { value } = await Swal.fire({
      title: isEdit ? '✏️ Editar Vecino' : '🏠 Nuevo Vecino',
      background: '#1e293b', color: '#f1f5f9', width: 600,
      html: `
        <div style="text-align:left;font-size:12px;color:#10b981;font-weight:700;margin:4px 0 8px;letter-spacing:1px">DATOS DEL VECINO</div>
        <input id="nb-name" class="swal2-input" placeholder="Nombre completo" value="${editData?.name||''}" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <input id="nb-docid" class="swal2-input" placeholder="Número de Identificación (DPI/INE/Cédula)" value="${editData?.document_id||''}" ${isEdit?'readonly style="background:#0f172a;border-color:#334155;color:#64748b;opacity:0.6"':'style="background:#0f172a;border-color:#4da6ff;color:#f1f5f9;font-weight:700"'}>
        <div style="display:flex;gap:6px;align-items:center;margin:6px auto;max-width:92%">
          ${ladaBadge}
          <input id="nb-phone" class="swal2-input" placeholder="Teléfono del vecino" value="${stripPhone(editData?.phone)}" style="margin:0;flex:1;background:#0f172a;border-color:#334155;color:#f1f5f9">
        </div>
        <input id="nb-ref" class="swal2-input" placeholder="Referencia (dirección, colonia, etc.)" value="${editData?.reference||''}" style="background:#0f172a;border-color:#334155;color:#f1f5f9">
        <div style="text-align:left;font-size:12px;color:#f59e0b;font-weight:700;margin:16px 0 8px;letter-spacing:1px;border-top:1px solid #334155;padding-top:12px">🆘 CONTACTOS DE EMERGENCIA (familiares a avisar)</div>
        ${[1,2,3,4,5].map(i => `
          <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
            <span style="color:#f59e0b;font-size:12px;font-weight:700;min-width:18px">${i}.</span>
            <input id="nb-fn${i}" class="swal2-input" placeholder="Nombre familiar ${i}" value="${editData?editData['fam_name_'+i]||'':''}" style="margin:0;flex:1.2;background:#0f172a;border-color:#334155;color:#f1f5f9;font-size:13px;padding:8px">
            ${ladaBadge}
            <input id="nb-ft${i}" class="swal2-input" placeholder="Teléfono" value="${editData?stripPhone(editData['fam_phone_'+i]):''}" style="margin:0;flex:0.8;background:#0f172a;border-color:#334155;color:#f1f5f9;font-size:13px;padding:8px">
          </div>`).join('')}
        ${editData ? `<div style="margin-top:12px;padding:10px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:8px;text-align:center">
          <span style="font-size:12px;color:#64748b">Código de acceso:</span>
          <span style="font-family:monospace;font-size:18px;font-weight:900;letter-spacing:4px;color:#10b981;margin-left:8px">${editData.access_code}</span>
        </div>` : ''}
      `,
      confirmButtonText: isEdit ? '<i class="fas fa-save"></i> Guardar Cambios' : '<i class="fas fa-plus"></i> Crear Vecino',
      confirmButtonColor: '#10b981', showCancelButton: true, cancelButtonText: 'Cancelar',
      preConfirm: () => {
        const name = document.getElementById('nb-name').value.trim();
        const document_id = document.getElementById('nb-docid').value.trim();
        const rawPhone = document.getElementById('nb-phone').value.trim().replace(/\D/g,'');
        if (!name || !document_id || !rawPhone) { Swal.showValidationMessage('Nombre, identificación y teléfono son obligatorios'); return false; }
        const data = { name, document_id, phone: App.prependLada(rawPhone, '${lada}'), reference: document.getElementById('nb-ref').value.trim() };
        for (let i = 1; i <= 5; i++) {
          data['fam_name_'+i] = document.getElementById('nb-fn'+i).value.trim();
          const ft = document.getElementById('nb-ft'+i).value.trim().replace(/\D/g,'');
          data['fam_phone_'+i] = ft ? App.prependLada(ft, '${lada}') : '';
        }
        return data;
      }
    });
    if (!value) return;
    try {
      if (isEdit) {
        await API.put(`/api/neighbors/${editData.id}`, value);
      } else {
        const res = await API.post('/api/neighbors', value);
        await Swal.fire({
          title: '✅ Vecino Registrado', background: '#1e293b', color: '#f1f5f9',
          html: `<div style="text-align:center;padding:16px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:12px">
            <div style="font-size:14px;color:#94a3b8;margin-bottom:8px">Código de Acceso del Vecino:</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:36px;font-weight:900;letter-spacing:8px;color:#10b981;margin:8px 0">${res.access_code}</div>
            <div style="font-size:12px;color:#64748b;margin-top:8px">El vecino usará este código para ingresar al botón de pánico desde su celular</div>
            <button onclick="navigator.clipboard.writeText('${res.access_code}');this.textContent='¡Copiado!';this.style.background='#10b981'" style="margin-top:12px;padding:8px 24px;background:#1e293b;border:1px solid #10b981;color:#10b981;border-radius:8px;cursor:pointer;font-weight:600;width:100%">
              <i class="fas fa-copy"></i> Copiar Código
            </button>
          </div>`
        });
      }
      this.page_vecinos();
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async editNeighbor(id) {
    try {
      const neighbors = await API.get('/api/neighbors');
      const n = neighbors.find(x => x.id === id);
      if (n) this.showNeighborModal(n);
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  async deleteNeighbor(id, name) {
    const { isConfirmed } = await Swal.fire({
      title: `⚠️ Eliminar vecino?`, html: `¿Deseas eliminar a <b>${name}</b> y todos sus datos?`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'Sí, eliminar', cancelButtonText: 'Cancelar',
      background: '#1e293b', color: '#f1f5f9'
    });
    if (!isConfirmed) return;
    try { await API.del(`/api/neighbors/${id}`); this.page_vecinos(); } catch(e) { Swal.fire('Error', e.message, 'error'); }
  },

  // ═══════════ NEIGHBOR PANIC VIEW (Mobile) ═══════════
  renderNeighborPanicView(neighbor) {
    this._neighborData = neighbor;
    this._neighborGpsLat = null;
    this._neighborGpsLng = null;
    this._neighborAlertCount = 0;

    document.getElementById('app').innerHTML = `
    <div style="min-height:100vh;background:linear-gradient(180deg,#0b0d17 0%,#111325 50%,#0a0c14 100%);display:flex;flex-direction:column;align-items:center;font-family:'Inter',sans-serif;color:#fff;padding:0">

      <!-- Top bar -->
      <div style="width:100%;max-width:420px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(77,166,255,0.12);display:flex;align-items:center;justify-content:center"><i class="fas fa-user" style="color:#4da6ff"></i></div>
          <div>
            <div style="font-weight:800;font-size:14px;color:#f1f5f9">${neighbor.name}</div>
            <div style="font-size:11px;color:#64748b">${neighbor.company_name || 'SISDEL RONDÍN'}</div>
          </div>
        </div>
        <button onclick="App.logoutNeighbor()" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer"><i class="fas fa-sign-out-alt"></i> Salir</button>
      </div>

      <!-- GPS bar -->
      <div style="width:100%;max-width:420px;padding:8px 20px;display:flex;align-items:center;gap:8px">
        <div id="nb-gps-dot" style="width:8px;height:8px;border-radius:50%;background:#f59e0b"></div>
        <span id="nb-gps-status" style="font-size:12px;color:#64748b">📡 Obteniendo ubicación...</span>
      </div>

      <!-- Panic area -->
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;width:100%;max-width:420px">
        <p style="font-size:18px;font-weight:900;color:#ef4444;letter-spacing:3px;text-shadow:0 0 18px rgba(239,68,68,0.5);margin-bottom:6px">EN CASO DE EMERGENCIA</p>
        <p style="font-size:13px;color:#94a3b8;margin-bottom:30px">Mantén presionado 3 segundos para enviar alerta</p>

        <div style="position:relative;width:200px;height:200px;display:flex;align-items:center;justify-content:center">
          <div style="position:absolute;width:200px;height:200px;border-radius:50%;border:2px solid rgba(239,68,68,0.15);animation:nbPulse 2s ease-in-out infinite"></div>
          <div style="position:absolute;width:170px;height:170px;border-radius:50%;border:2px solid rgba(239,68,68,0.25);animation:nbPulse 2s ease-in-out 0.3s infinite"></div>
          <div style="position:absolute;width:140px;height:140px;border-radius:50%;border:2px solid rgba(239,68,68,0.35);animation:nbPulse 2s ease-in-out 0.6s infinite"></div>
          <button id="nb-panic-btn"
            ontouchstart="App.nbStartPanic(event)" ontouchend="App.nbCancelPanic(event)"
            onmousedown="App.nbStartPanic(event)" onmouseup="App.nbCancelPanic(event)" onmouseleave="App.nbCancelPanic(event)"
            style="width:120px;height:120px;border-radius:50%;background:linear-gradient(145deg,#dc2626,#991b1b);border:3px solid rgba(239,68,68,0.5);color:white;font-size:16px;font-weight:900;letter-spacing:2px;cursor:pointer;box-shadow:0 0 40px rgba(239,68,68,0.4),0 8px 30px rgba(0,0,0,0.5);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;transition:transform 0.1s;z-index:2;-webkit-user-select:none;user-select:none">
            <i class="fas fa-exclamation-triangle" style="font-size:28px"></i>
            <span>PÁNICO</span>
          </button>
        </div>

        <!-- Hold progress bar -->
        <div id="nb-hold-wrap" style="display:none;width:80%;max-width:280px;height:8px;background:rgba(255,255,255,0.06);border-radius:4px;margin-top:20px;overflow:hidden">
          <div id="nb-hold-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#ef4444,#f59e0b);border-radius:4px;transition:width 50ms linear"></div>
        </div>
        <p id="nb-hint" style="font-size:12px;color:#64748b;margin-top:12px">Mantén presionado 3 segundos para enviar alerta</p>

        <!-- WhatsApp buttons appear after alert -->
        <div id="nb-wa-buttons" style="display:none;flex-direction:column;gap:8px;margin-top:20px;width:100%;max-width:300px"></div>
      </div>

      <!-- Edit contacts link -->
      <div style="width:100%;max-width:420px;padding:16px 20px;text-align:center;border-top:1px solid rgba(255,255,255,0.06)">
        <button onclick="App.nbEditContacts()" style="background:rgba(77,166,255,0.08);border:1px solid rgba(77,166,255,0.2);color:#4da6ff;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;width:100%">✏️ Editar Contactos de Emergencia</button>
      </div>
    </div>

    <style>
      @keyframes nbPulse { 0%,100%{transform:scale(1);opacity:0.5} 50%{transform:scale(1.08);opacity:1} }
    </style>`;

    // Start GPS
    this.nbStartGPS();
  },

  nbStartGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => { this._neighborGpsLat = pos.coords.latitude; this._neighborGpsLng = pos.coords.longitude; this.nbUpdateGPSBar(pos.coords); },
      () => { document.getElementById('nb-gps-status').textContent = '🟡 Buscando señal GPS...'; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
    );
    this._nbWatchId = navigator.geolocation.watchPosition(
      pos => { this._neighborGpsLat = pos.coords.latitude; this._neighborGpsLng = pos.coords.longitude; this.nbUpdateGPSBar(pos.coords); },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  },

  nbUpdateGPSBar(coords) {
    const dot = document.getElementById('nb-gps-dot');
    const status = document.getElementById('nb-gps-status');
    if (dot) dot.style.background = '#10b981';
    if (status) status.textContent = `📍 ${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)} (±${Math.round(coords.accuracy)}m)`;
  },

  nbStartPanic(e) {
    e.preventDefault();
    const btn = document.getElementById('nb-panic-btn');
    btn.style.transform = 'scale(0.92)';
    document.getElementById('nb-hold-wrap').style.display = 'block';
    document.getElementById('nb-hint').textContent = '¡Mantén presionado!';
    this._nbHoldStart = Date.now();
    this._nbHoldInterval = setInterval(() => {
      const pct = Math.min(((Date.now() - this._nbHoldStart) / 3000) * 100, 100);
      document.getElementById('nb-hold-bar').style.width = pct + '%';
      if (pct >= 100) { clearInterval(this._nbHoldInterval); this._nbHoldInterval = null; this.nbSendAlert(); }
    }, 50);
  },

  nbCancelPanic(e) {
    e.preventDefault();
    const btn = document.getElementById('nb-panic-btn');
    btn.style.transform = 'scale(1)';
    if (this._nbHoldInterval) { clearInterval(this._nbHoldInterval); this._nbHoldInterval = null; }
    const bar = document.getElementById('nb-hold-bar');
    if (bar && parseFloat(bar.style.width) < 100) {
      document.getElementById('nb-hold-wrap').style.display = 'none';
      bar.style.width = '0%';
      document.getElementById('nb-hint').textContent = 'Mantén presionado 3 segundos para enviar alerta';
    }
  },

  async nbSendAlert() {
    const n = this._neighborData;
    if (!n) return;
    this._neighborAlertCount++;
    if (this._neighborAlertCount > 10) { alert('Has enviado 10 alertas. Mantén la calma.'); return; }

    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 500]);

    try {
      const res = await fetch('/api/neighbors/panic', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_code: n.access_code,
          latitude: this._neighborGpsLat,
          longitude: this._neighborGpsLng
        })
      });
      const data = await res.json();

      // Show WhatsApp auto-send results
      const waResults = data.whatsapp_results || [];
      const waBtns = document.getElementById('nb-wa-buttons');

      // Build WhatsApp manual message as fallback
      const loc = (this._neighborGpsLat && this._neighborGpsLng)
        ? `https://maps.google.com/?q=${this._neighborGpsLat},${this._neighborGpsLng}` : 'Sin GPS';
      const textoWA = `🚨‼️ EMERGENCIA ‼️🚨\n\n${n.name} necesita ayuda URGENTE.\n📍 Ubicación: ${loc}\n📱 Tel: ${n.phone}\n\n🆘 POR FAVOR LLAMA O VEN DE INMEDIATO 🆘`;

      if (waBtns) {
        const sentOk = waResults.filter(r => r.exito).length;
        const sentFail = waResults.filter(r => !r.exito);
        let html = '';
        if (waResults.length > 0) {
          html += `<div style="font-size:13px;font-weight:700;color:#10b981;text-align:center;margin-bottom:6px">📱 WhatsApp enviado automáticamente:</div>`;
          html += waResults.map(r =>
            `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:${r.exito?'rgba(16,185,129,0.08)':'rgba(239,68,68,0.08)'};border:1px solid ${r.exito?'rgba(16,185,129,0.25)':'rgba(239,68,68,0.25)'};border-radius:8px;font-size:13px">
              <span>${r.exito?'✅':'❌'}</span>
              <span style="flex:1;color:#f1f5f9">${r.nombre || r.telefono}</span>
              <span style="font-size:11px;color:#64748b">${r.canal || ''}</span>
            </div>`
          ).join('');
        }
        // Manual fallback for any failed or if no auto-send
        const familiares = (data.familiares || []).filter(f => f.telefono);
        const failedPhones = sentFail.map(r => r.telefono);
        const manualList = waResults.length === 0 ? familiares : familiares.filter(f => failedPhones.includes(f.telefono));
        if (manualList.length > 0) {
          html += `<div style="font-size:12px;color:#f59e0b;text-align:center;margin-top:8px;margin-bottom:4px">⚠️ Enviar manualmente:</div>`;
          html += manualList.map(f =>
            `<a href="whatsapp://send?phone=${f.telefono}&text=${encodeURIComponent(textoWA)}" target="_blank" rel="noopener"
              style="display:block;background:#25d366;color:#fff;text-align:center;padding:10px;border-radius:10px;font-weight:700;font-size:13px;text-decoration:none">
              💬 Avisar a ${f.nombre || f.telefono}
            </a>`
          ).join('');
        }
        waBtns.innerHTML = html;
        waBtns.style.display = 'flex';
      }

      // Reset panic button
      document.getElementById('nb-panic-btn').style.transform = 'scale(1)';
      document.getElementById('nb-hold-wrap').style.display = 'none';
      document.getElementById('nb-hold-bar').style.width = '0%';
      const sentCount = (data.whatsapp_results || []).filter(r => r.exito).length;
      document.getElementById('nb-hint').innerHTML = `<span style="color:#10b981;font-weight:700">✅ ALERTA #${this._neighborAlertCount} ENVIADA${sentCount ? ` — ${sentCount} WhatsApp enviados` : ''}</span>`;

    } catch(e) {
      document.getElementById('nb-hint').innerHTML = '<span style="color:#ef4444">⚠️ Error de conexión. Intenta de nuevo.</span>';
    }
  },

  logoutNeighbor() {
    sessionStorage.removeItem('sisdel_neighbor');
    if (this._nbWatchId) navigator.geolocation.clearWatch(this._nbWatchId);
    this.renderLogin();
  },

  async nbEditContacts() {
    const n = this._neighborData;
    if (!n) return;
    const country = n.company_country || this._currentCompanyCountry || 'GT';
    const lada = this._countryLadas[country] || '502';
    const flag = this._countryFlags[country] || '🇬🇹';
    const ladaBadge = `<span style="background:#1a1f3e;border:1px solid #2d3366;border-radius:8px;padding:5px 8px;font-size:12px;color:#4da6ff;font-weight:700;white-space:nowrap">${flag}+${lada}</span>`;
    const stripPhone = (p) => this.stripLada(p||'', lada);
    const { value } = await Swal.fire({
      title: '✏️ Contactos de Emergencia', background: '#1e293b', color: '#f1f5f9', width: 500,
      html: [1,2,3,4,5].map(i => `
        <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
          <span style="color:#f59e0b;font-size:13px;font-weight:700;min-width:18px">${i}.</span>
          <input id="nbc-n${i}" class="swal2-input" placeholder="Nombre" value="${n['fam_name_'+i]||''}" style="margin:0;flex:1;background:#0f172a;border-color:#334155;color:#f1f5f9;font-size:13px;padding:8px">
          ${ladaBadge}
          <input id="nbc-t${i}" class="swal2-input" placeholder="Teléfono" value="${stripPhone(n['fam_phone_'+i])}" style="margin:0;flex:0.7;background:#0f172a;border-color:#334155;color:#f1f5f9;font-size:13px;padding:8px">
        </div>`).join(''),
      confirmButtonText: '💾 Guardar', confirmButtonColor: '#10b981', showCancelButton: true,
      preConfirm: () => {
        const data = {};
        for (let i = 1; i <= 5; i++) {
          data['fam_name_'+i] = document.getElementById('nbc-n'+i).value.trim();
          const ft = document.getElementById('nbc-t'+i).value.trim().replace(/\D/g,'');
          data['fam_phone_'+i] = ft ? App.prependLada(ft, lada) : '';
        }
        return data;
      }
    });
    if (!value) return;
    try {
      Object.assign(this._neighborData, value);
      sessionStorage.setItem('sisdel_neighbor', JSON.stringify(this._neighborData));
      Swal.fire({ toast:true, position:'top-end', icon:'success', title:'Contactos guardados', showConfirmButton:false, timer:2000, background:'#1e293b', color:'#fff' });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
  }
};

// ═══ BOOT ═══
document.addEventListener('DOMContentLoaded', () => App.init());

// ═══ KEEP-ALIVE — evita que Render duerma el servidor ═══
setInterval(function() {
  fetch('/api/ping').catch(function(){});
}, 14 * 60 * 1000); // ping cada 14 minutos
