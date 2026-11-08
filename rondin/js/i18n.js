// ═══════════════════════════════════════════
// SISDEL RONDÍN — i18n (Internationalization)
// ═══════════════════════════════════════════

const I18N = {
  es: {
    // App
    app_name: 'SISDEL RONDÍN',
    app_subtitle: 'Control Inteligente de Rondas',

    // Login
    login_title: 'Iniciar Sesión',
    login_pin: 'Acceso por PIN',
    login_email: 'Acceso por Email',
    pin_placeholder: 'Ingresa tu PIN de 6 dígitos',
    email_placeholder: 'Email',
    password_placeholder: 'Contraseña',
    login_btn: 'Ingresar',
    login_error: 'Credenciales inválidas',

    // Nav
    nav_dashboard: 'Panel Principal',
    nav_monitoring: 'Monitoreo',
    nav_routes: 'Rutas',
    nav_users: 'Usuarios',
    nav_shifts: 'Turnos',
    nav_incidents: 'Incidentes',
    nav_alerts: 'Alertas',
    nav_reports: 'Reportes',
    nav_settings: 'Configuración',
    nav_logout: 'Cerrar Sesión',
    nav_operations: 'OPERACIONES',
    nav_management: 'GESTIÓN',

    // Dashboard
    dash_active_guards: 'Guardias Activos',
    dash_active_shifts: 'Turnos Activos',
    dash_today_rounds: 'Rondas Hoy',
    dash_avg_score: 'Score Promedio',
    dash_pending_alerts: 'Alertas Pendientes',
    dash_open_incidents: 'Incidentes Abiertos',
    dash_compliance: 'Cumplimiento por Guardia',
    dash_recent: 'Actividad Reciente',
    dash_route_stats: 'Estadísticas por Ruta',

    // Guard
    guard_start_shift: 'Iniciar Turno',
    guard_end_shift: 'Finalizar Turno',
    guard_start_round: 'Iniciar Ronda',
    guard_report_incident: 'Reportar Incidente',
    guard_checkpoints: 'Checkpoints',
    guard_panic: 'S.O.S',
    guard_status_on_duty: 'EN SERVICIO',
    guard_status_off_duty: 'FUERA DE SERVICIO',
    guard_round_progress: 'Progreso de Ronda',

    // Shifts
    shift_scheduled: 'Programado',
    shift_active: 'Activo',
    shift_completed: 'Completado',
    shift_missed: 'Perdido',

    // Common
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    edit: 'Editar',
    create: 'Crear',
    search: 'Buscar',
    actions: 'Acciones',
    status: 'Estado',
    name: 'Nombre',
    role: 'Rol',
    date: 'Fecha',
    time: 'Hora',
    loading: 'Cargando...',
    no_data: 'Sin datos disponibles',
    confirm_delete: '¿Eliminar este registro?',
    success: 'Operación exitosa',
    error: 'Ocurrió un error',

    // Roles
    role_admin: 'Administrador',
    role_supervisor: 'Supervisor',
    role_guard: 'Guardia',
    role_chief: 'Jefe de Guardia',

    // Alerts
    alert_panic: '🆘 PÁNICO ACTIVADO',
    alert_battery: 'Batería Baja',
    alert_inactive: 'Guardia Inactivo',
    alert_deviation: 'Desviación de Ruta',
    alert_missed: 'Ronda no iniciada',
  },

  en: {
    app_name: 'SISDEL RONDÍN',
    app_subtitle: 'Intelligent Patrol Control',
    login_title: 'Sign In',
    login_pin: 'PIN Access',
    login_email: 'Email Access',
    pin_placeholder: 'Enter your 6-digit PIN',
    email_placeholder: 'Email',
    password_placeholder: 'Password',
    login_btn: 'Sign In',
    login_error: 'Invalid credentials',
    nav_dashboard: 'Dashboard',
    nav_monitoring: 'Monitoring',
    nav_routes: 'Routes',
    nav_users: 'Users',
    nav_shifts: 'Shifts',
    nav_incidents: 'Incidents',
    nav_alerts: 'Alerts',
    nav_reports: 'Reports',
    nav_settings: 'Settings',
    nav_logout: 'Logout',
    nav_operations: 'OPERATIONS',
    nav_management: 'MANAGEMENT',
    dash_active_guards: 'Active Guards',
    dash_active_shifts: 'Active Shifts',
    dash_today_rounds: 'Rounds Today',
    dash_avg_score: 'Avg Score',
    dash_pending_alerts: 'Pending Alerts',
    dash_open_incidents: 'Open Incidents',
    dash_compliance: 'Guard Compliance',
    dash_recent: 'Recent Activity',
    dash_route_stats: 'Route Statistics',
    guard_start_shift: 'Start Shift',
    guard_end_shift: 'End Shift',
    guard_start_round: 'Start Round',
    guard_report_incident: 'Report Incident',
    guard_checkpoints: 'Checkpoints',
    guard_panic: 'S.O.S',
    guard_status_on_duty: 'ON DUTY',
    guard_status_off_duty: 'OFF DUTY',
    guard_round_progress: 'Round Progress',
    shift_scheduled: 'Scheduled',
    shift_active: 'Active',
    shift_completed: 'Completed',
    shift_missed: 'Missed',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    create: 'Create',
    search: 'Search',
    actions: 'Actions',
    status: 'Status',
    name: 'Name',
    role: 'Role',
    date: 'Date',
    time: 'Time',
    loading: 'Loading...',
    no_data: 'No data available',
    confirm_delete: 'Delete this record?',
    success: 'Operation successful',
    error: 'An error occurred',
    role_admin: 'Administrator',
    role_supervisor: 'Supervisor',
    role_guard: 'Guard',
    role_chief: 'Guard Chief',
    alert_panic: '🆘 PANIC ACTIVATED',
    alert_battery: 'Low Battery',
    alert_inactive: 'Guard Inactive',
    alert_deviation: 'Route Deviation',
    alert_missed: 'Round not started',
  },

  pt: {
    app_name: 'SISDEL RONDÍN',
    app_subtitle: 'Controle Inteligente de Rondas',
    login_title: 'Entrar',
    login_pin: 'Acesso por PIN',
    login_email: 'Acesso por Email',
    login_btn: 'Entrar',
    nav_dashboard: 'Painel',
    nav_monitoring: 'Monitoramento',
    nav_routes: 'Rotas',
    nav_users: 'Usuários',
    nav_shifts: 'Turnos',
    nav_incidents: 'Incidentes',
    nav_alerts: 'Alertas',
    nav_reports: 'Relatórios',
    nav_settings: 'Configurações',
    nav_logout: 'Sair',
    guard_panic: 'S.O.S',
    save: 'Salvar',
    cancel: 'Cancelar',
    delete: 'Excluir',
    create: 'Criar',
  }
};

let currentLang = localStorage.getItem('sisdel_lang') || 'es';

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || (I18N.es[key]) || key;
}

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('sisdel_lang', lang);
}
