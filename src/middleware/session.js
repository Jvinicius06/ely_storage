// Middleware de sessão e autenticação

// Middleware para verificar se usuário está autenticado
export function requireAuth(request, reply, done) {
  if (!request.session || !request.session.userId) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Você precisa estar autenticado para acessar este recurso.'
    });
  }
  done();
}

// Middleware para verificar se usuário é admin
export function requireAdmin(request, reply, done) {
  if (!request.session || !request.session.userId) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Você precisa estar autenticado para acessar este recurso.'
    });
  }

  if (request.session.userRole !== 'admin') {
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
    if (!request.session || !request.session.userId) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Você precisa estar autenticado para acessar este recurso.'
      });
    }

    const isAdmin = request.session.userRole === 'admin';
    const isOwner = fileOwnerId === request.session.userId;

    if (!isAdmin && !isOwner) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Você não tem permissão para deletar este arquivo.'
      });
    }

    done();
  };
}
