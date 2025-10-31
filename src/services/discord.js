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

// Enviar notificação para o Discord
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
