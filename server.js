const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const rootDir = __dirname;
// En la Pi usa los USB externos; en desarrollo usa carpetas locales
const dataBase   = fs.existsSync('/data') ? '/data' : rootDir;
const uploadsDir = path.join(dataBase, 'fotos');
const dataDir    = path.join(dataBase, 'checklists');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(dataDir))    fs.mkdirSync(dataDir,    { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}_${safeName}`);
  }
});

const upload = multer({ storage });

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Admin-Token');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
// Redirigir raíz y rutas sin prefijo conocido a la app móvil
app.get('/', (_req, res) => res.redirect('/mobile/'));
app.use(express.static(rootDir));

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta la foto' });
  }

  res.json({
    ok: true,
    category: req.body.category || '',
    url: `/uploads/${req.file.filename}`
  });
});

app.get('/api/validate-shelly', async (req, res) => {
  try {
    const { shellyUrl, channel } = req.query;
    if (!shellyUrl) return res.status(400).json({ ok: false, error: 'shellyUrl requerida' });

    const base = shellyUrl.replace(/\/$/, '');
    const id   = Number(channel) || 0;

    const tryUrl = async (url) => {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        return r;
      } catch (e) { clearTimeout(tid); throw e; }
    };

    // Detectar tipo: Cover (Shelly 2PM con motor) o Switch
    let deviceType = 'switch';
    let statusUrl  = `${base}/rpc/Switch.GetStatus?id=${id}`;

    try {
      const rCover = await tryUrl(`${base}/rpc/Cover.GetStatus?id=${id}`);
      if (rCover.ok) {
        const d = await rCover.json();
        if (d.state !== undefined) { deviceType = 'cover'; statusUrl = `${base}/rpc/Cover.GetStatus?id=${id}`; }
      }
    } catch(_) {}

    if (deviceType === 'switch') {
      const rSwitch = await tryUrl(statusUrl);
      if (!rSwitch.ok) return res.json({ ok: false, error: `Shelly no responde en ${shellyUrl}` });
    }

    console.log(`[VALIDATE] ✅ Shelly ${deviceType} en ${shellyUrl}`);
    return res.json({ ok: true, deviceType, message: `Shelly (${deviceType}) validado` });
  } catch (error) {
    const msg = error.name === 'AbortError' ? `Timeout: Shelly no responde en 3s` : error.message;
    return res.json({ ok: false, error: msg });
  }
});

app.get('/api/validation-challenge', (_req, res) => {
  const challengeOptions = [
    { index: 1, name: 'Tablero / mando', hint: 'Evidencia de controles y estado visual.' },
    { index: 3, name: 'Cierre de turno', hint: 'Foto final y observaciones.' },
    { index: 4, name: 'Desperfecto', hint: 'Solo si detectas anomalías.' },
    { index: 5, name: 'Producto / material', hint: 'Cuando aplique al proceso.' }
  ];

  const challenge = challengeOptions[Math.floor(Math.random() * challengeOptions.length)];

  console.log('[CHALLENGE] Seleccionada foto sorpresa:', challenge.name);

  return res.json({
    ok: true,
    challenge
  });
});

app.get('/api/shelly-status', async (req, res) => {
  try {
    const { shellyUrl, channel } = req.query;
    if (!shellyUrl || channel === undefined)
      return res.status(400).json({ error: 'Params requeridos: shellyUrl, channel' });

    const base = shellyUrl.replace(/\/$/, '');
    const id   = Number(channel);

    // Intentar Cover primero, luego Switch
    let data, isCover = false;
    try {
      const r = await fetch(`${base}/rpc/Cover.GetStatus?id=${id}`);
      const d = await r.json();
      if (d.state !== undefined) { data = d; isCover = true; }
    } catch(_) {}

    if (!data) {
      const r = await fetch(`${base}/rpc/Switch.GetStatus?id=${id}`);
      data = await r.json();
    }

    // Cover: open/opening/stopped = activo. Solo closed/closing = inactivo.
    const isOn = isCover
      ? (data.state === 'open' || data.state === 'opening' || data.state === 'stopped')
      : data.output === true;

    res.json({ ok: true, isOn, state: data.state, power: data.apower || 0,
      voltage: data.voltage || 0, current: data.current || 0, temperature: data.temperature?.tC || null });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error inesperado' });
  }
});

app.post('/api/shelly-switch', async (req, res) => {
  try {
    const { shellyUrl, channel, on } = req.body || {};
    if (!shellyUrl || channel === undefined || typeof on !== 'boolean')
      return res.status(400).json({ error: 'Faltan parametros: shellyUrl, channel, on' });

    const base = shellyUrl.replace(/\/$/, '');
    const id   = Number(channel) || 0;

    // Detectar tipo de dispositivo e invocar el comando correcto
    let commandUrl;
    try {
      const r = await fetch(`${base}/rpc/Cover.GetStatus?id=${id}`);
      const d = await r.json();
      if (d.state !== undefined) {
        commandUrl = on ? `${base}/rpc/Cover.Open?id=${id}` : `${base}/rpc/Cover.Close?id=${id}`;
      }
    } catch(_) {}

    if (!commandUrl) {
      commandUrl = `${base}/rpc/Switch.Set?id=${id}&on=${on}`;
    }

    console.log('[SWITCH] Comando:', commandUrl);
    const response = await fetch(commandUrl, { method: 'GET' });
    const bodyText = await response.text();

    if (!response.ok) {
      return res.status(502).json({ error: 'El Shelly respondió con error', details: bodyText });
    }

    return res.json({ ok: true, on });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error inesperado' });
  }
});

// ── CHECKLIST RECORDS ────────────────────────────────────────────

app.get('/api/discover', (_req, res) => {
  const os = require('os');
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  res.json({ ok: true, ips, port });
});

app.post('/api/checklist/save', async (req, res) => {
  const record = req.body;
  if (!record || !record.id) return res.status(400).json({ error: 'Registro inválido: falta id' });
  const safe = record.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  fs.writeFileSync(path.join(dataDir, `${safe}.json`), JSON.stringify(record, null, 2));
  console.log(`[CHECKLIST] Guardado: ${safe}.json`);

  // Ítems críticos con pararSi=true → ids 4, 5, 6 (guardas, atrapamiento, paro de emergencia)
  const criticalNOK = (record.items || []).filter(it => [4, 5, 6].includes(it.id) && it.status === 'nok');
  if (criticalNOK.length > 0) {
    dispatchAlert(record, criticalNOK).catch(e => console.error('[ALERTA] Dispatch error:', e.message));
  }

  res.json({ ok: true, id: record.id });
});

app.get('/api/checklists', (_req, res) => {
  try {
    const files   = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    const records = files
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ ok: true, records });
  } catch (e) {
    res.json({ ok: true, records: [] });
  }
});

// ── SHELLY ────────────────────────────────────────────────────────
app.post('/api/activate', async (req, res) => {
  try {
    console.log('[ACTIVATE] Recibido request:', JSON.stringify(req.body).substring(0, 100));
    const { shellyUrl, channel, checks = [], photos = [], operador = '', turno = '', randomChallengeIndex } = req.body || {};

    if (!shellyUrl) {
      console.log('[ACTIVATE] Error: Falta URL Shelly');
      return res.status(400).json({ error: 'Falta la URL del Shelly' });
    }

    const allChecksComplete = Array.isArray(checks) && checks.length > 0 && checks.every(Boolean);
    const requiredPhotoIndexes = [0, 2];
    const requiredPhotosComplete = requiredPhotoIndexes.every((index) => Boolean(photos[index]));
    const allowedChallengeIndexes = [1, 3, 4, 5];
    const challengeIndex = Number(randomChallengeIndex);
    const challengeIsValid = allowedChallengeIndexes.includes(challengeIndex);
    const challengePhotoComplete = challengeIsValid && Boolean(photos[challengeIndex]);

    if (!allChecksComplete) {
      console.log('[ACTIVATE] Error: Checklist incompleta');
      return res.status(400).json({ error: 'La checklist no está completa' });
    }

    if (!requiredPhotosComplete) {
      console.log('[ACTIVATE] Error: Fotos incompletas');
      return res.status(400).json({ error: 'Falta evidencia obligatoria' });
    }

    if (!challengeIsValid) {
      console.log('[ACTIVATE] Error: Sin foto sorpresa válida');
      return res.status(400).json({ error: 'Falta la verificación aleatoria. Elige una foto sorpresa válida.' });
    }

    if (!challengePhotoComplete) {
      console.log('[ACTIVATE] Error: Foto sorpresa no cargada');
      return res.status(400).json({ error: 'Falta la foto sorpresa requerida para validar intención.' });
    }

    const base = shellyUrl.replace(/\/$/, '');
    const id   = Number(channel) || 0;

    // Detectar Cover vs Switch y usar el comando correcto
    let commandUrl;
    try {
      const r = await fetch(`${base}/rpc/Cover.GetStatus?id=${id}`);
      const d = await r.json();
      commandUrl = d.state !== undefined
        ? `${base}/rpc/Cover.Open?id=${id}`
        : `${base}/rpc/Switch.Set?id=${id}&on=true`;
    } catch(_) {
      commandUrl = `${base}/rpc/Switch.Set?id=${id}&on=true`;
    }
    console.log('[ACTIVATE] Enviando comando a:', commandUrl);

    const response = await fetch(commandUrl, { method: 'GET' });
    const bodyText = await response.text();

    if (!response.ok) {
      console.log('[ACTIVATE] Error Shelly:', response.status, bodyText);
      return res.status(502).json({ error: 'El Shelly respondió con error', details: bodyText });
    }

    console.log('[ACTIVATE] ✅ Éxito para:', operador, turno);
    console.log(`[ACTIVATE] 🔊 El usuario iniciará monitoreo en tiempo real cada 5 segundos`);
    
    res.json({
      ok: true,
      message: `Shelly habilitado para ${operador || 'operador'} en ${turno || 'turno sin nombre'}. Monitoreando estado...`
    });
  } catch (error) {
    console.log('[ACTIVATE] ❌ Exception:', error.message);
    console.error(error.stack);
    res.status(500).json({ error: error.message || 'Error inesperado' });
  }
});

// ── ADMIN & CONFIGURACIÓN DE MÁQUINAS ──────────────────────────────────────
const crypto = require('crypto');
const configFile = path.join(dataBase, 'config.json');

function loadServerConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch { return { adminPassword: 'changeme', machines: [] }; }
}
function saveServerConfig(data) {
  fs.writeFileSync(configFile, JSON.stringify(data, null, 2));
}

// ── ALERTAS CRÍTICAS ──────────────────────────────────────────────
const alertsLog = path.join(dataBase, 'alertas.log');
const LABEL_MAP = { 4: 'Guardas de seguridad', 5: 'Riesgo de atrapamiento', 6: 'Paro de emergencia' };

async function dispatchAlert(record, criticalNOK) {
  const cfg      = loadServerConfig();
  const maquina  = record.maquina  || '—';
  const linea    = record.linea    || '—';
  const operador = record.operador || '—';
  const turno    = record.turno    || '—';
  const itemDesc = criticalNOK.map(it => LABEL_MAP[it.id] || `Item ${it.id}`).join(' | ');
  const ts = new Date().toLocaleString('es-MX', { timeZone: 'America/Monterrey', hour12: false });
  const msg = `⛔ ALERTA CRITICA [${ts}] ${maquina} L${linea} Turno:${turno} Op:${operador} NOK: ${itemDesc}`;

  // 1. Log a archivo
  try { fs.appendFileSync(alertsLog, msg + '\n'); } catch(e) { console.error('[ALERTA] Log error:', e.message); }
  console.log('[ALERTA]', msg);

  // 2. WhatsApp gratuito via Callmebot
  const phone  = cfg.alertWhatsapp;
  const apiKey = cfg.callmebotKey;
  if (phone && apiKey) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(msg)}&apikey=${apiKey}`;
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(url, { signal: ctrl.signal });
      console.log('[ALERTA] WhatsApp HTTP', r.status, '→', phone);
    } catch(e) { console.log('[ALERTA] WhatsApp error:', e.message); }
  }
}

