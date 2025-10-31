// Elementos do DOM
const createUserForm = document.getElementById('createUserForm');
const newUsernameInput = document.getElementById('newUsername');
const newPasswordInput = document.getElementById('newPassword');
const newRoleSelect = document.getElementById('newRole');
const usersTable = document.getElementById('usersTable');
const refreshBtn = document.getElementById('refreshBtn');
const currentUserSpan = document.getElementById('currentUser');
const totalUsersSpan = document.getElementById('totalUsers');

// Constantes
const API_URL = window.location.origin;
let currentUser = null;

// ==================== FUNÇÕES AUXILIARES ====================

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

// Formatar data
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('pt-BR');
}

// ==================== AUTENTICAÇÃO ====================

// Verificar se está autenticado e se é admin
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

        // Verificar se é admin
        if (currentUser.role !== 'admin') {
            showNotification('Acesso negado. Apenas administradores podem acessar esta página.', 'error');
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
            return false;
        }

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

// ==================== USUÁRIOS ====================

// Carregar usuários
async function loadUsers() {
    try {
        const response = await fetch(`${API_URL}/api/users`, {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Erro ao carregar usuários');
        }

        const data = await response.json();
        renderUsers(data.users);
        totalUsersSpan.textContent = data.count;
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
        showNotification('Erro ao carregar usuários', 'error');
    }
}

// Renderizar usuários
function renderUsers(users) {
    if (users.length === 0) {
        usersTable.innerHTML = `
            <div class="empty-state">
                <h3>Nenhum usuário encontrado</h3>
                <p>Crie um novo usuário usando o formulário acima</p>
            </div>
        `;
        return;
    }

    const tableHTML = `
        <table style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr style="background: var(--light-gray); text-align: left;">
                    <th style="padding: 15px;">ID</th>
                    <th style="padding: 15px;">Username</th>
                    <th style="padding: 15px;">Função</th>
                    <th style="padding: 15px;">Criado em</th>
                    <th style="padding: 15px;">Ações</th>
                </tr>
            </thead>
            <tbody>
                ${users.map(user => `
                    <tr style="border-bottom: 1px solid var(--border);">
                        <td style="padding: 15px;">${user.id}</td>
                        <td style="padding: 15px; font-weight: 600;">${user.username}</td>
                        <td style="padding: 15px;">
                            <span style="
                                padding: 4px 12px;
                                border-radius: 12px;
                                font-size: 0.85rem;
                                font-weight: 500;
                                background: ${user.role === 'admin' ? 'var(--warning)' : 'var(--primary)'};
                                color: white;
                            ">
                                ${user.role === 'admin' ? 'Admin' : 'Usuário'}
                            </span>
                        </td>
                        <td style="padding: 15px;">${formatDate(user.created_at)}</td>
                        <td style="padding: 15px;">
                            ${user.id !== currentUser.id ? `
                                <button
                                    class="btn btn-danger"
                                    onclick="deleteUser(${user.id}, '${user.username}')"
                                    style="padding: 8px 16px; font-size: 0.85rem;"
                                >
                                    Deletar
                                </button>
                            ` : `
                                <span style="color: var(--gray); font-size: 0.85rem;">Você</span>
                            `}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    usersTable.innerHTML = tableHTML;
}

// Criar usuário
createUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = newUsernameInput.value.trim();
    const password = newPasswordInput.value;
    const role = newRoleSelect.value;

    if (!username || !password) {
        showNotification('Por favor, preencha todos os campos.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ username, password, role })
        });

        const data = await response.json();

        if (response.ok) {
            showNotification('Usuário criado com sucesso!', 'success');
            newUsernameInput.value = '';
            newPasswordInput.value = '';
            newRoleSelect.value = 'user';
            loadUsers();
        } else {
            showNotification(data.message || 'Erro ao criar usuário', 'error');
        }
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        showNotification('Erro ao criar usuário', 'error');
    }
});

// Deletar usuário
async function deleteUser(userId, username) {
    if (!confirm(`Tem certeza que deseja deletar o usuário "${username}"?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json();

        if (response.ok) {
            showNotification('Usuário deletado com sucesso!', 'success');
            loadUsers();
        } else {
            showNotification(data.message || 'Erro ao deletar usuário', 'error');
        }
    } catch (error) {
        console.error('Erro ao deletar usuário:', error);
        showNotification('Erro ao deletar usuário', 'error');
    }
}

// ==================== EVENT LISTENERS ====================

refreshBtn.addEventListener('click', () => {
    loadUsers();
    showNotification('Atualizado!', 'success');
});

// ==================== INICIALIZAÇÃO ====================

async function init() {
    const isAuth = await checkAuth();
    if (isAuth) {
        loadUsers();
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
