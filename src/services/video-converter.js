import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dbOperations } from '../database.js';
import { sendVideoConversionNotification, sendVideoConversionErrorNotification } from './discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configurações
const ENABLE_CONVERSION = process.env.ENABLE_VIDEO_CONVERSION !== 'false';
const CONCURRENCY = parseInt(process.env.VIDEO_CONVERSION_CONCURRENCY || '1', 10);
const UPLOADS_PATH = join(__dirname, '..', '..', 'config', 'uploads');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Job queue e estado
class VideoConverterService {
  constructor() {
    this.queue = [];
    this.processing = new Set();
    this.maxConcurrency = CONCURRENCY;
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      processing: 0
    };
  }

  /**
   * Adiciona um vídeo à fila de conversão
   */
  async addToQueue(fileId, storedName, originalName) {
    if (!ENABLE_CONVERSION) {
      console.log(`⚠️  Conversão de vídeo desabilitada (fileId: ${fileId})`);
      return false;
    }

    const job = {
      fileId,
      storedName,
      originalName,
      addedAt: new Date(),
      retries: 0,
      maxRetries: 2
    };

    this.queue.push(job);
    this.stats.total++;

    console.log(`📹 Vídeo adicionado à fila de conversão: ${originalName} (ID: ${fileId})`);
    console.log(`📊 Fila: ${this.queue.length} aguardando, ${this.processing.size} processando`);

    // Iniciar processamento se houver capacidade
    this.processQueue();

    return true;
  }

  /**
   * Processa a fila de conversão
   */
  async processQueue() {
    // Verificar se podemos processar mais jobs
    while (this.queue.length > 0 && this.processing.size < this.maxConcurrency) {
      const job = this.queue.shift();
      this.processing.add(job.fileId);
      this.stats.processing = this.processing.size;

      // Processar job em background (não aguardar)
      this.processJob(job).catch(err => {
        console.error(`❌ Erro inesperado ao processar job ${job.fileId}:`, err);
      });
    }
  }

  /**
   * Processa um job individual
   */
  async processJob(job) {
    try {
      console.log(`\n🎬 Iniciando conversão: ${job.originalName} (ID: ${job.fileId})`);

      // Atualizar status no banco
      dbOperations.updateConversionStatus(job.fileId, 'processing');

      // Caminhos dos arquivos
      const inputPath = join(UPLOADS_PATH, job.storedName);
      const outputName = this.generateOutputName(job.storedName);
      const outputPath = join(UPLOADS_PATH, outputName);

      // Verificar se arquivo de entrada existe
      try {
        await fs.access(inputPath);
      } catch (err) {
        throw new Error(`Arquivo de entrada não encontrado: ${inputPath}`);
      }

      // Extrair metadados do vídeo original
      const metadata = await this.getVideoMetadata(inputPath);
      console.log(`📊 Metadados: ${metadata.width}x${metadata.height}, ${metadata.duration}s, ${metadata.codec}`);

      // Converter vídeo
      await this.convertVideo(inputPath, outputPath, (progress) => {
        // Log de progresso a cada 25%
        if (progress % 25 === 0) {
          console.log(`⏳ Progresso (ID: ${job.fileId}): ${progress}%`);
        }
      });

      // Obter metadados do vídeo convertido
      const convertedMetadata = await this.getVideoMetadata(outputPath);
      const fileStats = await fs.stat(outputPath);

      // Preparar URL do arquivo convertido
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const convertedUrl = `${baseUrl}/download/${outputName}`;

      // Atualizar banco de dados com arquivo convertido
      dbOperations.updateConvertedFile(
        job.fileId,
        outputName,
        convertedUrl,
        Math.round(convertedMetadata.duration),
        {
          width: convertedMetadata.width,
          height: convertedMetadata.height,
          codec: convertedMetadata.codec,
          audioCodec: convertedMetadata.audioCodec,
          bitrate: convertedMetadata.bitrate,
          size: fileStats.size,
          originalSize: metadata.size || 0
        }
      );

      console.log(`✅ Conversão concluída: ${job.originalName} (ID: ${job.fileId})`);
      console.log(`   Original: ${this.formatBytes(metadata.size || 0)} → Convertido: ${this.formatBytes(fileStats.size)}`);
      console.log(`   Duração: ${Math.round(convertedMetadata.duration)}s\n`);

      this.stats.completed++;

      // Enviar notificação ao Discord sobre conversão concluída
      await sendVideoConversionNotification(DISCORD_WEBHOOK_URL, {
        originalName: job.originalName,
        convertedUrl,
        duration: Math.round(convertedMetadata.duration),
        metadata: {
          width: convertedMetadata.width,
          height: convertedMetadata.height,
          codec: convertedMetadata.codec,
          audioCodec: convertedMetadata.audioCodec,
          bitrate: convertedMetadata.bitrate,
          size: fileStats.size,
          originalSize: metadata.size || 0
        }
      });

    } catch (error) {
      console.error(`❌ Erro na conversão (ID: ${job.fileId}):`, error.message);

      // Tentar novamente se houver retries disponíveis
      if (job.retries < job.maxRetries) {
        job.retries++;
        this.queue.push(job);
        console.log(`🔄 Tentando novamente (${job.retries}/${job.maxRetries}): ${job.originalName}`);
      } else {
        // Marcar como falha no banco
        dbOperations.updateConversionStatus(job.fileId, 'failed');
        this.stats.failed++;
        console.error(`💥 Falha definitiva após ${job.maxRetries} tentativas: ${job.originalName}\n`);

        // Enviar notificação ao Discord sobre erro na conversão
        const originalUrl = `${BASE_URL}/download/${job.storedName}`;
        await sendVideoConversionErrorNotification(DISCORD_WEBHOOK_URL, {
          originalName: job.originalName,
          storedName: job.storedName,
          downloadUrl: originalUrl
        }, error.message);
      }
    } finally {
      // Remover da lista de processamento
      this.processing.delete(job.fileId);
      this.stats.processing = this.processing.size;

      // Continuar processando a fila
      this.processQueue();
    }
  }

  /**
   * Converte vídeo usando FFmpeg
   */
  async convertVideo(inputPath, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
      let lastProgress = 0;

      ffmpeg(inputPath)
        // Codec de vídeo: H.264 (libx264)
        .videoCodec('libx264')
        // Preset: faster (balanço entre velocidade e qualidade)
        .addOption('-preset', 'faster')
        // CRF: 18 (qualidade visual quase idêntica ao original)
        .addOption('-crf', '18')
        // Codec de áudio: AAC
        .audioCodec('aac')
        // Bitrate de áudio: 192k (qualidade alta)
        .audioBitrate('192k')
        // FastStart: move moov atom para o início (essencial para streaming)
        .addOption('-movflags', '+faststart')
        // Formato de saída
        .format('mp4')
        // Output
        .output(outputPath)
        // Eventos
        .on('start', (commandLine) => {
          console.log(`🔧 FFmpeg iniciado: ${commandLine.substring(0, 100)}...`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            const currentProgress = Math.floor(progress.percent);
            if (currentProgress !== lastProgress && currentProgress % 5 === 0) {
              lastProgress = currentProgress;
              if (onProgress) {
                onProgress(currentProgress);
              }
            }
          }
        })
        .on('end', () => {
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg stderr:', stderr);
          reject(new Error(`FFmpeg error: ${err.message}`));
        })
        .run();
    });
  }

  /**
   * Obtém metadados do vídeo usando FFprobe
   */
  async getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          return reject(err);
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration || 0,
          size: metadata.format.size || 0,
          bitrate: metadata.format.bit_rate || 0,
          codec: videoStream?.codec_name || 'unknown',
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          audioCodec: audioStream?.codec_name || 'unknown',
          format: metadata.format.format_name || 'unknown'
        });
      });
    });
  }

  /**
   * Gera nome do arquivo de saída
   */
  generateOutputName(inputName) {
    const ext = extname(inputName);
    const nameWithoutExt = inputName.substring(0, inputName.length - ext.length);
    return `${nameWithoutExt}.mp4`;
  }

  /**
   * Formata bytes para leitura humana
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  /**
   * Obtém status da fila
   */
  getQueueStatus() {
    return {
      queue: this.queue.length,
      processing: this.processing.size,
      maxConcurrency: this.maxConcurrency,
      stats: this.stats,
      enabled: ENABLE_CONVERSION
    };
  }

  /**
   * Obtém jobs em processamento
   */
  getProcessingJobs() {
    return Array.from(this.processing);
  }
}

// Singleton
const videoConverter = new VideoConverterService();

// Recuperar conversões pendentes ao iniciar (se houver)
if (ENABLE_CONVERSION) {
  setTimeout(() => {
    try {
      const pending = dbOperations.getPendingConversions();
      if (pending.length > 0) {
        console.log(`\n📹 Recuperando ${pending.length} conversões pendentes...`);
        pending.forEach(file => {
          videoConverter.addToQueue(file.id, file.stored_name, file.original_name);
        });
      }
    } catch (error) {
      console.error('❌ Erro ao recuperar conversões pendentes:', error);
    }
  }, 2000); // Aguardar 2s para o servidor inicializar
}

export default videoConverter;
