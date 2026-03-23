// ==================== REFERÊNCIAS DOM ====================

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const tagsInput = document.getElementById('tagsInput');
const descriptionInput = document.getElementById('descriptionInput');
const filesGrid = document.getElementById('filesGrid');
const refreshBtn = document.getElementById('refreshBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressLabel = document.getElementById('progressLabel');
const previewModal = document.getElementById('previewModal');
const modalClose = document.getElementById('modalClose');
const modalBody = document.getElementById('modalBody');
const currentUserSpan = document.getElementById('currentUser');
const adminBtn = document.getElementById('adminBtn');

// Filtros
const filterSearch = document.getElementById('filterSearch');
const filterType = document.getElementById('filterType');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');

// Modal de editar tags
const editTagsModal = document.getElementById('editTagsModal');
const editTagsModalClose = document.getElementById('editTagsModalClose');
const editTagsInput = document.getElementById('editTagsInput');
const editDescriptionInput = document.getElementById('editDescriptionInput');
const saveTagsBtn = document.getElementById('saveTagsBtn');
const cancelTagsBtn = document.getElementById('cancelTagsBtn');

// Modal de trocar senha
const changePasswordModal = document.getElementById('changePasswordModal');
const changePasswordModalClose = document.getElementById('changePasswordModalClose');
const currentPasswordInput = document.getElementById('currentPasswordInput');
const newPasswordInput = document.getElementById('newPasswordInput');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
const savePasswordBtn = document.getElementById('savePasswordBtn');
const cancelPasswordBtn = document.getElementById('cancelPasswordBtn');

// ==================== ESTADO GLOBAL ====================

let currentPage = 0;
let limitPerPage = 50;
let totalFiles = 0;
let hasMoreFiles = false;
let currentEditingFileId = null;
let currentUser = null;

// Tags
let allTags = [];
let activeTag = '';

// Fila de upload
let fileQueue = []; // Array de { file: File, status: 'pending'|'uploading'|'done'|'error' }
let isUploading = false;

const API_URL = window.location.origin;

// ==================== HELPERS ====================

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('pt-BR');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getQueueIcon(mimeType) {
    if (!mimeType) return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎥';
    if (mimeType.startsWith('audio/')) return '🎵';
    return '📄';
}

function showNotification(message, type = 'info') {
    const colors = {
        success: '#10b981',
        error: '#ef4444',
        info: '#667eea'
    };
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 13px 20px;
        background: ${colors[type] || colors.info};
        color: white;
        border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        z-index: 2000;
        font-size: 0.9rem;
        font-weight: 500;
        animation: slideIn 0.3s ease;
        max-width: 320px;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// ==================== AUTH ====================

async function checkAuth() {
    try {
        const response = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login.html';
            return false;
        }
        const data = await response.json();
        currentUser = data.user;
        currentUserSpan.textContent = currentUser.username;
        if (currentUser.role === 'admin') {
            adminBtn.style.display = 'inline-block';
        }
        return true;
    } catch (error) {
        console.error('Erro ao verificar autenticação:', error);
        window.location.href = '/login.html';
        return false;
    }
}

async function logout() {
    try {
        await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
        window.location.href = '/login.html';
    } catch (error) {
        showNotification('Erro ao fazer logout', 'error');
    }
}

// ==================== ESTATÍSTICAS ====================

async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/stats`);
        const data = await response.json();
        if (data.success) {
            document.getElementById('totalFiles').textContent = data.stats.totalFiles;
            document.getElementById('totalSize').textContent = formatFileSize(data.stats.totalSize);
        }
    } catch (error) {
        console.error('Erro ao carregar estatísticas:', error);
    }
}

// ==================== FILA DE UPLOAD ====================

function addFilesToQueue(files) {
    const newItems = Array.from(files).map(file => ({ file, status: 'pending' }));
    fileQueue = [...fileQueue, ...newItems];
    renderQueue();
}

function removeFromQueue(index) {
    if (isUploading) return;
    fileQueue.splice(index, 1);
    renderQueue();
}

function clearQueue() {
    if (isUploading) return;
    fileQueue = [];
    renderQueue();
}

function renderQueue() {
    const queueContainer = document.getElementById('fileQueue');
    const uploadMeta = document.getElementById('uploadMeta');
    const uploadBtnText = document.getElementById('uploadBtnText');
    const uploadBtn = document.getElementById('uploadBtn');

    if (fileQueue.length === 0) {
        queueContainer.innerHTML = '';
        if (uploadMeta) uploadMeta.style.display = 'none';
        return;
    }

    if (uploadMeta) uploadMeta.style.display = 'block';

    const pending = fileQueue.filter(i => i.status === 'pending').length;
    if (uploadBtnText) {
        if (pending > 0) {
            uploadBtnText.textContent = `Enviar ${pending} arquivo${pending > 1 ? 's' : ''}`;
        } else {
            uploadBtnText.textContent = 'Concluído';
        }
    }
    if (uploadBtn) uploadBtn.disabled = isUploading || pending === 0;

    queueContainer.innerHTML = fileQueue.map((item, i) => {
        const statusLabel = {
            pending: '',
            uploading: '<span class="queue-status uploading">Enviando...</span>',
            done: '<span class="queue-status done">✓ Enviado</span>',
            error: '<span class="queue-status error">✗ Erro</span>'
        }[item.status] || '';

        const removeBtn = item.status === 'pending' && !isUploading
            ? `<button class="queue-remove" onclick="removeFromQueue(${i})" title="Remover">&times;</button>`
            : '<div style="width:22px"></div>';

        return `
            <div class="queue-item ${item.status !== 'pending' ? item.status : ''}">
                <span class="queue-icon">${getQueueIcon(item.file.type)}</span>
                <span class="queue-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>
                <span class="queue-size">${formatFileSize(item.file.size)}</span>
                ${statusLabel}
                ${removeBtn}
            </div>
        `;
    }).join('');
}

async function uploadQueue() {
    const pending = fileQueue.filter(i => i.status === 'pending');
    if (pending.length === 0 || isUploading) return;

    isUploading = true;
    renderQueue();

    const tags = tagsInput.value.trim();
    const description = descriptionInput.value.trim();

    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';

    let uploaded = 0;
    let failed = 0;
    const total = fileQueue.length;

    for (let i = 0; i < fileQueue.length; i++) {
        const item = fileQueue[i];
        if (item.status !== 'pending') continue;

        item.status = 'uploading';
        renderQueue();

        try {
            await uploadSingleFile(item.file, tags, description, i, total);
            item.status = 'done';
            uploaded++;
        } catch (e) {
            item.status = 'error';
            failed++;
        }

        const overallProgress = Math.round(((i + 1) / total) * 100);
        progressBar.style.width = overallProgress + '%';
        progressText.textContent = overallProgress + '%';
        progressLabel.textContent = `Arquivo ${Math.min(i + 1, total)} de ${total}`;
        renderQueue();
    }

    isUploading = false;

    setTimeout(() => {
        progressContainer.style.display = 'none';
    }, 1000);

    if (uploaded > 0) {
        showNotification(`${uploaded} arquivo${uploaded > 1 ? 's' : ''} enviado${uploaded > 1 ? 's' : ''} com sucesso!`, 'success');
        loadStats();
        loadTags();
    }
    if (failed > 0) {
        showNotification(`${failed} arquivo${failed > 1 ? 's' : ''} falhou no upload`, 'error');
    }

    // Limpar fila após upload completo
    fileQueue = [];
    tagsInput.value = '';
    descriptionInput.value = '';
    renderQueue();
    loadFiles();
}

function uploadSingleFile(file, tags, description, fileIndex, totalCount) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        if (tags) formData.append('tags', tags);
        if (description) formData.append('description', description);

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const fileProgress = e.loaded / e.total;
                const overallProgress = Math.round(((fileIndex + fileProgress) / totalCount) * 100);
                progressBar.style.width = overallProgress + '%';
                progressText.textContent = overallProgress + '%';
                progressLabel.textContent = `Enviando ${fileIndex + 1} de ${totalCount}: ${file.name}`;
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 201) {
                resolve();
            } else {
                reject(new Error(`Status ${xhr.status}`));
            }
        });

        xhr.addEventListener('error', () => reject(new Error('Erro de rede')));

        xhr.open('POST', `${API_URL}/api/upload`);
        xhr.withCredentials = true;
        xhr.send(formData);
    });
}

// ==================== LISTAGEM DE ARQUIVOS ====================

async function loadFiles(page = 0) {
    try {
        currentPage = page;
        const offset = page * limitPerPage;
        const response = await fetch(`${API_URL}/api/files?limit=${limitPerPage}&offset=${offset}`);
        const data = await response.json();
        if (data.success) {
            totalFiles = data.total;
            hasMoreFiles = data.hasMore;
            renderFiles(data.files);
            renderPagination();
        }
    } catch (error) {
        console.error('Erro ao carregar arquivos:', error);
        showNotification('Erro ao carregar arquivos', 'error');
    }
}

function renderFiles(files) {
    if (files.length === 0) {
        filesGrid.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                </svg>
                <h3>Nenhum arquivo encontrado</h3>
                <p>Faça upload de arquivos usando a área acima</p>
            </div>
        `;
        return;
    }

    filesGrid.innerHTML = files.map(file => {
        const preview = getFilePreview(file);
        const tags = file.tags ? file.tags.split(',').map(t => t.trim()).filter(t => t) : [];
        const tagsHTML = tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
        const canModify = currentUser && (currentUser.role === 'admin' || file.uploaded_by === currentUser.id);
        const uploaderInfo = file.uploaded_by_username
            ? `Enviado por: ${escapeHtml(file.uploaded_by_username)}`
            : 'Enviado via API';

        return `
            <div class="file-card">
                <div class="file-preview" onclick="openPreview(${file.id})">
                    ${preview}
                </div>
                <div class="file-info">
                    <div class="file-name" title="${escapeHtml(file.original_name)}">${escapeHtml(file.original_name)}</div>
                    <div class="file-meta">${formatFileSize(file.size)} &bull; ${formatDate(file.uploaded_at)}</div>
                    <div class="file-meta" style="color: var(--primary); font-size: 0.78rem;">${uploaderInfo}</div>
                    <div class="file-tags">${tagsHTML}</div>
                    <div class="file-actions">
                        <button class="btn btn-primary" onclick="copyLink('${escapeHtml(file.download_url)}')">
                            Copiar Link
                        </button>
                        ${canModify ? `
                            <button class="btn btn-secondary" onclick="openEditTagsModal(${file.id})">
                                Tags
                            </button>
                            <button class="btn btn-danger" onclick="deleteFile(${file.id}, '${escapeHtml(file.stored_name)}')">
                                🗑️
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderPagination() {
    let paginationContainer = document.getElementById('paginationContainer');
    if (!paginationContainer) {
        paginationContainer = document.createElement('div');
        paginationContainer.id = 'paginationContainer';
        paginationContainer.className = 'pagination-container';
        filesGrid.parentNode.appendChild(paginationContainer);
    }

    if (totalFiles === 0) {
        paginationContainer.innerHTML = '';
        return;
    }

    const startItem = currentPage * limitPerPage + 1;
    const endItem = Math.min((currentPage + 1) * limitPerPage, totalFiles);
    const totalPages = Math.ceil(totalFiles / limitPerPage);

    paginationContainer.innerHTML = `
        <div class="pagination-info">
            Mostrando ${startItem}–${endItem} de ${totalFiles} arquivos
        </div>
        <div class="pagination-buttons">
            <button class="btn btn-secondary" ${currentPage === 0 ? 'disabled' : ''} onclick="loadFiles(0)">
                ⏮ Primeira
            </button>
            <button class="btn btn-secondary" ${currentPage === 0 ? 'disabled' : ''} onclick="loadFiles(${currentPage - 1})">
                ← Anterior
            </button>
            <span class="pagination-current">Página ${currentPage + 1} de ${totalPages}</span>
            <button class="btn btn-secondary" ${!hasMoreFiles ? 'disabled' : ''} onclick="loadFiles(${currentPage + 1})">
                Próxima →
            </button>
            <button class="btn btn-secondary" ${!hasMoreFiles ? 'disabled' : ''} onclick="loadFiles(${totalPages - 1})">
                Última ⏭
            </button>
        </div>
    `;
}

function getFilePreview(file) {
    const url = file.download_url;
    if (file.file_type === 'image') {
        return `<img src="${url}" alt="${escapeHtml(file.original_name)}">`;
    } else if (file.file_type === 'video') {
        return `<video src="${url}" preload="metadata"></video>`;
    } else if (file.file_type === 'audio') {
        return `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path>
            </svg>
        `;
    } else {
        return `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
            </svg>
        `;
    }
}

// ==================== AÇÕES ====================

async function openPreview(fileId) {
    try {
        const response = await fetch(`${API_URL}/api/files/${fileId}`);
        const data = await response.json();
        if (!data.success) return;

        const file = data.file;
        let content = '';

        if (file.file_type === 'image') {
            content = `<img src="${file.download_url}" alt="${escapeHtml(file.original_name)}">`;
        } else if (file.file_type === 'video') {
            content = `<video src="${file.download_url}" controls style="max-width: 100%;"></video>`;
        } else if (file.file_type === 'audio') {
            content = `
                <h3 style="margin-bottom:16px">${escapeHtml(file.original_name)}</h3>
                <audio src="${file.download_url}" controls></audio>
            `;
        } else {
            content = `
                <h3 style="margin-bottom:16px">${escapeHtml(file.original_name)}</h3>
                <p style="color:var(--gray); margin-bottom:8px">Tipo: ${escapeHtml(file.mime_type)}</p>
                <p style="color:var(--gray); margin-bottom:16px">Tamanho: ${formatFileSize(file.size)}</p>
                <a href="${file.download_url}" target="_blank" class="btn btn-primary">Abrir arquivo</a>
            `;
        }

        modalBody.innerHTML = content;
        previewModal.classList.add('active');
    } catch (error) {
        showNotification('Erro ao abrir preview', 'error');
    }
}

function copyLink(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url)
            .then(() => showNotification('Link copiado!', 'success'))
            .catch(() => showNotification('Erro ao copiar link', 'error'));
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showNotification('Link copiado!', 'success');
        } catch {
            showNotification('Erro ao copiar link', 'error');
        }
        document.body.removeChild(textarea);
    }
}

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
            loadFiles(currentPage);
            loadStats();
        } else {
            showNotification(`Erro: ${data.message}`, 'error');
        }
    } catch (error) {
        showNotification('Erro ao deletar arquivo', 'error');
    }
}

