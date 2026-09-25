import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import fastifySession from '@fastify/session';
import fastifyCookie from '@fastify/cookie';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { randomBytes } from 'crypto';
import { dbOperations } from './database.js';
import { authMiddleware } from './middleware/auth.js';
import { requireAuth, requireAdmin } from './middleware/session.js';
import { rateLimiter } from './middleware/rate-limiter.js';
import { isVideo, serveVideoFromCache, evictFromCache, getCacheStats, HOT_CACHE_LIMIT_MB } from './middleware/hot-cache.js';
import { sendDiscordNotification } from './services/discord.js';
import { initVideoProcessor, isVideoProcessingEnabled, isConvertibleVideo, isVideoProcessing, enqueueVideo, optimizeExistingVideos } from './services/video-processor.js';
// Migração Discord removida (não utilizada) para economizar memória
// import { migrateChannel } from './services/discord-migrator.js';

// Configuração de paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carregar variáveis de ambiente
dotenv.config();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '1000');
const ENABLE_HOT_CACHE = process.env.ENABLE_HOT_CACHE === 'true'; // Cache para arquivos populares

// Criar instância do Fastify com logging otimizado
const isProduction = process.env.NODE_ENV === 'production';

const fastify = Fastify({
  logger: isProduction
    ? {
        // Produção: apenas erros e warnings
        level: 'warn',
        serializers: {
          req: (req) => ({
            method: req.method,
            url: req.url,
            // Não logar headers ou body para economizar memória
          }),
          res: (res) => ({
            statusCode: res.statusCode
          })
        }
      }
    : {
        // Desenvolvimento: logs completos
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname'
          }
        }
      },
  bodyLimit: MAX_FILE_SIZE_MB * 1024 * 1024,
  disableRequestLogging: isProduction, // Desabilitar em produção
  requestIdLogLabel: 'reqId',
  trustProxy: true, // Se atrás de proxy/load balancer
  // Otimizações adicionais
  routerOptions: {
    ignoreTrailingSlash: true,
    caseSensitive: false
  }
});

// Registrar plugins
await fastify.register(fastifyCors, {
  origin: true,
  credentials: true
});

await fastify.register(fastifyCookie);

// Configurar sessão com @fastify/session (armazena na memória por padrão)
await fastify.register(fastifySession, {
  secret: SESSION_SECRET,
  cookie: {
    path: '/',
    httpOnly: true,
    secure: false, // Desabilitar HTTPS em desenvolvimento
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7 * 1000 // 7 dias em milissegundos
  },
  cookieName: 'sessionId',
  saveUninitialized: false
});

await fastify.register(fastifyMultipart, {
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: 1
  },
  attachFieldsToBody: false
});

// Servir arquivos estáticos (UI)
await fastify.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/'
});


// Gerar nome único para arquivo
function generateUniqueFileName(originalName, forcedExtension) {
  const timestamp = Date.now();
  const random = randomBytes(8).toString('hex');
  const extension = forcedExtension || originalName.split('.').pop();
  return `${timestamp}-${random}.${extension}`;
}

// Vídeos convertíveis viram .mp4 já no nome (a URL não muda depois da otimização)
function prepareStoredFile(originalName, mimeType) {
  if (isVideoProcessingEnabled() && isConvertibleVideo(originalName)) {
    return { storedName: generateUniqueFileName(originalName, 'mp4'), fileType: 'video', optimizeVideo: true };
  }
  return { storedName: generateUniqueFileName(originalName), fileType: getFileType(mimeType), optimizeVideo: false };
}

// Determinar tipo de arquivo
function getFileType(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}

// ==================== ROTAS ====================

// Rota de download com rastreamento explícito.
// Substituímos o @fastify/static com prefix /download/ por uma rota explícita
// porque em Fastify 5 + @fastify/static v8, hooks globais (onRequest/addHook)
// não propagam de forma confiável para rotas de plugins estáticos registrados
// com await fastify.register(). Uma rota direta (fastify.get) sempre herda
// todos os hooks e middlewares do contexto raiz sem ambiguidade.
const UPLOADS_DIR = join(__dirname, '..', 'config', 'uploads');

