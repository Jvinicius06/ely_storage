// Cache em memória para arquivos mais baixados (hot files)
// Ideal para cenário de poucos arquivos com muitos downloads

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configurações
const MAX_CACHE_SIZE_MB = 512; // 512MB de cache
const MAX_FILE_SIZE_MB = 50; // Apenas arquivos até 50MB
const CACHE_HITS_TO_STORE = 3; // Cachear após 3 downloads
const CLEANUP_INTERVAL = 10 * 60 * 1000; // Limpar a cada 10 minutos

// Estrutura do cache
const fileCache = new Map();
const downloadStats = new Map();

let totalCacheSize = 0;

/**
 * Adicionar arquivo ao cache
 */
async function addToCache(filePath, storedName) {
  try {
    const stats = await import('fs').then(fs => fs.promises.stat(filePath));
    const fileSizeMB = stats.size / 1024 / 1024;

    // Não cachear arquivos muito grandes
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      return false;
    }

    // Verificar se tem espaço
    if (totalCacheSize + stats.size > MAX_CACHE_SIZE_MB * 1024 * 1024) {
      // Liberar espaço: remover arquivo menos acessado
      evictLeastUsed();
    }

    // Ler arquivo para memória
    const buffer = await readFile(filePath);

    fileCache.set(storedName, {
      buffer,
      size: stats.size,
      mtime: stats.mtime,
      hits: 0,
      lastAccess: Date.now()
    });

    totalCacheSize += stats.size;

    console.log(`✅ Arquivo cacheado: ${storedName} (${fileSizeMB.toFixed(2)}MB)`);
    return true;
  } catch (error) {
    console.error(`Erro ao cachear arquivo ${storedName}:`, error.message);
    return false;
  }
}

/**
 * Remover arquivo menos usado do cache
 */
function evictLeastUsed() {
  let leastUsed = null;
  let minHits = Infinity;

  for (const [key, value] of fileCache.entries()) {
    if (value.hits < minHits) {
      minHits = value.hits;
      leastUsed = key;
    }
  }

  if (leastUsed) {
    const cached = fileCache.get(leastUsed);
    totalCacheSize -= cached.size;
    fileCache.delete(leastUsed);
    console.log(`🗑️  Removido do cache: ${leastUsed} (${minHits} hits)`);
  }
}

/**
 * Obter arquivo do cache
 */
function getFromCache(storedName) {
  const cached = fileCache.get(storedName);

  if (cached) {
    cached.hits++;
    cached.lastAccess = Date.now();
    return cached.buffer;
  }

  return null;
}

/**
 * Registrar download (para estatísticas)
 */
function recordDownload(storedName, filePath) {
  let stats = downloadStats.get(storedName);

  if (!stats) {
    stats = {
      downloads: 0,
      filePath
    };
    downloadStats.set(storedName, stats);
  }

  stats.downloads++;

  // Se atingiu threshold e não está cacheado, cachear
  if (stats.downloads >= CACHE_HITS_TO_STORE && !fileCache.has(storedName)) {
    addToCache(filePath, storedName);
  }
}

/**
 * Middleware para servir arquivos do cache
 */
export function hotCacheMiddleware(request, reply, done) {
  // Extrair nome do arquivo da URL
  const urlPath = request.url.replace('/download/', '');
  const storedName = urlPath.split('?')[0]; // Remover query params

  // Tentar obter do cache
  const cached = getFromCache(storedName);

  if (cached) {
    // Servir do cache (super rápido!)
    reply
      .type('application/octet-stream')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Cache', 'HIT')
      .send(cached);

    return; // Não chamar done() - reply já foi enviado
  }

  // Não está no cache, registrar e continuar com fastify-static
  const filePath = join(__dirname, '..', '..', 'config', 'uploads', storedName);
  recordDownload(storedName, filePath);

  // Adicionar header para indicar miss
  reply.header('X-Cache', 'MISS');

  done();
}

/**
 * Limpeza periódica
 */
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutos sem acesso

  for (const [key, value] of fileCache.entries()) {
    if (now - value.lastAccess > maxAge && value.hits < 10) {
      totalCacheSize -= value.size;
      fileCache.delete(key);
      console.log(`🧹 Cache expirado: ${key}`);
    }
  }
}, CLEANUP_INTERVAL);

/**
 * Estatísticas do cache
 */
export function getCacheStats() {
  const cachedFiles = Array.from(fileCache.entries()).map(([name, data]) => ({
    name,
    size: data.size,
    hits: data.hits,
    lastAccess: new Date(data.lastAccess)
  })).sort((a, b) => b.hits - a.hits);

  const topDownloads = Array.from(downloadStats.entries())
    .map(([name, data]) => ({
      name,
      downloads: data.downloads
    }))
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 20);

  return {
    totalCached: fileCache.size,
    totalSizeMB: (totalCacheSize / 1024 / 1024).toFixed(2),
    maxSizeMB: MAX_CACHE_SIZE_MB,
    utilizationPercent: ((totalCacheSize / (MAX_CACHE_SIZE_MB * 1024 * 1024)) * 100).toFixed(1),
    cachedFiles,
    topDownloads
  };
}

// Log ao iniciar
console.log(`🔥 Hot Cache ativado: ${MAX_CACHE_SIZE_MB}MB para arquivos populares`);
