window.initBrandAssets = function() {
    const btnFile = document.getElementById('btn-tab-file');
    if (!btnFile) return;

    const btnUrl = document.getElementById('btn-tab-url');
    const zoneFile = document.getElementById('zone-file');
    const zoneUrl = document.getElementById('zone-url');
    const inputUrl = document.getElementById('external-url');
    const inputFile = document.getElementById('file-upload');

    let currentMode = 'file';

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
        dropZone.addEventListener(eventName, e => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
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
    const assetList = document.getElementById('asset-list');
    const submitBtn = document.getElementById('submit-asset-btn');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const category = document.getElementById('asset-category').value;
        if (!category) return alert("Please select an asset category.");

        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading...';
        submitBtn.classList.add('opacity-75', 'cursor-not-allowed');

        try {
            let assetName = '';
            let payload = new FormData();
            payload.append('category', category);

            if (currentMode === 'file') {
                const file = inputFile.files[0];
                if (!file) throw new Error("Please select a file to upload.");
                assetName = file.name;
                payload.append('file', file);
            } else {
                const url = inputUrl.value.trim();
                if (!url) throw new Error("Please enter a valid URL.");
                assetName = url;
                payload.append('url', url);
            }

            const response = await fetch('/.netlify/functions/upload-asset', {
                method: 'POST',
                body: payload
            });

            if (!response.ok) throw new Error("Failed to upload asset");

            injectAssetIntoList(assetName, category, 'Processing AI Context...', 'amber', true);

            form.reset();
            fileNameDisplay.classList.add('hidden');
            inputFile.value = '';

        } catch (error) {
            console.error('Save failed:', error);
            alert(error.message || "Failed to save asset. Please try again.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Upload Asset';
            submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        }
    });

    function injectAssetIntoList(name, cat, statusText, statusColor, isSpinning = false) {
        const iconSvg = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"></path></svg>`;
        const statusIcon = isSpinning
            ? `<svg class="animate-spin w-3 h-3 text-${statusColor}-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" class="opacity-75"></path></svg>`
            : `<span class="w-1.5 h-1.5 rounded-full bg-${statusColor}-600"></span>`;

        const li = document.createElement('li');
        li.className = 'p-6 hover:bg-gray-50 transition-colors flex items-center justify-between gap-4 animate-pulse';
        li.innerHTML = `
            <div class="flex items-center gap-4 min-w-0">
                <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-gray-500">
                    ${iconSvg}
                </div>
                <div class="truncate">
                    <p class="text-sm font-bold text-gray-900 truncate">${name}</p>
                    <p class="text-xs text-gray-500">${cat.replace('_', ' ')} • Uploaded just now</p>
                </div>
            </div>
            <span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-medium bg-${statusColor}-50 text-${statusColor}-700 border border-${statusColor}-200 shrink-0">
                ${statusIcon} ${statusText}
            </span>
        `;
        document.getElementById('asset-list').prepend(li);
    }
};