fastify.get('/download/:filename', {
  preHandler: rateLimiter
}, async (request, reply) => {
  // basename() previne path traversal (e.g. ../../etc/passwd)
  const filename = basename(request.params.filename);
  const range = request.headers.range;

  // Rastrear download de forma síncrona (better-sqlite3 é síncrono).
  // Vídeo chega em vários pedaços (206): contar só o primeiro (sem Range ou começando em 0)
  let fileRecord = null;
  try {
    fileRecord = dbOperations.getFileByStoredName(filename);
    if (fileRecord && (!range || range.startsWith('bytes=0-'))) {
      dbOperations.recordDownload(fileRecord.id);
    }
  } catch (e) {
    fastify.log.warn(`Erro ao rastrear download de "${filename}": ${e.message}`);
  }

  reply.header('Access-Control-Allow-Origin', '*');

  // Vídeo ainda sendo otimizado: o conteúdo vai mudar, então não cachear em lugar nenhum
  if (isVideoProcessing(filename)) {
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile(filename, UPLOADS_DIR, { cacheControl: false });
  }

  // Arquivo excluído (ou inexistente): 404 sem cache, para não ficar guardado na Cloudflare/navegador
  if (!fileRecord) {
    try {
      await fs.stat(join(UPLOADS_DIR, filename));
    } catch {
      reply.header('Cache-Control', 'no-store');
      return reply.code(404).send({ error: 'Not Found', message: 'Arquivo não encontrado.' });
    }
  }

  reply.header('Cache-Control', 'public, max-age=31536000, immutable');

  // Vídeos: servir da RAM (Range/206 via slice do buffer compartilhado).
  // Só vídeos registrados no banco: arquivo excluído não pode voltar para o cache
  if (ENABLE_HOT_CACHE && fileRecord && isVideo(filename, fileRecord.mime_type)) {
    if (serveVideoFromCache(request, reply, filename, join(UPLOADS_DIR, filename), fileRecord.mime_type)) {
      return reply;
    }
  }

  // Demais arquivos (ou vídeo ainda carregando): sendFile do @fastify/static (suporta Range, ETag, etc.)
  return reply.sendFile(filename, UPLOADS_DIR, { cacheControl: false });
});

// Rota de health check
fastify.get('/api/health', async (request, reply) => {
  const stats = dbOperations.getStats();
  const cacheStats = ENABLE_HOT_CACHE ? getCacheStats() : null;

  return {
    status: 'ok',
    uptime: process.uptime(),
    stats,
    cache: cacheStats
  };
});

// ==================== AUTENTICAÇÃO ====================

// Login
fastify.post('/api/auth/login', async (request, reply) => {
  try {
    const { username, password } = request.body;

    if (!username || !password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Username e password são obrigatórios.'
      });
    }

    const user = dbOperations.getUserByUsername(username);

    if (!user) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Credenciais inválidas.'
      });
    }

    const isValidPassword = dbOperations.verifyPassword(password, user.password_hash);

    if (!isValidPassword) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Credenciais inválidas.'
      });
    }

    // Criar sessão (secure-session usa set())
    request.session.userId = user.id;
    request.session.username = user.username;
    request.session.userRole = user.role;

    return {
      success: true,
      message: 'Login realizado com sucesso!',
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao fazer login.'
    });
  }
});

// Logout
fastify.post('/api/auth/logout', async (request, reply) => {
  request.session.destroy();
  return {
    success: true,
    message: 'Logout realizado com sucesso!'
  };
});

// Obter usuário atual
fastify.get('/api/auth/me', {
  preHandler: requireAuth
}, async (request, reply) => {
  try {
    const user = dbOperations.getUserById(request.session.userId);

    if (!user) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Usuário não encontrado.'
      });
    }

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar usuário.'
    });
  }
});

