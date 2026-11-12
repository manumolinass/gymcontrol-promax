const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'clave-secreta-gymcontrol',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 3600 * 1000 }
}));

// Funciones para autenticación persistente y sin estado (stateless tokens para Vercel Serverless)
const JWT_SECRET = process.env.SESSION_SECRET || 'clave-secreta-gymcontrol-super-segura-2026';

function crearToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const data = Buffer.from(JSON.stringify({
    ...payload,
    exp: Date.now() + 24 * 3600 * 1000 // 24 horas
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${sig}`;
}

function verificarToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, data, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function obtenerUsuario(req) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/gym_session=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token && req.session && req.session.adminId) {
    return { adminId: req.session.adminId, rol: req.session.rol };
  }
  return verificarToken(token);
}

app.use(express.static(path.join(__dirname, 'public')));

// Configurar cliente de Supabase (Variables de entorno)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('Conectado a Supabase correctamente.');
} else {
  console.warn('ATENCIÓN: SUPABASE_URL o SUPABASE_ANON_KEY no están configuradas.');
}

// Configuración de Multer para archivos en memoria (para subir Excel a Supabase Storage)
const upload = multer({ storage: multer.memoryStorage() });

// Utilidades de fecha ISO
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoy = () => fmt(new Date());
const hora = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const sumarDias = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return fmt(new Date(y, m - 1, d + n));
};
const DIAS_CUOTA = 30;

// Middleware de autenticación
const auth = (req, res, next) => {
  const user = obtenerUsuario(req);
  if (user && user.adminId) {
    req.user = user;
    if (!req.session) req.session = {};
    req.session.adminId = user.adminId;
    req.session.rol = user.rol;
    next();
  } else {
    res.status(401).json({ error: 'No autorizado. Inicie sesión.' });
  }
};

// ==================== RUTAS DE AUTENTICACIÓN ====================
app.get('/api/auth/estado', async (req, res) => {
  const user = obtenerUsuario(req);
  if (!supabase) return res.json({ hayAdmins: false, logueado: !!(user && user.adminId) });
  try {
    const { count, error } = await supabase.from('usuarios_sistema').select('*', { count: 'exact', head: true });
    res.json({
      hayAdmins: (count || 0) > 0,
      logueado: !!(user && user.adminId),
      rol: user ? (user.rol || 'admin') : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/registro', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' });
  const { usuario, password, nombre_completo, rol } = req.body;
  const userTrim = String(usuario || '').trim();
  const passStr = String(password || '');

  if (userTrim.length < 3 || passStr.length < 6) {
    return res.status(400).json({ error: 'Usuario (mín. 3) y contraseña (mín. 6 caracteres)' });
  }

  try {
    const { count } = await supabase.from('usuarios_sistema').select('*', { count: 'exact', head: true });
    const user = obtenerUsuario(req);
    if (count > 0 && !(user && user.adminId)) {
      return res.status(403).json({ error: 'Solo un administrador puede crear nuevas cuentas.' });
    }

    const password_hash = bcrypt.hashSync(passStr, 10);
    const assignedRole = (count === 0) ? 'admin' : (rol || 'admin');

    const { data, error } = await supabase.from('usuarios_sistema').insert([{
      usuario: userTrim,
      nombre_completo: nombre_completo || userTrim,
      password_hash,
      rol: assignedRole
    }]).select().single();

    if (error) throw error;

    const token = crearToken({ adminId: data.id, rol: data.rol });
    res.setHeader('Set-Cookie', `gym_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`);

    if (count === 0) {
      if (!req.session) req.session = {};
      req.session.adminId = data.id;
      req.session.rol = data.rol;
    }
    res.json({ ok: true, rol: data.rol, token });
  } catch (e) {
    res.status(409).json({ error: 'El usuario ya existe o error en base de datos: ' + e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' });
  const { usuario, password } = req.body;
  const userTrim = String(usuario || '').trim();

  try {
    const { data: admin, error } = await supabase.from('usuarios_sistema').select('*').eq('usuario', userTrim).single();
    if (error || !admin || !bcrypt.compareSync(String(password || ''), admin.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const token = crearToken({ adminId: admin.id, rol: admin.rol });
    res.setHeader('Set-Cookie', `gym_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`);

    if (!req.session) req.session = {};
    req.session.adminId = admin.id;
    req.session.rol = admin.rol;
    res.json({ ok: true, rol: admin.rol, token });
  } catch (e) {
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'gym_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  if (req.session) {
    req.session.destroy(() => res.json({ ok: true }));
  } else {
    res.json({ ok: true });
  }
});

// ==================== CONSULTA PÚBLICA / RECEPCIÓN POR DNI ====================
app.post('/api/consulta', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' });
  const dni = String(req.body.dni || '').trim();
  if (!/^\d{6,10}$/.test(dni)) {
    return res.status(400).json({ acceso: false, mensaje: 'Ingresá un DNI válido (solo números)' });
  }

  try {
    const { data: c, error } = await supabase.from('clientes').select('*').eq('dni', dni).single();
    if (error || !c) {
      return res.json({ acceso: false, existe: false, mensaje: 'DNI no registrado. Acceso no permitido.' });
    }

    const alDia = c.fecha_vencimiento >= hoy();
    
    // Actualizar estado en BD
    await supabase.from('clientes').update({ estado: alDia }).eq('id', c.id);

    if (alDia) {
      // Verificar si ya registró asistencia hoy
      const { data: yaAsistio } = await supabase.from('asistencias')
        .select('id')
        .eq('cliente_id', c.id)
        .eq('fecha_ingreso', hoy())
        .maybeSingle();

      if (!yaAsistio) {
        await supabase.from('asistencias').insert([{
          cliente_id: c.id,
          fecha_ingreso: hoy(),
          hora_ingreso: hora()
        }]);
      }
    }

    // Buscar rutina Excel asignada si existe
    const { data: rutina } = await supabase.from('rutinas_excel').select('nombre_archivo, ruta_o_url_archivo, fecha_actualizacion').eq('cliente_id', c.id).maybeSingle();

    res.json({
      access: alDia,
      existe: true,
      nombre: `${c.nombre} ${c.apellido}`,
      estado: alDia ? 'Al día' : 'Deuda vencida',
      ultimoPago: c.fecha_ultimo_pago,
      vencimiento: c.fecha_vencimiento,
      rutina: rutina || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ABM DE CLIENTES (ADMIN) ====================
app.get('/api/clientes', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('clientes').select('*').order('apellido', { ascending: true });
    if (error) throw error;
    res.json(data.map(c => ({ ...c, alDia: c.fecha_vencimiento >= hoy() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clientes', auth, async (req, res) => {
  const { dni, nombre, apellido, celular } = req.body;
  if (!/^\d{6,10}$/.test(String(dni || '').trim())) return res.status(400).json({ error: 'DNI inválido (6 a 10 números)' });
  if (!nombre || !apellido || !celular) return res.status(400).json({ error: 'Todos los campos son obligatorios' });

  const ultimo = hoy();
  const vencimiento = sumarDias(ultimo, DIAS_CUOTA);

  try {
    const { error } = await supabase.from('clientes').insert([{
      dni: String(dni).trim(),
      nombre: String(nombre).trim(),
      apellido: String(apellido).trim(),
      celular: String(celular).trim(),
      fecha_ultimo_pago: ultimo,
      fecha_vencimiento: vencimiento,
      estado: true
    }]);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Ya existe un socio con ese DNI o error de BD' });
  }
});

app.put('/api/clientes/:id', auth, async (req, res) => {
  const { dni, nombre, apellido, celular } = req.body;
  try {
    const { error } = await supabase.from('clientes').update({
      dni: String(dni).trim(),
      nombre: String(nombre).trim(),
      apellido: String(apellido).trim(),
      celular: String(celular).trim()
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Error al actualizar socio (DNI duplicado)' });
  }
});

app.post('/api/clientes/:id/pago', auth, async (req, res) => {
  const ultimo = hoy();
  const vencimiento = sumarDias(ultimo, DIAS_CUOTA);
  try {
    const { error } = await supabase.from('clientes').update({
      fecha_ultimo_pago: ultimo,
      fecha_vencimiento: vencimiento,
      estado: true
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clientes/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('clientes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== MÓDULO DE RUTINAS EN EXCEL ====================
app.post('/api/rutinas/:clienteId', auth, upload.single('archivoExcel'), async (req, res) => {
  const clienteId = req.params.clienteId;
  const profesorId = req.session.adminId;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No se adjuntó ningún archivo Excel' });

  try {
    // Subir archivo al Storage de Supabase (Bucket llamado 'rutinas')
    const fileName = `rutina_${clienteId}_${Date.now()}${path.extname(file.originalname)}`;
    const { data: storageData, error: storageError } = await supabase.storage
      .from('rutinas')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (storageError) throw storageError;

    // Obtener URL pública del archivo
    const { data: publicURLData } = supabase.storage.from('rutinas').getPublicUrl(fileName);
    const fileUrl = publicURLData.publicUrl;

    // Registrar o actualizar en tabla rutinas_excel (Upsert por cliente_id)
    const { error: dbError } = await supabase.from('rutinas_excel').upsert({
      cliente_id: clienteId,
      profesor_id: profesorId,
      nombre_archivo: file.originalname,
      ruta_o_url_archivo: fileUrl,
      fecha_actualizacion: new Date().toISOString()
    }, { onConflict: 'cliente_id' });

    if (dbError) throw dbError;

    res.json({ ok: true, url: fileUrl });
  } catch (e) {
    res.status(500).json({ error: 'Error al subir la rutina: ' + e.message });
  }
});

// ==================== ESTADÍSTICAS Y ANALÍTICA ====================
app.get('/api/estadisticas', auth, async (req, res) => {
  const h = hoy();
  const mesStr = h.slice(0, 7);
  const limite15 = sumarDias(h, -15);

  try {
    // Ingresos de hoy (asistencias distintas de hoy)
    const { count: ingresosHoy } = await supabase.from('asistencias')
      .select('cliente_id', { count: 'exact', head: true })
      .eq('fecha_ingreso', h);

    // Ingresos del mes
    const { count: ingresosMes } = await supabase.from('asistencias')
      .select('*', { count: 'exact', head: true })
      .gte('fecha_ingreso', `${mesStr}-01`);

    // Socios únicos
    const { count: sociosUnicos } = await supabase.from('clientes')
      .select('*', { count: 'exact', head: true });

    // Historial de accesos recientes
    const { data: historial } = await supabase.from('asistencias')
      .select('fecha_ingreso, hora_ingreso, clientes(dni, nombre, apellido, fecha_vencimiento)')
      .order('id', { ascending: false })
      .limit(20);

    // Socios inactivos (> 15 días sin marcar o sin asistencias)
    const { data: todosClientes } = await supabase.from('clientes').select('id, dni, nombre, apellido, celular');
    const { data: ultimasAsistencias } = await supabase.from('asistencias').select('cliente_id, fecha_ingreso').order('fecha_ingreso', { ascending: false });

    const ultimoIngresoMap = {};
    if (ultimasAsistencias) {
      ultimasAsistencias.forEach(a => {
        if (!ultimoIngresoMap[a.cliente_id]) ultimoIngresoMap[a.cliente_id] = a.fecha_ingreso;
      });
    }

    const inactivos = todosClientes.filter(c => {
      const ultimo = ultimoIngresoMap[c.id];
      return !ultimo || ultimo < limite15;
    }).map(c => ({ ...c, ultimo: ultimoIngresoMap[c.id] || 'Sin registros' }));

    res.json({
      ingresosHoy: ingresosHoy || 0,
      ingresosMes: ingresosMes || 0,
      sociosUnicos: sociosUnicos || 0,
      historial: historial || [],
      inactivos
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Servidor GymControl corriendo en puerto ${PORT}`));
}

module.exports = app;
