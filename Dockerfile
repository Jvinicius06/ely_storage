# Use Node.js 18 Alpine para imagem menor
FROM node:18-alpine

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json e package-lock.json
COPY package*.json ./

# Instalar dependências
RUN npm ci --only=production

# Copiar código da aplicação
COPY . .

# Criar pasta config se não existir
RUN mkdir -p /app/config/uploads

# Expor a porta
EXPOSE 3000

# Variável de ambiente padrão
ENV NODE_ENV=production

# Comando para iniciar a aplicação
CMD ["npm", "start"]