let adminToken = null;

function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'];
  if (!t || t !== adminToken) return res.status(401).json({ ok: false, error: 'No autorizado' });
  next();
}

app.get('/api/admin/verify', requireAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const cfg = loadServerConfig();
  if (password !== (cfg.adminPassword || 'changeme'))
    return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
  adminToken = crypto.randomBytes(32).toString('hex');
  console.log('[ADMIN] Login exitoso');
  res.json({ ok: true, token: adminToken });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  adminToken = null;
  res.json({ ok: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ ok: false, error: 'Mínimo 4 caracteres' });
  const cfg = loadServerConfig();
  cfg.adminPassword = newPassword;
  saveServerConfig(cfg);
  res.json({ ok: true });
});

// Público — las tablets leen esto para obtener config de la máquina asignada
app.get('/api/machines', (_req, res) => {
  const cfg = loadServerConfig();
  res.json({ ok: true, machines: cfg.machines || [] });
});

// Admin — guardar lista de máquinas
app.post('/api/machines', requireAdmin, (req, res) => {
  const cfg = loadServerConfig();
  cfg.machines = req.body.machines || [];
  saveServerConfig(cfg);
  console.log(`[ADMIN] Máquinas guardadas: ${cfg.machines.length}`);
  res.json({ ok: true });
});

