/**
 * Conversão de áudio para OGG/Opus mono 16kHz — formato que o WhatsApp
 * aceita como PTT (mensagem de voz). Áudios em webm/mp4/mp3/wav passam
 * pelo ffmpeg antes de serem enviados.
 */
const { spawn } = require('child_process');
const ffmpegStatic = (() => {
  try { return require('ffmpeg-static'); } catch { return null; }
})();
const logger = require('./logger');

// Em Alpine/musl o binário do ffmpeg-static às vezes não roda; o Dockerfile
// instala ffmpeg do sistema como fallback. Tenta primeiro o do sistema (PATH),
// depois o ffmpeg-static.
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFMPEG_FALLBACK = ffmpegStatic;

/**
 * Converte um Buffer de áudio em qualquer formato suportado pelo ffmpeg
 * para OGG/Opus mono 16kHz, ideal para PTT no WhatsApp.
 * Retorna { buffer, mimeType } pronto pra mandar via Baileys.
 */
async function convertToOggOpus(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error('Buffer de áudio vazio');
  }

  // Tenta ffmpeg do sistema primeiro; se falhar com ENOENT, cai pro estático.
  try {
    return await runFfmpeg(FFMPEG_BIN, inputBuffer);
  } catch (err) {
    if (err && err.code === 'ENOENT' && FFMPEG_FALLBACK) {
      return runFfmpeg(FFMPEG_FALLBACK, inputBuffer);
    }
    throw err;
  }
}

function runFfmpeg(bin, inputBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ar', '16000',
      '-ac', '1',
      '-application', 'voip',
      '-f', 'ogg',
      'pipe:1',
    ];

    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => errChunks.push(c));

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
        return reject(new Error(`ffmpeg saiu com código ${code}: ${stderr}`));
      }
      const out = Buffer.concat(chunks);
      if (out.length === 0) {
        return reject(new Error('ffmpeg retornou áudio vazio'));
      }
      logger.debug(
        { inputSize: inputBuffer.length, outputSize: out.length },
        '🎚️  Áudio convertido para OGG/Opus',
      );
      resolve({ buffer: out, mimeType: 'audio/ogg; codecs=opus' });
    });

    // Escreve input e fecha stdin
    proc.stdin.on('error', (err) => {
      // Se ffmpeg já fechou, ignora EPIPE — o close handler resolve/rejeita
      if (err && err.code !== 'EPIPE') reject(err);
    });
    proc.stdin.end(inputBuffer);
  });
}

module.exports = { convertToOggOpus };
