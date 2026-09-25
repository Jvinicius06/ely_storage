// Cache em memória (RAM) apenas para vídeos.
// Imagens/áudio respondem 200 e a Cloudflare cacheia direto, então não precisam disso.
// Vídeos são pedidos em pedaços (206 / Range) por várias pessoas ao mesmo tempo:
// manter o arquivo inteiro em RAM e responder cada Range com um slice do buffer
// evita reabrir/ler o disco a cada pedaço.

// Imports ESM rodam antes do dotenv.config() do server.js; carregar o .env aqui
import 'dotenv/config';
import { readFile, stat } from 'fs/promises';
import { extname } from 'path';
import os from 'os';

const MB = 1024 * 1024;

// Memória disponível para o processo (respeita limite do container quando existir)
const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
const SYSTEM_MEMORY = constrained > 0 ? Math.min(constrained, os.totalmem()) : os.totalmem();

// Configurações (via .env)
const REQUESTED_MAX_BYTES = parseInt(process.env.HOT_CACHE_MAX_MB || '1024') * MB;
// Nunca usar mais que 50% da RAM, mesmo que o .env peça mais
const MAX_CACHE_BYTES = Math.min(REQUESTED_MAX_BYTES, Math.floor(SYSTEM_MEMORY * 0.5));
const MAX_FILE_BYTES = parseInt(process.env.HOT_CACHE_MAX_FILE_MB || '400') * MB;
const IDLE_TTL_MS = parseInt(process.env.HOT_CACHE_IDLE_MINUTES || '30') * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

export const HOT_CACHE_LIMIT_MB = Math.floor(MAX_CACHE_BYTES / MB);

const VIDEO_MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg'
};

// Map mantém ordem de inserção: primeiro item = menos usado recentemente (LRU)
const videoCache = new Map();
// Carregamentos em andamento (evita ler o mesmo arquivo várias vezes em paralelo)
const loading = new Map();

let totalCacheBytes = 0;
let reservedBytes = 0; // espaço reservado por carregamentos em andamento

/**
 * Verifica se o arquivo é vídeo (pelo MIME do banco ou pela extensão)
 */
export function isVideo(storedName, mimeType) {
  if (mimeType && mimeType.startsWith('video/')) return true;
  return extname(storedName).toLowerCase() in VIDEO_MIME_BY_EXT;
}

function removeEntry(storedName) {
  const entry = videoCache.get(storedName);
  if (!entry) return;
  totalCacheBytes -= entry.size;
  videoCache.delete(storedName);
}

/**
 * Remover vídeo do cache (ex.: arquivo deletado)
 */
export function evictFromCache(storedName) {
  removeEntry(storedName);
}

/**
 * Liberar espaço removendo os vídeos usados há mais tempo (LRU)
 */
function makeRoom(bytesNeeded) {
  for (const key of videoCache.keys()) {
    if (totalCacheBytes + reservedBytes + bytesNeeded <= MAX_CACHE_BYTES) break;
    removeEntry(key);
    console.log(`🗑️  Vídeo removido do cache (LRU): ${key}`);
  }
  return totalCacheBytes + reservedBytes + bytesNeeded <= MAX_CACHE_BYTES;
}

/**
 * Ler vídeo do disco para a RAM (em background)
 */
async function loadVideo(storedName, filePath, mimeType) {
  const st = await stat(filePath);

  if (st.size > MAX_FILE_BYTES || !makeRoom(st.size)) {
    return;
  }

  reservedBytes += st.size;
  let buffer;
  try {
    buffer = await readFile(filePath);
  } finally {
    reservedBytes -= st.size;
  }

  videoCache.set(storedName, {
    buffer,
    size: buffer.length,
    mimeType,
    // Mesmo formato de ETag do @fastify/static (send), para HIT e MISS serem consistentes
    etag: `W/"${buffer.length.toString(16)}-${st.mtime.getTime().toString(16)}"`,
    lastModified: st.mtime.toUTCString(),
    hits: 0,
    lastAccess: Date.now()
  });
  totalCacheBytes += buffer.length;

  console.log(`✅ Vídeo cacheado em RAM: ${storedName} (${(buffer.length / MB).toFixed(1)}MB) - total ${(totalCacheBytes / MB).toFixed(0)}/${HOT_CACHE_LIMIT_MB}MB`);
}

