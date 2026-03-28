import {
  getMemberById, getMembers, updateMember, deleteMember, addMember,
  addSpouse, addChild, setParent, addGalleryItem, removeGalleryItem
} from './data-store.js';
import { getImageUrl, getVideoEmbedUrl, extractDriveFileId } from './google-drive.js';
import { formatFullDate, formatDates, getInitials, generateId } from './utils.js';

let panelEl, currentMemberId = null, currentTab = 'profile';
let onTreeUpdate = null;

export function initSidePanel(container, onUpdate) {
  panelEl = container;
  onTreeUpdate = onUpdate;
}

export function openPanel(memberId) {
  currentMemberId = memberId;
  currentTab = 'profile';
  panelEl.classList.add('open');
  renderPanel();
}

export function closePanel() {
  currentMemberId = null;
  panelEl.classList.remove('open');
  panelEl.innerHTML = '';
}

function renderPanel() {
  const member = getMemberById(currentMemberId);
  if (!member) { closePanel(); return; }

  panelEl.innerHTML = `
    <div class="panel-header">
      <div class="panel-tabs">
        <button class="tab-btn ${currentTab === 'profile' ? 'active' : ''}" data-tab="profile">Profile</button>
        <button class="tab-btn ${currentTab === 'edit' ? 'active' : ''}" data-tab="edit">Edit</button>
        <button class="tab-btn ${currentTab === 'gallery' ? 'active' : ''}" data-tab="gallery">Gallery</button>
      </div>
      <button class="panel-close" title="Close">&times;</button>
    </div>
    <div class="panel-body" id="panel-body"></div>
  `;

  panelEl.querySelector('.panel-close').addEventListener('click', closePanel);
  panelEl.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      renderPanel();
    });
  });

  const body = panelEl.querySelector('#panel-body');
  if (currentTab === 'profile') renderProfile(body, member);
  else if (currentTab === 'edit') renderEditForm(body, member);
  else if (currentTab === 'gallery') renderGallery(body, member);
}

// --- Profile Tab ---

function renderProfile(container, member) {
  const avatarHtml = member.avatar
    ? `<img src="${getImageUrl(member.avatar, 600)}" alt="${member.firstName}" class="profile-avatar-img" />`
    : `<div class="profile-avatar-placeholder">${getInitials(member)}</div>`;

  const father = member.fatherId ? getMemberById(member.fatherId) : null;
  const mother = member.motherId ? getMemberById(member.motherId) : null;
  const spouses = member.spouseIds.map(id => getMemberById(id)).filter(Boolean);
  const children = member.childIds.map(id => getMemberById(id)).filter(Boolean);

  container.innerHTML = `
    <div class="profile-avatar">${avatarHtml}</div>
    <h2 class="profile-name">${member.firstName} ${member.lastName}</h2>
    <p class="profile-dates">${formatDates(member)}</p>
    ${member.birthday ? `<p class="profile-detail"><span class="detail-label">Born:</span> ${formatFullDate(member.birthday)}</p>` : ''}
    ${member.deathday ? `<p class="profile-detail"><span class="detail-label">Died:</span> ${formatFullDate(member.deathday)}</p>` : ''}
    <p class="profile-detail"><span class="detail-label">Gender:</span> ${member.gender === 'M' ? 'Male' : member.gender === 'F' ? 'Female' : 'Other'}</p>
    ${member.bio ? `<div class="profile-bio"><span class="detail-label">Bio:</span><p>${escapeHtml(member.bio)}</p></div>` : ''}

    <div class="profile-relationships">
      <h3>Relationships</h3>
      ${father ? `<p class="rel-item"><span class="detail-label">Father:</span> <a href="#" class="rel-link" data-id="${father.id}">${father.firstName} ${father.lastName}</a></p>` : ''}
      ${mother ? `<p class="rel-item"><span class="detail-label">Mother:</span> <a href="#" class="rel-link" data-id="${mother.id}">${mother.firstName} ${mother.lastName}</a></p>` : ''}
      ${spouses.length ? `<p class="rel-item"><span class="detail-label">Spouse:</span> ${spouses.map(s => `<a href="#" class="rel-link" data-id="${s.id}">${s.firstName} ${s.lastName}</a>`).join(', ')}</p>` : ''}
      ${children.length ? `<p class="rel-item"><span class="detail-label">Children:</span> ${children.map(c => `<a href="#" class="rel-link" data-id="${c.id}">${c.firstName} ${c.lastName}</a>`).join(', ')}</p>` : ''}
    </div>

    <div class="profile-actions">
      <button class="btn btn-sm" id="btn-add-spouse">Add Spouse</button>
      <button class="btn btn-sm" id="btn-add-child">Add Child</button>
      <button class="btn btn-sm" id="btn-add-parent">Add Parent</button>
      <button class="btn btn-sm btn-danger" id="btn-delete">Delete</button>
    </div>

    <div id="relationship-form-area"></div>
  `;

  // Relationship links
  container.querySelectorAll('.rel-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openPanel(link.dataset.id);
    });
  });

  // Action buttons
  container.querySelector('#btn-add-spouse').addEventListener('click', () => showRelForm(container, 'spouse'));
  container.querySelector('#btn-add-child').addEventListener('click', () => showRelForm(container, 'child'));
  container.querySelector('#btn-add-parent').addEventListener('click', () => showRelForm(container, 'parent'));
  container.querySelector('#btn-delete').addEventListener('click', () => {
    if (confirm(`Delete ${member.firstName} ${member.lastName}? This cannot be undone.`)) {
      deleteMember(member.id);
      closePanel();
      if (onTreeUpdate) onTreeUpdate();
    }
  });
}

