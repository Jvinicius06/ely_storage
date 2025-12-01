// Elementos do DOM
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const tagsInput = document.getElementById('tagsInput');
const descriptionInput = document.getElementById('descriptionInput');
const filesGrid = document.getElementById('filesGrid');
const refreshBtn = document.getElementById('refreshBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const previewModal = document.getElementById('previewModal');
const modalClose = document.getElementById('modalClose');
const modalBody = document.getElementById('modalBody');
const currentUserSpan = document.getElementById('currentUser');
const adminBtn = document.getElementById('adminBtn');

// Paginação
let currentPage = 0;
let limitPerPage = 50; // 50 arquivos por página
let totalFiles = 0;
let hasMoreFiles = false;

// Filtros
const filterSearch = document.getElementById('filterSearch');
const filterType = document.getElementById('filterType');
const filterTag = document.getElementById('filterTag');
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

// Variável global para armazenar o ID do arquivo sendo editado
let currentEditingFileId = null;

// Variável global para armazenar usuário atual
let currentUser = null;

// Constantes
const API_URL = window.location.origin;

// ==================== FUNÇÕES AUXILIARES ====================

// Formatar tamanho de arquivo
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Formatar data
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('pt-BR');
}

// Verificar autenticação
async function checkAuth() {
    try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
            credentials: 'include'
        });

        if (!response.ok) {
            // Não autenticado, redirecionar para login
            window.location.href = '/login.html';
            return false;
        }

        const data = await response.json();
        currentUser = data.user;
        currentUserSpan.textContent = currentUser.username;

        // Mostrar botão de admin se for admin
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

// Logout
async function logout() {
    try {
        await fetch(`${API_URL}/api/auth/logout`, {
            method: 'POST',
            credentials: 'include'
        });

        window.location.href = '/login.html';
    } catch (error) {
        console.error('Erro ao fazer logout:', error);
        showNotification('Erro ao fazer logout', 'error');
    }
}

// Mostrar notificação
function showNotification(message, type = 'info') {
    // Criar elemento de notificação
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 20px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#667eea'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 2000;
        animation: slideIn 0.3s ease;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Remover após 3 segundos
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
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

// ==================== UPLOAD ====================

// Upload de arquivo
async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    // Adicionar tags e description se fornecidos
    const tags = tagsInput.value.trim();
    const description = descriptionInput.value.trim();
    if (tags) formData.append('tags', tags);
    if (description) formData.append('description', description);

    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';

    try {
        const xhr = new XMLHttpRequest();

        // Progress listener
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percentComplete + '%';
                progressText.textContent = percentComplete + '%';
            }
        });

        // Complete listener
        xhr.addEventListener('load', () => {
            progressContainer.style.display = 'none';

            if (xhr.status === 201) {
                const response = JSON.parse(xhr.responseText);
                showNotification('Arquivo enviado com sucesso!', 'success');

                // Limpar campos de tags e descrição
                tagsInput.value = '';
                descriptionInput.value = '';

                loadFiles();
                loadStats();
                loadTags(); // Recarregar tags disponíveis
            } else {
                const error = JSON.parse(xhr.responseText);
                showNotification(`Erro: ${error.message}`, 'error');
            }
        });

        // Error listener
        xhr.addEventListener('error', () => {
            progressContainer.style.display = 'none';
            showNotification('Erro ao enviar arquivo!', 'error');
        });

        xhr.open('POST', `${API_URL}/api/upload`);
        xhr.withCredentials = true; // Incluir cookies de sessão
        xhr.send(formData);
    } catch (error) {
        progressContainer.style.display = 'none';
        showNotification('Erro ao enviar arquivo!', 'error');
        console.error('Erro:', error);
    }
}

// ==================== LISTAGEM ====================

// Carregar arquivos com paginação
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

// Variável global para rastrear se há vídeos em conversão
let hasVideosConverting = false;
let autoRefreshInterval = null;

