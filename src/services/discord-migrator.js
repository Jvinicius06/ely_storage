import axios from 'axios';
import { randomBytes } from 'crypto';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dbOperations } from '../database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Regex para detectar URLs de arquivos do Discord
const DISCORD_CDN_REGEX = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[\w/-]+\.[\w]+/gi;

/**
 * Extrair informações do webhook
 */
export function parseWebhookUrl(webhookUrl) {
  const match = webhookUrl.match(/discord\.com\/api\/webhooks\/(\d+)\/([\w-]+)/);
  if (!match) {
    throw new Error('URL de webhook inválida');
  }
  return {
    webhookId: match[1],
    webhookToken: match[2]
  };
}

/**
 * Buscar mensagens de um canal ou thread usando bot token
 */
export async function fetchChannelMessages(botToken, channelId, threadId = null, limit = 100) {
  try {
    const messages = [];
    let lastMessageId = null;

    // Se threadId for fornecido, buscar mensagens da thread, senão do canal
    const targetId = threadId || channelId;

    while (true) {
      const url = `https://discord.com/api/v10/channels/${targetId}/messages`;
      const params = {
        limit: Math.min(limit, 100)
      };

      if (lastMessageId) {
        params.before = lastMessageId;
      }

      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        params
      });

      const batch = response.data;

      if (batch.length === 0) break;

      messages.push(...batch);
      lastMessageId = batch[batch.length - 1].id;

      // Se retornou menos que o limite, não há mais mensagens
      if (batch.length < 100) break;
    }

    return messages;
  } catch (error) {
    throw new Error(`Erro ao buscar mensagens: ${error.message}`);
  }
}

/**
 * Extrair URLs de arquivos de uma mensagem
 */
export function extractFileUrls(message) {
  const urls = new Set();

  // Attachments diretos
  if (message.attachments && message.attachments.length > 0) {
    message.attachments.forEach(att => {
      if (att.url) urls.add(att.url);
    });
  }

  // Embeds
  if (message.embeds && message.embeds.length > 0) {
    message.embeds.forEach(embed => {
      // Imagem do embed
      if (embed.image?.url) urls.add(embed.image.url);

      // Thumbnail
      if (embed.thumbnail?.url) urls.add(embed.thumbnail.url);

      // Vídeo
      if (embed.video?.url) urls.add(embed.video.url);

      // Procurar URLs em fields
      if (embed.fields) {
        embed.fields.forEach(field => {
          const matches = field.value.match(DISCORD_CDN_REGEX);
          if (matches) {
            matches.forEach(url => urls.add(url));
          }
        });
      }

      // Procurar URLs na descrição
      if (embed.description) {
        const matches = embed.description.match(DISCORD_CDN_REGEX);
        if (matches) {
          matches.forEach(url => urls.add(url));
        }
      }
    });
  }

  // Procurar URLs no conteúdo da mensagem
  if (message.content) {
    const matches = message.content.match(DISCORD_CDN_REGEX);
    if (matches) {
      matches.forEach(url => urls.add(url));
    }
  }

  return Array.from(urls);
}

/**
 * Baixar arquivo de uma URL
 */
export async function downloadFile(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000 // 30 segundos
    });

    // Extrair nome do arquivo da URL e remover query params
    const urlParts = url.split('/');
    let fileName = urlParts[urlParts.length - 1].split('?')[0];

    // Pegar MIME type do header
    const mimeType = response.headers['content-type'] || 'application/octet-stream';

    // Mapear MIME type para extensão correta
    const mimeToExt = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'application/pdf': 'pdf',
      'application/zip': 'zip'
    };

    // Determinar extensão correta
    let extension = mimeToExt[mimeType];

    // Se não temos um mapeamento, tentar extrair da URL
    if (!extension) {
      const urlExt = fileName.split('.').pop().toLowerCase();
      // Validar se a extensão parece válida (2-4 caracteres alfabéticos)
      if (urlExt && /^[a-z]{2,4}$/.test(urlExt)) {
        extension = urlExt;
      } else {
        extension = 'bin'; // fallback
      }
    }

    // Nome original para referência (sem a extensão estranha)
    const originalName = fileName.includes('.') ? fileName.split('.')[0] + '.' + extension : fileName + '.' + extension;

    return {
      stream: response.data,
      originalName,
      extension,
      mimeType,
      size: parseInt(response.headers['content-length'] || '0')
    };
  } catch (error) {
    throw new Error(`Erro ao baixar arquivo ${url}: ${error.message}`);
  }
}

