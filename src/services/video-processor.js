// Otimização de vídeos para streaming com ffmpeg.
// Reempacota (sem recodificar) em MP4 com áudio/vídeo intercalados e o índice (moov)
// no início (+faststart). Assim o navegador toca com uma única conexão 206, em vez de
// ficar pulando entre posições distantes do arquivo.
// Só recodifica quando o codec não toca no navegador (ex.: AVI com Xvid, WebM VP8).

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { dbOperations } from '../database.js';
import { evictFromCache } from '../middleware/hot-cache.js';

// Formatos aceitos para conversão
export const CONVERTIBLE_VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];

// Codecs que o navegador toca dentro de MP4 (copiados sem perda)
const COPY_VIDEO_CODECS = ['h264', 'hevc', 'av1', 'vp9'];
const COPY_AUDIO_CODECS = ['aac', 'mp3'];

let uploadsDir = null;
let ffmpegAvailable = false;

const queue = [];
const pending = new Set(); // na fila ou em processamento
let running = false;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    // Guardar só o final do stderr (ffmpeg escreve muito)
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} saiu com código ${code}: ${stderr.trim().split('\n').pop()}`));
    });
  });
}

export async function initVideoProcessor(dir) {
  uploadsDir = dir;
  try {
    await run('ffmpeg', ['-version']);
    await run('ffprobe', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    console.warn('⚠️  ffmpeg/ffprobe não encontrados: vídeos serão salvos sem otimização');
  }
  return ffmpegAvailable;
}

export function isVideoProcessingEnabled() {
  return ffmpegAvailable;
}

export function isConvertibleVideo(fileName) {
  return CONVERTIBLE_VIDEO_EXTS.includes(extname(fileName).toLowerCase());
}

/**
 * Vídeo ainda na fila/processando (não deve ir para cache)
 */
export function isVideoProcessing(storedName) {
  return pending.has(storedName);
}

async function probeStreams(filePath) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json',
    filePath
  ]);
  return JSON.parse(out).streams || [];
}

/**
 * Lê as caixas de topo do MP4/MOV: já otimizado se 'moov' vem antes de 'mdat'
 */
async function hasMoovFirst(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const header = Buffer.alloc(16);
    let offset = 0;

    while (offset + 8 <= fileSize) {
      await fh.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);

      if (type === 'moov') return true;
      if (type === 'mdat') return false;

      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) return false; // caixa vai até o fim do arquivo
      if (boxSize < 8) return false;
      offset += boxSize;
    }
    return false;
  } finally {
    await fh.close();
  }
}

function buildFfmpegArgs(input, output, streams, format) {
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');

  if (!video) throw new Error('arquivo sem faixa de vídeo');

  // Só primeira faixa de vídeo e de áudio (legendas/anexos de MKV não cabem em MP4)
  const args = ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];

  if (COPY_VIDEO_CODECS.includes(video.codec_name)) {
    args.push('-c:v', 'copy');
    // Safari só reconhece HEVC em MP4 com a tag hvc1
    if (video.codec_name === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    // CRF 18 ≈ visualmente sem perda
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p');
  }

  if (audio) {
    if (COPY_AUDIO_CODECS.includes(audio.codec_name)) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
  }

  args.push('-movflags', '+faststart', '-f', format, output);
  return args;
}

async function processVideo(storedName) {
  const filePath = join(uploadsDir, storedName);
  const ext = extname(storedName).toLowerCase();
  // Mantém o container da extensão (a URL não muda): .mov continua MOV, o resto vira MP4
  const format = ext === '.mov' ? 'mov' : 'mp4';
  const tmpPath = join(uploadsDir, 'tmp', `${storedName}.processing${ext}`);
  const started = Date.now();

  try {
    const streams = await probeStreams(filePath);
    await run('ffmpeg', buildFfmpegArgs(filePath, tmpPath, streams, format));

    // Arquivo deletado enquanto processava
    if (!dbOperations.getFileByStoredName(storedName)) {
      await fs.unlink(tmpPath).catch(() => {});
      return;
    }

    await fs.rename(tmpPath, filePath);
    const { size } = await fs.stat(filePath);
    dbOperations.updateFileMedia(storedName, size, format === 'mov' ? 'video/quicktime' : 'video/mp4');
    evictFromCache(storedName);

    console.log(`🎬 Vídeo otimizado para streaming: ${storedName} (${(size / 1024 / 1024).toFixed(1)}MB em ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    console.error(`❌ Erro ao otimizar vídeo ${storedName}: ${error.message}`);
  }
}

async function drainQueue() {
  if (running) return;
  running = true;
  // Um por vez para não disputar CPU/disco com os downloads
  while (queue.length > 0) {
    const storedName = queue.shift();
    await processVideo(storedName);
    pending.delete(storedName);
  }
  running = false;
}

/**
 * Colocar vídeo na fila de otimização (processa em background)
 */
export function enqueueVideo(storedName) {
  if (!ffmpegAvailable || pending.has(storedName)) return false;
  pending.add(storedName);
  queue.push(storedName);
  drainQueue();
  return true;
}

/**
 * Otimizar vídeos antigos (MP4/MOV com o índice no fim do arquivo)
 */
export async function optimizeExistingVideos() {
  if (!ffmpegAvailable) return 0;

  let count = 0;
  for (const storedName of dbOperations.getVideoStoredNames()) {
    if (!['.mp4', '.m4v', '.mov'].includes(extname(storedName).toLowerCase())) continue;
    try {
      if (!(await hasMoovFirst(join(uploadsDir, storedName)))) {
        if (enqueueVideo(storedName)) count++;
      }
    } catch {
      // arquivo físico ausente/ilegível: ignorar
    }
  }

  if (count > 0) console.log(`🎬 ${count} vídeo(s) antigo(s) na fila para otimização`);
  return count;
}
