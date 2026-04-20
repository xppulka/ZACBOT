/**
 * Configuração centralizada — lê env vars uma vez, valida e exporta.
 * Falha rápido (process.exit) se algo essencial estiver faltando.
 */
require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`❌ Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return v;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

const config = {
  port: int('PORT', 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  apiKey: required('API_KEY'),
  webhookSecret: required('WEBHOOK_SECRET'),
  webhookUrl: process.env.LOVABLE_WEBHOOK_URL || '',

  redisUrl: required('REDIS_URL'),

  // Limites e timings
  maxSessionsPerInstance: int('MAX_SESSIONS_PER_INSTANCE', 50),
  sessionIdleTtlHours: int('SESSION_IDLE_TTL_HOURS', 0), // 0 = desativado
  webhookRetryAttempts: int('WEBHOOK_RETRY_ATTEMPTS', 3),
  responseDelayMinMs: int('RESPONSE_DELAY_MIN_MS', 1000),
  responseDelayMaxMs: int('RESPONSE_DELAY_MAX_MS', 3000),
  messageDebounceMs: int('MESSAGE_DEBOUNCE_MS', 2000),

  // Reconexão
  reconnectInitialMs: int('RECONNECT_INITIAL_MS', 3000),
  reconnectMaxMs: int('RECONNECT_MAX_MS', 60000),
  reconnectMaxAttempts: int('RECONNECT_MAX_ATTEMPTS', 10),
};

module.exports = config;
