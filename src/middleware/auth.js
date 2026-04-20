/**
 * Middleware simples de autenticação por API key.
 * Espera header: x-api-key: <chave>
 */
const config = require('../config');

module.exports = function apiKeyAuth(req, res, next) {
  const provided = req.header('x-api-key');
  if (!provided || provided !== config.apiKey) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'API key inválida ou ausente',
    });
  }
  next();
};
