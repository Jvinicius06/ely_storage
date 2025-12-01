import axios from 'axios';

// Determinar o tipo de arquivo (imagem, vídeo, áudio)
function getFileCategory(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

// Formatar tamanho do arquivo
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Enviar notificação para o Discord (upload inicial)
export async function sendDiscordNotification(webhookUrl, fileData) {
  if (!webhookUrl) {
    console.log('[Discord] Webhook URL não configurada. Pulando notificação.');
    return;
  }

  try {
    const fileCategory = getFileCategory(fileData.mimeType);

    // Emoji baseado no tipo de arquivo
    const emojiMap = {
      image: '🖼️',
      video: '🎬',
      audio: '🎵',
      file: '📁'
    };

    // Cor do embed baseado no tipo
    const colorMap = {
      image: 0x3498db,  // Azul
      video: 0xe74c3c,  // Vermelho
      audio: 0x9b59b6,  // Roxo
      file: 0x95a5a6    // Cinza
    };

    const embed = {
      title: `${emojiMap[fileCategory]} Novo arquivo enviado`,
      description: `**${fileData.originalName}**`,
      color: colorMap[fileCategory],
      fields: [
        {
          name: 'Tipo',
          value: fileData.mimeType,
          inline: true
        },
        {
          name: 'Tamanho',
          value: formatFileSize(fileData.size),
          inline: true
        },
        {
          name: 'Link de Download',
          value: `[Clique aqui](${fileData.downloadUrl})`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Ely Storage'
      }
    };

    // Se for vídeo, adicionar informação sobre conversão
    if (fileCategory === 'video') {
      embed.fields.push({
        name: '⚙️ Status',
        value: '🕐 Vídeo adicionado à fila de conversão para otimização',
        inline: false
      });
    }

    // Se for imagem ou vídeo, adicionar visualização
    if (fileCategory === 'image') {
      embed.image = { url: fileData.downloadUrl };
    } else if (fileCategory === 'video') {
      embed.thumbnail = { url: fileData.downloadUrl };
    }

    const payload = {
      username: 'Ely Storage',
      embeds: [embed]
    };

    await axios.post(webhookUrl, payload);
    console.log('[Discord] Notificação enviada com sucesso!');
  } catch (error) {
    console.error('[Discord] Erro ao enviar notificação:', error.message);
  }
}

// Notificação de conversão de vídeo concluída
export async function sendVideoConversionNotification(webhookUrl, videoData) {
  if (!webhookUrl) {
    console.log('[Discord] Webhook URL não configurada. Pulando notificação.');
    return;
  }

  try {
    const metadata = videoData.metadata || {};
    const durationMinutes = Math.floor((videoData.duration || 0) / 60);
    const durationSeconds = (videoData.duration || 0) % 60;
    const durationFormatted = `${durationMinutes}:${durationSeconds.toString().padStart(2, '0')}`;

    const embed = {
      title: '✅ Conversão de vídeo concluída',
      description: `**${videoData.originalName}**`,
      color: 0x10b981, // Verde
      fields: [
        {
          name: '🎬 Duração',
          value: durationFormatted,
          inline: true
        },
        {
          name: '📐 Resolução',
          value: `${metadata.width || 0}x${metadata.height || 0}`,
          inline: true
        },
        {
          name: '🎥 Codec',
          value: `H.264 (${metadata.codec || 'h264'})`,
          inline: true
        },
        {
          name: '🔊 Áudio',
          value: `AAC (${metadata.audioCodec || 'aac'})`,
          inline: true
        },
        {
          name: '📦 Tamanho Original',
          value: formatFileSize(metadata.originalSize || 0),
          inline: true
        },
        {
          name: '📦 Tamanho Convertido',
          value: formatFileSize(metadata.size || 0),
          inline: true
        },
        {
          name: '🔗 Link MP4 Otimizado',
          value: `[Clique aqui](${videoData.convertedUrl})`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Ely Storage • Conversão Automática'
      }
    };

    // Calcular redução de tamanho
    if (metadata.originalSize && metadata.size) {
      const reduction = ((1 - (metadata.size / metadata.originalSize)) * 100).toFixed(1);
      if (reduction > 0) {
        embed.fields.push({
          name: '📉 Redução',
          value: `${reduction}% menor`,
          inline: true
        });
      }
    }

    const payload = {
      username: 'Ely Storage',
      embeds: [embed]
    };

    await axios.post(webhookUrl, payload);
    console.log('[Discord] Notificação de conversão enviada com sucesso!');
  } catch (error) {
    console.error('[Discord] Erro ao enviar notificação de conversão:', error.message);
  }
}

// Notificação de erro na conversão
export async function sendVideoConversionErrorNotification(webhookUrl, videoData, errorMessage) {
  if (!webhookUrl) {
    console.log('[Discord] Webhook URL não configurada. Pulando notificação.');
    return;
  }

  try {
    const embed = {
      title: '❌ Erro na conversão de vídeo',
      description: `**${videoData.originalName}**`,
      color: 0xef4444, // Vermelho
      fields: [
        {
          name: '📁 Arquivo',
          value: videoData.storedName,
          inline: true
        },
        {
          name: '❗ Erro',
          value: errorMessage || 'Erro desconhecido durante a conversão',
          inline: false
        },
        {
          name: '🔗 Link Original',
          value: `[Clique aqui](${videoData.downloadUrl})`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Ely Storage • Sistema de Conversão'
      }
    };

    const payload = {
      username: 'Ely Storage',
      embeds: [embed]
    };

    await axios.post(webhookUrl, payload);
    console.log('[Discord] Notificação de erro enviada com sucesso!');
  } catch (error) {
    console.error('[Discord] Erro ao enviar notificação de erro:', error.message);
  }
}
