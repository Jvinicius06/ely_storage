import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cria/abre o banco de dados na pasta config
const db = new Database(join(__dirname, '..', 'config', 'storage.db'));

// ==================== OTIMIZAÇÕES DE PERFORMANCE ====================
// WAL mode: melhor concorrência e performance
db.pragma('journal_mode = WAL');
// Cache de 64MB para queries frequentes
db.pragma('cache_size = -64000');
// Sincronização normal (balanço entre segurança e performance)
db.pragma('synchronous = NORMAL');
// Memory-mapped I/O para leituras rápidas
db.pragma('mmap_size = 268435456'); // 256MB
// Temp store em memória para operações temporárias
db.pragma('temp_store = MEMORY');

// Cria a tabela de usuários se não existir
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Cria a tabela de arquivos se não existir
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    file_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    download_url TEXT NOT NULL,
    tags TEXT DEFAULT '',
    description TEXT DEFAULT '',
    uploaded_by INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )
`);

// Adicionar colunas tags e description se não existirem (para bancos existentes)
try {
  db.exec(`ALTER TABLE files ADD COLUMN tags TEXT DEFAULT ''`);
} catch (e) {
  // Coluna já existe
}

try {
  db.exec(`ALTER TABLE files ADD COLUMN description TEXT DEFAULT ''`);
} catch (e) {
  // Coluna já existe
}

// Adicionar coluna uploaded_by se não existir
try {
  db.exec(`ALTER TABLE files ADD COLUMN uploaded_by INTEGER REFERENCES users(id)`);
} catch (e) {
  // Coluna já existe
}

// ==================== ÍNDICES PARA PERFORMANCE ====================
// Criar índices se não existirem
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files(uploaded_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON files(uploaded_by)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_stored_name ON files(stored_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_tags ON files(tags)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);

// Criar usuário admin inicial se não existir
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUsername);
if (!existingAdmin) {
  const passwordHash = bcrypt.hashSync(adminPassword, 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    adminUsername,
    passwordHash,
    'admin'
  );
  console.log(`✅ Usuário admin criado: ${adminUsername}`);
}

// Funções do banco de dados
export const dbOperations = {
  // ==================== USUÁRIOS ====================

  // Criar novo usuário
  createUser(username, password, role = 'user') {
    const passwordHash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, role)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(username, passwordHash, role);
    return result.lastInsertRowid;
  },

  // Buscar usuário por username
  getUserByUsername(username) {
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    return stmt.get(username);
  },

  // Buscar usuário por ID
  getUserById(id) {
    const stmt = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?');
    return stmt.get(id);
  },

  // Verificar senha
  verifyPassword(password, passwordHash) {
    return bcrypt.compareSync(password, passwordHash);
  },

  // Listar todos os usuários (sem password_hash)
  getAllUsers() {
    const stmt = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
    return stmt.all();
  },

  // Deletar usuário
  deleteUser(id) {
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    return stmt.run(id);
  },

  // Atualizar senha do usuário
  updateUserPassword(id, newPassword) {
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    return stmt.run(passwordHash, id);
  },

  // ==================== ARQUIVOS ====================

  // Inserir novo arquivo
  insertFile(file) {
    const stmt = db.prepare(`
      INSERT INTO files (original_name, stored_name, file_type, mime_type, size, download_url, tags, description, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      file.originalName,
      file.storedName,
      file.fileType,
      file.mimeType,
      file.size,
      file.downloadUrl,
      file.tags || '',
      file.description || '',
      file.uploadedBy || null
    );
    return result.lastInsertRowid;
  },

  // Buscar todos os arquivos (com paginação para evitar sobrecarga de memória)
  getAllFiles(limit = 100, offset = 0) {
    const stmt = db.prepare(`
      SELECT
        f.*,
        u.username as uploaded_by_username,
        u.role as uploaded_by_role
      FROM files f
      LEFT JOIN users u ON f.uploaded_by = u.id
      ORDER BY f.uploaded_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  },

  // Contar total de arquivos (para paginação)
  countAllFiles() {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM files');
    return stmt.get().count;
  },

  // Buscar arquivo por ID (com informações do usuário)
  getFileById(id) {
    const stmt = db.prepare(`
      SELECT
        f.*,
        u.username as uploaded_by_username,
        u.role as uploaded_by_role
      FROM files f
      LEFT JOIN users u ON f.uploaded_by = u.id
      WHERE f.id = ?
    `);
    return stmt.get(id);
  },

  // Buscar arquivo pelo nome armazenado
  getFileByStoredName(storedName) {
    const stmt = db.prepare('SELECT * FROM files WHERE stored_name = ?');
    return stmt.get(storedName);
  },

  // Deletar arquivo
  deleteFile(id) {
    const stmt = db.prepare('DELETE FROM files WHERE id = ?');
    return stmt.run(id);
  },

  // Estatísticas
  getStats() {
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM files').get();
    const totalSize = db.prepare('SELECT SUM(size) as total FROM files').get();
    const filesByType = db.prepare(`
      SELECT file_type, COUNT(*) as count
      FROM files
      GROUP BY file_type
    `).all();

    return {
      totalFiles: totalFiles.count,
      totalSize: totalSize.total || 0,
      filesByType
    };
  },

  // Atualizar tags e descrição de um arquivo
  updateFileTags(id, tags, description) {
    const stmt = db.prepare(`
      UPDATE files
      SET tags = ?, description = ?
      WHERE id = ?
    `);
    return stmt.run(tags || '', description || '', id);
  },

  // Buscar arquivos com filtros (com informações do usuário e paginação)
  searchFiles(filters = {}) {
    let query = `
      SELECT
        f.*,
        u.username as uploaded_by_username,
        u.role as uploaded_by_role
      FROM files f
      LEFT JOIN users u ON f.uploaded_by = u.id
      WHERE 1=1
    `;
    const params = [];

    // Filtrar por tipo
    if (filters.fileType) {
      query += ' AND f.file_type = ?';
      params.push(filters.fileType);
    }

    // Filtrar por tag (busca parcial)
    if (filters.tag) {
      query += ' AND f.tags LIKE ?';
      params.push(`%${filters.tag}%`);
    }

    // Filtrar por nome
    if (filters.search) {
      query += ' AND f.original_name LIKE ?';
      params.push(`%${filters.search}%`);
    }

    // Filtrar por data inicial
    if (filters.startDate) {
      query += ' AND f.uploaded_at >= ?';
      params.push(filters.startDate);
    }

    // Filtrar por data final
    if (filters.endDate) {
      query += ' AND f.uploaded_at <= ?';
      params.push(filters.endDate);
    }

    query += ' ORDER BY f.uploaded_at DESC';

    // Paginação
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }

    const stmt = db.prepare(query);
    return stmt.all(...params);
  },

  // Contar total de arquivos com filtros (para paginação)
  countSearchFiles(filters = {}) {
    let query = `
      SELECT COUNT(*) as count
      FROM files f
      WHERE 1=1
    `;
    const params = [];

    // Aplicar mesmos filtros (sem paginação)
    if (filters.fileType) {
      query += ' AND f.file_type = ?';
      params.push(filters.fileType);
    }

    if (filters.tag) {
      query += ' AND f.tags LIKE ?';
      params.push(`%${filters.tag}%`);
    }

    if (filters.search) {
      query += ' AND f.original_name LIKE ?';
      params.push(`%${filters.search}%`);
    }

    if (filters.startDate) {
      query += ' AND f.uploaded_at >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      query += ' AND f.uploaded_at <= ?';
      params.push(filters.endDate);
    }

    const stmt = db.prepare(query);
    return stmt.get(...params).count;
  },

  // Obter todas as tags únicas
  getAllTags() {
    const files = db.prepare("SELECT tags FROM files WHERE tags != ''").all();
    const tagsSet = new Set();

    files.forEach(file => {
      if (file.tags) {
        const tags = file.tags.split(',').map(t => t.trim()).filter(t => t);
        tags.forEach(tag => tagsSet.add(tag));
      }
    });

    return Array.from(tagsSet).sort();
  },

  // Buscar arquivos por uma tag específica
  getFilesByTag(tag) {
    const stmt = db.prepare('SELECT * FROM files WHERE tags LIKE ? ORDER BY uploaded_at DESC');
    return stmt.all(`%${tag}%`);
  },

  // Obter estatísticas por tag
  getStatsByTag() {
    const files = db.prepare("SELECT tags FROM files WHERE tags != ''").all();
    const tagCounts = {};

    files.forEach(file => {
      if (file.tags) {
        const tags = file.tags.split(',').map(t => t.trim()).filter(t => t);
        tags.forEach(tag => {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        });
      }
    });

    return Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  },

  // ==================== MANUTENÇÃO E OTIMIZAÇÃO ====================

  // Executar VACUUM para otimizar banco (rodar periodicamente)
  vacuum() {
    db.exec('VACUUM');
    db.exec('ANALYZE');
  },

  // Otimizar banco (menos agressivo que VACUUM)
  optimize() {
    db.exec('PRAGMA optimize');
    db.exec('ANALYZE');
  },

  // Checkpoint do WAL (liberar memória)
  checkpoint() {
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
};

export default db;
