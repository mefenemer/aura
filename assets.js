window.initBrandAssets = function() {
    const btnFile = document.getElementById('btn-tab-file');
    if (!btnFile) return;

    const btnUrl = document.getElementById('btn-tab-url');
    const zoneFile = document.getElementById('zone-file');
    const zoneUrl = document.getElementById('zone-url');
    const inputUrl = document.getElementById('external-url');
    const inputFile = document.getElementById('file-upload');

    let currentMode = 'file';

    // ── Helpers ───────────────────────────────────────────────────────────────
    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmtBytes = (b) => {
        if (!b) return '';
        if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(b / 1024))} KB`;
    };
    // Literal class strings (so Tailwind's scanner compiles them — no dynamic class names).
    const STATUS_STYLES = {
        confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        active:    'bg-emerald-50 text-emerald-700 border-emerald-200',
        pending:   'bg-amber-50 text-amber-700 border-amber-200',
        failed:    'bg-red-50 text-red-700 border-red-200',
    };
    const FILE_ICON = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"></path></svg>`;

    // --- TAB TOGGLING ---
    const updateTabs = (mode) => {
        currentMode = mode;
        const activeClass = 'flex-1 py-1.5 text-xs font-bold bg-white text-gray-900 rounded-md shadow-sm transition-all';
        const inactiveClass = 'flex-1 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-all';
        btnFile.className = mode === 'file' ? activeClass : inactiveClass;
        btnUrl.className = mode === 'url' ? activeClass : inactiveClass;
        zoneFile.classList.toggle('hidden', mode !== 'file');
        zoneFile.classList.toggle('block', mode === 'file');
        zoneUrl.classList.toggle('hidden', mode !== 'url');
        zoneUrl.classList.toggle('block', mode === 'url');
    };
    btnFile.addEventListener('click', () => updateTabs('file'));
    btnUrl.addEventListener('click', () => updateTabs('url'));

    // --- DRAG & DROP HANDLING ---
    const dropZone = document.getElementById('drop-zone');
    const fileNameDisplay = document.getElementById('file-name-display');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    });
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('border-emerald-500', 'bg-emerald-50'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('border-emerald-500', 'bg-emerald-50'), false);
    });
    dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
    inputFile.addEventListener('change', function() { handleFiles(this.files); });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            if (file.size > 10 * 1024 * 1024) {
                alert("File is too large. Maximum size is 10MB.");
                inputFile.value = '';
                return;
            }
            fileNameDisplay.textContent = `Selected: ${file.name}`;
            fileNameDisplay.classList.remove('hidden');
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            inputFile.files = dataTransfer.files;
        }
    }

    // --- FORM SUBMISSION ---
    const form = document.getElementById('asset-upload-form');
    const submitBtn = document.getElementById('submit-asset-btn');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const category = document.getElementById('asset-category').value;
        if (!category) return alert("Please select an asset category.");

        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading...';
        submitBtn.classList.add('opacity-75', 'cursor-not-allowed');

        try {
            if (currentMode === 'file') {
                const file = inputFile.files[0];
                if (!file) throw new Error("Please select a file to upload.");
                await uploadFileToR2(file, category);
            } else {
                const url = inputUrl.value.trim();
                if (!url) throw new Error("Please enter a valid URL.");
                const payload = new FormData();
                payload.append('category', category);
                payload.append('url', url);
                const response = await fetch('/.netlify/functions/upload-asset', { method: 'POST', body: payload });
                if (!response.ok) throw new Error("Failed to save URL asset.");
            }

            await loadAssets();
            form.reset();
            fileNameDisplay.classList.add('hidden');
            inputFile.value = '';
            updateTabs('file');
        } catch (error) {
            console.error('Save failed:', error);
            alert(error.message || "Failed to save asset. Please try again.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Upload Asset';
            submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        }
    });

    // 3-step presigned R2 upload: request → PUT to R2 → confirm.
    async function uploadFileToR2(file, category) {
        const mimeType = file.type || 'application/octet-stream';
        const assetType = mimeType.startsWith('image/') ? 'brand_logo' : 'brand_document';

        // 1. Ask for a presigned PUT URL (org is resolved server-side from the session)
        const reqRes = await fetch('/.netlify/functions/storage-request-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetType, category, filename: file.name, mimeType, fileSizeBytes: file.size }),
        });
        if (!reqRes.ok) {
            const err = await reqRes.json().catch(() => ({}));
            throw new Error(err.error === 'storage_quota_exceeded'
                ? 'Storage quota exceeded — remove an asset or upgrade your plan.'
                : (err.error || 'Could not start the upload.'));
        }
        const { uploadUrl, assetId } = await reqRes.json();

        // 2. Upload the bytes straight to R2 via the presigned URL
        const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
        if (!putRes.ok) throw new Error('Upload to storage failed. Please try again.');

        // 3. Confirm — verifies the object, counts the bytes, and kicks off AI extraction
        const confRes = await fetch('/.netlify/functions/storage-confirm-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId }),
        });
        if (!confRes.ok) {
            const err = await confRes.json().catch(() => ({}));
            throw new Error(err.error || 'Could not confirm the upload.');
        }
    }

    // ── Listing / display ───────────────────────────────────────────────────
    async function loadAssets() {
        const list = document.getElementById('asset-list');
        if (!list) return;
        try {
            const res = await fetch('/.netlify/functions/get-workspace-assets');
            if (!res.ok) return;
            const { assets } = await res.json();
            renderAssets(assets || []);
        } catch { /* non-fatal */ }
    }

    function renderAssets(assets) {
        const list = document.getElementById('asset-list');
        if (!list) return;
        if (!assets.length) {
            list.innerHTML = '<li class="p-6 text-sm text-gray-400 text-center">No brand assets yet — upload a file or add a URL above.</li>';
            return;
        }
        list.innerHTML = assets.map(a => {
            const styles = STATUS_STYLES[a.status] || 'bg-gray-50 text-gray-600 border-gray-200';
            const meta = [(a.category || a.assetType || '').replace(/_/g, ' '), fmtBytes(a.fileSizeBytes)].filter(Boolean).join(' • ');
            const action = a.isFile
                ? `<button type="button" data-download="${a.id}" class="text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline">Download</button>`
                : (a.externalUrl ? `<a href="${escHtml(a.externalUrl)}" target="_blank" rel="noopener" class="text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline">Open</a>` : '');
            return `<li class="p-6 hover:bg-gray-50 transition-colors flex items-center justify-between gap-4">
                <div class="flex items-center gap-4 min-w-0">
                    <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-gray-500">${FILE_ICON}</div>
                    <div class="truncate">
                        <p class="text-sm font-bold text-gray-900 truncate">${escHtml(a.name)}</p>
                        <p class="text-xs text-gray-500">${escHtml(meta)}</p>
                    </div>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                    ${action}
                    <span class="inline-flex items-center py-1 px-2.5 rounded-md text-xs font-medium border ${styles}">${escHtml(a.status)}</span>
                </div>
            </li>`;
        }).join('');

        list.querySelectorAll('[data-download]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-download');
                try {
                    const res = await fetch(`/.netlify/functions/storage-download-url?assetId=${id}`);
                    if (!res.ok) throw new Error();
                    const { downloadUrl } = await res.json();
                    window.open(downloadUrl, '_blank', 'noopener');
                } catch { alert('Could not generate a download link.'); }
            });
        });
    }

    // Initial load of existing assets so they survive a page refresh.
    loadAssets();
};