function showRelForm(container, relType) {
  const area = container.querySelector('#relationship-form-area');
  const existing = getMembers().filter(m => m.id !== currentMemberId);
  const typeLabel = relType === 'spouse' ? 'Spouse' : relType === 'child' ? 'Child' : 'Parent';

  area.innerHTML = `
    <div class="rel-form">
      <h4>Add ${typeLabel}</h4>
      <div class="rel-form-toggle">
        <label><input type="radio" name="rel-mode" value="new" checked /> Create new person</label>
        <label><input type="radio" name="rel-mode" value="existing" /> Link existing</label>
      </div>
      <div id="rel-new-fields">
        <input type="text" placeholder="First Name" id="rel-fname" class="input" required />
        <input type="text" placeholder="Last Name" id="rel-lname" class="input" />
        <select id="rel-gender" class="input">
          <option value="M">Male</option>
          <option value="F">Female</option>
          <option value="O">Other</option>
        </select>
      </div>
      <div id="rel-existing-fields" style="display:none">
        <select id="rel-existing-select" class="input">
          <option value="">-- Select Person --</option>
          ${existing.map(m => `<option value="${m.id}">${m.firstName} ${m.lastName}</option>`).join('')}
        </select>
      </div>
      <div class="rel-form-actions">
        <button class="btn btn-primary btn-sm" id="rel-save">Save</button>
        <button class="btn btn-sm" id="rel-cancel">Cancel</button>
      </div>
    </div>
  `;

  area.querySelectorAll('input[name="rel-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isNew = radio.value === 'new' && radio.checked;
      area.querySelector('#rel-new-fields').style.display = isNew ? 'block' : 'none';
      area.querySelector('#rel-existing-fields').style.display = isNew ? 'none' : 'block';
    });
  });

  area.querySelector('#rel-cancel').addEventListener('click', () => { area.innerHTML = ''; });

  area.querySelector('#rel-save').addEventListener('click', () => {
    const mode = area.querySelector('input[name="rel-mode"]:checked').value;
    let targetId;

    if (mode === 'new') {
      const fname = area.querySelector('#rel-fname').value.trim();
      if (!fname) { alert('First name is required'); return; }
      const newMember = addMember({
        firstName: fname,
        lastName: area.querySelector('#rel-lname').value.trim(),
        gender: area.querySelector('#rel-gender').value
      });
      targetId = newMember.id;
    } else {
      targetId = area.querySelector('#rel-existing-select').value;
      if (!targetId) { alert('Please select a person'); return; }
    }

    if (relType === 'spouse') addSpouse(currentMemberId, targetId);
    else if (relType === 'child') addChild(currentMemberId, targetId);
    else if (relType === 'parent') setParent(currentMemberId, targetId);

    if (onTreeUpdate) onTreeUpdate();
    renderPanel();
  });
}