function startLoading(storedName, filePath, mimeType) {
  if (loading.has(storedName)) return;

  const contentType = mimeType?.startsWith('video/')
    ? mimeType
    : VIDEO_MIME_BY_EXT[extname(storedName).toLowerCase()] || 'application/octet-stream';

  const promise = loadVideo(storedName, filePath, contentType)
    .catch(error => console.error(`Erro ao cachear vídeo ${storedName}:`, error.message))
    .finally(() => loading.delete(storedName));

  loading.set(storedName, promise);
}

/**
 * Interpretar header Range (apenas um intervalo).
 * Retorna { start, end }, null (servir inteiro) ou -1 (fora do tamanho → 416)
 */
function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=')) return null;

  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null; // multi-range: servir arquivo inteiro

  const [startStr, endStr] = spec.split('-');
  let start;
  let end;

  if (startStr === '') {
    // bytes=-500 → últimos 500 bytes
    const suffix = parseInt(endStr, 10);
    if (isNaN(suffix) || suffix <= 0) return -1;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : size - 1;
    if (isNaN(start) || isNaN(end)) return null;
    end = Math.min(end, size - 1);
  }

  if (start >= size || start > end) return -1;
  return { start, end };
}

/**
 * Servir vídeo da RAM, com suporte a Range (206).
 * Retorna true se respondeu; false se não está em cache (nesse caso inicia o
 * carregamento em background e quem chamou deve servir do disco).
 */
export function serveVideoFromCache(request, reply, storedName, filePath, mimeType) {
  const entry = videoCache.get(storedName);

  if (!entry) {
    startLoading(storedName, filePath, mimeType);
    reply.header('X-Cache', 'MISS');
    return false;
  }

  // Mover para o fim do Map (mais recente no LRU)
  videoCache.delete(storedName);
  videoCache.set(storedName, entry);
  entry.hits++;
  entry.lastAccess = Date.now();

  reply
    .header('X-Cache', 'HIT')
    .header('Accept-Ranges', 'bytes')
    .header('ETag', entry.etag)
    .header('Last-Modified', entry.lastModified)
    .type(entry.mimeType);

  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    reply.code(304).send();
    return true;
  }

  let range = parseRange(request.headers.range, entry.size);

  // If-Range diferente da versão atual → ignorar Range e mandar inteiro
  const ifRange = request.headers['if-range'];
  if (range && ifRange && ifRange !== entry.etag && ifRange !== entry.lastModified) {
    range = null;
  }

  if (range === -1) {
    reply
      .code(416)
      .header('Content-Range', `bytes */${entry.size}`)
      .send();
    return true;
  }

  if (!range) {
    reply
      .code(200)
      .header('Content-Length', entry.size)
      .send(entry.buffer);
    return true;
  }

  // subarray não copia memória: todos os clientes compartilham o mesmo buffer
  reply
    .code(206)
    .header('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`)
    .header('Content-Length', range.end - range.start + 1)
    .send(entry.buffer.subarray(range.start, range.end + 1));
  return true;
}

/**
 * Limpeza periódica: remove vídeos sem acesso há IDLE_TTL_MS
 */
setInterval(() => {
  const now = Date.now();

  for (const [key, value] of videoCache.entries()) {
    if (now - value.lastAccess > IDLE_TTL_MS) {
      removeEntry(key);
      console.log(`🧹 Vídeo expirado do cache: ${key}`);
    }
  }
}, CLEANUP_INTERVAL).unref();

/**
 * Estatísticas do cache
 */
export function getCacheStats() {
  const cachedFiles = Array.from(videoCache.entries()).map(([name, data]) => ({
    name,
    size: data.size,
    hits: data.hits,
    lastAccess: new Date(data.lastAccess)
  })).sort((a, b) => b.hits - a.hits);

  return {
    totalCached: videoCache.size,
    loading: loading.size,
    totalSizeMB: (totalCacheBytes / MB).toFixed(2),
    maxSizeMB: HOT_CACHE_LIMIT_MB,
    maxFileSizeMB: Math.floor(MAX_FILE_BYTES / MB),
    utilizationPercent: ((totalCacheBytes / MAX_CACHE_BYTES) * 100).toFixed(1),
    cachedFiles
  };
}

// Log ao iniciar
console.log(`🔥 Hot Cache de vídeos: até ${HOT_CACHE_LIMIT_MB}MB em RAM (máx ${Math.floor(MAX_FILE_BYTES / MB)}MB por vídeo)`);
