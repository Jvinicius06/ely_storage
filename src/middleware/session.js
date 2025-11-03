// Middleware de sessão e autenticação

// Middleware para verificar se usuário está autenticado
export function requireAuth(request, reply, done) {
  const userId = request.session.get('userId');
  if (!userId) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Você precisa estar autenticado para acessar este recurso.'
    });
  }
  done();
}

// Middleware para verificar se usuário é admin
export function requireAdmin(request, reply, done) {
  const userId = request.session.get('userId');
  const userRole = request.session.get('userRole');

  if (!userId) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Você precisa estar autenticado para acessar este recurso.'
    });
  }

  if (userRole !== 'admin') {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Você não tem permissão para acessar este recurso.'
    });
  }

  done();
}

// Middleware para verificar se usuário pode deletar arquivo
// Permite se: usuário é admin OU o arquivo pertence ao usuário
export function canDeleteFile(fileOwnerId) {
  return function (request, reply, done) {
    const userId = request.session.get('userId');

    if (!userId) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Você precisa estar autenticado para acessar este recurso.'
      });
    }

    const isAdmin = request.session.get('userRole') === 'admin';
    const isOwner = fileOwnerId === userId;

    if (!isAdmin && !isOwner) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Você não tem permissão para deletar este arquivo.'
      });
    }

    done();
  };
}
