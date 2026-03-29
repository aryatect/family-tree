import { loadData, getState, setFamilyName, addMember, exportData, importData, resetToFile, subscribe } from './data-store.js';
import { initTree, renderTree, fitToScreen, zoomToMember, expandAll, collapseAll } from './tree-renderer.js';
import { initSidePanel, openPanel, closePanel } from './side-panel.js';
import { debounce } from './utils.js';
import { requireAuth, logout } from './auth.js';
import { getToken, setToken, hasToken, onSyncStatus, getSyncStatus, fetchFromGithub } from './github-sync.js';

async function init() {
  await loadData();

  const treeContainer = document.getElementById('tree-container');
  const sidePanel = document.getElementById('side-panel');
  const familyNameEl = document.getElementById('family-name');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');

  // Init tree
  initTree(treeContainer, (memberId) => openPanel(memberId));

  // Init side panel
  initSidePanel(sidePanel, () => renderTree());

  // Family name
  const state = getState();
  familyNameEl.textContent = state.familyName || 'My Family';
  familyNameEl.addEventListener('blur', () => {
    const name = familyNameEl.textContent.trim();
    if (name) setFamilyName(name);
  });
  familyNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); familyNameEl.blur(); }
  });

  // Add person button
  document.getElementById('btn-add-person').addEventListener('click', () => {
    showAddPersonDialog();
  });

  // Import
  document.getElementById('btn-import').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        importData(text);
        renderTree();
        setTimeout(fitToScreen, 100);
      } catch (err) {
        alert('Failed to import: ' + err.message);
      }
    });
    input.click();
  });

  // Export
  document.getElementById('btn-export').addEventListener('click', exportData);

  // Reset to file data
  document.getElementById('btn-reset')?.addEventListener('click', async () => {
    if (confirm('Reset to original data from file? Your browser edits will be lost.')) {
      await resetToFile();
      renderTree();
      setTimeout(fitToScreen, 100);
    }
  });

  // Fit to screen
  document.getElementById('btn-fit').addEventListener('click', fitToScreen);

  // Expand/Collapse all
  document.getElementById('btn-expand-all').addEventListener('click', () => {
    expandAll();
    setTimeout(fitToScreen, 100);
  });
  document.getElementById('btn-collapse-all').addEventListener('click', () => {
    collapseAll();
    setTimeout(fitToScreen, 100);
  });

  // Theme toggle
  const themeToggle = document.getElementById('btn-theme');
  const savedTheme = localStorage.getItem('familyTreeTheme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('familyTreeTheme', next);
    updateThemeIcon(next);
  });

  // Search
  const doSearch = debounce((query) => {
    if (!query.trim()) {
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
      return;
    }
    const q = query.toLowerCase();
    const members = getState().members.filter(m =>
      `${m.firstName} ${m.lastName}`.toLowerCase().includes(q)
    );
    if (members.length === 0) {
      searchResults.innerHTML = '<div class="search-item">No results</div>';
    } else {
      searchResults.innerHTML = members.slice(0, 10).map(m =>
        `<div class="search-item" data-id="${m.id}">${m.firstName} ${m.lastName}</div>`
      ).join('');
    }
    searchResults.style.display = 'block';
  }, 200);

  searchInput.addEventListener('input', () => doSearch(searchInput.value));
  searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) doSearch(searchInput.value); });

  searchResults.addEventListener('click', (e) => {
    const item = e.target.closest('.search-item');
    if (item && item.dataset.id) {
      openPanel(item.dataset.id);
      zoomToMember(item.dataset.id);
      searchResults.style.display = 'none';
      searchInput.value = '';
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      searchResults.style.display = 'none';
    }
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', showSettingsDialog);

  // Sync status indicator
  const syncStatusEl = document.getElementById('sync-status');
  updateSyncIndicator(syncStatusEl);
  onSyncStatus(() => updateSyncIndicator(syncStatusEl));

  // Logout
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  // Initial fit
  setTimeout(fitToScreen, 200);
}

function showAddPersonDialog() {
  const dialog = document.getElementById('add-person-dialog');
  dialog.style.display = 'flex';

  const form = dialog.querySelector('#add-person-form');
  form.reset();

  dialog.querySelector('.dialog-overlay').addEventListener('click', () => {
    dialog.style.display = 'none';
  });
  dialog.querySelector('#add-person-cancel').addEventListener('click', () => {
    dialog.style.display = 'none';
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fname = form.firstName.value.trim();
    if (!fname) return;
    addMember({
      firstName: fname,
      lastName: form.lastName.value.trim(),
      gender: form.gender.value,
      birthday: form.birthday.value || null,
    });
    dialog.style.display = 'none';
    renderTree();
    setTimeout(fitToScreen, 100);
  }, { once: true });
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('btn-theme');
  btn.innerHTML = theme === 'dark'
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}

function showSettingsDialog() {
  const dialog = document.getElementById('settings-dialog');
  dialog.style.display = 'flex';
  const form = dialog.querySelector('#settings-form');
  form.githubToken.value = getToken() || '';

  const closeDialog = () => { dialog.style.display = 'none'; };

  dialog.querySelector('.dialog-overlay').onclick = closeDialog;
  dialog.querySelector('#settings-cancel').onclick = closeDialog;

  dialog.querySelector('#settings-test').onclick = async () => {
    const resultEl = dialog.querySelector('#sync-test-result');
    const token = form.githubToken.value.trim();
    if (!token) { resultEl.textContent = 'Enter a token first'; return; }
    resultEl.textContent = 'Testing...';
    setToken(token);
    const result = await fetchFromGithub();
    resultEl.textContent = result ? 'Connected successfully!' : 'Connection failed. Check your token.';
    resultEl.style.color = result ? '#38a169' : '#e53e3e';
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    const token = form.githubToken.value.trim();
    setToken(token || null);
    updateSyncIndicator(document.getElementById('sync-status'));
    closeDialog();
  };
}

function updateSyncIndicator(el) {
  if (!hasToken()) {
    el.textContent = '';
    el.title = 'Sync not configured — click Settings';
    el.className = 'sync-status';
    return;
  }
  const statusMap = {
    idle: { text: '●', cls: 'sync-idle', tip: 'Sync ready' },
    syncing: { text: '↻', cls: 'sync-syncing', tip: 'Syncing...' },
    synced: { text: '●', cls: 'sync-synced', tip: 'Synced' },
    error: { text: '●', cls: 'sync-error', tip: 'Sync error' }
  };
  const s = statusMap[getSyncStatus()] || statusMap.idle;
  el.textContent = s.text;
  el.className = `sync-status ${s.cls}`;
  el.title = s.tip;
}

requireAuth().then(() => init());
