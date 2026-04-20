/**
 * Entrypoint do servidor Express.
 * Healthcheck público + rotas de sessão protegidas por API key.
 */
const express = require('express');
const cors = require('cors');

const config = require('./config');
const logger = require('./utils/logger');
const { ping: redisPing } = require('./utils/redis');
const { getDLQSize } = require('./utils/webhook');

const sessionRoutes = require('./routes/session');
const sessionManager = require('./services/sessionManager');

const app = express();

app.use(cors());
app.use(express.json({ limit: '32mb' }));

// Healthcheck público — Railway/Render usam isso pra liveness
app.get('/health', async (_req, res) => {
  const redisOk = await redisPing();
  const dlq = await getDLQSize();
  res.status(redisOk ? 200 : 503).json({
    ok: redisOk,
    redis: redisOk ? 'connected' : 'down',
    sessions: sessionManager.countByStatus(),
    dlqSize: dlq,
    uptime: process.uptime(),
    version: '5.3.0',
  });
});

app.use('/session', sessionRoutes);

// Handler global de erros
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'Erro não tratado');
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const server = app.listen(config.port, async () => {
  logger.info('================================================');
  logger.info('🟢 BACKEND v5.3.0 — Send image outbound + imagem/áudio inbound');
  logger.info(`🚀 Escutando em :${config.port}`);
  logger.info('================================================');

  try {
    const restored = await sessionManager.restoreAllSessions();
    logger.info(`♻️  ${restored} sessão(ões) restaurada(s) do Redis`);
  } catch (err) {
    logger.error({ err: err.message }, 'Falha ao restaurar sessões');
  }
});

// Encerramento gracioso
async function gracefulShutdown(signal) {
  logger.info(`${signal} recebido, encerrando...`);
  server.close(() => logger.info('HTTP server fechado'));
  await sessionManager.shutdownAll();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
});