// ==================== TAGS E ABAS ====================

async function loadTags() {
    try {
        const response = await fetch(`${API_URL}/api/tags`);
        const data = await response.json();
        if (data.success) {
            allTags = data.tags;
            renderTagTabs(allTags);
        }
    } catch (error) {
        console.error('Erro ao carregar tags:', error);
    }
}

function renderTagTabs(tags) {
    const container = document.getElementById('tagTabs');
    if (!container) return;

    container.innerHTML = `
        <button class="tag-tab ${activeTag === '' ? 'active' : ''}" onclick="setTagTab('')">
            Todos
        </button>
        ${tags.map(tag => `
            <button class="tag-tab ${activeTag === tag ? 'active' : ''}" onclick="setTagTab(${JSON.stringify(tag)})">
                ${escapeHtml(tag)}
            </button>
        `).join('')}
    `;
}

function setTagTab(tag) {
    activeTag = tag;
    renderTagTabs(allTags);
    searchFiles(0);
}

// ==================== BUSCA E FILTROS ====================

async function searchFiles(page = 0) {
    try {
        currentPage = page;
        const offset = page * limitPerPage;
        const search = filterSearch.value.trim();
        const type = filterType.value;
        const tag = activeTag;

        const params = new URLSearchParams();
        params.append('limit', limitPerPage);
        params.append('offset', offset);
        if (search) params.append('search', search);
        if (type) params.append('fileType', type);
        if (tag) params.append('tag', tag);

        const hasFilters = search || type || tag;
        const url = hasFilters
            ? `${API_URL}/api/search?${params.toString()}`
            : `${API_URL}/api/files?${params.toString()}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.success) {
            if (hasFilters) {
                totalFiles = data.count || data.files.length;
                hasMoreFiles = data.files.length >= limitPerPage;
            } else {
                totalFiles = data.total;
                hasMoreFiles = data.hasMore;
            }
            renderFiles(data.files);
            renderPagination();
        }
    } catch (error) {
        showNotification('Erro ao buscar arquivos', 'error');
    }
}

function clearFilters() {
    filterSearch.value = '';
    filterType.value = '';
    activeTag = '';
    renderTagTabs(allTags);
    loadFiles();
}

// ==================== MODAL EDITAR TAGS ====================

async function openEditTagsModal(fileId) {
    try {
        const response = await fetch(`${API_URL}/api/files/${fileId}`);
        const data = await response.json();
        if (data.success) {
            currentEditingFileId = fileId;
            editTagsInput.value = data.file.tags || '';
            editDescriptionInput.value = data.file.description || '';
            editTagsModal.classList.add('active');
        }
    } catch (error) {
        showNotification('Erro ao carregar arquivo', 'error');
    }
}

async function saveEditedTags() {
    if (!currentEditingFileId) return;
    const tags = editTagsInput.value.trim();
    const description = editDescriptionInput.value.trim();

    try {
        const response = await fetch(`${API_URL}/api/files/${currentEditingFileId}/tags`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ tags, description })
        });
        const data = await response.json();

        if (data.success) {
            showNotification('Tags atualizadas!', 'success');
            editTagsModal.classList.remove('active');
            currentEditingFileId = null;
            loadFiles(currentPage);
            loadTags();
        } else {
            showNotification(`Erro: ${data.message}`, 'error');
        }
    } catch (error) {
        showNotification('Erro ao atualizar tags', 'error');
    }
}

function closeEditTagsModal() {
    editTagsModal.classList.remove('active');
    currentEditingFileId = null;
}

// ==================== MODAL TROCAR SENHA ====================

function openChangePasswordModal() {
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
    changePasswordModal.classList.add('active');
}

function closeChangePasswordModal() {
    changePasswordModal.classList.remove('active');
}

async function changePassword() {
    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (!currentPassword || !newPassword || !confirmPassword) {
        showNotification('Preencha todos os campos.', 'error');
        return;
    }
    if (newPassword.length < 6) {
        showNotification('A nova senha deve ter pelo menos 6 caracteres.', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showNotification('As senhas não coincidem.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/auth/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await response.json();
        if (response.ok) {
            showNotification('Senha alterada com sucesso!', 'success');
            closeChangePasswordModal();
        } else {
            showNotification(data.message || 'Erro ao trocar senha.', 'error');
        }
    } catch (error) {
        showNotification('Erro ao trocar senha.', 'error');
    }
}

// ==================== EVENT LISTENERS ====================

uploadArea.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    addFilesToQueue(e.target.files);
    fileInput.value = '';
});

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    addFilesToQueue(e.dataTransfer.files);
});

document.getElementById('uploadBtn').addEventListener('click', uploadQueue);

document.getElementById('clearQueueBtn').addEventListener('click', clearQueue);

refreshBtn.addEventListener('click', () => {
    loadFiles();
    loadStats();
    showNotification('Atualizado!', 'success');
});

modalClose.addEventListener('click', () => previewModal.classList.remove('active'));
previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) previewModal.classList.remove('active');
});

applyFiltersBtn.addEventListener('click', () => searchFiles());
clearFiltersBtn.addEventListener('click', clearFilters);
filterSearch.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchFiles();
});

editTagsModalClose.addEventListener('click', closeEditTagsModal);
cancelTagsBtn.addEventListener('click', closeEditTagsModal);
editTagsModal.addEventListener('click', (e) => {
    if (e.target === editTagsModal) closeEditTagsModal();
});
saveTagsBtn.addEventListener('click', saveEditedTags);

changePasswordModalClose.addEventListener('click', closeChangePasswordModal);
cancelPasswordBtn.addEventListener('click', closeChangePasswordModal);
changePasswordModal.addEventListener('click', (e) => {
    if (e.target === changePasswordModal) closeChangePasswordModal();
});
savePasswordBtn.addEventListener('click', changePassword);
[currentPasswordInput, newPasswordInput, confirmPasswordInput].forEach(input => {
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') changePassword(); });
});

// ==================== INICIALIZAÇÃO ====================

async function init() {
    const isAuth = await checkAuth();
    if (isAuth) {
        loadFiles();
        loadStats();
        loadTags();
    }
}

init();

// Animações
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);