// Renderizar arquivos
function renderFiles(files) {
    if (files.length === 0) {
        filesGrid.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                </svg>
                <h3>Nenhum arquivo enviado ainda</h3>
                <p>Faça upload de arquivos usando a área acima</p>
            </div>
        `;
        stopAutoRefresh();
        return;
    }

    // Verificar se há vídeos em conversão (pending ou processing)
    hasVideosConverting = files.some(file =>
        file.file_type === 'video' &&
        (file.conversion_status === 'pending' || file.conversion_status === 'processing')
    );

    // Iniciar auto-refresh se houver vídeos convertendo
    if (hasVideosConverting) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }

    filesGrid.innerHTML = files.map(file => {
        const preview = getFilePreview(file);
        const tags = file.tags ? file.tags.split(',').map(t => t.trim()).filter(t => t) : [];
        const tagsHTML = tags.map(tag => `<span class="tag">${tag}</span>`).join('');

        // Verificar se o usuário pode deletar/editar este arquivo
        const canModify = currentUser && (currentUser.role === 'admin' || file.uploaded_by === currentUser.id);
        const isAdmin = currentUser && currentUser.role === 'admin';

        // Informação de quem fez upload
        const uploaderInfo = file.uploaded_by_username
            ? `Enviado por: ${file.uploaded_by_username}`
            : 'Enviado via API';

        // Status de conversão de vídeo
        let conversionStatusHTML = '';
        let downloadLink = file.download_url;
        let videoInfoHTML = '';

        if (file.file_type === 'video') {
            // Determinar qual link usar
            if (file.converted_url && file.conversion_status === 'completed') {
                // Vídeo convertido - usuários normais veem apenas o convertido
                downloadLink = isAdmin ? file.download_url : file.converted_url;
            }

            // Badge de status de conversão
            if (file.conversion_status === 'pending') {
                conversionStatusHTML = '<span class="conversion-badge conversion-pending">🕐 Na Fila</span>';
            } else if (file.conversion_status === 'processing') {
                conversionStatusHTML = '<span class="conversion-badge conversion-processing">⚙️ Convertendo...</span>';
            } else if (file.conversion_status === 'completed') {
                conversionStatusHTML = '<span class="conversion-badge conversion-completed">✅ Otimizado</span>';

                // Informações do vídeo
                if (file.video_duration) {
                    const minutes = Math.floor(file.video_duration / 60);
                    const seconds = file.video_duration % 60;
                    videoInfoHTML = `<div class="file-meta" style="margin-top: 3px; font-size: 0.75rem; color: #888;">
                        🎬 ${minutes}:${seconds.toString().padStart(2, '0')}
                    </div>`;
                }
            } else if (file.conversion_status === 'failed') {
                conversionStatusHTML = '<span class="conversion-badge conversion-failed">❌ Erro na Conversão</span>';
            }
        }

        return `
            <div class="file-card">
                <div class="file-preview" onclick="openPreview(${file.id})">
                    ${preview}
                    ${conversionStatusHTML ? `<div class="conversion-overlay">${conversionStatusHTML}</div>` : ''}
                </div>
                <div class="file-info">
                    <div class="file-name" title="${file.original_name}">${file.original_name}</div>
                    <div class="file-meta">
                        ${formatFileSize(file.size)} • ${formatDate(file.uploaded_at)}
                    </div>
                    ${videoInfoHTML}
                    <div class="file-meta" style="margin-top: 5px; font-size: 0.8rem; color: var(--primary);">
                        ${uploaderInfo}
                    </div>
                    <div class="file-tags">
                        ${tagsHTML}
                    </div>
                    <div class="file-actions">
                        <button class="btn btn-primary" onclick="copyLink('${downloadLink}')">
                            📋 ${file.file_type === 'video' && file.converted_url && !isAdmin ? 'MP4' : 'Link'}
                        </button>
                        ${isAdmin && file.file_type === 'video' && file.converted_url ? `
                            <button class="btn btn-secondary" onclick="copyLink('${file.converted_url}')" title="Link do MP4 convertido">
                                📋 MP4
                            </button>
                        ` : ''}
                        ${canModify ? `
                            <button class="btn btn-secondary" onclick="openEditTagsModal(${file.id})">
                                🏷️ Tags
                            </button>
                            <button class="btn btn-danger" onclick="deleteFile(${file.id}, '${file.stored_name}')">
                                🗑️
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Renderizar controles de paginação
function renderPagination() {
    let paginationContainer = document.getElementById('paginationContainer');

    // Criar container se não existir
    if (!paginationContainer) {
        paginationContainer = document.createElement('div');
        paginationContainer.id = 'paginationContainer';
        paginationContainer.className = 'pagination-container';
        filesGrid.parentNode.appendChild(paginationContainer);
    }

    // Calcular informações
    const startItem = currentPage * limitPerPage + 1;
    const endItem = Math.min((currentPage + 1) * limitPerPage, totalFiles);
    const totalPages = Math.ceil(totalFiles / limitPerPage);

    if (totalFiles === 0) {
        paginationContainer.innerHTML = '';
        return;
    }

    paginationContainer.innerHTML = `
        <div class="pagination-info">
            Mostrando ${startItem}-${endItem} de ${totalFiles} arquivos
        </div>
        <div class="pagination-buttons">
            <button
                class="btn btn-secondary"
                ${currentPage === 0 ? 'disabled' : ''}
                onclick="loadFiles(0)"
                title="Primeira página"
            >
                ⏮️ Primeira
            </button>
            <button
                class="btn btn-secondary"
                ${currentPage === 0 ? 'disabled' : ''}
                onclick="loadFiles(${currentPage - 1})"
                title="Página anterior"
            >
                ⬅️ Anterior
            </button>
            <span class="pagination-current">
                Página ${currentPage + 1} de ${totalPages}
            </span>
            <button
                class="btn btn-secondary"
                ${!hasMoreFiles ? 'disabled' : ''}
                onclick="loadFiles(${currentPage + 1})"
                title="Próxima página"
            >
                Próxima ➡️
            </button>
            <button
                class="btn btn-secondary"
                ${!hasMoreFiles ? 'disabled' : ''}
                onclick="loadFiles(${totalPages - 1})"
                title="Última página"
            >
                Última ⏭️
            </button>
        </div>
    `;
}

// Obter preview do arquivo
function getFilePreview(file) {
    const url = file.download_url;

    if (file.file_type === 'image') {
        return `<img src="${url}" alt="${file.original_name}">`;
    } else if (file.file_type === 'video') {
        return `<video src="${url}" preload="metadata"></video>`;
    } else if (file.file_type === 'audio') {
        return `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path>
            </svg>
        `;
    } else {
        return `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
            </svg>
        `;
    }
}

// ==================== AÇÕES ====================

// Abrir preview
async function openPreview(fileId) {
    try {
        const response = await fetch(`${API_URL}/api/files/${fileId}`);
        const data = await response.json();

        if (data.success) {
            const file = data.file;
            let content = '';

            if (file.file_type === 'image') {
                content = `<img src="${file.download_url}" alt="${file.original_name}">`;
            } else if (file.file_type === 'video') {
                content = `<video src="${file.download_url}" controls style="max-width: 100%;"></video>`;
            } else if (file.file_type === 'audio') {
                content = `
                    <h3>${file.original_name}</h3>
                    <audio src="${file.download_url}" controls></audio>
                `;
            } else {
                content = `
                    <h3>${file.original_name}</h3>
                    <p>Tipo: ${file.mime_type}</p>
                    <p>Tamanho: ${formatFileSize(file.size)}</p>
                    <a href="${file.download_url}" target="_blank" class="btn btn-primary">Abrir arquivo</a>
                `;
            }

            modalBody.innerHTML = content;
            previewModal.classList.add('active');
        }
    } catch (error) {
        console.error('Erro ao abrir preview:', error);
        showNotification('Erro ao abrir preview', 'error');
    }
}

// Copiar link
function copyLink(url) {
    // Verificar se a API Clipboard está disponível
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
            showNotification('✅ Link copiado!', 'success');
        }).catch(() => {
            showNotification('❌ Erro ao copiar link', 'error');
        });
    } else {
        // Fallback para navegadores antigos ou HTTP
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();

        try {
            document.execCommand('copy');
            showNotification('✅ Link copiado!', 'success');
        } catch (err) {
            showNotification('❌ Erro ao copiar link', 'error');
        }

        document.body.removeChild(textarea);
    }
}

// Deletar arquivo
async function deleteFile(fileId, fileName) {
    if (!confirm(`Tem certeza que deseja deletar "${fileName}"?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/files/${fileId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json();

        if (data.success) {
            showNotification('Arquivo deletado!', 'success');
            loadFiles();
            loadStats();
        } else {
            showNotification(`Erro: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Erro ao deletar arquivo:', error);
        showNotification('Erro ao deletar arquivo', 'error');
    }
}

// ==================== TAGS E FILTROS ====================

// Carregar todas as tags disponíveis
async function loadTags() {
    try {
        const response = await fetch(`${API_URL}/api/tags`);
        const data = await response.json();

        if (data.success) {
            const tags = data.tags;
            filterTag.innerHTML = '<option value="">Todas</option>' +
                tags.map(tag => `<option value="${tag}">${tag}</option>`).join('');
        }
    } catch (error) {
        console.error('Erro ao carregar tags:', error);
    }
}

// Buscar arquivos com filtros e paginação
async function searchFiles(page = 0) {
    try {
        currentPage = page;
        const offset = page * limitPerPage;

        const search = filterSearch.value.trim();
        const type = filterType.value;
        const tag = filterTag.value;

        const params = new URLSearchParams();
        params.append('limit', limitPerPage);
        params.append('offset', offset);
        if (search) params.append('search', search);
        if (type) params.append('fileType', type);
        if (tag) params.append('tag', tag);

        // Se tem filtros, usa /api/search, senão usa /api/files
        const hasFilters = search || type || tag;
        const url = hasFilters
            ? `${API_URL}/api/search?${params.toString()}`
            : `${API_URL}/api/files?${params.toString()}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.success) {
            // Se é busca com filtros, calcular total e hasMore manualmente
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
        console.error('Erro ao buscar arquivos:', error);
        showNotification('Erro ao buscar arquivos', 'error');
    }
}

// Limpar filtros
function clearFilters() {
    filterSearch.value = '';
    filterType.value = '';
    filterTag.value = '';
    loadFiles();
}

// Abrir modal de edição de tags
async function openEditTagsModal(fileId) {
    try {
        const response = await fetch(`${API_URL}/api/files/${fileId}`);
        const data = await response.json();

        if (data.success) {
            const file = data.file;
            currentEditingFileId = fileId;
            editTagsInput.value = file.tags || '';
            editDescriptionInput.value = file.description || '';
            editTagsModal.classList.add('active');
        }
    } catch (error) {
        console.error('Erro ao carregar arquivo:', error);
        showNotification('Erro ao carregar arquivo', 'error');
    }
}

// Salvar tags editadas
async function saveEditedTags() {
    if (!currentEditingFileId) return;

    const tags = editTagsInput.value.trim();
    const description = editDescriptionInput.value.trim();

    try {
        const response = await fetch(`${API_URL}/api/files/${currentEditingFileId}/tags`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ tags, description })
        });

        const data = await response.json();

        if (data.success) {
            showNotification('Tags atualizadas!', 'success');
            editTagsModal.classList.remove('active');
            currentEditingFileId = null;
            loadFiles();
            loadTags();
        } else {
            showNotification(`Erro: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Erro ao atualizar tags:', error);
        showNotification('Erro ao atualizar tags', 'error');
    }
}

// Fechar modal de edição de tags
function closeEditTagsModal() {
    editTagsModal.classList.remove('active');
    currentEditingFileId = null;
}

// ==================== TROCAR SENHA ====================

// Abrir modal de trocar senha
function openChangePasswordModal() {
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
    changePasswordModal.classList.add('active');
}

// Fechar modal de trocar senha
function closeChangePasswordModal() {
    changePasswordModal.classList.remove('active');
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
}

// Trocar senha
async function changePassword() {
    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    // Validações
    if (!currentPassword || !newPassword || !confirmPassword) {
        showNotification('Por favor, preencha todos os campos.', 'error');
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
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                currentPassword,
                newPassword
            })
        });

        const data = await response.json();

        if (response.ok) {
            showNotification('Senha alterada com sucesso!', 'success');
            closeChangePasswordModal();
        } else {
            showNotification(data.message || 'Erro ao trocar senha.', 'error');
        }
    } catch (error) {
        console.error('Erro ao trocar senha:', error);
        showNotification('Erro ao trocar senha.', 'error');
    }
}

// ==================== EVENT LISTENERS ====================

// Click na área de upload
uploadArea.addEventListener('click', () => {
    fileInput.click();
});

// Selecionar arquivos
fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => uploadFile(file));
    fileInput.value = ''; // Limpar input
});

// Drag and drop
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');

    const files = Array.from(e.dataTransfer.files);
    files.forEach(file => uploadFile(file));
});

// Botão de refresh
refreshBtn.addEventListener('click', () => {
    loadFiles();
    loadStats();
    showNotification('✅ Atualizado!', 'success');
});

// Fechar modal
modalClose.addEventListener('click', () => {
    previewModal.classList.remove('active');
});

previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) {
        previewModal.classList.remove('active');
    }
});

// Aplicar filtros
applyFiltersBtn.addEventListener('click', () => {
    searchFiles();
});

// Limpar filtros
clearFiltersBtn.addEventListener('click', () => {
    clearFilters();
});

// Enter na busca para aplicar filtros
filterSearch.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        searchFiles();
    }
});

// Fechar modal de editar tags
editTagsModalClose.addEventListener('click', closeEditTagsModal);

cancelTagsBtn.addEventListener('click', closeEditTagsModal);

editTagsModal.addEventListener('click', (e) => {
    if (e.target === editTagsModal) {
        closeEditTagsModal();
    }
});

// Salvar tags editadas
saveTagsBtn.addEventListener('click', saveEditedTags);

// Fechar modal de trocar senha
changePasswordModalClose.addEventListener('click', closeChangePasswordModal);

cancelPasswordBtn.addEventListener('click', closeChangePasswordModal);

changePasswordModal.addEventListener('click', (e) => {
    if (e.target === changePasswordModal) {
        closeChangePasswordModal();
    }
});

// Salvar nova senha
savePasswordBtn.addEventListener('click', changePassword);

// Enter nos campos de senha para submeter
currentPasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') changePassword();
});

newPasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') changePassword();
});

confirmPasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') changePassword();
});

// ==================== INICIALIZAÇÃO ====================

// Inicializar aplicação
async function init() {
    const isAuth = await checkAuth();
    if (isAuth) {
        loadFiles();
        loadStats();
        loadTags();
    }
}

// Carregar dados ao iniciar
init();

// ==================== AUTO-REFRESH PARA VÍDEOS EM CONVERSÃO ====================

// Iniciar auto-refresh (atualizar a cada 10 segundos)
function startAutoRefresh() {
    // Se já existe um intervalo, não criar outro
    if (autoRefreshInterval) {
        return;
    }

    console.log('🔄 Auto-refresh ativado para vídeos em conversão');

    autoRefreshInterval = setInterval(() => {
        console.log('🔄 Atualizando status de conversão...');
        loadFiles(currentPage);
    }, 10000); // 10 segundos
}

// Parar auto-refresh
function stopAutoRefresh() {
    if (autoRefreshInterval) {
        console.log('⏹️ Auto-refresh desativado');
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

// Limpar intervalo ao sair da página
window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
});

// Adicionar estilos de animação
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }

    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);
