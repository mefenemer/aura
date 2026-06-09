// my-content.js — My Content Media Hub controller
// Wrapped in IIFE to avoid global scope collisions with other view controllers.
(function () {

// ── Section config ────────────────────────────────────────────────
const SECTIONS = [
    {
        key: 'pending',
        label: 'Pending',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
        badge: 'bg-amber-100 text-amber-700 border-amber-200',
        dot: 'bg-amber-400',
        defaultExpanded: true,
        emptyMessage: 'No pending content. Upload images, videos, or links to get started.',
    },
    {
        key: 'scheduled',
        label: 'Scheduled',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`,
        badge: 'bg-blue-100 text-blue-700 border-blue-200',
        dot: 'bg-blue-500',
        defaultExpanded: true,
        emptyMessage: 'No content is currently scheduled. Assets move here when an assistant queues them for a post.',
    },
    {
        key: 'posted',
        label: 'Posted',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
        badge: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        dot: 'bg-emerald-500',
        defaultExpanded: false,
        emptyMessage: 'No published content yet.',
    },
    {
        key: 'rejected',
        label: 'Rejected',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>`,
        badge: 'bg-red-100 text-red-700 border-red-200',
        dot: 'bg-red-500',
        defaultExpanded: false,
        emptyMessage: 'No rejected content.',
    },
];

// ── State ─────────────────────────────────────────────────────────
let _assets = { pending: [], scheduled: [], posted: [], rejected: [] };
let _pendingFile = null;
let _activeTab = 'file';
let _assetToDelete = null;
let _assetToDetach = null;
let _orgId = null;

// ── Init ──────────────────────────────────────────────────────────
window.initMyContent = async function () {
    document.getElementById('btn-open-upload')?.addEventListener('click', _openUploadModal);
    document.getElementById('btn-confirm-delete')?.addEventListener('click', _doDelete);
    document.getElementById('btn-confirm-detach')?.addEventListener('click', _doDetach);
    await _loadAssets();
};

// ── Load & render ─────────────────────────────────────────────────
async function _loadAssets() {
    try {
        const res = await fetch('/.netlify/functions/content-assets');
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        _assets = { pending: [], scheduled: [], posted: [], rejected: [], ...data.assets };
        // Try to capture orgId from first asset
        for (const bucket of Object.values(data.assets)) {
            if (Array.isArray(bucket) && bucket.length > 0) {
                _orgId = bucket[0].organisationId;
                break;
            }
        }
    } catch (e) {
        console.warn('Could not load assets:', e);
    }
    _renderSections();
}

function _renderSections() {
    const container = document.getElementById('content-sections');
    if (!container) return;
    container.innerHTML = SECTIONS.map(sec => _sectionHTML(sec)).join('');
}

function _sectionHTML(sec) {
    const items = _assets[sec.key] || [];
    const count = items.length;
    const expanded = sec.defaultExpanded;

    const rows = count === 0
        ? `<div class="px-6 py-8 text-center text-sm text-gray-400">${sec.emptyMessage}</div>`
        : items.map(a => _assetRow(a, sec)).join('');

    return `
    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <button type="button" data-section="${sec.key}"
        onclick="window._mcToggleSection('${sec.key}')"
        class="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition cursor-pointer">
        <div class="flex items-center gap-3">
          <span class="inline-flex items-center gap-1.5 text-sm font-bold px-2.5 py-1 rounded-full border ${sec.badge}">
            <span class="w-1.5 h-1.5 rounded-full ${sec.dot}"></span>
            ${sec.label}
          </span>
          <span class="text-sm text-gray-400 font-medium">${count} ${count === 1 ? 'item' : 'items'}</span>
        </div>
        <svg id="chevron-${sec.key}" class="w-5 h-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div id="section-body-${sec.key}" class="${expanded ? '' : 'hidden'}">
        <div class="border-t border-gray-100 divide-y divide-gray-100">
          ${rows}
        </div>
      </div>
    </div>`;
}

function _assetRow(asset, sec) {
    const icon = _typeIcon(asset.assetType, asset.mimeType);
    const date = new Date(asset.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const fileSize = asset.fileSize ? _formatBytes(asset.fileSize) : '';

    // Actions depend on status
    let actions = '';
    if (asset.status === 'pending') {
        actions = `
          <button type="button" onclick="window._mcPromptDelete(${asset.id})"
            title="Delete"
            class="p-1.5 text-gray-400 hover:text-red-500 transition cursor-pointer rounded-lg hover:bg-red-50">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>`;
    } else if (asset.status === 'scheduled') {
        actions = `
          <button type="button" onclick="window._mcPromptDetach(${asset.id})"
            class="text-xs font-bold text-amber-600 hover:text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-lg transition cursor-pointer">
            Remove from Post
          </button>`;
    } else if (asset.status === 'posted') {
        actions = `<span class="text-xs text-gray-400">Auto-removed in ~${_daysUntilPurge(asset.retentionDeleteAfter)}</span>`;
    }

    const rejectionBadge = asset.status === 'rejected' && asset.rejectionReason
        ? `<p class="text-xs text-red-600 mt-1 flex items-center gap-1">
             <svg class="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
             ${_escHtml(asset.rejectionReason)}
           </p>`
        : '';

    const previewThumb = (asset.assetType === 'image' && asset.storageUrl && !asset.purgedAt)
        ? `<img src="${asset.storageUrl}" alt="" class="w-full h-full object-cover rounded-lg">`
        : `<div class="w-full h-full flex items-center justify-center text-gray-400">${icon}</div>`;

    return `
    <div class="flex items-center gap-4 px-5 py-4 group hover:bg-gray-50 transition" data-asset-id="${asset.id}">
      <div class="w-14 h-14 rounded-xl bg-gray-100 overflow-hidden shrink-0 border border-gray-200">
        ${previewThumb}
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold text-gray-900 truncate">${_escHtml(asset.name)}</p>
        <p class="text-xs text-gray-400 mt-0.5">${_typeLabel(asset.assetType)}${fileSize ? ' · ' + fileSize : ''} · ${date}</p>
        ${rejectionBadge}
      </div>
      <div class="shrink-0 flex items-center gap-2">${actions}</div>
    </div>`;
}

// ── Section toggle ────────────────────────────────────────────────
window._mcToggleSection = function (key) {
    const body = document.getElementById(`section-body-${key}`);
    const chevron = document.getElementById(`chevron-${key}`);
    if (!body) return;
    const hidden = body.classList.toggle('hidden');
    if (chevron) chevron.classList.toggle('rotate-180', !hidden);
};

// ── Upload Modal ──────────────────────────────────────────────────
function _openUploadModal() {
    _pendingFile = null;
    _mcSwitchTab('file');
    document.getElementById('file-preview')?.classList.add('hidden');
    document.getElementById('upload-progress')?.classList.add('hidden');
    document.getElementById('upload-error')?.classList.add('hidden');
    document.getElementById('link-url') && (document.getElementById('link-url').value = '');
    document.getElementById('link-name') && (document.getElementById('link-name').value = '');
    document.getElementById('modal-upload')?.classList.remove('hidden');
}

window._mcSwitchTab = function (tab) {
    _activeTab = tab;
    const fileBtn = document.getElementById('tab-file');
    const linkBtn = document.getElementById('tab-link');
    const filePanel = document.getElementById('panel-file');
    const linkPanel = document.getElementById('panel-link');

    if (tab === 'file') {
        fileBtn.className = 'flex-1 py-2 text-sm font-bold rounded-lg transition bg-white shadow text-gray-900 cursor-pointer';
        linkBtn.className = 'flex-1 py-2 text-sm font-bold rounded-lg transition text-gray-500 hover:text-gray-700 cursor-pointer';
        filePanel.classList.remove('hidden');
        linkPanel.classList.add('hidden');
    } else {
        linkBtn.className = 'flex-1 py-2 text-sm font-bold rounded-lg transition bg-white shadow text-gray-900 cursor-pointer';
        fileBtn.className = 'flex-1 py-2 text-sm font-bold rounded-lg transition text-gray-500 hover:text-gray-700 cursor-pointer';
        linkPanel.classList.remove('hidden');
        filePanel.classList.add('hidden');
    }
};

// ── File selection ────────────────────────────────────────────────
window._mcFileSelected = function (e) {
    const file = e.target.files?.[0];
    if (file) _setSelectedFile(file);
};

window._mcDragOver = function (e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.add('border-emerald-500', 'bg-emerald-50/40');
};

window._mcDragLeave = function () {
    document.getElementById('drop-zone')?.classList.remove('border-emerald-500', 'bg-emerald-50/40');
};

window._mcDrop = function (e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.remove('border-emerald-500', 'bg-emerald-50/40');
    const file = e.dataTransfer?.files?.[0];
    if (file) _setSelectedFile(file);
};

function _setSelectedFile(file) {
    _pendingFile = file;
    const preview = document.getElementById('file-preview');
    const iconEl = document.getElementById('file-preview-icon');
    const nameEl = document.getElementById('file-preview-name');
    const sizeEl = document.getElementById('file-preview-size');

    if (file.type.startsWith('image/') && file.size < 10 * 1024 * 1024) {
        const reader = new FileReader();
        reader.onload = e => { iconEl.innerHTML = `<img src="${e.target.result}" class="w-full h-full object-cover">`; };
        reader.readAsDataURL(file);
    } else {
        iconEl.innerHTML = file.type.startsWith('video/')
            ? `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.72v6.56a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`
            : `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
    }
    nameEl.textContent = file.name;
    sizeEl.textContent = _formatBytes(file.size);
    preview.classList.remove('hidden');
}

window._mcClearFile = function () {
    _pendingFile = null;
    document.getElementById('file-preview')?.classList.add('hidden');
    document.getElementById('file-input').value = '';
};

// ── Submit upload ─────────────────────────────────────────────────
window._mcSubmitUpload = async function () {
    const errorEl = document.getElementById('upload-error');
    const btn = document.getElementById('btn-upload-submit');
    errorEl.classList.add('hidden');

    if (_activeTab === 'link') {
        const url = document.getElementById('link-url').value.trim();
        const label = document.getElementById('link-name').value.trim();
        if (!url) {
            errorEl.textContent = 'Please enter a URL.';
            errorEl.classList.remove('hidden');
            return;
        }
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            const res = await fetch('/.netlify/functions/content-assets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: label || url,
                    assetType: 'link',
                    externalUrl: url,
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
            document.getElementById('modal-upload').classList.add('hidden');
            await _loadAssets();
        } catch (e) {
            errorEl.textContent = e.message;
            errorEl.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg> Add to My Content';
        }
        return;
    }

    // File upload
    if (!_pendingFile) {
        errorEl.textContent = 'Please select a file to upload.';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Uploading…';

    try {
        // 1. Get presigned URL
        const urlRes = await fetch('/.netlify/functions/content-upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileName: _pendingFile.name,
                mimeType: _pendingFile.type,
                fileSize: _pendingFile.size,
                orgId: _orgId,
            }),
        });
        if (!urlRes.ok) {
            const err = await urlRes.json().catch(() => ({}));
            throw new Error(err.error || 'Could not get upload URL.');
        }
        const { uploadUrl, storageKey, storageUrl, mock } = await urlRes.json();

        // Show progress bar
        document.getElementById('upload-progress').classList.remove('hidden');

        if (!mock) {
            // 2a. Real upload via XMLHttpRequest for progress
            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', uploadUrl);
                xhr.setRequestHeader('Content-Type', _pendingFile.type);
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        document.getElementById('upload-bar').style.width = pct + '%';
                        document.getElementById('upload-percent').textContent = pct + '%';
                    }
                };
                xhr.onload = () => xhr.status < 400 ? resolve() : reject(new Error('Upload failed'));
                xhr.onerror = () => reject(new Error('Network error during upload'));
                xhr.send(_pendingFile);
            });
        } else {
            // 2b. Mock mode — simulate progress
            for (let p = 0; p <= 100; p += 20) {
                document.getElementById('upload-bar').style.width = p + '%';
                document.getElementById('upload-percent').textContent = p + '%';
                await new Promise(r => setTimeout(r, 80));
            }
        }

        // 3. Create DB record
        const assetType = _pendingFile.type.startsWith('video/') ? 'video' : 'image';
        const createRes = await fetch('/.netlify/functions/content-assets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: _pendingFile.name,
                assetType,
                mimeType: _pendingFile.type,
                fileSize: _pendingFile.size,
                storageKey,
                storageUrl,
            }),
        });
        if (!createRes.ok) throw new Error('File uploaded but record save failed. Please contact support.');

        document.getElementById('modal-upload').classList.add('hidden');
        await _loadAssets();

    } catch (e) {
        errorEl.textContent = e.message;
        errorEl.classList.remove('hidden');
        document.getElementById('upload-progress').classList.add('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg> Add to My Content';
    }
};

// ── Delete ────────────────────────────────────────────────────────
window._mcPromptDelete = function (assetId) {
    _assetToDelete = assetId;
    document.getElementById('modal-delete-asset').classList.remove('hidden');
};

async function _doDelete() {
    if (!_assetToDelete) return;
    try {
        const res = await fetch(`/.netlify/functions/content-assets?id=${_assetToDelete}`, { method: 'DELETE' });
        if (res.ok) {
            document.getElementById('modal-delete-asset').classList.add('hidden');
            _assetToDelete = null;
            await _loadAssets();
        }
    } catch { alert('Could not delete. Please try again.'); }
}

// ── Detach from scheduled post (US3) ─────────────────────────────
window._mcPromptDetach = function (assetId) {
    _assetToDetach = assetId;
    // Find asset
    const all = [...(_assets.scheduled || [])];
    const asset = all.find(a => a.id === assetId);
    const warningEl = document.getElementById('detach-warning');
    if (asset?.scheduledPostId) {
        warningEl.textContent = `Post #${asset.scheduledPostId} will be flagged as "Draft / Requires Attention" if it cannot exist without this asset.`;
        warningEl.classList.remove('hidden');
    } else {
        warningEl.classList.add('hidden');
    }
    document.getElementById('modal-detach').classList.remove('hidden');
};

async function _doDetach() {
    if (!_assetToDetach) return;
    try {
        const res = await fetch(`/.netlify/functions/content-assets?id=${_assetToDetach}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'detach' }),
        });
        if (res.ok) {
            document.getElementById('modal-detach').classList.add('hidden');
            _assetToDetach = null;
            await _loadAssets();
        }
    } catch { alert('Could not detach. Please try again.'); }
}

// ── Helpers ───────────────────────────────────────────────────────
function _escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _typeLabel(type) {
    return { image: 'Image', video: 'Video', link: 'Link' }[type] || type;
}

function _typeIcon(type) {
    if (type === 'image') return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`;
    if (type === 'video') return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.72v6.56a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
    return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>`;
}

function _daysUntilPurge(retentionDate) {
    if (!retentionDate) return 'unknown time';
    const diff = new Date(retentionDate) - Date.now();
    const days = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    return days === 0 ? 'less than 1 day' : `${days} day${days !== 1 ? 's' : ''}`;
}

})(); // end IIFE
