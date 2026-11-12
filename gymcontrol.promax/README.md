# Guía de Instalación y Conexión de GymControl con Supabase y Vercel

Esta guía detalla los pasos exactos para configurar **Supabase** (Base de datos PostgreSQL + Storage de archivos Excel) y desplegar la aplicación en **Vercel** o ejecutarla localmente con **XAMPP / Node.js**.

---

## Paso 1: Configurar Supabase (Base de Datos y Storage)
1. Creá una cuenta gratuita en [supabase.com](https://supabase.com) y un nuevo proyecto.
2. Andá a **SQL Editor** en el panel de Supabase y ejecutá el siguiente script SQL para crear las tablas:

```sql
-- Tabla de Usuarios (Administradores y Profesores)
CREATE TABLE IF NOT EXISTS usuarios_sistema (
    id SERIAL PRIMARY KEY,
    usuario VARCHAR(50) UNIQUE NOT NULL,
    nombre_completo VARCHAR(120) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    rol VARCHAR(20) NOT NULL DEFAULT 'admin'
);

-- Tabla de Socios / Clientes
CREATE TABLE IF NOT EXISTS clientes (
    id SERIAL PRIMARY KEY,
    dni VARCHAR(10) UNIQUE NOT NULL,
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL,
    celular VARCHAR(20) NOT NULL,
    fecha_ultimo_pago DATE NOT NULL,
    fecha_vencimiento DATE NOT NULL,
    estado BOOLEAN DEFAULT TRUE
);

-- Tabla de Asistencias
CREATE TABLE IF NOT EXISTS asistencias (
    id SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
    fecha_ingreso DATE NOT NULL,
    hora_ingreso TIME NOT NULL
);

-- Tabla de Rutinas en Excel vinculadas a cada socio
CREATE TABLE IF NOT EXISTS rutinas_excel (
    id SERIAL PRIMARY KEY,
    cliente_id INT UNIQUE REFERENCES clientes(id) ON DELETE CASCADE,
    profesor_id INT REFERENCES usuarios_sistema(id),
    nombre_archivo VARCHAR(255) NOT NULL,
    ruta_o_url_archivo TEXT NOT NULL,
    fecha_actualizacion TIMESTAMP NOT NULL DEFAULT NOW()
);
```

3. Andá a **Storage** en Supabase, creá un nuevo Bucket llamado `rutinas` y marcalo como **Public** (Público) para que los socios puedan descargar sus planillas de Excel desde la recepción.
4. En **Project Settings > API**, copiá la **Project URL** y la **anon / public key**.

---

## Paso 2: Desplegar en Vercel
1. Subí este proyecto a un repositorio en **GitHub**.
2. Importá el repositorio en [vercel.com](https://vercel.com).
3. En la configuración del proyecto en Vercel, agregá las siguientes **Environment Variables (Variables de Entorno)**:
   - `SUPABASE_URL`: (Tu URL de Supabase)
   - `SUPABASE_ANON_KEY`: (Tu Clave Anon de Supabase)
4. Hacé clic en **Deploy**. Vercel compilará la aplicación automáticamente utilizando la función serverless en `api/index.js`.

---

## Paso 3: Ejecución Local (Alternativa a Vercel)
Si querés probarlo localmente en tu computadora:
1. Instalá Node.js.
2. Abrí la carpeta del proyecto en la terminal y ejecutá:
   ```bash
   npm install
   ```
3. Creá un archivo `.env` en la raíz con tus credenciales:
   ```env
   SUPABASE_URL=tu_url
   SUPABASE_ANON_KEY=tu_clave
   PORT=3000
   ```
4. Iniciá el servidor:
   ```bash
   npm start
   ```
5. Entrá en `http://localhost:3000`.