// --- Edit Tab ---

function renderEditForm(container, member) {
  container.innerHTML = `
    <form id="edit-form" class="edit-form">
      <label class="form-label">First Name
        <input type="text" name="firstName" value="${escapeAttr(member.firstName)}" class="input" required />
      </label>
      <label class="form-label">Last Name
        <input type="text" name="lastName" value="${escapeAttr(member.lastName)}" class="input" />
      </label>
      <label class="form-label">Gender
        <select name="gender" class="input">
          <option value="M" ${member.gender === 'M' ? 'selected' : ''}>Male</option>
          <option value="F" ${member.gender === 'F' ? 'selected' : ''}>Female</option>
          <option value="O" ${member.gender === 'O' ? 'selected' : ''}>Other</option>
        </select>
      </label>
      <label class="form-label">Date of Birth
        <input type="date" name="birthday" value="${member.birthday || ''}" class="input" />
      </label>
      <label class="form-label">Date of Death
        <input type="date" name="deathday" value="${member.deathday || ''}" class="input" />
      </label>
      <label class="form-label">Bio
        <textarea name="bio" class="input textarea" rows="4">${escapeHtml(member.bio || '')}</textarea>
      </label>
      <label class="form-label">Profile Picture (Google Drive link or file ID)
        <input type="text" name="avatar" value="${escapeAttr(member.avatar || '')}" class="input" placeholder="Paste Google Drive link or file ID" />
      </label>
      <div id="avatar-preview" class="avatar-preview">
        ${member.avatar ? `<img src="${getImageUrl(member.avatar, 400)}" alt="Preview" />` : '<span>No photo set</span>'}
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save Changes</button>
        <button type="button" class="btn" id="edit-cancel">Cancel</button>
      </div>
    </form>
  `;

  // Live avatar preview
  const avatarInput = container.querySelector('input[name="avatar"]');
  const previewDiv = container.querySelector('#avatar-preview');
  avatarInput.addEventListener('input', () => {
    const fileId = extractDriveFileId(avatarInput.value);
    if (fileId) {
      previewDiv.innerHTML = `<img src="${getImageUrl(fileId, 400)}" alt="Preview" />`;
    } else if (!avatarInput.value.trim()) {
      previewDiv.innerHTML = '<span>No photo set</span>';
    }
  });

  container.querySelector('#edit-cancel').addEventListener('click', () => {
    currentTab = 'profile';
    renderPanel();
  });

  container.querySelector('#edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const avatarRaw = form.avatar.value.trim();
    const avatarId = avatarRaw ? (extractDriveFileId(avatarRaw) || avatarRaw) : null;

    updateMember(currentMemberId, {
      firstName: form.firstName.value.trim(),
      lastName: form.lastName.value.trim(),
      gender: form.gender.value,
      birthday: form.birthday.value || null,
      deathday: form.deathday.value || null,
      bio: form.bio.value.trim(),
      avatar: avatarId
    });

    if (onTreeUpdate) onTreeUpdate();
    currentTab = 'profile';
    renderPanel();
  });
}

// --- Gallery Tab ---