// Trocar senha do usuário logado
fastify.post('/api/auth/change-password', {
  preHandler: requireAuth
}, async (request, reply) => {
  try {
    const { currentPassword, newPassword } = request.body;

    if (!currentPassword || !newPassword) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Senha atual e nova senha são obrigatórias.'
      });
    }

    if (newPassword.length < 6) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'A nova senha deve ter pelo menos 6 caracteres.'
      });
    }

    // Buscar usuário com senha hash
    const user = dbOperations.getUserByUsername(request.session.username);

    if (!user) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Usuário não encontrado.'
      });
    }

    // Verificar senha atual
    const isValidPassword = dbOperations.verifyPassword(currentPassword, user.password_hash);

    if (!isValidPassword) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Senha atual incorreta.'
      });
    }

    // Atualizar senha
    dbOperations.updateUserPassword(request.session.userId, newPassword);

    return {
      success: true,
      message: 'Senha alterada com sucesso!'
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao trocar senha.'
    });
  }
});

// ==================== GERENCIAMENTO DE USUÁRIOS ====================

// Criar usuário (apenas admin)
fastify.post('/api/users', {
  preHandler: requireAdmin
}, async (request, reply) => {
  try {
    const { username, password, role } = request.body;

    if (!username || !password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Username e password são obrigatórios.'
      });
    }

    // Verificar se usuário já existe
    const existingUser = dbOperations.getUserByUsername(username);
    if (existingUser) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Usuário já existe.'
      });
    }

    const userId = dbOperations.createUser(username, password, role || 'user');

    return reply.code(201).send({
      success: true,
      message: 'Usuário criado com sucesso!',
      user: {
        id: userId,
        username,
        role: role || 'user'
      }
    });
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao criar usuário.'
    });
  }
});

// Listar usuários (apenas admin)
fastify.get('/api/users', {
  preHandler: requireAdmin
}, async (request, reply) => {
  try {
    const users = dbOperations.getAllUsers();
    return {
      success: true,
      count: users.length,
      users
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar usuários.'
    });
  }
});

// Deletar usuário (apenas admin)
fastify.delete('/api/users/:id', {
  preHandler: requireAdmin
}, async (request, reply) => {
  try {
    const { id } = request.params;

    // Não permitir deletar o próprio usuário
    if (parseInt(id) === request.session.userId) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Você não pode deletar seu próprio usuário.'
      });
    }

    const user = dbOperations.getUserById(id);

    if (!user) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Usuário não encontrado.'
      });
    }

    dbOperations.deleteUser(id);

    return {
      success: true,
      message: 'Usuário deletado com sucesso!'
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao deletar usuário.'
    });
  }
});

// Resetar senha de usuário (apenas admin)
fastify.patch('/api/users/:id/reset-password', {
  preHandler: requireAdmin
}, async (request, reply) => {
  try {
    const { id } = request.params;
    const { newPassword } = request.body;

    if (!newPassword) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Nova senha é obrigatória.'
      });
    }

    if (newPassword.length < 6) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'A nova senha deve ter pelo menos 6 caracteres.'
      });
    }

    const user = dbOperations.getUserById(id);

    if (!user) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Usuário não encontrado.'
      });
    }

    // Atualizar senha
    dbOperations.updateUserPassword(id, newPassword);

    return {
      success: true,
      message: `Senha do usuário ${user.username} foi resetada com sucesso!`
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao resetar senha.'
    });
  }
});

// Autenticação de upload: API Key (integrações externas) ou sessão de usuário
async function uploadAuth(request, reply) {
  const apiKey = request.headers['x-api-key'] || request.query.apiKey;
  if (apiKey === API_KEY) {
    return; // API Key válida, continuar
  }
  return requireAuth(request, reply, () => {});
}

// ==================== UPLOAD EM CHUNKS ====================
// Proxies como o Cloudflare (free/pro) cortam requests com corpo > 100MB.
// Arquivos grandes são enviados em partes menores e remontados aqui.

const TMP_UPLOADS_DIR = join(__dirname, '..', 'config', 'uploads', 'tmp');
await fs.mkdir(TMP_UPLOADS_DIR, { recursive: true });

const chunkedUploads = new Map(); // uploadId -> { receivedChunks, lastActivity }

