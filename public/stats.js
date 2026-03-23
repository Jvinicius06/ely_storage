const API_URL = window.location.origin;

let allFiles = [];
let currentPeriod = 30;
let currentSort = { key: 'downloads', dir: 'asc' };
let currentFilter = 'all';

// ==================== AUTH ====================

async function checkAuth() {
    try {
        const response = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login.html';
            return false;
        }
        const data = await response.json();
        document.getElementById('currentUser').textContent = data.user.username;
        return true;
    } catch {
        window.location.href = '/login.html';
        return false;
    }
}

async function logout() {
    await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    window.location.href = '/login.html';
}

// ==================== HELPERS ====================

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'hoje';
    if (diffDays === 1) return 'ontem';
    if (diffDays < 7) return `${diffDays} dias atrás`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} sem. atrás`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} meses atrás`;
    return `${Math.floor(diffDays / 365)} anos atrás`;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('pt-BR');
}

function fileTypeIcon(type) {
    const icons = { image: '🖼️', video: '🎥', audio: '🎵', other: '📄' };
    return icons[type] || '📄';
}

function downloadBadgeClass(count) {
    if (count === 0) return 'zero';
    if (count <= 5) return 'low';
    return 'high';
}

function showNotification(message, type = 'info') {
    const colors = { success: '#10b981', error: '#ef4444', info: '#667eea' };
    const n = document.createElement('div');
    n.style.cssText = `position:fixed;top:20px;right:20px;padding:12px 20px;background:${colors[type]};color:white;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:2000;font-size:0.9rem;font-weight:500;animation:slideIn 0.3s ease;`;
    n.textContent = message;
    document.body.appendChild(n);
    setTimeout(() => { n.style.animation = 'slideOut 0.3s ease'; setTimeout(() => n.remove(), 300); }, 3000);
}

// ==================== CARREGAR DADOS ====================