function renderGallery(container, member) {
  const gallery = member.gallery || [];

  container.innerHTML = `
    <div class="gallery-section">
      <div class="gallery-add">
        <h4>Add Photo/Video</h4>
        <input type="text" id="gallery-drive-link" class="input" placeholder="Paste Google Drive link or file ID" />
        <div class="gallery-add-row">
          <select id="gallery-type" class="input">
            <option value="image">Photo</option>
            <option value="video">Video</option>
          </select>
          <input type="text" id="gallery-caption" class="input" placeholder="Caption (optional)" />
          <button class="btn btn-primary btn-sm" id="gallery-add-btn">Add</button>
        </div>
      </div>
      <div class="gallery-grid" id="gallery-grid">
        ${gallery.length === 0 ? '<p class="gallery-empty">No photos or videos yet. Add media using Google Drive links above.</p>' : ''}
        ${gallery.map(item => renderGalleryItem(item)).join('')}
      </div>
    </div>
    <div id="lightbox" class="lightbox" style="display:none">
      <div class="lightbox-overlay"></div>
      <div class="lightbox-content" id="lightbox-content"></div>
      <button class="lightbox-close">&times;</button>
    </div>
  `;

  // Add media
  container.querySelector('#gallery-add-btn').addEventListener('click', () => {
    const link = container.querySelector('#gallery-drive-link').value.trim();
    const fileId = extractDriveFileId(link);
    if (!fileId) { alert('Please enter a valid Google Drive link or file ID'); return; }
    const type = container.querySelector('#gallery-type').value;
    const caption = container.querySelector('#gallery-caption').value.trim();
    addGalleryItem(currentMemberId, { driveFileId: fileId, type, caption });
    renderPanel();
  });

  // Gallery item clicks (lightbox)
  container.querySelectorAll('.gallery-item').forEach(item => {
    item.addEventListener('click', () => {
      const fileId = item.dataset.fileId;
      const type = item.dataset.type;
      const caption = item.dataset.caption || '';
      openLightbox(container, fileId, type, caption);
    });
  });

  // Delete buttons
  container.querySelectorAll('.gallery-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Remove this media?')) {
        removeGalleryItem(currentMemberId, btn.dataset.itemId);
        renderPanel();
      }
    });
  });
}

function renderGalleryItem(item) {
  if (item.type === 'video') {
    return `
      <div class="gallery-item gallery-item--video" data-file-id="${item.driveFileId}" data-type="video" data-caption="${escapeAttr(item.caption || '')}">
        <div class="gallery-video-thumb">
          <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><polygon points="5,3 19,12 5,21"/></svg>
        </div>
        ${item.caption ? `<p class="gallery-caption">${escapeHtml(item.caption)}</p>` : ''}
        <button class="gallery-delete" data-item-id="${item.id}" title="Remove">&times;</button>
      </div>
    `;
  }
  return `
    <div class="gallery-item" data-file-id="${item.driveFileId}" data-type="image" data-caption="${escapeAttr(item.caption || '')}">
      <img src="${getImageUrl(item.driveFileId, 400)}" alt="${escapeAttr(item.caption || 'Photo')}" loading="lazy" />
      ${item.caption ? `<p class="gallery-caption">${escapeHtml(item.caption)}</p>` : ''}
      <button class="gallery-delete" data-item-id="${item.id}" title="Remove">&times;</button>
    </div>
  `;
}

function openLightbox(container, fileId, type, caption) {
  const lightbox = container.querySelector('#lightbox');
  const content = container.querySelector('#lightbox-content');

  if (type === 'video') {
    content.innerHTML = `
      <iframe src="${getVideoEmbedUrl(fileId)}" allowfullscreen class="lightbox-video"></iframe>
      ${caption ? `<p class="lightbox-caption">${escapeHtml(caption)}</p>` : ''}
    `;
  } else {
    content.innerHTML = `
      <img src="${getImageUrl(fileId, 1600)}" alt="${escapeAttr(caption)}" class="lightbox-img" />
      ${caption ? `<p class="lightbox-caption">${escapeHtml(caption)}</p>` : ''}
    `;
  }

  lightbox.style.display = 'flex';

  const closeLb = () => { lightbox.style.display = 'none'; content.innerHTML = ''; };
  lightbox.querySelector('.lightbox-overlay').addEventListener('click', closeLb);
  lightbox.querySelector('.lightbox-close').addEventListener('click', closeLb);
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
