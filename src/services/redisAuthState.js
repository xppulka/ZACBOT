/**
 * Auth state customizado pro Baileys que persiste em Redis em vez de disco.
 * Substitui useMultiFileAuthState.
 *
 * Estrutura de chaves:
 *   wa:session:{userId}:creds                     -> JSON de credenciais
 *   wa:session:{userId}:keys:{type}:{id}          -> JSON de chave Signal
 *
 * Serialização usa BufferJSON do Baileys (lida com Buffer/Uint8Array).
 */
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { redis } = require('../utils/redis');

const NS = 'wa:session';

function credsKey(userId) {
  return `${NS}:${userId}:creds`;
}
function keyKey(userId, type, id) {
  return `${NS}:${userId}:keys:${type}:${id}`;
}
function keysScanPattern(userId) {
  return `${NS}:${userId}:keys:*`;
}

async function useRedisAuthState(userId) {
  // Carrega credenciais existentes ou cria novas
  const credsRaw = await redis.get(credsKey(userId));
  const creds = credsRaw
    ? JSON.parse(credsRaw, BufferJSON.reviver)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids || ids.length === 0) return data;

          const pipeline = redis.pipeline();
          ids.forEach((id) => pipeline.get(keyKey(userId, type, id)));
          const results = await pipeline.exec();

          ids.forEach((id, i) => {
            const [err, value] = results[i];
            if (err || !value) return;
            let parsed = JSON.parse(value, BufferJSON.reviver);
            if (type === 'app-state-sync-key' && parsed) {
              parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
            }
            data[id] = parsed;
          });
          return data;
        },
        set: async (data) => {
          const pipeline = redis.pipeline();
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const k = keyKey(userId, type, id);
              if (value) {
                pipeline.set(k, JSON.stringify(value, BufferJSON.replacer));
              } else {
                pipeline.del(k);
              }
            }
          }
          await pipeline.exec();
        },
      },
    },
    saveCreds: async () => {
      await redis.set(
        credsKey(userId),
        JSON.stringify(creds, BufferJSON.replacer)
      );
    },
  };
}

/**
 * Apaga TODAS as chaves de auth de um userId. Usado em /session/stop e logout.
 * Itera com SCAN para não bloquear o Redis em datasets grandes.
 */
async function clearRedisAuthState(userId) {
  let cursor = '0';
  const pattern = keysScanPattern(userId);
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      200
    );
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');

  await redis.del(credsKey(userId));
}

/**
 * Verifica se um userId tem credenciais salvas (já fez pareamento).
 */
async function hasRedisAuthState(userId) {
  const exists = await redis.exists(credsKey(userId));
  return exists === 1;
}

module.exports = {
  useRedisAuthState,
  clearRedisAuthState,
  hasRedisAuthState,
};
