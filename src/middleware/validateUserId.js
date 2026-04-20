/**
 * Valida que userId é seguro (sem path traversal, sem caracteres exóticos).
 * Aceita 3-64 chars: letras, números, `_` e `-`.
 */
const USER_ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;

function isValidUserId(userId) {
  return typeof userId === 'string' && USER_ID_RE.test(userId);
}

function validateUserIdParam(req, res, next) {
  const userId = req.params.userId;
  if (!isValidUserId(userId)) {
    return res.status(400).json({
      error: 'invalid_userId',
      message: 'userId deve ter 3-64 caracteres alfanuméricos, _ ou -',
    });
  }
  next();
}

function validateUserIdBody(req, res, next) {
  const userId = req.body && req.body.userId;
  if (!isValidUserId(userId)) {
    return res.status(400).json({
      error: 'invalid_userId',
      message: 'userId deve ter 3-64 caracteres alfanuméricos, _ ou -',
    });
  }
  next();
}

module.exports = { isValidUserId, validateUserIdParam, validateUserIdBody };