// Remover uploads em chunks abandonados (6h sem atividade)
setInterval(async () => {
  const now = Date.now();
  for (const [id, info] of chunkedUploads.entries()) {
    if (now - info.lastActivity > 6 * 60 * 60 * 1000) {
      chunkedUploads.delete(id);
      try { await fs.unlink(join(TMP_UPLOADS_DIR, `${id}.part`)); } catch {}
    }
  }
}, 30 * 60 * 1000);

// Receber um chunk de um arquivo grande
fastify.post('/api/upload/chunk', {
  preHandler: [uploadAuth]
}, async (request, reply) => {
  try {
    const data = await request.file();

    if (!data) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Nenhum chunk fornecido.'
      });
    }

    const uploadId = data.fields?.uploadId?.value || '';
    const chunkIndex = parseInt(data.fields?.chunkIndex?.value, 10);
    const totalChunks = parseInt(data.fields?.totalChunks?.value, 10);

    if (!/^[a-f0-9]{32}$/.test(uploadId) || !Number.isInteger(chunkIndex) ||
        !Number.isInteger(totalChunks) || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Parâmetros do chunk inválidos.'
      });
    }

    const partPath = join(TMP_UPLOADS_DIR, `${uploadId}.part`);
    let info = chunkedUploads.get(uploadId);

    if (chunkIndex === 0) {
      info = { receivedChunks: 0, lastActivity: Date.now() };
      chunkedUploads.set(uploadId, info);
    } else if (!info || info.receivedChunks !== chunkIndex) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Chunk fora de ordem. Reinicie o upload.'
      });
    }

    const writeStream = createWriteStream(partPath, { flags: chunkIndex === 0 ? 'w' : 'a' });
    await pipeline(data.file, writeStream);

    info.receivedChunks = chunkIndex + 1;
    info.lastActivity = Date.now();

    // O limite por request vale para cada chunk; validar também o total montado
    const { size } = await fs.stat(partPath);
    if (size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      chunkedUploads.delete(uploadId);
      await fs.unlink(partPath).catch(() => {});
      return reply.code(413).send({
        error: 'Payload Too Large',
        message: `Arquivo excede o limite de ${MAX_FILE_SIZE_MB}MB.`
      });
    }

    return { success: true, received: info.receivedChunks, totalChunks };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao receber chunk.',
      details: error.message
    });
  }
});

// Finalizar upload em chunks: move o arquivo montado e registra no banco
fastify.post('/api/upload/complete', {
  preHandler: [uploadAuth]
}, async (request, reply) => {
  try {
    const { uploadId, fileName, mimeType, totalChunks, tags, description } = request.body || {};

    if (!/^[a-f0-9]{32}$/.test(uploadId || '') || !fileName) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Parâmetros inválidos.'
      });
    }

    const info = chunkedUploads.get(uploadId);
    const partPath = join(TMP_UPLOADS_DIR, `${uploadId}.part`);

    if (!info || info.receivedChunks !== parseInt(totalChunks, 10)) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Upload incompleto. Reinicie o envio.'
      });
    }

    chunkedUploads.delete(uploadId);

    const originalName = basename(String(fileName));
    const finalMime = mimeType || 'application/octet-stream';
    const { storedName, fileType, optimizeVideo } = prepareStoredFile(originalName, finalMime);
    const uploadPath = join(__dirname, '..', 'config', 'uploads', storedName);
    const uploadedBy = request.session.userId || null;

    await fs.rename(partPath, uploadPath);

    const stats = await fs.stat(uploadPath);
    const fileSize = stats.size;
    const downloadUrl = `${BASE_URL}/download/${storedName}`;

    const fileId = dbOperations.insertFile({
      originalName,
      storedName,
      fileType,
      mimeType: finalMime,
      size: fileSize,
      downloadUrl,
      tags: tags || '',
      description: description || '',
      uploadedBy
    });

    // Reempacotar para streaming em background (não segura a resposta)
    if (optimizeVideo) enqueueVideo(storedName);

    await sendDiscordNotification(DISCORD_WEBHOOK_URL, {
      originalName,
      mimeType: finalMime,
      size: fileSize,
      downloadUrl
    });

    return reply.code(201).send({
      success: true,
      message: 'Arquivo enviado com sucesso!',
      file: {
        id: fileId,
        originalName,
        storedName,
        fileType,
        mimeType: finalMime,
        size: fileSize,
        downloadUrl,
        uploadedAt: new Date().toISOString(),
        processing: optimizeVideo
      }
    });
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao finalizar upload.',
      details: error.message
    });
  }
});

