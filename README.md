# Ely Storage

Sistema de storage para upload de arquivos com integração Discord, desenvolvido para uso com FiveM.

## Características

- Upload de arquivos (imagens, vídeos e áudios)
- Interface web simples e intuitiva
- Drag & drop para upload
- Visualização de arquivos
- Links de download diretos
- Integração com Discord via Webhooks
- Autenticação por API Key
- Estatísticas de uso
- Sistema de storage local

## Tecnologias

- **Backend**: Node.js com Fastify
- **Banco de Dados**: SQLite
- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Upload**: Multipart Form Data
- **Notificações**: Discord Webhooks

## Instalação

### Pré-requisitos

- Node.js 18 ou superior
- npm ou yarn

### Passo a Passo

1. **Clone ou baixe o projeto**

```bash
cd ely_storage
```

2. **Instale as dependências**

```bash
npm install
```

3. **Configure as variáveis de ambiente**

Edite o arquivo `.env` com suas configurações:

```env
PORT=3000
BASE_URL=http://localhost:3000
API_KEY=sua-api-key-super-secreta-aqui
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/SEU_WEBHOOK_ID/SEU_WEBHOOK_TOKEN
MAX_FILE_SIZE_MB=100
```

**Importante**: Gere uma API Key segura para proteger seus uploads!

4. **Inicie o servidor**

```bash
npm start
```

Para desenvolvimento (com auto-reload):

```bash
npm run dev
```

O servidor estará disponível em `http://localhost:3000`

## Como Criar um Webhook no Discord

Para receber notificações de uploads no Discord, você precisa criar um webhook:

1. **Abra o Discord** e vá até o servidor desejado
2. **Clique com o botão direito** no canal onde deseja receber as notificações
3. Selecione **Editar Canal**
4. Vá para a aba **Integrações**
5. Clique em **Webhooks** > **Criar Webhook**
6. Configure o webhook:
   - Nome: `Ely Storage` (ou o nome que preferir)
   - Avatar: Opcional
7. **Copie a URL do Webhook**
8. Cole a URL no arquivo `.env` na variável `DISCORD_WEBHOOK_URL`

Exemplo de URL do webhook:
```
https://discord.com/api/webhooks/1234567890/AbCdEfGhIjKlMnOpQrStUvWxYz
```

## Uso

### Interface Web

1. Acesse `http://localhost:3000` no navegador
2. Insira sua API Key no campo indicado
3. Faça upload de arquivos:
   - Clique na área de upload e selecione arquivos
   - OU arraste e solte arquivos na área
4. Visualize, copie links e gerencie seus arquivos

### API REST

#### Upload de Arquivo

```bash
curl -X POST http://localhost:3000/api/upload \
  -H "x-api-key: sua-api-key" \
  -F "file=@/caminho/para/arquivo.jpg"
```

Resposta:
```json
{
  "success": true,
  "message": "Arquivo enviado com sucesso!",
  "file": {
    "id": 1,
    "originalName": "arquivo.jpg",
    "storedName": "1234567890-abc123.jpg",
    "fileType": "image",
    "mimeType": "image/jpeg",
    "size": 1024000,
    "downloadUrl": "http://localhost:3000/download/1234567890-abc123.jpg",
    "uploadedAt": "2025-10-27T12:00:00.000Z"
  }
}
```

#### Listar Arquivos

```bash
curl http://localhost:3000/api/files
```

#### Buscar Arquivo por ID

```bash
curl http://localhost:3000/api/files/1
```

#### Deletar Arquivo

```bash
curl -X DELETE http://localhost:3000/api/files/1 \
  -H "x-api-key: sua-api-key"
```

#### Estatísticas

```bash
curl http://localhost:3000/api/stats
```

### Integração com FiveM

Exemplo de código Lua para fazer upload de um arquivo do FiveM:

```lua
function UploadToStorage(filePath, apiKey)
    local file = LoadResourceFile(GetCurrentResourceName(), filePath)

    if not file then
        print("Arquivo não encontrado!")
        return
    end

    PerformHttpRequest("http://seu-servidor:3000/api/upload", function(statusCode, response, headers)
        if statusCode == 201 then
            local data = json.decode(response)
            print("Upload concluído! URL: " .. data.file.downloadUrl)

            -- Você pode usar o link retornado
            TriggerEvent('storage:uploadComplete', data.file.downloadUrl)
        else
            print("Erro no upload: " .. statusCode)
        end
    end, "POST", json.encode({
        file = file
    }), {
        ["x-api-key"] = apiKey,
        ["Content-Type"] = "application/json"
    })
end

-- Uso
UploadToStorage("files/minha-imagem.png", "sua-api-key")
```

## Estrutura do Projeto

```
ely_storage/
├── src/
│   ├── server.js           # Servidor principal
│   ├── database.js         # Configuração do SQLite
│   ├── middleware/
│   │   └── auth.js         # Autenticação por API Key
│   └── services/
│       └── discord.js      # Integração Discord
├── public/
│   ├── index.html          # Interface web
│   ├── styles.css          # Estilos
│   └── script.js           # JavaScript frontend
├── uploads/                # Arquivos enviados
├── .env                    # Configurações (não committar)
├── .env.example            # Exemplo de configurações
├── package.json            # Dependências
└── README.md              # Este arquivo
```

## Endpoints da API

| Método | Endpoint | Autenticação | Descrição |
|--------|----------|--------------|-----------|
| GET | `/` | Não | Interface web |
| GET | `/api/health` | Não | Status do servidor |
| POST | `/api/upload` | Sim | Upload de arquivo |
| GET | `/api/files` | Não | Listar todos os arquivos |
| GET | `/api/files/:id` | Não | Detalhes de um arquivo |
| DELETE | `/api/files/:id` | Sim | Deletar arquivo |
| GET | `/api/stats` | Não | Estatísticas do servidor |
| GET | `/download/:filename` | Não | Download/visualização de arquivo |

## Segurança

- Sempre use uma API Key forte e única
- Mantenha o arquivo `.env` seguro e não o compartilhe
- Configure HTTPS em produção
- Considere usar rate limiting
- Valide tipos de arquivo permitidos

## Deploy em Produção

### Usando PM2 (Recomendado)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar aplicação
pm2 start src/server.js --name ely-storage

# Configurar para iniciar automaticamente
pm2 startup
pm2 save
```

### Configurar Proxy Reverso (Nginx)

```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 100M;
    }
}
```

### SSL/HTTPS (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d seu-dominio.com
```

## Troubleshooting

### Erro ao fazer upload

- Verifique se a API Key está correta
- Confirme se o tamanho do arquivo não excede o limite configurado
- Certifique-se de que a pasta `uploads/` existe e tem permissões de escrita

### Discord não está recebendo notificações

- Verifique se a URL do webhook está correta no `.env`
- Teste o webhook manualmente usando uma ferramenta como Postman
- Confirme que o canal ainda existe e o webhook não foi deletado

### Porta já em uso

- Altere a porta no arquivo `.env`
- Ou encerre o processo que está usando a porta atual:
  ```bash
  # Linux/Mac
  lsof -ti:3000 | xargs kill -9

  # Windows
  netstat -ano | findstr :3000
  taskkill /PID <PID> /F
  ```

## Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para:

- Reportar bugs
- Sugerir novas funcionalidades
- Enviar pull requests

## Licença

MIT

## Suporte

Para dúvidas ou problemas, abra uma issue no repositório do projeto.

---

Desenvolvido para a comunidade FiveM 🎮
