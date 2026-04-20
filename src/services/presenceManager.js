/**
 * Cache em memória da presença do contato vista por cada sessão.
 * Estrutura: Map<userId, Map<jid, { status, lastUpdate, lastSeenAt }>>
 *
 * - status: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
 * - lastUpdate: timestamp do último update recebido (qualquer status)
 * - lastSeenAt: timestamp da última vez que vimos `available` (= "online")
 *
 * O frontend usa lastSeenAt pra mostrar "visto às HH:MM" quando o contato
 * não está online no momento, mas esteve recentemente.
 *
 * O frontend faz polling rápido (~2s) por essa info enquanto a conversa
 * está aberta. Não persistimos: presença é volátil por natureza.
 */
const cache = new Map();

const PRESENCE_TTL_MS = 30 * 60_000; // mantém o lastSeenAt por até 30 min

function setPresence(userId, jid, status) {
  if (!userId || !jid) return;
  let userMap = cache.get(userId);
  if (!userMap) {
    userMap = new Map();
    cache.set(userId, userMap);
  }
  const now = Date.now();
  const existing = userMap.get(jid);
  const lastSeenAt =
    status === 'available' ? now : existing?.lastSeenAt ?? null;
  userMap.set(jid, { status, lastUpdate: now, lastSeenAt });
}

function getPresence(userId, jid) {
  const userMap = cache.get(userId);
  if (!userMap) return null;
  const entry = userMap.get(jid);
  if (!entry) return null;
  // Se o último update já é muito antigo, considera expirado
  if (Date.now() - entry.lastUpdate > PRESENCE_TTL_MS) {
    userMap.delete(jid);
    return null;
  }
  return {
    status: entry.status,
    lastUpdate: entry.lastUpdate,
    lastSeenAt: entry.lastSeenAt,
  };
}

function clearUser(userId) {
  cache.delete(userId);
}

module.exports = { setPresence, getPresence, clearUser };