/**
 * Fazer upload de arquivo para o storage
 */
export async function uploadToStorage(fileData, baseUrl, uploadedBy = null) {
  try {
    // Gerar nome único usando a extensão correta
    const timestamp = Date.now();
    const random = randomBytes(8).toString('hex');
    const extension = fileData.extension || fileData.originalName.split('.').pop();
    const storedName = `${timestamp}-${random}.${extension}`;

    // Caminho de upload
    const uploadPath = join(__dirname, '..', '..', 'config', 'uploads', storedName);

    // Salvar arquivo
    const writeStream = createWriteStream(uploadPath, {
      flags: 'w',
      encoding: 'binary'
    });

    await pipeline(fileData.stream, writeStream);

    // URL de download
    const downloadUrl = `${baseUrl}/download/${storedName}`;

    // Determinar tipo
    let fileType = 'other';
    if (fileData.mimeType.startsWith('image/')) fileType = 'image';
    else if (fileData.mimeType.startsWith('video/')) fileType = 'video';
    else if (fileData.mimeType.startsWith('audio/')) fileType = 'audio';

    // Salvar no banco
    const fileId = dbOperations.insertFile({
      originalName: fileData.originalName,
      storedName,
      fileType,
      mimeType: fileData.mimeType,
      size: fileData.size,
      downloadUrl,
      tags: 'discord-migration',
      description: 'Migrado automaticamente do Discord',
      uploadedBy
    });

    return {
      fileId,
      downloadUrl,
      storedName
    };
  } catch (error) {
    throw new Error(`Erro ao fazer upload: ${error.message}`);
  }
}

/**
 * Substituir URLs em uma mensagem
 */
export function replaceUrlsInMessage(message, urlMap) {
  let newContent = message.content || '';
  let newEmbeds = message.embeds ? JSON.parse(JSON.stringify(message.embeds)) : [];

  // Substituir no conteúdo
  urlMap.forEach((newUrl, oldUrl) => {
    newContent = newContent.replace(new RegExp(escapeRegex(oldUrl), 'g'), newUrl);
  });

  // Substituir nos embeds
  newEmbeds.forEach(embed => {
    // Image
    if (embed.image?.url && urlMap.has(embed.image.url)) {
      embed.image.url = urlMap.get(embed.image.url);
    }

    // Thumbnail
    if (embed.thumbnail?.url && urlMap.has(embed.thumbnail.url)) {
      embed.thumbnail.url = urlMap.get(embed.thumbnail.url);
    }

    // Video (manter com novo link)
    if (embed.video?.url && urlMap.has(embed.video.url)) {
      embed.video.url = urlMap.get(embed.video.url);
    }

    // Fields
    if (embed.fields) {
      embed.fields.forEach(field => {
        urlMap.forEach((newUrl, oldUrl) => {
          field.value = field.value.replace(new RegExp(escapeRegex(oldUrl), 'g'), newUrl);
        });
      });
    }

    // Description
    if (embed.description) {
      urlMap.forEach((newUrl, oldUrl) => {
        embed.description = embed.description.replace(new RegExp(escapeRegex(oldUrl), 'g'), newUrl);
      });
    }
  });

  return {
    content: newContent,
    embeds: newEmbeds
  };
}

