import { generateId, debounce } from './utils.js';
import { fetchFromGithub, pushToGithub, hasToken } from './github-sync.js';

const STORAGE_KEY = 'familyTreeData';
let state = null;
let listeners = [];
const debouncedSync = debounce(() => syncToGithub(), 2000);

export function subscribe(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

function notify() {
  listeners.forEach(fn => fn(state));
}

export async function loadData() {
  // Try GitHub API first (latest cross-device data)
  if (hasToken()) {
    try {
      const result = await fetchFromGithub();
      if (result && result.data) {
        state = result.data;
        saveToStorage();
        return state;
      }
    } catch { /* fall through */ }
  }

  // Fall back to localStorage
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      state = JSON.parse(saved);
      return state;
    } catch { /* fall through */ }
  }

  // Fall back to static file
  try {
    const resp = await fetch('data/family.json');
    if (resp.ok) {
      state = await resp.json();
      saveToStorage();
      return state;
    }
  } catch { /* fall through */ }
  state = createEmptyState();
  return state;
}

function createEmptyState() {
  return {
    version: 1,
    familyName: 'My Family',
    rootMemberId: null,
    lastModified: new Date().toISOString(),
    members: []
  };
}

function saveToStorage() {
  state.lastModified = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  debouncedSync();
}

async function syncToGithub() {
  if (hasToken() && state) {
    await pushToGithub(state);
  }
}

export function getState() { return state; }

export function getMembers() { return state ? state.members : []; }

export function getMemberById(id) {
  return state ? state.members.find(m => m.id === id) : null;
}

export function setFamilyName(name) {
  state.familyName = name;
  saveToStorage();
  notify();
}

export function addMember(data) {
  const member = {
    id: generateId(),
    firstName: data.firstName || '',
    lastName: data.lastName || '',
    birthday: data.birthday || null,
    deathday: data.deathday || null,
    gender: data.gender || 'M',
    bio: data.bio || '',
    avatar: data.avatar || null,
    gallery: [],
    spouseIds: [],
    childIds: [],
    fatherId: null,
    motherId: null
  };
  state.members.push(member);
  if (!state.rootMemberId) state.rootMemberId = member.id;
  saveToStorage();
  notify();
  return member;
}

export function updateMember(id, updates) {
  const member = getMemberById(id);
  if (!member) return null;
  const fields = ['firstName', 'lastName', 'birthday', 'deathday', 'gender', 'bio', 'avatar'];
  for (const f of fields) {
    if (f in updates) member[f] = updates[f];
  }
  saveToStorage();
  notify();
  return member;
}

export function deleteMember(id) {
  const member = getMemberById(id);
  if (!member) return;

  // Clean up relationship references
  for (const m of state.members) {
    m.spouseIds = m.spouseIds.filter(sid => sid !== id);
    m.childIds = m.childIds.filter(cid => cid !== id);
    if (m.fatherId === id) m.fatherId = null;
    if (m.motherId === id) m.motherId = null;
  }

  state.members = state.members.filter(m => m.id !== id);
  if (state.rootMemberId === id) {
    state.rootMemberId = state.members.length > 0 ? state.members[0].id : null;
  }
  saveToStorage();
  notify();
}

export function addSpouse(id1, id2) {
  const m1 = getMemberById(id1);
  const m2 = getMemberById(id2);
  if (!m1 || !m2) return;
  if (!m1.spouseIds.includes(id2)) m1.spouseIds.push(id2);
  if (!m2.spouseIds.includes(id1)) m2.spouseIds.push(id1);
  saveToStorage();
  notify();
}

export function addChild(parentId, childId) {
  const parent = getMemberById(parentId);
  const child = getMemberById(childId);
  if (!parent || !child) return;
  if (!parent.childIds.includes(childId)) parent.childIds.push(childId);
  if (parent.gender === 'M') child.fatherId = parentId;
  else if (parent.gender === 'F') child.motherId = parentId;

  // Also link to spouse(s) for consistency
  for (const sid of parent.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) {
      if (!spouse.childIds.includes(childId)) spouse.childIds.push(childId);
      if (spouse.gender === 'M' && !child.fatherId) child.fatherId = sid;
      else if (spouse.gender === 'F' && !child.motherId) child.motherId = sid;
    }
  }
  saveToStorage();
  notify();
}

export function setParent(childId, parentId) {
  const child = getMemberById(childId);
  const parent = getMemberById(parentId);
  if (!child || !parent) return;
  if (parent.gender === 'M') child.fatherId = parentId;
  else if (parent.gender === 'F') child.motherId = parentId;
  if (!parent.childIds.includes(childId)) parent.childIds.push(childId);

  // Also link to parent's spouse for consistency
  for (const sid of parent.spouseIds) {
    const spouse = getMemberById(sid);
    if (spouse) {
      if (!spouse.childIds.includes(childId)) spouse.childIds.push(childId);
      if (spouse.gender === 'M' && !child.fatherId) child.fatherId = sid;
      else if (spouse.gender === 'F' && !child.motherId) child.motherId = sid;
    }
  }
  saveToStorage();
  notify();
}

export function addGalleryItem(memberId, item) {
  const member = getMemberById(memberId);
  if (!member) return;
  member.gallery.push({ id: generateId(), ...item });
  saveToStorage();
  notify();
}

export function removeGalleryItem(memberId, itemId) {
  const member = getMemberById(memberId);
  if (!member) return;
  member.gallery = member.gallery.filter(g => g.id !== itemId);
  saveToStorage();
  notify();
}

export function exportData() {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = (state.familyName || 'family-tree').replace(/\s+/g, '-').toLowerCase();
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importData(jsonString) {
  const parsed = JSON.parse(jsonString);
  if (!parsed.version || !Array.isArray(parsed.members)) {
    throw new Error('Invalid family tree data format');
  }
  state = parsed;
  saveToStorage();
  notify();
  return state;
}

export function resetToFile() {
  localStorage.removeItem(STORAGE_KEY);
  return loadData();
}
