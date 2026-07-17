/**
 * Login page logic — kept in an external file so the CSP can forbid inline
 * <script> (script-src 'self' without 'unsafe-inline').
 */

// Redirect if already logged in
if (API.isLoggedIn()) {
  window.location.href = '/admin.html';
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const errorMsg = document.getElementById('errorMsg');

  btn.disabled = true;
  btn.textContent = 'Anmelden...';
  errorMsg.style.display = 'none';

  try {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    await API.login(username, password);
    window.location.href = '/admin.html';
  } catch (err) {
    errorMsg.textContent = err.message;
    errorMsg.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});