/**
 * Postar mensagem usando webhook (em canal ou thread)
 */
export async function postWebhookMessage(webhookUrl, messageData, targetThreadId = null) {
  try {
    // Se targetThreadId for fornecido, adicionar à URL
    let finalUrl = webhookUrl;
    if (targetThreadId) {
      finalUrl = `${webhookUrl}?thread_id=${targetThreadId}`;
    }

    await axios.post(finalUrl, messageData, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return true;
  } catch (error) {
    throw new Error(`Erro ao postar mensagem: ${error.message}`);
  }
}

/**
 * Escape de regex
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Processar migração completa de um canal ou thread
 */
export async function migrateChannel(botToken, sourceChannelId, targetWebhookUrl, baseUrl, uploadedBy, onProgress, sourceThreadId = null, targetThreadId = null) {
  try {
    // Buscar mensagens do canal/thread de origem
    const sourceType = sourceThreadId ? 'thread' : 'canal';
    const targetType = targetThreadId ? 'thread' : 'canal';
    onProgress({ status: 'fetching', message: `Buscando mensagens do ${sourceType} de origem...` });
    const messages = await fetchChannelMessages(botToken, sourceChannelId, sourceThreadId);

    // Reverter ordem para postar do mais antigo ao mais novo
    messages.reverse();

    onProgress({
      status: 'processing',
      message: `Encontradas ${messages.length} mensagens. Iniciando processamento...`,
      total: messages.length,
      processed: 0
    });

    const stats = {
      totalMessages: messages.length,
      messagesWithFiles: 0,
      filesProcessed: 0,
      filesUploaded: 0,
      messagesPosted: 0,
      errors: []
    };

    // Processar cada mensagem
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      try {
        // Extrair URLs
        const fileUrls = extractFileUrls(message);

        // Preparar dados da mensagem
        const messageData = {
          content: message.content || '',
          embeds: message.embeds || [],
          username: message.author.username || 'Migrated User',
          avatar_url: message.author.avatar
            ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png`
            : undefined
        };

        // Se tem arquivos, processar
        if (fileUrls.length > 0) {
          stats.messagesWithFiles++;
          const urlMap = new Map();

          // Processar cada arquivo
          for (const url of fileUrls) {
            try {
              stats.filesProcessed++;

              onProgress({
                status: 'processing',
                message: `Mensagem ${i + 1}/${messages.length}: baixando arquivo ${stats.filesProcessed}...`,
                processed: i + 1,
                total: messages.length
              });

              // Baixar arquivo
              const fileData = await downloadFile(url);

              // Upload para storage
              const uploadResult = await uploadToStorage(fileData, baseUrl, uploadedBy);

              urlMap.set(url, uploadResult.downloadUrl);
              stats.filesUploaded++;

            } catch (fileError) {
              stats.errors.push({
                messageId: message.id,
                url,
                error: fileError.message
              });
            }
          }

          // Substituir URLs na mensagem
          if (urlMap.size > 0) {
            const replacedMessage = replaceUrlsInMessage(message, urlMap);
            messageData.content = replacedMessage.content;
            messageData.embeds = replacedMessage.embeds;
          }
        }

        // Postar mensagem no canal/thread de destino
        await postWebhookMessage(targetWebhookUrl, messageData, targetThreadId);
        stats.messagesPosted++;

        onProgress({
          status: 'processing',
          message: `Mensagem ${i + 1}/${messages.length}: postada no ${targetType} de destino`,
          processed: i + 1,
          total: messages.length
        });

        // Pequeno delay para evitar rate limit
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (messageError) {
        stats.errors.push({
          messageId: message.id,
          error: messageError.message
        });
      }
    }

    onProgress({
      status: 'completed',
      message: 'Migração concluída!',
      stats
    });

    return stats;

  } catch (error) {
    onProgress({
      status: 'error',
      message: error.message
    });
    throw error;
  }
}
