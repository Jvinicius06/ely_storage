// Elementos do DOM
const migrationForm = document.getElementById('migrationForm');
const botTokenInput = document.getElementById('botToken');
const sourceChannelIdInput = document.getElementById('sourceChannelId');
const sourceThreadIdInput = document.getElementById('sourceThreadId');
const targetWebhookUrlInput = document.getElementById('targetWebhookUrl');
const targetThreadIdInput = document.getElementById('targetThreadId');
const startMigrationBtn = document.getElementById('startMigrationBtn');
const currentUserSpan = document.getElementById('currentUser');
const progressSection = document.getElementById('progressSection');
const statusText = document.getElementById('statusText');
const statusMessage = document.getElementById('statusMessage');
const progressBarContainer = document.getElementById('progressBarContainer');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const progressCount = document.getElementById('progressCount');
const activityLog = document.getElementById('activityLog');
const statsSection = document.getElementById('statsSection');
const resetBtn = document.getElementById('resetBtn');
const errorsDetails = document.getElementById('errorsDetails');
const errorsList = document.getElementById('errorsList');

// Stats elements
const statTotalMessages = document.getElementById('statTotalMessages');
const statMessagesWithFiles = document.getElementById('statMessagesWithFiles');
const statFilesProcessed = document.getElementById('statFilesProcessed');
const statFilesUploaded = document.getElementById('statFilesUploaded');
const statMessagesPosted = document.getElementById('statMessagesPosted');
const statErrors = document.getElementById('statErrors');

// Constantes
const API_URL = window.location.origin;
let currentUser = null;

// ==================== FUNÇÕES AUXILIARES ====================

// Formatar data/hora
function formatTime() {
    const now = new Date();
    return now.toLocaleTimeString('pt-BR');
}

// Adicionar log de atividade
function addLog(message, type = 'info') {
    const logEntry = document.createElement('div');
    logEntry.style.cssText = `
        padding: 8px;
        margin-bottom: 5px;
        border-left: 3px solid ${type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--primary)'};
        background: white;
        border-radius: 4px;
    `;
    logEntry.innerHTML = `<strong>[${formatTime()}]</strong> ${message}`;
    activityLog.appendChild(logEntry);

    // Auto scroll para o final
    activityLog.scrollTop = activityLog.scrollHeight;
}

// Mostrar notificação
function showNotification(message, type = 'info') {
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

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Atualizar progresso
function updateProgress(processed, total) {
    const percentage = total > 0 ? (processed / total) * 100 : 0;
    progressBar.style.width = `${percentage}%`;
    progressCount.textContent = `${processed}/${total}`;
}

// ==================== AUTENTICAÇÃO ====================

// Verificar se está autenticado
async function checkAuth() {
    try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
            credentials: 'include'
        });

        if (!response.ok) {
            window.location.href = '/login.html';
            return false;
        }

        const data = await response.json();
        currentUser = data.user;
        currentUserSpan.textContent = currentUser.username;
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

// ==================== MIGRAÇÃO ====================

// Processar eventos de progresso
function handleProgressEvent(data) {
    const { status, message, total, processed, stats } = data;

    // Atualizar status
    statusText.textContent = message || status;

    // Colorir status message baseado no estado
    if (status === 'error') {
        statusMessage.style.background = '#fee';
        statusMessage.style.color = 'var(--danger)';
    } else if (status === 'completed') {
        statusMessage.style.background = '#efe';
        statusMessage.style.color = 'var(--success)';
    } else {
        statusMessage.style.background = 'var(--light-gray)';
        statusMessage.style.color = 'var(--text)';
    }

    // Adicionar ao log
    addLog(message || status, status === 'error' ? 'error' : status === 'completed' ? 'success' : 'info');

    // Atualizar barra de progresso
    if (total !== undefined && processed !== undefined) {
        progressBarContainer.style.display = 'block';
        updateProgress(processed, total);
    }

    // Se completado, mostrar estatísticas
    if (status === 'completed' && stats) {
        showStatistics(stats);
    }

    // Se erro, habilitar reset
    if (status === 'error' || status === 'completed') {
        startMigrationBtn.disabled = false;
        resetBtn.style.display = 'inline-block';
    }
}

// Mostrar estatísticas finais
function showStatistics(stats) {
    statsSection.style.display = 'block';

    statTotalMessages.textContent = stats.totalMessages || 0;
    statMessagesWithFiles.textContent = stats.messagesWithFiles || 0;
    statFilesProcessed.textContent = stats.filesProcessed || 0;
    statFilesUploaded.textContent = stats.filesUploaded || 0;
    statMessagesPosted.textContent = stats.messagesPosted || 0;
    statErrors.textContent = stats.errors?.length || 0;

    // Mostrar detalhes de erros se houver
    if (stats.errors && stats.errors.length > 0) {
        errorsDetails.style.display = 'block';
        errorsList.innerHTML = stats.errors.map(err => `
            <div style="padding: 8px; margin-bottom: 5px; background: white; border-radius: 4px;">
                <strong>Mensagem ID:</strong> ${err.messageId || 'N/A'}<br>
                ${err.url ? `<strong>URL:</strong> ${err.url}<br>` : ''}
                <strong>Erro:</strong> ${err.error}
            </div>
        `).join('');
    }
}

