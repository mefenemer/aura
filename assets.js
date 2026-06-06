window.initBrandAssets = function() {
    const btnFile = document.getElementById('btn-tab-file');
    if (!btnFile) return; // Safety check

    const btnUrl = document.getElementById('btn-tab-url');
    const btnText = document.getElementById('btn-tab-text');

    const zoneFile = document.getElementById('zone-file');
    const zoneUrl = document.getElementById('zone-url');
    const zoneText = document.getElementById('zone-text');

    const inputUrl = document.getElementById('external-url');
    const inputFile = document.getElementById('file-upload');

    // UPDATED TABLE SELECTORS
    const tableBody = document.getElementById('text-assets-table-body');
    const btnAddRow = document.getElementById('btn-add-text-row');

    let currentMode = 'file';

    // --- TAB TOGGLING ---
    const updateTabs = (mode) => {
        currentMode = mode;
        const activeClass = 'flex-1 py-1.5 text-xs font-bold bg-white text-gray-900 rounded-md shadow-sm transition-all';
        const inactiveClass = 'flex-1 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-all';

        btnFile.className = mode === 'file' ? activeClass : inactiveClass;
        btnUrl.className = mode === 'url' ? activeClass : inactiveClass;
        btnText.className = mode === 'text' ? activeClass : inactiveClass;

        zoneFile.classList.toggle('hidden', mode !== 'file');
        zoneFile.classList.toggle('block', mode === 'file');
        zoneUrl.classList.toggle('hidden', mode !== 'url');
        zoneUrl.classList.toggle('block', mode === 'url');
        zoneText.classList.toggle('hidden', mode !== 'text');
        zoneText.classList.toggle('block', mode === 'text');
    };

    btnFile.addEventListener('click', () => updateTabs('file'));
    btnUrl.addEventListener('click', () => updateTabs('url'));
    btnText.addEventListener('click', () => updateTabs('text'));

    // --- SCENARIO 2: ADD TABLE ROW ---

    // 1. Wire up the initial row that is hardcoded in the HTML
    const initialRemoveBtn = tableBody.querySelector('.btn-remove-row');
    if (initialRemoveBtn) {
        initialRemoveBtn.addEventListener('click', (e) => {
            e.target.closest('tr').remove();
        });
    }

    // 2. Wire up the "Add Row" button
    btnAddRow.addEventListener('click', () => {
        const row = document.createElement('tr');
        row.className = 'asset-row border-b border-gray-100';
        row.innerHTML = `
            <td class="p-2"><input type="text" placeholder="Title" class="text-title w-full px-3 py-2 rounded border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none"></td>
            <td class="p-2"><input type="text" placeholder="Description" class="text-content w-full px-3 py-2 rounded border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none"></td>
            <td class="p-2 text-center">
                <button type="button" class="btn-remove-row text-gray-400 hover:text-red-500">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </td>
        `;
        row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
        tableBody.appendChild(row);
    });

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
        submitBtn.textContent = 'Saving...';
        submitBtn.classList.add('opacity-75', 'cursor-not-allowed');

        try {
            if (currentMode === 'text') {
                const rows = Array.from(tableBody.querySelectorAll('.asset-row'));
                const textAssets = rows.map(row => ({
                    title: row.querySelector('.text-title').value.trim(),
                    content: row.querySelector('.text-content').value.trim()
                })).filter(b => b.title && b.content);

                if (textAssets.length === 0) throw new Error("Please enter at least one title and description.");

                const response = await fetch('/.netlify/functions/add-text-assets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ category, assets: textAssets })
                });

                if (!response.ok) throw new Error("Failed to save text assets");

                textAssets.forEach(asset => injectAssetIntoList(asset.title, category, 'Ready', 'green'));

                // Reset table to a single empty row after successful save
                tableBody.innerHTML = `
                    <tr class="asset-row border-b border-gray-100">
                        <td class="p-2"><input type="text" placeholder="Title" class="text-title w-full px-3 py-2 rounded border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none"></td>
                        <td class="p-2"><input type="text" placeholder="Description" class="text-content w-full px-3 py-2 rounded border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none"></td>
                        <td class="p-2 text-center">
                            <button type="button" class="btn-remove-row text-gray-400 hover:text-red-500">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                        </td>
                    </tr>
                `;
                // Rewire the remove button for the new empty row
                tableBody.querySelector('.btn-remove-row').addEventListener('click', (e) => e.target.closest('tr').remove());

            } else {
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

                // Call upload-asset.ts endpoint
                const response = await fetch('/.netlify/functions/upload-asset', {
                    method: 'POST',
                    body: payload
                });

                if (!response.ok) throw new Error("Failed to upload asset");

                injectAssetIntoList(assetName, category, 'Processing AI Context...', 'amber', true);

                form.reset();
                fileNameDisplay.classList.add('hidden');
                inputFile.value = '';
            }

        } catch (error) {
            console.error('Save failed:', error);
            alert(error.message || "Failed to save asset. Please try again.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Asset';
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
        assetList.prepend(li);
    }
};