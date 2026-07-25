import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  publicAppUrl: process.env.PUBLIC_APP_URL || 'http://localhost:4001',

  databaseUrl: required('DATABASE_URL'),
  dbSchema: process.env.DB_SCHEMA || 'sst',

  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  // Administrador Maestro: cuenta exclusiva del equipo de desarrollo (es_maestro).
  // Única con capacidad de crear/gestionar usuarios internos del sistema.
  maestro: {
    nombre: process.env.MAESTRO_NOMBRE || 'Administrador Maestro JD&D',
    email: (process.env.MAESTRO_EMAIL || 'admin@jdd.com').toLowerCase(),
    documento: process.env.MAESTRO_DOCUMENTO || '9999999999',
    password: process.env.MAESTRO_PASSWORD || process.env.ADMIN_PASSWORD || 'Maestro123*',
  },

  // Cuenta del cliente (administradora operativa). Conserva el rol 'admin' y el
  // documento con el que el cliente ya inicia sesión; NO es maestro.
  cliente: {
    nombre: process.env.CLIENTE_NOMBRE || 'Administrador JD&D',
    email: (process.env.CLIENTE_EMAIL || 'juanskpc@gmail.com').toLowerCase(),
    documento: process.env.CLIENTE_DOCUMENTO || '1234567890',
    celular: process.env.CLIENTE_CELULAR || '3188887013',
    // Solo se usa si la cuenta no existe aún (alta inicial); nunca pisa el hash actual.
    password: process.env.CLIENTE_PASSWORD || process.env.ADMIN_PASSWORD || 'Admin123*',
  },

  auth: {
    // Vida útil del token de recuperación de contraseña (minutos).
    resetTokenTtlMinutes: parseInt(process.env.RESET_TOKEN_TTL_MINUTES || '60', 10),
    // Rate limiting de /auth/forgot-password: máx. solicitudes por ventana.
    resetRateWindowMinutes: parseInt(process.env.RESET_RATE_WINDOW_MINUTES || '15', 10),
    resetRateMax: parseInt(process.env.RESET_RATE_MAX || '3', 10),
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    localDir: process.env.STORAGE_LOCAL_DIR || './storage',
    s3Bucket: process.env.S3_BUCKET,
    s3Region: process.env.S3_REGION,
    // Opcional: endpoint para S3-compatible (DigitalOcean Spaces / Linode).
    s3Endpoint: process.env.S3_ENDPOINT,
  },

  email: {
    driver: process.env.EMAIL_DRIVER || 'console',
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'JD&D Consultores <no-reply@jdd.com>',
  },

  // Gemini NO es el motor principal de extracción (ese es OpenAI). Esta config
  // solo alimenta los componentes auxiliares PENDIENTES DE MIGRACIÓN a OpenAI:
  // clasificación de ARL, resumen ejecutivo y búsqueda en lenguaje natural
  // (ver services/gemini.service.js). La config del motor OpenAI vive en
  // infrastructure/openai/openai-extraction.config.js (lee OPENAI_* de process.env).
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    modelPro: process.env.GEMINI_MODEL_PRO || 'gemini-2.5-pro',
    modelFlash: process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash',
    enabled: Boolean(process.env.GEMINI_API_KEY),
  },
};
