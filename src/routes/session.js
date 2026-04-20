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
 * POST /session/send-audio
 * body: { userId, number, audioBase64, mimeType? }
 * Envia áudio como mensagem de voz (PTT) no WhatsApp.
 */
router.post('/send-audio', validateUserIdBody, async (req, res, next) => {
  try {
    const { userId, number, audioBase64, mimeType } = req.body || {};
    if (!number || !audioBase64) {
      return res.status(400).json({
        error: 'missing_fields',
        required: ['number', 'audioBase64'],
      });
    }
    if (typeof audioBase64 !== 'string' || audioBase64.length > 28_000_000) {
      return res.status(400).json({
        error: 'invalid_audio',
        message: 'audioBase64 deve ser string até ~20MB',
      });
    }

    let buffer;
    try {
      buffer = Buffer.from(audioBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'invalid_base64' });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'empty_audio' });
    }
    if (buffer.length > 16 * 1024 * 1024) {
      return res.status(400).json({
        error: 'audio_too_large',
        message: 'Áudio acima de 16MB não é suportado',
      });
    }

    const result = await sessionManager.sendAudioMessage(
      userId,
      number,
      buffer,
      typeof mimeType === 'string' ? mimeType : null
    );
    res.json(result);
  } catch (err) {
    if (err.code === 'SESSION_NOT_CONNECTED') {
      return res.status(409).json({ error: 'session_not_connected', message: err.message });
    }
    if (err.code === 'INVALID_AUDIO') {
      return res.status(400).json({ error: 'invalid_audio', message: err.message });
    }
    next(err);
  }
});

/**
 * POST /session/send-image
 * body: { userId, number, imageBase64, mimeType?, caption? }
 * Envia imagem (jpeg/png/webp) com legenda opcional.
 */
router.post('/send-image', validateUserIdBody, async (req, res, next) => {
  try {
    const { userId, number, imageBase64, mimeType, caption } = req.body || {};
    if (!number || !imageBase64) {
      return res.status(400).json({
        error: 'missing_fields',
        required: ['number', 'imageBase64'],
      });
    }
    if (typeof imageBase64 !== 'string' || imageBase64.length > 28_000_000) {
      return res.status(400).json({
        error: 'invalid_image',
        message: 'imageBase64 deve ser string até ~20MB',
      });
    }
    if (caption != null && (typeof caption !== 'string' || caption.length > 1024)) {
      return res.status(400).json({
        error: 'invalid_caption',
        message: 'caption deve ser string até 1024 chars',
      });
    }

    let buffer;
    try {
      buffer = Buffer.from(imageBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'invalid_base64' });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'empty_image' });
    }
    if (buffer.length > 16 * 1024 * 1024) {
      return res.status(400).json({
        error: 'image_too_large',
        message: 'Imagem acima de 16MB não é suportada',
      });
    }

    const result = await sessionManager.sendImageMessage(
      userId,
      number,
      buffer,
      typeof mimeType === 'string' ? mimeType : null,
      typeof caption === 'string' ? caption : '',
    );
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
