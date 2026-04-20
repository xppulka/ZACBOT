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
const presenceManager = require('./presenceManager');
const logger = require('../utils/logger');
const config = require('../config');
const { convertToOggOpus } = require('../utils/audio');

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

  const jid = await resolveSendJid(record.sock, number, logger.child({ userId }));
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

/**
 * Envia áudio (PTT — push-to-talk / mensagem de voz) pra um contato.
 * audioBuffer: Buffer com o conteúdo do áudio (ogg/opus de preferência).
 * mimeType: opcional, default 'audio/ogg; codecs=opus'.
 */
async function sendAudioMessage(userId, number, audioBuffer, mimeType) {
  const record = sessions.get(userId);
  if (!record || record.status !== 'connected' || !record.sock) {
    const err = new Error(`Sessão de ${userId} não está conectada`);
    err.code = 'SESSION_NOT_CONNECTED';
    throw err;
  }
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    const err = new Error('audioBuffer vazio ou inválido');
    err.code = 'INVALID_AUDIO';
    throw err;
  }

  const log = logger.child({ userId });
  const jid = await resolveSendJid(record.sock, number, log);
  record.lastActivityAt = Date.now();

  // WhatsApp aceita PTT só em OGG/Opus mono. Sempre transcoda — garante
  // compatibilidade independente do formato vindo do navegador (webm, mp4, mp3, wav…).
  const incomingMime = (mimeType || '').toLowerCase();
  const alreadyOgg = incomingMime.includes('ogg') && incomingMime.includes('opus');
  let finalBuffer = audioBuffer;
  let finalMime = 'audio/ogg; codecs=opus';
  if (!alreadyOgg) {
    try {
      const converted = await convertToOggOpus(audioBuffer);
      finalBuffer = converted.buffer;
      finalMime = converted.mimeType;
      log.info(
        { from: incomingMime || 'unknown', inSize: audioBuffer.length, outSize: finalBuffer.length },
        '🎚️  Áudio convertido para OGG/Opus antes do envio PTT',
      );
    } catch (err) {
      log.error({ err: err.message }, 'Falha ao converter áudio para OGG/Opus');
      const e = new Error(`Falha ao converter áudio: ${err.message}`);
      e.code = 'INVALID_AUDIO';
      throw e;
    }
  }

  const previous = record.contactQueues.get(jid) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        await record.sock.presenceSubscribe(jid);
        await record.sock.sendPresenceUpdate('recording', jid);
      } catch (e) {
        log.warn({ err: e.message, jid }, 'Falha em presence recording');
      }

      try {
        await record.sock.sendPresenceUpdate('paused', jid);
      } catch {
        /* ignore */
      }

      const sent = await record.sock.sendMessage(jid, {
        audio: finalBuffer,
        mimetype: finalMime,
        ptt: true,
      });
      log.info(
        { jid, msgId: sent?.key?.id, sizeBytes: finalBuffer.length },
        '🎙️  Áudio enviado (PTT)'
      );
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

/**
 * Envia imagem (jpeg/png/webp) com caption opcional.
 */
async function sendImageMessage(userId, number, imageBuffer, mimeType, caption) {
  const record = sessions.get(userId);
  if (!record || record.status !== 'connected' || !record.sock) {
    const err = new Error(`Sessão de ${userId} não está conectada`);
    err.code = 'SESSION_NOT_CONNECTED';
    throw err;
  }
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const err = new Error('imageBuffer vazio ou inválido');
    err.code = 'INVALID_IMAGE';
    throw err;
  }

  const log = logger.child({ userId });
  const jid = await resolveSendJid(record.sock, number, log);
  record.lastActivityAt = Date.now();

  const finalMime = (mimeType || 'image/jpeg').toLowerCase();

  const previous = record.contactQueues.get(jid) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const sent = await record.sock.sendMessage(jid, {
        image: imageBuffer,
        mimetype: finalMime,
        caption: caption || undefined,
      });
      log.info(
        { jid, msgId: sent?.key?.id, sizeBytes: imageBuffer.length, hasCaption: !!caption },
        '🖼️  Imagem enviada',
      );
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

/**
 * Envia uma atualização de presença pro contato.
 * presence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
 * Também subscribe na presença do contato (pra começar a receber updates dele).
 */
