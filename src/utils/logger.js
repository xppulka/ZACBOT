/**
 * Logger Pino centralizado. Saída JSON estruturada em stdout.
 * Use logger.child({ userId }) pra correlacionar logs por sessão.
 */
const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.logLevel,
  base: { service: 'whatsapp-baileys' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