// Rota de upload (protegida por autenticação de usuário ou API Key)
fastify.post('/api/upload', {
  preHandler: [uploadAuth]
}, async (request, reply) => {
  try {
    const data = await request.file();

    if (!data) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Nenhum arquivo fornecido.'
      });
    }

    const originalName = data.filename;
    const mimeType = data.mimetype;
    const { storedName, fileType, optimizeVideo } = prepareStoredFile(originalName, mimeType);
    const uploadPath = join(__dirname, '..', 'config', 'uploads', storedName);

    // Extrair tags e description dos fields
    const tags = data.fields?.tags?.value || '';
    const description = data.fields?.description?.value || '';

    // Pegar ID do usuário logado (se houver)
    const uploadedBy = request.session.userId || null;

    // Log para debug
    fastify.log.info(`Recebendo arquivo: ${originalName}, MIME: ${mimeType}, Encoding: ${data.encoding}, Usuario: ${uploadedBy}`);

    // Salvar arquivo diretamente, sem transformações
    const writeStream = createWriteStream(uploadPath, {
      flags: 'w',
      encoding: 'binary'
    });

    await pipeline(data.file, writeStream);

    // Obter tamanho do arquivo
    const stats = await fs.stat(uploadPath);
    const fileSize = stats.size;

    // URL de download
    const downloadUrl = `${BASE_URL}/download/${storedName}`;

    // Salvar no banco de dados
    const fileId = dbOperations.insertFile({
      originalName,
      storedName,
      fileType,
      mimeType,
      size: fileSize,
      downloadUrl,
      tags,
      description,
      uploadedBy
    });

    // Reempacotar para streaming em background (não segura a resposta)
    if (optimizeVideo) enqueueVideo(storedName);

    // Enviar notificação para Discord
    await sendDiscordNotification(DISCORD_WEBHOOK_URL, {
      originalName,
      mimeType,
      size: fileSize,
      downloadUrl
    });

    return reply.code(201).send({
      success: true,
      message: 'Arquivo enviado com sucesso!',
      file: {
        id: fileId,
        originalName,
        storedName,
        fileType,
        mimeType,
        size: fileSize,
        downloadUrl,
        uploadedAt: new Date().toISOString(),
        processing: optimizeVideo
      }
    });
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao fazer upload do arquivo.',
      details: error.message
    });
  }
});

// Listar todos os arquivos (com paginação)
fastify.get('/api/files', async (request, reply) => {
  try {
    const limit = parseInt(request.query.limit) || 100;
    const offset = parseInt(request.query.offset) || 0;

    // Validar limites
    const validLimit = Math.min(Math.max(limit, 1), 500); // Máximo 500 por página
    const validOffset = Math.max(offset, 0);

    const files = dbOperations.getAllFiles(validLimit, validOffset);
    const total = dbOperations.countAllFiles();

    return {
      success: true,
      count: files.length,
      total,
      limit: validLimit,
      offset: validOffset,
      hasMore: (validOffset + validLimit) < total,
      files
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar arquivos.'
    });
  }
});

// Buscar arquivo por ID
fastify.get('/api/files/:id', async (request, reply) => {
  try {
    const { id } = request.params;
    const file = dbOperations.getFileById(id);

    if (!file) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Arquivo não encontrado.'
      });
    }

    return {
      success: true,
      file
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar arquivo.'
    });
  }
});

