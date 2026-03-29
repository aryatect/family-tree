// ============================================================
// GITHUB SYNC — persist family.json back to the repo
// ============================================================
// Uses the GitHub Contents API to read/write data/family.json.
// A Personal Access Token (PAT) with repo scope is required.
// The token is stored in localStorage.
// ============================================================

const TOKEN_KEY = 'familyTreeGithubToken';
const REPO_OWNER = 'aryatect';
const REPO_NAME = 'family-tree';
const FILE_PATH = 'data/family.json';
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

let currentSha = null;
let syncStatus = 'idle'; // idle | syncing | synced | error
let statusListeners = [];

export function onSyncStatus(fn) {
  statusListeners.push(fn);
  return () => { statusListeners = statusListeners.filter(l => l !== fn); };
}

function setSyncStatus(status) {
  syncStatus = status;
  statusListeners.forEach(fn => fn(status));
}

export function getSyncStatus() { return syncStatus; }

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function hasToken() {
  return !!getToken();
}

/**
 * Fetch the latest family.json from GitHub API.
 * Returns { data, sha } or null on failure.
 */
export async function fetchFromGithub() {
  const token = getToken();
  if (!token) return null;

  try {
    const resp = await fetch(API_BASE, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    currentSha = json.sha;
    const content = atob(json.content.replace(/\n/g, ''));
    const data = JSON.parse(content);
    setSyncStatus('synced');
    return { data, sha: json.sha };
  } catch {
    setSyncStatus('error');
    return null;
  }
}

/**
 * Push updated data to GitHub.
 * Uses the Contents API PUT to update the file.
 */
export async function pushToGithub(data) {
  const token = getToken();
  if (!token) return false;

  setSyncStatus('syncing');

  try {
    // Get current SHA if we don't have it
    if (!currentSha) {
      const resp = await fetch(API_BASE, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (resp.ok) {
        const json = await resp.json();
        currentSha = json.sha;
      }
    }

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n')));

    const resp = await fetch(API_BASE, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Update family tree data',
        content,
        sha: currentSha
      })
    });

    if (resp.ok) {
      const result = await resp.json();
      currentSha = result.content.sha;
      setSyncStatus('synced');
      return true;
    } else {
      setSyncStatus('error');
      return false;
    }
  } catch {
    setSyncStatus('error');
    return false;
  }
}