async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/stats/downloads?days=${currentPeriod}`, {
            credentials: 'include'
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message);

        allFiles = data.files;

        // Atualizar cards
        document.getElementById('cardTotalFiles').textContent = data.totalFiles;
        document.getElementById('cardTotalDownloads').textContent = data.totalDownloads;
        document.getElementById('cardUnused').textContent = data.unusedCount;
        document.getElementById('cardPeriod').textContent = `${data.days}d`;

        // Mostrar botão de deletar não utilizados se houver
        const deleteBtn = document.getElementById('deleteUnusedBtn');
        deleteBtn.style.display = data.unusedCount > 0 ? 'inline-block' : 'none';
        deleteBtn.textContent = `Deletar ${data.unusedCount} não utilizados`;

        renderTable();
    } catch (error) {
        console.error('Erro ao carregar estatísticas:', error);
        document.getElementById('statsTableBody').innerHTML = `
            <tr><td colspan="8" style="text-align:center;padding:40px;color:var(--danger);">
                Erro ao carregar dados. Tente novamente.
            </td></tr>
        `;
    }
}

// ==================== RENDERIZAR TABELA ====================

function getFilteredSorted() {
    let files = [...allFiles];

    // Filtro
    if (currentFilter === 'unused') files = files.filter(f => f.download_count === 0);
    else if (currentFilter === 'used') files = files.filter(f => f.download_count > 0);

    // Ordenação
    const { key, dir } = currentSort;
    files.sort((a, b) => {
        let va, vb;
        if (key === 'name') { va = a.original_name.toLowerCase(); vb = b.original_name.toLowerCase(); }
        else if (key === 'size') { va = a.size; vb = b.size; }
        else if (key === 'downloads') { va = a.download_count; vb = b.download_count; }
        else if (key === 'last') { va = a.last_downloaded_at || ''; vb = b.last_downloaded_at || ''; }
        else if (key === 'uploaded') { va = a.uploaded_at; vb = b.uploaded_at; }
        else if (key === 'tags') { va = a.tags || ''; vb = b.tags || ''; }
        else return 0;

        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
    });

    return files;
}

function renderTable() {
    const files = getFilteredSorted();
    const tbody = document.getElementById('statsTableBody');

    if (files.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="8" style="text-align:center;padding:48px;color:var(--gray);">
                Nenhum arquivo encontrado
            </td></tr>
        `;
        return;
    }

    tbody.innerHTML = files.map(file => {
        const tags = file.tags ? file.tags.split(',').map(t => t.trim()).filter(t => t) : [];
        const tagsHTML = tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
        const ago = timeAgo(file.last_downloaded_at);
        const badgeClass = downloadBadgeClass(file.download_count);
        const rowClass = file.download_count === 0 ? ' unused' : '';

        return `
            <tr class="${rowClass}">
                <td>
                    <span class="file-type-badge ${file.file_type}" title="${file.file_type}">
                        ${fileTypeIcon(file.file_type)}
                    </span>
                </td>
                <td>
                    <span class="stats-filename" title="${escapeHtml(file.original_name)}">
                        ${escapeHtml(file.original_name)}
                    </span>
                    <span style="font-size:0.75rem;color:var(--gray);">
                        ${file.uploaded_by_username ? 'por ' + escapeHtml(file.uploaded_by_username) : 'via API'}
                    </span>
                </td>
                <td>
                    <div class="stats-tags">${tagsHTML || '<span style="color:var(--gray);font-size:0.78rem;">—</span>'}</div>
                </td>
                <td style="white-space:nowrap">${formatFileSize(file.size)}</td>
                <td>
                    <span class="download-badge ${badgeClass}">${file.download_count}</span>
                </td>
                <td>
                    ${ago
                        ? `<span class="date-ago">${ago}</span>`
                        : `<span class="date-ago never">Nunca</span>`
                    }
                </td>
                <td class="date-ago">${formatDate(file.uploaded_at)}</td>
                <td>
                    <button class="btn btn-danger" style="padding:5px 10px;font-size:0.78rem;"
                        onclick="deleteFile(${file.id}, '${escapeHtml(file.original_name)}')">
                        🗑️
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// ==================== CONTROLES ====================

function setPeriod(days) {
    currentPeriod = days;
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === `${days}d`);
    });
    loadStats();
}

function applyFilter() {
    currentFilter = document.getElementById('showFilter').value;
    renderTable();
}

function sortBy(key) {
    if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.key = key;
        currentSort.dir = key === 'downloads' ? 'asc' : 'desc';
    }

    // Atualizar ícones de ordenação
    ['name', 'size', 'downloads', 'last', 'uploaded', 'tags'].forEach(k => {
        const el = document.getElementById(`sort-${k}`);
        if (el) el.textContent = '';
    });
    const icon = document.getElementById(`sort-${key}`);
    if (icon) icon.textContent = currentSort.dir === 'asc' ? ' ↑' : ' ↓';

    // Atualizar classe sorted
    document.querySelectorAll('.stats-table thead th').forEach(th => th.classList.remove('sorted'));
    const headers = document.querySelectorAll('.stats-table thead th');
    const keyIndex = { name: 1, tags: 2, size: 3, downloads: 4, last: 5, uploaded: 6 };
    if (headers[keyIndex[key]]) headers[keyIndex[key]].classList.add('sorted');

    renderTable();
}

// ==================== AÇÕES ====================

async function deleteFile(fileId, fileName) {
    if (!confirm(`Deletar "${fileName}"?`)) return;

    try {
        const response = await fetch(`${API_URL}/api/files/${fileId}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const data = await response.json();
        if (data.success) {
            showNotification('Arquivo deletado!', 'success');
            loadStats();
        } else {
            showNotification(data.message || 'Erro ao deletar', 'error');
        }
    } catch {
        showNotification('Erro ao deletar arquivo', 'error');
    }
}

async function deleteAllUnused() {
    const unused = allFiles.filter(f => f.download_count === 0);
    if (unused.length === 0) return;

    if (!confirm(`Deletar ${unused.length} arquivo${unused.length > 1 ? 's' : ''} sem downloads no período de ${currentPeriod} dias? Esta ação não pode ser desfeita.`)) return;

    let deleted = 0;
    let failed = 0;

    for (const file of unused) {
        try {
            const response = await fetch(`${API_URL}/api/files/${file.id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            const data = await response.json();
            if (data.success) deleted++;
            else failed++;
        } catch {
            failed++;
        }
    }

    if (deleted > 0) showNotification(`${deleted} arquivo${deleted > 1 ? 's' : ''} deletado${deleted > 1 ? 's' : ''}!`, 'success');
    if (failed > 0) showNotification(`${failed} arquivo${failed > 1 ? 's' : ''} falhou`, 'error');
    loadStats();
}

// ==================== INIT ====================

async function init() {
    const ok = await checkAuth();
    if (ok) loadStats();
}

init();

// Animações
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn { from { transform:translateX(100%); opacity:0; } to { transform:translateX(0); opacity:1; } }
    @keyframes slideOut { from { transform:translateX(0); opacity:1; } to { transform:translateX(100%); opacity:0; } }
    .filter-select {
        padding: 7px 12px;
        border: 1.5px solid var(--border);
        border-radius: 8px;
        font-size: 0.875rem;
        background: white;
        font-family: inherit;
        cursor: pointer;
        color: var(--dark);
    }
    .filter-select:focus { outline: none; border-color: var(--primary); }
`;
document.head.appendChild(style);
