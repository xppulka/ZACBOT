/**
 * Gerenciador de sessões WhatsApp (Redis-backed, multi-tenant).
 *
 * - Mantém um mapa em memória { userId -> sessionRecord } pra acesso rápido
 *   ao socket Baileys, mas TODA persistência de credenciais vai pro Redis.
 * - Index de sessões ativas em Redis (SET wa:sessions:active) — usado pra
 *   restaurar tudo no boot e listar sessões.
 * - Cada sessão tem fila por contato (debounce + ordem de envio).
 */
const { createWhatsAppClient } = require('./whatsappClient');
const { clearRedisAuthState, hasRedisAuthState } = require('./redisAuthState');
const { redis } = require('../utils/redis');
const logger = require('../utils/logger');
const config = require('../config');

const ACTIVE_SET = 'wa:sessions:active';

const sessions = new Map();

function getOrCreateSessionRecord(userId) {
  let s = sessions.get(userId);
  if (!s) {
    s = {
      userId,
      sock: null,
      status: 'disconnected', // 'waiting_qr' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'logged_out'
      qr: null,
      lastError: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      contactQueues: new Map(),
      // Buffer de mensagens recebidas por contato (debounce)
      incomingBuffers: new Map(), // jid -> { messages: [], timer }
      starting: false,
      lastActivityAt: Date.now(),
    };
    sessions.set(userId, s);
  }
  return s;
}

async function startSession(userId) {
  const record = getOrCreateSessionRecord(userId);

  if (record.status === 'connected') {
    return publicState(record);
  }
  if (record.starting) {
    return publicState(record);
  }

  if (sessions.size >= config.maxSessionsPerInstance && !sessions.has(userId)) {
    const err = new Error(
      `Limite de ${config.maxSessionsPerInstance} sessões por instância atingido`
    );
    err.code = 'MAX_SESSIONS_REACHED';
    throw err;
  }

  record.starting = true;
  try {
    await redis.sadd(ACTIVE_SET, userId);
    await createWhatsAppClient({
      userId,
      record,
      logger: logger.child({ userId }),
    });
    return publicState(record);
  } finally {
    record.starting = false;
  }
}

function getStatus(userId) {
  const record = sessions.get(userId);
  if (!record) {
    return { userId, status: 'not_started', qr: null };
  }
  return publicState(record);
}

function listSessions() {
  const out = [];
  for (const [userId, record] of sessions.entries()) {
    out.push({
      userId,
      status: record.status,
      hasQr: !!record.qr,
      reconnectAttempts: record.reconnectAttempts,
      lastActivityAt: record.lastActivityAt,
    });
  }
  return out;
}

function countByStatus() {
  const counts = { total: 0, connected: 0, waiting_qr: 0, reconnecting: 0, disconnected: 0 };
  for (const record of sessions.values()) {
    counts.total++;
    if (counts[record.status] !== undefined) counts[record.status]++;
  }
  return counts;
}

async function sendMessage(userId, number, message) {
  const record = sessions.get(userId);
  if (!record || record.status !== 'connected' || !record.sock) {
    const err = new Error(`Sessão de ${userId} não está conectada`);
    err.code = 'SESSION_NOT_CONNECTED';
    throw err;
  }

  const jid = normalizeJid(number);
  record.lastActivityAt = Date.now();

  const previous = record.contactQueues.get(jid) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        await record.sock.presenceSubscribe(jid);
        await record.sock.sendPresenceUpdate('composing', jid);
      } catch (e) {
        logger.warn({ err: e.message, jid, userId }, 'Falha em presence composing');
      }

      const min = config.responseDelayMinMs;
      const max = config.responseDelayMaxMs;
      const delay = Math.floor(Math.random() * Math.max(0, max - min)) + min;
      await sleep(delay);

      try {
        await record.sock.sendPresenceUpdate('paused', jid);
      } catch {
        /* ignore */
      }

      const sent = await record.sock.sendMessage(jid, { text: String(message) });
      logger.info({ jid, msgId: sent?.key?.id, userId }, '✉️  Mensagem enviada');
      return { ok: true, to: jid, id: sent?.key?.id };
    });

  record.contactQueues.set(jid, next);
  next.finally(() => {
    if (record.contactQueues.get(jid) === next) {
      record.contactQueues.delete(jid);
    }
  });

  return next;
}

async function stopSession(userId) {
  const record = sessions.get(userId);
  if (record) {
    if (record.reconnectTimer) {
      clearTimeout(record.reconnectTimer);
      record.reconnectTimer = null;
    }
    try {
      if (record.sock) {
        await record.sock.logout().catch(() => {});
        record.sock.end?.(undefined);
      }
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Erro ao encerrar socket');
    }
    sessions.delete(userId);
  }

  // Limpa credenciais do Redis e remove do índice
  await clearRedisAuthState(userId).catch((err) =>
    logger.warn({ err: err.message, userId }, 'Erro ao limpar auth no Redis')
  );
  await redis.srem(ACTIVE_SET, userId).catch(() => {});

  logger.info({ userId }, '🛑 Sessão encerrada e limpa');
}

async function shutdownAll() {
  const tasks = [];
  for (const [userId, record] of sessions.entries()) {
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    if (record.sock) {
      tasks.push(
        Promise.resolve()
          .then(() => record.sock.end?.(undefined))
          .catch(() => {})
      );
    }
    logger.info({ userId }, 'Encerrando socket no shutdown');
  }
  await Promise.allSettled(tasks);
}

/**
 * Restaura todas as sessões com credenciais salvas no Redis.
 * Lê o índice ACTIVE_SET e tenta startSession em cada uma.
 */
async function restoreAllSessions() {
  const userIds = await redis.smembers(ACTIVE_SET);
  let count = 0;

  for (const userId of userIds) {
    const has = await hasRedisAuthState(userId);
    if (!has) {
      // Sem credenciais — remove do índice (lixo)
      await redis.srem(ACTIVE_SET, userId);
      continue;
    }
    try {
      await startSession(userId);
      count++;
    } catch (err) {
      logger.error({ err: err.message, userId }, 'Falha ao restaurar sessão');
    }
  }
  return count;
}

// ---------- helpers ----------

function publicState(record) {
  return {
    userId: record.userId,
    status: record.status,
    qr: record.qr,
    reconnectAttempts: record.reconnectAttempts,
  };
}

function normalizeJid(number) {
  if (typeof number !== 'string') number = String(number);
  // Já tem sufixo? respeita (@s.whatsapp.net, @lid, @g.us)
  if (number.includes('@')) return number;
  const digits = number.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  startSession,
  getStatus,
  listSessions,
  countByStatus,
  sendMessage,
  stopSession,
  shutdownAll,
  restoreAllSessions,
  _internals: { getOrCreateSessionRecord, sessions, ACTIVE_SET },
};