// Admin — probar Shelly de una URL dada
app.get('/api/admin/test-shelly', requireAdmin, async (req, res) => {
  const { shellyUrl, channel } = req.query;
  if (!shellyUrl) return res.status(400).json({ ok: false, error: 'shellyUrl requerida' });
  const base = shellyUrl.replace(/\/$/, '');
  const id = Number(channel) || 0;
  try {
    let deviceType = 'switch', state = null, voltage = null, apower = null, temp = null;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${base}/rpc/Cover.GetStatus?id=${id}`, { signal: ctrl.signal });
      const d = await r.json();
      if (d.state !== undefined) {
        deviceType = 'cover'; state = d.state;
        voltage = d.voltage; apower = d.apower; temp = d.temperature?.tC;
      }
    } catch(_) {}
    if (deviceType === 'switch') {
      const ctrl2 = new AbortController();
      setTimeout(() => ctrl2.abort(), 3000);
      const r = await fetch(`${base}/rpc/Switch.GetStatus?id=${id}`, { signal: ctrl2.signal });
      const d = await r.json();
      state = d.output ? 'ON' : 'OFF';
      voltage = d.voltage; apower = d.apower; temp = d.temperature?.tC;
    }
    res.json({ ok: true, deviceType, state, voltage, apower, temp });
  } catch (e) {
    res.json({ ok: false, error: e.name === 'AbortError' ? 'Timeout (4s)' : e.message });
  }
});

// Admin — escanear red en busca de Shellys
app.get('/api/admin/scan-shelly', requireAdmin, async (req, res) => {
  const os = require('os');
  const ifaces = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === 'IPv4' && !i.internal);
  const subnets = [...new Set([
    ...ifaces.map(i => i.address.split('.').slice(0,3).join('.')),
    '192.168.4','192.168.100','192.168.1'
  ])];
  const cfg2 = loadServerConfig();
  const usedIPs = (cfg2.machines||[]).map(m => (m.shellyUrl||'').replace(/^https?:\/\//,'').replace(/\/.*$/,''));

  const found = [];
  const tryIP = async (subnet, h) => {
    const ip = `${subnet}.${h}`;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 600);
      const r = await fetch(`http://${ip}/rpc/Shelly.GetDeviceInfo`, { signal: ctrl.signal });
      if (!r.ok) return;
      const d = await r.json();
      let deviceType = 'switch';
      try {
        const r2 = await fetch(`http://${ip}/rpc/Cover.GetStatus?id=0`, { signal: AbortSignal.timeout(500) });
        const d2 = await r2.json();
        if (d2.state !== undefined) deviceType = 'cover';
      } catch(_) {}
      found.push({ ip: `http://${ip}`, model: d.model || d.app || 'Shelly', type: deviceType, inUse: usedIPs.includes(ip) });
    } catch(_) {}
  };

  const tasks = [];
  for (const subnet of subnets)
    for (let h = 1; h <= 254; h++) tasks.push(tryIP(subnet, h));
  await Promise.all(tasks);
  found.sort((a,b) => a.ip.localeCompare(b.ip));
  console.log(`[SCAN] Encontrados ${found.length} Shelly(s)`);
  res.json({ ok: true, found });
});