// Iniciar migração
async function startMigration(botToken, sourceChannelId, targetWebhookUrl, sourceThreadId = null, targetThreadId = null) {
    try {
        // Resetar UI
        activityLog.innerHTML = '';
        progressBarContainer.style.display = 'none';
        statsSection.style.display = 'none';
        errorsDetails.style.display = 'none';
        progressSection.style.display = 'block';
        resetBtn.style.display = 'none';

        // Desabilitar botão
        startMigrationBtn.disabled = true;
        startMigrationBtn.textContent = '⏳ Migrando...';

        addLog('Conectando ao servidor...', 'info');

        // Preparar body
        const requestBody = { botToken, sourceChannelId, targetWebhookUrl };
        if (sourceThreadId) {
            requestBody.sourceThreadId = sourceThreadId;
        }
        if (targetThreadId) {
            requestBody.targetThreadId = targetThreadId;
        }

        // Fazer request com EventSource para receber progresso em tempo real
        const response = await fetch(`${API_URL}/api/discord/migrate-channel`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Erro ao iniciar migração');
        }

        // Ler stream de eventos
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonData = line.substring(6);
                    try {
                        const data = JSON.parse(jsonData);
                        handleProgressEvent(data);
                    } catch (e) {
                        console.error('Erro ao parsear JSON:', e, jsonData);
                    }
                }
            }
        }

    } catch (error) {
        console.error('Erro na migração:', error);
        showNotification(error.message, 'error');
        addLog(`ERRO: ${error.message}`, 'error');
        statusText.textContent = `Erro: ${error.message}`;
        statusMessage.style.background = '#fee';
        statusMessage.style.color = 'var(--danger)';
        startMigrationBtn.disabled = false;
        startMigrationBtn.textContent = '🚀 Iniciar Migração';
        resetBtn.style.display = 'inline-block';
    }
}

// Resetar para nova migração
function resetMigration() {
    progressSection.style.display = 'none';
    startMigrationBtn.disabled = false;
    startMigrationBtn.textContent = '🚀 Iniciar Migração';
    botTokenInput.value = '';
    sourceChannelIdInput.value = '';
    sourceThreadIdInput.value = '';
    targetWebhookUrlInput.value = '';
    targetThreadIdInput.value = '';
}

// ==================== EVENT LISTENERS ====================

migrationForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const botToken = botTokenInput.value.trim();
    const sourceChannelId = sourceChannelIdInput.value.trim();
    const sourceThreadId = sourceThreadIdInput.value.trim();
    const targetWebhookUrl = targetWebhookUrlInput.value.trim();
    const targetThreadId = targetThreadIdInput.value.trim();

    if (!botToken || !sourceChannelId || !targetWebhookUrl) {
        showNotification('Por favor, preencha todos os campos obrigatórios.', 'error');
        return;
    }

    // Validar formato do webhook
    if (!targetWebhookUrl.includes('discord.com/api/webhooks/')) {
        showNotification('URL de webhook inválida. Deve conter "discord.com/api/webhooks/"', 'error');
        return;
    }

    // Validar channel ID (deve ser numérico)
    if (!/^\d+$/.test(sourceChannelId)) {
        showNotification('ID do canal deve ser numérico.', 'error');
        return;
    }

    // Validar source thread ID se fornecido (deve ser numérico)
    if (sourceThreadId && !/^\d+$/.test(sourceThreadId)) {
        showNotification('ID da thread de origem deve ser numérico.', 'error');
        return;
    }

    // Validar target thread ID se fornecido (deve ser numérico)
    if (targetThreadId && !/^\d+$/.test(targetThreadId)) {
        showNotification('ID da thread de destino deve ser numérico.', 'error');
        return;
    }

    // Validar bot token (formato básico)
    if (botToken.length < 50) {
        showNotification('Token de bot inválido. Verifique se copiou o token completo.', 'error');
        return;
    }

    // Confirmar antes de iniciar
    const sourceDescription = sourceThreadId ? `thread ${sourceThreadId} do canal ${sourceChannelId}` : `canal ${sourceChannelId}`;
    const targetDescription = targetThreadId ? `thread ${targetThreadId}` : `canal de destino`;
    if (!confirm(`Tem certeza que deseja migrar a ${sourceDescription}?\n\nIsso pode levar vários minutos dependendo da quantidade de arquivos.\n\nAs mensagens serão repostadas na ${targetDescription}.`)) {
        return;
    }

    await startMigration(botToken, sourceChannelId, targetWebhookUrl, sourceThreadId || null, targetThreadId || null);
});

// ==================== INICIALIZAÇÃO ====================

async function init() {
    const isAuth = await checkAuth();
    if (!isAuth) {
        return;
    }
}

init();

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