async function sendPresenceUpdate(userId, number, presence) {
  const record = sessions.get(userId);
  if (!record || record.status !== 'connected' || !record.sock) {
    const err = new Error(`Sessão de ${userId} não está conectada`);
    err.code = 'SESSION_NOT_CONNECTED';
    throw err;
  }
  const validPresences = ['available', 'unavailable', 'composing', 'recording', 'paused'];
  if (!validPresences.includes(presence)) {
    const err = new Error(`Presence inválido: ${presence}`);
    err.code = 'INVALID_PRESENCE';
    throw err;
  }

  // Normaliza JID — não precisa resolver via onWhatsApp pra presence
  const jid = typeof number === 'string' && number.includes('@')
    ? number
    : `${String(number).replace(/\D/g, '')}@s.whatsapp.net`;

  try {
    // Subscribe pra começar a receber a presença do outro lado
    await record.sock.presenceSubscribe(jid).catch(() => {});
    await record.sock.sendPresenceUpdate(presence, jid);
    record.lastActivityAt = Date.now();
    return { ok: true, jid, presence };
  } catch (err) {
    logger.warn({ err: err.message, userId, jid, presence }, 'Falha em sendPresenceUpdate');
    throw err;
  }
}

/**
 * Marca mensagens como lidas (envia read receipt — duplo check azul).
 * messageKeys: array de { remoteJid, id, fromMe?, participant? }
 */
async function markMessagesAsRead(userId, messageKeys) {
  const record = sessions.get(userId);
  if (!record || record.status !== 'connected' || !record.sock) {
    const err = new Error(`Sessão de ${userId} não está conectada`);
    err.code = 'SESSION_NOT_CONNECTED';
    throw err;
  }
  if (!Array.isArray(messageKeys) || messageKeys.length === 0) {
    return { ok: true, markedCount: 0 };
  }

  // Filtra chaves válidas (precisa pelo menos remoteJid + id, e não pode ser fromMe)
  const validKeys = messageKeys
    .filter((k) => k && typeof k.remoteJid === 'string' && typeof k.id === 'string' && !k.fromMe)
    .map((k) => ({
      remoteJid: k.remoteJid,
      id: k.id,
      ...(k.participant ? { participant: k.participant } : {}),
    }));

  if (validKeys.length === 0) {
    return { ok: true, markedCount: 0 };
  }

  try {
    await record.sock.readMessages(validKeys);
    record.lastActivityAt = Date.now();
    logger.info({ userId, count: validKeys.length }, '✓✓ Mensagens marcadas como lidas');
    return { ok: true, markedCount: validKeys.length };
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Falha em readMessages');
    throw err;
  }
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

/**
 * Resolve o JID real para envio.
 *
 * - Grupos (@g.us) e LIDs (@lid) são preservados — Baileys envia direto.
 * - Números (com ou sem @s.whatsapp.net) são confirmados via onWhatsApp(),
 *   pois um JID “sintético” com dígitos errados (ex: vindo de mensagem com
 *   senderLid) é aceito pelo socket mas o WhatsApp descarta silenciosamente.
 */
async function resolveSendJid(sock, number, log) {
  const initial = normalizeJid(number);

  if (initial.endsWith('@g.us') || initial.endsWith('@lid')) {
    return initial;
  }

  const digits = initial.split('@')[0];
  try {
    const results = await sock.onWhatsApp(digits);
    log.info(
      { requested: initial, digits, results },
      '🔎 onWhatsApp result',
    );
    const match = Array.isArray(results) ? results.find((r) => r && r.exists) : null;
    if (match && match.jid) {
      log.info(
        { requested: initial, resolved: match.jid },
        '✅ JID confirmado no WhatsApp',
      );
      return match.jid;
    }
    log.error(
      { requested: initial, results },
      '❌ NÚMERO NÃO EXISTE NO WHATSAPP — envio será descartado pelo servidor',
    );
  } catch (err) {
    log.warn(
      { err: err.message, requested: initial },
      'Falha em onWhatsApp; usando JID literal',
    );
  }
  return initial;
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
  sendAudioMessage,
  sendImageMessage,
  sendPresenceUpdate,
  markMessagesAsRead,
  getContactPresence: (userId, jid) => presenceManager.getPresence(userId, jid),
  stopSession,
  shutdownAll,
  restoreAllSessions,
  _internals: { getOrCreateSessionRecord, sessions, ACTIVE_SET },
};