// Admin — activar/desactivar Shelly directamente desde admin
app.post('/api/admin/shelly-action', requireAdmin, async (req, res) => {
  const { shellyUrl, channel, action } = req.body || {};
  if (!shellyUrl || !action) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
  const base = shellyUrl.replace(/\/$/, '');
  const id = Number(channel) || 0;
  try {
    let url;
    if (action === 'open')       url = `${base}/rpc/Cover.Open?id=${id}`;
    else if (action === 'close') url = `${base}/rpc/Cover.Close?id=${id}`;
    else if (action === 'on')    url = `${base}/rpc/Switch.Set?id=${id}&on=true`;
    else if (action === 'off')   url = `${base}/rpc/Switch.Set?id=${id}&on=false`;
    else return res.status(400).json({ ok: false, error: 'Acción desconocida' });
    const r = await fetch(url, { method: 'GET' });
    const body = await r.text();
    res.json({ ok: r.ok, body });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Admin — config de alertas
app.get('/api/admin/alert-config', requireAdmin, (req, res) => {
  const cfg = loadServerConfig();
  res.json({ ok: true, alertWhatsapp: cfg.alertWhatsapp || '', callmebotKey: cfg.callmebotKey || '' });
});

app.post('/api/admin/alert-config', requireAdmin, (req, res) => {
  const { alertWhatsapp, callmebotKey } = req.body || {};
  const cfg = loadServerConfig();
  cfg.alertWhatsapp = (alertWhatsapp || '').trim();
  cfg.callmebotKey  = (callmebotKey  || '').trim();
  saveServerConfig(cfg);
  console.log('[ADMIN] Alert config guardada, phone:', cfg.alertWhatsapp);
  res.json({ ok: true });
});

app.post('/api/admin/test-alert', requireAdmin, async (req, res) => {
  const fakeRecord = { maquina: 'TEST', linea: '01', operador: 'Prueba Admin', turno: 'M1', items: [] };
  const fakeItems  = [{ id: 4 }];
  try {
    await dispatchAlert(fakeRecord, fakeItems);
    res.json({ ok: true, message: 'Alerta de prueba enviada (revisa log y WhatsApp si configurado)' });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/alerts-log', requireAdmin, (req, res) => {
  try {
    const content = fs.existsSync(alertsLog) ? fs.readFileSync(alertsLog, 'utf8') : '';
    const lines = content.trim().split('\n').filter(Boolean).reverse().slice(0, 50);
    res.json({ ok: true, lines });
  } catch(e) {
    res.json({ ok: true, lines: [] });
  }
});

// ── LIBERACIÓN MANUAL (BYPASS) ────────────────────────────────────
const bypassLogFile = path.join(dataBase, 'bypass.log');

app.post('/api/bypass', (req, res) => {
  const { password, reason, maquina, operador, turno, linea } = req.body || {};
  if (!password || !reason?.trim())
    return res.status(400).json({ ok: false, error: 'Se requiere contraseña y motivo' });
  const cfg = loadServerConfig();
  const supPw = cfg.supervisorPassword || '';
  if (!supPw)
    return res.status(401).json({ ok: false, error: 'No hay contraseña de supervisor configurada. Pide al administrador que la configure.' });
  if (password !== supPw)
    return res.status(401).json({ ok: false, error: 'Contraseña de supervisor incorrecta' });
  const ts = new Date().toLocaleString('es-MX', { timeZone: 'America/Monterrey', hour12: false });
  const line = `[BYPASS ${ts}] ${maquina||'—'} L${linea||'—'} T:${turno||'—'} Op:${operador||'—'} | ${reason.trim()}`;
  try { fs.appendFileSync(bypassLogFile, line + '\n'); } catch(e) {}
  console.log('[BYPASS]', line);
  res.json({ ok: true });
});

app.get('/api/admin/supervisor-config', requireAdmin, (req, res) => {
  const cfg = loadServerConfig();
  res.json({ ok: true, supervisorPassword: cfg.supervisorPassword || '' });
});
app.post('/api/admin/supervisor-config', requireAdmin, (req, res) => {
  const { supervisorPassword } = req.body || {};
  const cfg = loadServerConfig();
  cfg.supervisorPassword = (supervisorPassword || '').trim();
  saveServerConfig(cfg);
  res.json({ ok: true });
});
app.get('/api/admin/bypass-log', requireAdmin, (req, res) => {
  try {
    const content = fs.existsSync(bypassLogFile) ? fs.readFileSync(bypassLogFile, 'utf8') : '';
    const lines = content.trim().split('\n').filter(Boolean).reverse().slice(0, 50);
    res.json({ ok: true, lines });
  } catch(e) { res.json({ ok: true, lines: [] }); }
});

// Servir admin
app.use('/admin', express.static(path.join(rootDir, 'admin')));

app.listen(port, host, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  ✅ Checklist Shelly 2PM Gen4 en línea                       ║
║  🌐 URL: http://${host}:${port}                              ║
║  📱 API: /api/upload, /api/activate                          ║
║  ⏰ Auto-reset: Habilitado                                    ║
╚════════════════════════════════════════════════════════════╝
  `);
});
