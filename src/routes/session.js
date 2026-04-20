/**
 * Rotas REST para gerenciar sessões WhatsApp.
 * Todas exigem header x-api-key.
 */
const express = require('express');
const apiKeyAuth = require('../middleware/auth');
const {
  validateUserIdParam,
  validateUserIdBody,
} = require('../middleware/validateUserId');
const sessionManager = require('../services/sessionManager');

const router = express.Router();

router.use(apiKeyAuth);

/**
 * POST /session/start
 * body: { userId: string }
 */
router.post('/start', validateUserIdBody, async (req, res, next) => {
  try {
    const { userId } = req.body;
    const state = await sessionManager.startSession(userId);
    res.json(state);
  } catch (err) {
    if (err.code === 'MAX_SESSIONS_REACHED') {
      return res.status(429).json({ error: 'max_sessions_reached', message: err.message });
    }
    next(err);
  }
});

/**
 * GET /session/status/:userId
 */
router.get('/status/:userId', validateUserIdParam, (req, res) => {
  const { userId } = req.params;
  const state = sessionManager.getStatus(userId);
  res.json(state);
});

/**
 * GET /session/list
 * Lista todas as sessões ativas em memória.
 */
router.get('/list', (_req, res) => {
  res.json({
    counts: sessionManager.countByStatus(),
    sessions: sessionManager.listSessions(),
  });
});

/**
 * POST /session/send
 * body: { userId, number, message }
 */
router.post('/send', validateUserIdBody, async (req, res, next) => {
  try {
    const { userId, number, message } = req.body || {};
    if (!number || !message) {
      return res
        .status(400)
        .json({ error: 'missing_fields', required: ['number', 'message'] });
    }
    if (typeof message !== 'string' || message.length > 4096) {
      return res
        .status(400)
        .json({ error: 'invalid_message', message: 'message deve ser string até 4096 chars' });
    }

    const result = await sessionManager.sendMessage(userId, number, message);
    res.json(result);
  } catch (err) {
    if (err.code === 'SESSION_NOT_CONNECTED') {
      return res.status(409).json({ error: 'session_not_connected', message: err.message });
    }
    next(err);
  }
});

/**
 * POST /session/stop
 * body: { userId }
 */
router.post('/stop', validateUserIdBody, async (req, res, next) => {
  try {
    const { userId } = req.body;
    await sessionManager.stopSession(userId);
    res.json({ ok: true, userId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
