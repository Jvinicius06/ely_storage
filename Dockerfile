# Stage 1: Build (com dependências nativas para bcrypt e better-sqlite3)
FROM node:18-bullseye-slim AS builder

# Instalar dependências de build necessárias para bcrypt e better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar todas as dependências
RUN npm ci --build-from-source

# Stage 2: Runtime (imagem final otimizada)
FROM node:18-bullseye-slim

WORKDIR /app

# Copiar node_modules compilados do builder
COPY --from=builder /app/node_modules ./node_modules

# Copiar package.json
COPY package*.json ./

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
