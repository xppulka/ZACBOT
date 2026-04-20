/**
 * Cria e configura uma instância Baileys para um usuário.
 *
 * Responsável por:
 *   - autenticação persistente via Redis (useRedisAuthState)
 *   - geração de QR code em base64
 *   - reconexão automática com backoff exponencial + jitter
 *   - filtragem (ignora grupos e mensagens próprias)
 *   - debounce de mensagens em rajada por contato
 *   - envio ao webhook do Lovable + resposta automática
 */
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');

const { sendToWebhook } = require('../utils/webhook');
const { useRedisAuthState, clearRedisAuthState } = require('./redisAuthState');
const { redis } = require('../utils/redis');
const config = require('../config');

const ACTIVE_SET = 'wa:sessions:active';

async function createWhatsAppClient({ userId, record, logger }) {
  const { state, saveCreds } = await useRedisAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, 'Iniciando socket Baileys');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Lovable Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  record.sock = sock;
  record.status = record.status === 'reconnecting' ? 'reconnecting' : 'connecting';
  record.qr = null;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
        record.qr = dataUrl;
        record.status = 'waiting_qr';
        logger.info('📱 QR code gerado, aguardando scan');
      } catch (err) {
        logger.error({ err: err.message }, 'Falha ao gerar QR base64');
      }
    }

    if (connection === 'open') {
      record.status = 'connected';
      record.qr = null;
      record.reconnectAttempts = 0;
      record.lastActivityAt = Date.now();
      logger.info('✅ Conectado ao WhatsApp');
    }

    if (connection === 'close') {
      const statusCode =
        (lastDisconnect?.error instanceof Boom && lastDisconnect.error.output?.statusCode) ||
        lastDisconnect?.error?.output?.statusCode;

      const reasonName = lookupReason(statusCode);
      logger.warn({ statusCode, reasonName }, '🔌 Conexão fechada');

      record.lastError = reasonName || 'unknown';
      record.sock = null;

      if (statusCode === DisconnectReason.loggedOut) {
        // Sessão invalidada — limpa credenciais e marca como logged_out
        record.status = 'logged_out';
        record.qr = null;
        try {
          await clearRedisAuthState(userId);
          await redis.srem(ACTIVE_SET, userId);
        } catch (err) {
          logger.error({ err: err.message }, 'Erro ao limpar credenciais após logout');
        }
        logger.info('Sessão deslogada. Necessário novo /session/start');
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        // Outra sessão tomou o lugar — não tenta reconectar
        record.status = 'disconnected';
        record.qr = null;
        logger.warn('Conexão substituída por outro cliente. Sem reconexão automática.');
        return;
      }

      // Reconexão automática com backoff exponencial + jitter
      record.reconnectAttempts = (record.reconnectAttempts || 0) + 1;
      if (record.reconnectAttempts > config.reconnectMaxAttempts) {
        record.status = 'disconnected';
        logger.error(
          { attempts: record.reconnectAttempts },
          'Máximo de tentativas de reconexão atingido. Pare e reinicie a sessão.'
        );
        return;
      }

      const base = Math.min(
        config.reconnectInitialMs * 2 ** (record.reconnectAttempts - 1),
        config.reconnectMaxMs
      );
      const jitter = Math.floor(Math.random() * 1000);
      const delay = base + jitter;

      record.status = 'reconnecting';
      logger.info(
        { attempt: record.reconnectAttempts, delay },
        '⏳ Tentando reconectar'
      );

      record.reconnectTimer = setTimeout(() => {
        record.reconnectTimer = null;
        createWhatsAppClient({ userId, record, logger }).catch((err) => {
          logger.error({ err: err.message }, 'Falha na reconexão');
        });
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages) {
      try {
        await handleIncomingMessage({ userId, sock, msg, record, logger });
      } catch (err) {
        logger.error({ err: err.message }, 'Erro ao processar mensagem recebida');
      }
    }
  });

  return sock;
}

/**
 * Processa mensagem recebida com debounce por contato.
 * Se chegar mais mensagens do mesmo contato em < MESSAGE_DEBOUNCE_MS, agrupa
 * todas num único webhook (com message = textos concatenados).
 */
