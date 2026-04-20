/**
 * Cliente Redis singleton (ioredis).
 * Usado para:
 *   - persistência de credenciais Baileys (auth state)
 *   - índice global de sessões ativas
 *   - dead-letter queue de webhooks
 */
const Redis = require('ioredis');
const config = require('../config');
const logger = require('./logger');

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
});

redis.on('connect', () => logger.info('🔌 Redis conectando...'));
redis.on('ready', () => logger.info('✅ Redis pronto'));
redis.on('error', (err) => logger.error({ err: err.message }, 'Redis erro'));
redis.on('close', () => logger.warn('Redis conexão fechada'));
redis.on('reconnecting', (ms) => logger.warn({ ms }, 'Redis reconectando'));

async function ping() {
  try {
    const r = await redis.ping();
    return r === 'PONG';
  } catch {
    return false;
  }
}

module.exports = { redis, ping };