// Deletar arquivo (requer autenticação)
fastify.delete('/api/files/:id', {
  preHandler: requireAuth
}, async (request, reply) => {
  try {
    const { id } = request.params;
    const file = dbOperations.getFileById(id);

    if (!file) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Arquivo não encontrado.'
      });
    }

    // Verificar permissões: admin pode deletar qualquer arquivo, usuário comum só seus próprios
    const isAdmin = request.session.userRole === 'admin';
    const isOwner = file.uploaded_by === request.session.userId;

    if (!isAdmin && !isOwner) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Você não tem permissão para deletar este arquivo.'
      });
    }

    // Deletar arquivo físico
    const filePath = join(__dirname, '..', 'config', 'uploads', file.stored_name);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      fastify.log.warn(`Arquivo físico não encontrado: ${filePath}`);
    }
    evictFromCache(file.stored_name);

    // Deletar do banco de dados
    dbOperations.deleteFile(id);

    return {
      success: true,
      message: 'Arquivo deletado com sucesso!'
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao deletar arquivo.'
    });
  }
});

// Estatísticas
fastify.get('/api/stats', async (request, reply) => {
  try {
    const stats = dbOperations.getStats();
    return {
      success: true,
      stats
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar estatísticas.'
    });
  }
});

// Buscar/filtrar arquivos (com paginação)
fastify.get('/api/search', async (request, reply) => {
  try {
    const { fileType, tag, search, startDate, endDate, limit, offset } = request.query;

    const filters = {};
    if (fileType) filters.fileType = fileType;
    if (tag) filters.tag = tag;
    if (search) filters.search = search;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    // Paginação
    const parsedLimit = parseInt(limit) || 100;
    const parsedOffset = parseInt(offset) || 0;
    const validLimit = Math.min(Math.max(parsedLimit, 1), 500);
    const validOffset = Math.max(parsedOffset, 0);

    filters.limit = validLimit;
    filters.offset = validOffset;

    const files = dbOperations.searchFiles(filters);
    const total = dbOperations.countSearchFiles(filters); // Contar total sem limite

    return {
      success: true,
      count: files.length,
      total,
      limit: validLimit,
      offset: validOffset,
      hasMore: (validOffset + validLimit) < total,
      filters,
      files
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar arquivos.'
    });
  }
});

// Obter todas as tags
fastify.get('/api/tags', async (request, reply) => {
  try {
    const tags = dbOperations.getAllTags();
    return {
      success: true,
      count: tags.length,
      tags
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar tags.'
    });
  }
});

// Obter estatísticas por tag
fastify.get('/api/stats/tags', async (request, reply) => {
  try {
    const tagStats = dbOperations.getStatsByTag();
    return {
      success: true,
      tags: tagStats
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar estatísticas de tags.'
    });
  }
});

// Atualizar tags e descrição de um arquivo (requer autenticação)
fastify.patch('/api/files/:id/tags', {
  preHandler: requireAuth
}, async (request, reply) => {
  try {
    const { id } = request.params;
    const { tags, description } = request.body;

    const file = dbOperations.getFileById(id);
    if (!file) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Arquivo não encontrado.'
      });
    }

    // Verificar permissões: admin pode editar qualquer arquivo, usuário comum só seus próprios
    const isAdmin = request.session.userRole === 'admin';
    const isOwner = file.uploaded_by === request.session.userId;

    if (!isAdmin && !isOwner) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Você não tem permissão para editar este arquivo.'
      });
    }

    dbOperations.updateFileTags(id, tags, description);

    const updatedFile = dbOperations.getFileById(id);

    return {
      success: true,
      message: 'Tags atualizadas com sucesso!',
      file: updatedFile
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao atualizar tags.'
    });
  }
});

// Estatísticas de downloads por arquivo
fastify.get('/api/stats/downloads', {
  preHandler: requireAuth
}, async (request, reply) => {
  try {
    const days = parseInt(request.query.days) || 30;
    const validDays = Math.min(Math.max(days, 1), 365);
    const files = dbOperations.getDownloadStats(validDays);
    const totalDownloads = files.reduce((sum, f) => sum + f.download_count, 0);
    const unusedCount = files.filter(f => f.download_count === 0).length;
    return {
      success: true,
      days: validDays,
      totalFiles: files.length,
      totalDownloads,
      unusedCount,
      files
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro ao buscar estatísticas de downloads.'
    });
  }
});

// ==================== MIGRAÇÃO DO DISCORD ====================
// REMOVIDO: Código de migração Discord não utilizado
// Economiza ~2-3GB de RAM ao não carregar o módulo discord-migrator.js
// Se precisar reativar, descomente o import acima e esta rota