async function handleIncomingMessage({ userId, sock, msg, record, logger }) {
  if (!msg.message) return;
  if (msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  if (
    remoteJid.endsWith('@g.us') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@broadcast')
  ) {
    return;
  }

  const msgType = getMessageType(msg.message);
  const text = extractText(msg.message);

  // Aceita: texto OU áudio. Outros tipos (imagem/vídeo/etc) por enquanto ignorados.
  const isAudio = msgType === 'audio';
  logger.info(
    { jid: remoteJid, msgType, hasText: !!text, isAudio },
    '📨 Mensagem recebida (pré-filtro)'
  );
  if (!text && !isAudio) {
    logger.info({ remoteJid, msgType }, '⏭️  Mensagem sem texto/áudio, ignorada');
    return;
  }

  record.lastActivityAt = Date.now();

  try {
    await sock.readMessages([msg.key]);
  } catch {
    /* ignore */
  }

  // Tenta buscar foto de perfil (pode falhar se contato bloqueou ou não tem)
  let profilePicUrl = null;
  try {
    profilePicUrl = await sock.profilePictureUrl(remoteJid, 'image');
  } catch (e) {
    logger.debug({ jid: remoteJid, err: e.message }, 'Sem foto de perfil disponível');
  }

  // Resolve número real do contato:
  //  1. Se JID já é @s.whatsapp.net → usa os dígitos
  //  2. Se vier `key.senderPn` (Baileys novo, mensagens vindas via @lid) → usa
  //  3. Caso contrário, tenta onWhatsApp (com cache por JID em record.lidPhoneCache)
  let phoneNumber = null;
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    phoneNumber = remoteJid.split('@')[0];
  } else if (msg.key?.senderPn && typeof msg.key.senderPn === 'string') {
    phoneNumber = msg.key.senderPn.split('@')[0].replace(/\D/g, '') || null;
  } else if (remoteJid.endsWith('@lid')) {
    if (!record.lidPhoneCache) record.lidPhoneCache = new Map();
    if (record.lidPhoneCache.has(remoteJid)) {
      phoneNumber = record.lidPhoneCache.get(remoteJid);
    } else {
      try {
        const lidDigits = remoteJid.split('@')[0];
        const results = await sock.onWhatsApp(lidDigits);
        const match = Array.isArray(results) ? results.find((r) => r && r.exists) : null;
        if (match?.jid && typeof match.jid === 'string') {
          phoneNumber = match.jid.split('@')[0];
          record.lidPhoneCache.set(remoteJid, phoneNumber);
          logger.info({ lid: remoteJid, phoneNumber }, '🔎 LID → phone resolvido');
        }
      } catch (err) {
        logger.debug({ err: err.message, jid: remoteJid }, 'onWhatsApp para @lid falhou');
      }
    }
  }

  // ÁUDIO: download + envio imediato (não usa debounce)
  if (isAudio) {
    let audioBase64 = null;
    let mimeType = msg.message.audioMessage?.mimetype || 'audio/ogg';
    let durationSeconds = msg.message.audioMessage?.seconds || null;
    let sizeBytes = null;

    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );
      audioBase64 = buffer.toString('base64');
      sizeBytes = buffer.length;
      logger.info(
        { jid: remoteJid, sizeBytes, durationSeconds, mimeType },
        '🎙️  Áudio baixado'
      );
    } catch (err) {
      logger.error({ err: err.message, jid: remoteJid }, 'Falha ao baixar áudio');
      return;
    }

    try {
      await sendToWebhook(config.webhookUrl, {
        userId,
        messageId: msg.key.id,
        from: remoteJid.split('@')[0],
        jid: remoteJid,
        fromName: msg.pushName || null,
        profilePicUrl,
        phoneNumber,
        message: '',
        messageType: 'audio',
        audioBase64,
        audioMimeType: mimeType,
        audioDurationSeconds: durationSeconds,
        audioSizeBytes: sizeBytes,
        timestamp:
          typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : Date.now(),
        isReply: false,
        quotedMessageId: null,
        groupedCount: 1,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'Webhook (áudio) falhou após retries');
    }
    return;
  }

  // TEXTO: debounce normal
  const messageMeta = {
    messageId: msg.key.id,
    text,
    timestamp:
      typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp * 1000
        : Date.now(),
    fromName: msg.pushName || null,
    profilePicUrl,
    phoneNumber,
    isReply: !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage,
    quotedMessageId:
      msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
    messageType: msgType,
  };

  // Debounce: junta mensagens do mesmo contato em rajada
  const buf = record.incomingBuffers.get(remoteJid) || { messages: [], timer: null };
  buf.messages.push(messageMeta);
  if (buf.timer) clearTimeout(buf.timer);

  buf.timer = setTimeout(async () => {
    record.incomingBuffers.delete(remoteJid);
    const grouped = buf.messages;
    const combinedText = grouped.map((m) => m.text).join('\n');
    const last = grouped[grouped.length - 1];
    const from = remoteJid.split('@')[0];

    logger.info(
      { from, jid: remoteJid, count: grouped.length, preview: combinedText.slice(0, 80) },
      '📩 Mensagem(ns) recebida(s) — flushing buffer'
    );

    if (!config.webhookUrl) {
      logger.warn('LOVABLE_WEBHOOK_URL não configurado, não há resposta');
      return;
    }

    let response;
    try {
      response = await sendToWebhook(config.webhookUrl, {
        userId,
        messageId: last.messageId,
        from,           // só os dígitos (compat retro)
        jid: remoteJid, // JID completo com sufixo (@s.whatsapp.net ou @lid)
        fromName: last.fromName,
        profilePicUrl: last.profilePicUrl,
        phoneNumber: last.phoneNumber,
        message: combinedText,
        messageType: last.messageType,
        timestamp: last.timestamp,
        isReply: last.isReply,
        quotedMessageId: last.quotedMessageId,
        groupedCount: grouped.length,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'Webhook falhou após retries (já em DLQ)');
      return;
    }

    const replyText =
      response && typeof response.response === 'string' ? response.response.trim() : '';
    if (!replyText) {
      logger.debug('Webhook não retornou resposta para enviar');
      return;
    }

    await replyWithHumanLikeDelay({ sock, jid: remoteJid, text: replyText, logger });
  }, config.messageDebounceMs);

  record.incomingBuffers.set(remoteJid, buf);
}

async function replyWithHumanLikeDelay({ sock, jid, text, logger }) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
  } catch (e) {
    logger.warn({ err: e.message }, 'Falha em presence composing');
  }

  const min = config.responseDelayMinMs;
  const max = config.responseDelayMaxMs;
  const delay = Math.floor(Math.random() * Math.max(0, max - min)) + min;
  await new Promise((r) => setTimeout(r, delay));

  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch {
    /* ignore */
  }

  await sock.sendMessage(jid, { text });
  logger.info({ jid }, '🤖 Resposta automática enviada');
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

function getMessageType(message) {
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.locationMessage) return 'location';
  if (message.contactMessage) return 'contact';
  if (message.buttonsResponseMessage || message.listResponseMessage) return 'interactive';
  return 'unknown';
}

function lookupReason(code) {
  if (!code) return null;
  const entries = Object.entries(DisconnectReason || {});
  const found = entries.find(([, v]) => v === code);
  return found ? found[0] : `code_${code}`;
}

module.exports = { createWhatsAppClient };
