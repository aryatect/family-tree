// ============================================================
// PASSWORD AUTHENTICATION GATE
// ============================================================
//
// To change the password:
// 1. Open browser console (F12)
// 2. Run this command with your new password:
//    crypto.subtle.digest('SHA-256', new TextEncoder().encode('your-new-password'))
//      .then(buf => console.log(Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')))
// 3. Copy the hex string and replace PASSWORD_HASH below
//
// Default password: family123
// ============================================================

const PASSWORD_HASH = '0de502ac9741cf67868b8341dd858ef95822cb80ef8d616916afb6fa1654f85d';
const SESSION_KEY = 'familyTreeAuth';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function isSessionValid() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (!session || !session.timestamp) return false;
    return Date.now() - session.timestamp < SESSION_DURATION_MS;
  } catch {
    return false;
  }
}

function createSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    timestamp: Date.now(),
    token: crypto.randomUUID()
  }));
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}

export function requireAuth() {
  return new Promise((resolve) => {
    if (isSessionValid()) {
      resolve();
      return;
    }
    renderLoginScreen(resolve);
  });
}

function renderLoginScreen(onSuccess) {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-card">
      <div class="auth-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h2 class="auth-title">Family Tree</h2>
      <p class="auth-subtitle">Enter password to continue</p>
      <form id="auth-form" class="auth-form">
        <input type="password" id="auth-password" class="input auth-input" placeholder="Password" autocomplete="current-password" autofocus />
        <p id="auth-error" class="auth-error"></p>
        <button type="submit" class="btn btn-primary auth-btn">Unlock</button>
      </form>
    </div>
  `;

  document.body.prepend(overlay);

  const form = overlay.querySelector('#auth-form');
  const input = overlay.querySelector('#auth-password');
  const error = overlay.querySelector('#auth-error');
  const card = overlay.querySelector('.auth-card');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = input.value;
    if (!password) return;

    const hash = await sha256(password);
    if (hash === PASSWORD_HASH) {
      createSession();
      overlay.remove();
      onSuccess();
    } else {
      error.textContent = 'Incorrect password';
      input.value = '';
      input.focus();
      card.classList.remove('auth-shake');
      void card.offsetWidth; // force reflow
      card.classList.add('auth-shake');
    }
  });

  input.focus();
}