// ==================== OTIMIZAÇÃO DE MEMÓRIA ====================

// Forçar garbage collection periodicamente (se disponível)
if (global.gc) {
  setInterval(() => {
    global.gc();
    fastify.log.debug('Garbage collection manual executado');
  }, 30 * 60 * 1000); // A cada 30 minutos
} else {
  console.warn('⚠️  Garbage collection manual não disponível. Execute com: node --expose-gc src/server.js');
}

// Otimizar banco de dados periodicamente
setInterval(() => {
  try {
    dbOperations.checkpoint(); // Liberar memória do WAL
    fastify.log.debug('Database checkpoint executado');
  } catch (error) {
    fastify.log.warn('Erro ao executar checkpoint:', error.message);
  }
}, 60 * 60 * 1000); // A cada 1 hora

// VACUUM completo uma vez por dia (horário de menor uso)
setInterval(() => {
  try {
    const hour = new Date().getHours();
    // Executar apenas entre 3h e 5h da manhã
    if (hour >= 3 && hour < 5) {
      fastify.log.info('Executando VACUUM do banco de dados...');
      dbOperations.vacuum();
      fastify.log.info('VACUUM concluído com sucesso');
    }
  } catch (error) {
    fastify.log.warn('Erro ao executar VACUUM:', error.message);
  }
}, 60 * 60 * 1000); // Verificar a cada 1 hora

// Monitorar uso de memória
setInterval(() => {
  const usage = process.memoryUsage();
  const usedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const totalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rss = Math.round(usage.rss / 1024 / 1024);

  if (usedMB > 1024) { // Alerta se usar mais de 1GB
    fastify.log.warn(`⚠️  Alto uso de memória: ${usedMB}MB / ${totalMB}MB (RSS: ${rss}MB)`);
  } else {
    fastify.log.debug(`Memória: ${usedMB}MB / ${totalMB}MB (RSS: ${rss}MB)`);
  }
}, 10 * 60 * 1000); // A cada 10 minutos

// ==================== INICIAR SERVIDOR ====================

const start = async () => {
  try {
    const videoProcessing = await initVideoProcessor(UPLOADS_DIR);
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log('\n================================================');
    console.log('🚀 Ely Storage Server iniciado com sucesso!');
    console.log('================================================');
    console.log(`📍 Servidor: ${BASE_URL}`);
    console.log(`🔑 API Key configurada: ${API_KEY ? 'Sim' : 'Não'}`);
    console.log(`💬 Discord Webhook: ${DISCORD_WEBHOOK_URL ? 'Configurado' : 'Não configurado'}`);
    console.log(`📦 Tamanho máximo: ${MAX_FILE_SIZE_MB}MB`);
    console.log(`🔥 Hot Cache: ${ENABLE_HOT_CACHE ? `✅ Ativado - vídeos (${HOT_CACHE_LIMIT_MB}MB)` : '❌ Desativado'}`);
    console.log(`🎬 Otimização de vídeos (ffmpeg): ${videoProcessing ? '✅ Ativada' : '❌ ffmpeg não encontrado'}`);
    console.log(`🌍 Ambiente: ${isProduction ? 'Produção' : 'Desenvolvimento'}`);
    console.log('================================================\n');
    console.log('📖 Endpoints disponíveis:');
    console.log(`   GET  ${BASE_URL}/              - Interface Web`);
    console.log(`   POST ${BASE_URL}/api/upload    - Upload de arquivos`);
    console.log(`   GET  ${BASE_URL}/api/files     - Listar arquivos`);
    console.log(`   GET  ${BASE_URL}/api/files/:id - Detalhes do arquivo`);
    console.log(`   DEL  ${BASE_URL}/api/files/:id - Deletar arquivo`);
    console.log(`   GET  ${BASE_URL}/download/:name - Download/visualização`);
    console.log('================================================\n');

    // Vídeos enviados antes da otimização existir (índice no fim do arquivo)
    optimizeExistingVideos().catch(err => fastify.log.error(err));
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
