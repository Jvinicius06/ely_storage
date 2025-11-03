import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import fastifySecureSession from '@fastify/secure-session';
import fastifyCookie from '@fastify/cookie';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { randomBytes } from 'crypto';
import { dbOperations } from './database.js';
import { authMiddleware } from './middleware/auth.js';
import { requireAuth, requireAdmin } from './middleware/session.js';
import { rateLimiter, uploadRateLimiter } from './middleware/rate-limiter.js';
import { sendDiscordNotification } from './services/discord.js';
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
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '100');

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
  // Otimizações adicionais
  ignoreTrailingSlash: true,
  trustProxy: true, // Se atrás de proxy/load balancer
  caseSensitive: false
});

// Registrar plugins
await fastify.register(fastifyCors, {
  origin: true,
  credentials: true
});

await fastify.register(fastifyCookie);

// Usar secure-session: armazena sessão no cookie (não na memória do servidor!)
// Isso economiza MUITA memória com milhares de usuários
const sessionKey = SESSION_SECRET.length >= 32
  ? Buffer.from(SESSION_SECRET.substring(0, 32))
  : Buffer.concat([Buffer.from(SESSION_SECRET), Buffer.alloc(32)]).slice(0, 32);

await fastify.register(fastifySecureSession, {
  key: sessionKey,
  cookie: {
    path: '/',
    httpOnly: true,
    secure: isProduction, // HTTPS em produção
    maxAge: 60 * 60 * 24 * 7 // 7 dias em segundos
  },
  // Não armazena nada na memória do servidor!
  cookieName: 'session'
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

// Servir arquivos de upload com otimizações de performance
await fastify.register(fastifyStatic, {
  root: join(__dirname, '..', 'config', 'uploads'),
  prefix: '/download/',
  decorateReply: false,
  // Enviar arquivos diretamente sem buffer (streaming)
  send: {
    maxAge: 86400000, // Cache de 24 horas no cliente (1 dia)
    cacheControl: true,
    dotfiles: 'deny', // Segurança: não servir arquivos ocultos
    etag: true, // ETag para validação de cache
    lastModified: true, // Last-Modified header
    immutable: true, // Arquivos são imutáveis (nomes únicos)
  },
  preCompressed: false, // Não buscar versões pré-comprimidas
  setHeaders: (res, path, stat) => {
    // Cache agressivo (arquivos são imutáveis devido a nomes únicos)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Permitir cross-origin (se necessário)
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Sugerir download ao invés de abrir no navegador (opcional)
    // res.setHeader('Content-Disposition', 'attachment');
  },
  // Rate limiting via hooks
  preHandler: rateLimiter
});

// Gerar nome único para arquivo
function generateUniqueFileName(originalName) {
  const timestamp = Date.now();
  const random = randomBytes(8).toString('hex');
  const extension = originalName.split('.').pop();
  return `${timestamp}-${random}.${extension}`;
}

// Determinar tipo de arquivo
function getFileType(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}

// ==================== ROTAS ====================

// Rota de health check
fastify.get('/api/health', async (request, reply) => {
  const stats = dbOperations.getStats();
  return {
    status: 'ok',
    uptime: process.uptime(),
    stats
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
    request.session.set('userId', user.id);
    request.session.set('username', user.username);
    request.session.set('userRole', user.role);

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
    const user = dbOperations.getUserById(request.session.get('userId'));

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
    const user = dbOperations.getUserByUsername(request.session.get('username'));

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
    dbOperations.updateUserPassword(request.session.get('userId'), newPassword);

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
    if (parseInt(id) === request.session.get('userId')) {
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

// Rota de upload (protegida por autenticação de usuário ou API Key)
fastify.post('/api/upload', {
  preHandler: [
    uploadRateLimiter,
    async function(request, reply) {
      // Verificar se tem API Key (para integração externa)
      const apiKey = request.headers['x-api-key'] || request.query.apiKey;
      if (apiKey === API_KEY) {
        return; // API Key válida, continuar
      }

      // Caso contrário, verificar autenticação de usuário
      return requireAuth(request, reply, () => {});
    }
  ]
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
    const storedName = generateUniqueFileName(originalName);
    const fileType = getFileType(mimeType);
    const uploadPath = join(__dirname, '..', 'config', 'uploads', storedName);

    // Extrair tags e description dos fields
    const tags = data.fields?.tags?.value || '';
    const description = data.fields?.description?.value || '';

    // Pegar ID do usuário logado (se houver)
    const uploadedBy = request.session.get('userId') || null;

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
        uploadedAt: new Date().toISOString()
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
    const isAdmin = request.session.get('userRole') === 'admin';
    const isOwner = file.uploaded_by === request.session.get('userId');

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

// Buscar/filtrar arquivos
fastify.get('/api/search', async (request, reply) => {
  try {
    const { fileType, tag, search, startDate, endDate } = request.query;

    const filters = {};
    if (fileType) filters.fileType = fileType;
    if (tag) filters.tag = tag;
    if (search) filters.search = search;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const files = dbOperations.searchFiles(filters);

    return {
      success: true,
      count: files.length,
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
    const isAdmin = request.session.get('userRole') === 'admin';
    const isOwner = file.uploaded_by === request.session.get('userId');

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
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log('\n================================================');
    console.log('🚀 Ely Storage Server iniciado com sucesso!');
    console.log('================================================');
    console.log(`📍 Servidor: ${BASE_URL}`);
    console.log(`🔑 API Key configurada: ${API_KEY ? 'Sim' : 'Não'}`);
    console.log(`💬 Discord Webhook: ${DISCORD_WEBHOOK_URL ? 'Configurado' : 'Não configurado'}`);
    console.log(`📦 Tamanho máximo: ${MAX_FILE_SIZE_MB}MB`);
    console.log('================================================\n');
    console.log('📖 Endpoints disponíveis:');
    console.log(`   GET  ${BASE_URL}/              - Interface Web`);
    console.log(`   POST ${BASE_URL}/api/upload    - Upload de arquivos`);
    console.log(`   GET  ${BASE_URL}/api/files     - Listar arquivos`);
    console.log(`   GET  ${BASE_URL}/api/files/:id - Detalhes do arquivo`);
    console.log(`   DEL  ${BASE_URL}/api/files/:id - Deletar arquivo`);
    console.log(`   GET  ${BASE_URL}/download/:name - Download/visualização`);
    console.log('================================================\n');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
