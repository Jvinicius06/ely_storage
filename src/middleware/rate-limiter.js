// Rate limiter em memória (leve e eficiente)
// Para downloads de arquivos estáticos

const rateLimitMap = new Map();

// Configurações
const WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS = 60; // 60 requests por minuto por IP
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Limpar a cada 5 minutos

// Limpeza automática periódica para liberar memória
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitMap.entries()) {
    if (now - value.resetTime > WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

/**
 * Middleware de rate limiting
 */
export function rateLimiter(request, reply, done) {
  const ip = request.ip || request.socket.remoteAddress;
  const now = Date.now();

  let record = rateLimitMap.get(ip);

  if (!record) {
    // Primeiro acesso
    record = {
      count: 1,
      resetTime: now
    };
    rateLimitMap.set(ip, record);
    done();
    return;
  }

  // Verificar se a janela expirou
  if (now - record.resetTime > WINDOW_MS) {
    // Resetar contador
    record.count = 1;
    record.resetTime = now;
    rateLimitMap.set(ip, record);
    done();
    return;
  }

  // Incrementar contador
  record.count++;

  if (record.count > MAX_REQUESTS) {
    // Rate limit excedido
    const retryAfter = Math.ceil((WINDOW_MS - (now - record.resetTime)) / 1000);

    reply.code(429).send({
      error: 'Too Many Requests',
      message: `Muitos downloads. Tente novamente em ${retryAfter} segundos.`,
      retryAfter
    });
    return;
  }

  done();
}

/**
 * Rate limiter mais rigoroso para upload
 */
export function uploadRateLimiter(request, reply, done) {
  const ip = request.ip || request.socket.remoteAddress;
  const key = `upload:${ip}`;
  const now = Date.now();
  const UPLOAD_WINDOW = 60 * 1000; // 1 minuto
  const MAX_UPLOADS = 10; // 10 uploads por minuto

  let record = rateLimitMap.get(key);

  if (!record) {
    record = {
      count: 1,
      resetTime: now
    };
    rateLimitMap.set(key, record);
    done();
    return;
  }

  if (now - record.resetTime > UPLOAD_WINDOW) {
    record.count = 1;
    record.resetTime = now;
    rateLimitMap.set(key, record);
    done();
    return;
  }

  record.count++;

  if (record.count > MAX_UPLOADS) {
    const retryAfter = Math.ceil((UPLOAD_WINDOW - (now - record.resetTime)) / 1000);

    reply.code(429).send({
      error: 'Too Many Requests',
      message: `Muitos uploads. Tente novamente em ${retryAfter} segundos.`,
      retryAfter
    });
    return;
  }

  done();
}

// Exportar stats para monitoramento
export function getRateLimitStats() {
  return {
    activeIPs: rateLimitMap.size,
    memoryUsage: rateLimitMap.size * 64 // Estimativa em bytes
  };
}
