/**
 * Cliente HTTP para enviar mensagens recebidas ao webhook do Lovable.
 *
 * Recursos:
 *   - HMAC-SHA256 do body (header x-webhook-signature) — Lovable valida origem
 *   - Idempotency key (header x-idempotency-key = messageId)
 *   - Retry com backoff exponencial
 *   - Dead-letter queue em Redis (wa:webhook:dlq) quando esgotam tentativas
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');
const { redis } = require('./redis');

const DLQ_KEY = 'wa:webhook:dlq';
const DLQ_MAX = 5000; // mantém só os últimos N eventos

function signBody(bodyString, secret) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
}

async function sendToWebhook(url, payload) {
  const attempts = config.webhookRetryAttempts;
  const bodyString = JSON.stringify(payload);
  const signature = signBody(bodyString, config.webhookSecret);
  const idempotencyKey = payload.messageId || payload.id || cryptoRandom();

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'x-webhook-signature': signature,
          'x-idempotency-key': idempotencyKey,
        },
        body: bodyString,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Webhook HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await res.json();
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { response: text };
      }
    } catch (err) {
      lastErr = err;
      const delay = Math.min(1000 * 2 ** (i - 1), 8000);
      logger.warn(
        { attempt: i, attempts, err: err.message, delay, userId: payload.userId },
        'Webhook falhou, tentando novamente'
      );
      if (i < attempts) await sleep(delay);
    }
  }

  // Esgotou retries — envia pra DLQ
  await pushToDLQ(payload, lastErr);
  throw lastErr;
}

async function pushToDLQ(payload, err) {
  try {
    const entry = JSON.stringify({
      payload,
      error: err && err.message ? err.message : String(err),
      failedAt: Date.now(),
    });
    // LPUSH + LTRIM mantém só os últimos N
    await redis.lpush(DLQ_KEY, entry);
    await redis.ltrim(DLQ_KEY, 0, DLQ_MAX - 1);
    logger.error(
      { userId: payload.userId, messageId: payload.messageId },
      '☠️  Webhook falhou definitivamente — enviado pra DLQ'
    );
  } catch (e) {
    logger.error({ err: e.message }, 'Falha ao salvar evento na DLQ');
  }
}

async function getDLQSize() {
  try {
    return await redis.llen(DLQ_KEY);
  } catch {
    return 0;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cryptoRandom() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = { sendToWebhook, getDLQSize, signBody };
