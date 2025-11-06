# Stage 1: Build
FROM node:18-alpine AS builder

# Instalar dependências de build
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libsodium-dev

WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar todas as dependências (incluindo dev para rebuild)
RUN npm ci

# Rebuild módulos nativos
RUN npm rebuild bcrypt --build-from-source
RUN npm rebuild sodium-native --build-from-source

# Stage 2: Runtime
FROM node:18-alpine

# Instalar apenas runtime dependencies
RUN apk add --no-cache libsodium

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
