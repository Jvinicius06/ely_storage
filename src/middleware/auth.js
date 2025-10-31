// Middleware de autenticação por API Key
export function authMiddleware(apiKey) {
  return async function (request, reply) {
    const providedKey = request.headers['x-api-key'] || request.query.apiKey;

    if (!providedKey) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'API Key não fornecida. Use o header "x-api-key" ou query param "apiKey".'
      });
    }

    if (providedKey !== apiKey) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'API Key inválida.'
      });
    }

    // Autenticação bem-sucedida, continua para o handler
  };
}
