window.initBrandAssets = function() {
    const btnFile = document.getElementById('btn-tab-file');
    if (!btnFile) return;

    const btnUrl = document.getElementById('btn-tab-url');
    const btnText = document.getElementById('btn-tab-text'); // New Tab

    const zoneFile = document.getElementById('zone-file');
    const zoneUrl = document.getElementById('zone-url');
    const zoneText = document.getElementById('zone-text'); // New Zone

    const inputUrl = document.getElementById('external-url');
    const inputFile = document.getElementById('file-upload');
    const textBlocksContainer = document.getElementById('text-blocks-container');
    const btnAddText = document.getElementById('btn-add-text-block');

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

    // --- SCENARIO 2: ADD DYNAMIC TEXT BLOCKS ---
    btnAddText.addEventListener('click', () => {
        const newBlock = document.createElement('div');
        newBlock.className = 'text-block bg-gray-50 border border-gray-200 p-4 rounded-xl relative';
        newBlock.innerHTML = `
            <button type="button" class="btn-remove-block absolute top-2 right-2 text-gray-400 hover:text-red-500 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
            <input type="text" placeholder="Asset Title" class="text-title w-full px-3 py-2 text-sm rounded-md border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none mb-3 font-bold text-gray-900 pr-8">
            <textarea placeholder="Paste or type the rules here..." rows="3" class="text-content w-full px-3 py-2 text-sm rounded-md border border-gray-300 focus:ring-2 focus:ring-emerald-600 outline-none resize-none"></textarea>
        `;

        // Add remove functionality
        newBlock.querySelector('.btn-remove-block').addEventListener('click', () => newBlock.remove());
        textBlocksContainer.appendChild(newBlock);
    });

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
            // SCENARIO 3: Routing Logic based on active tab
            if (currentMode === 'text') {
                const blocks = Array.from(textBlocksContainer.querySelectorAll('.text-block'));
                const textAssets = blocks.map(block => ({
                    title: block.querySelector('.text-title').value.trim(),
                    content: block.querySelector('.text-content').value.trim()
                })).filter(b => b.title && b.content); // Filter out empty blocks

                if (textAssets.length === 0) throw new Error("Please enter at least one title and description.");

                // Post as standard JSON
                const response = await fetch('/.netlify/functions/add-text-assets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ category, assets: textAssets })
                });

                if (!response.ok) throw new Error("Failed to save text assets");

                // Optimistic UI for Bulk Text Assets
                textAssets.forEach(asset => injectAssetIntoList(asset.title, category, 'Ready', 'green'));

                // Reset text inputs
                textBlocksContainer.querySelectorAll('.text-title, .text-content').forEach(input => input.value = '');

            } else {
                // ... (Your existing file/url logic using FormData goes here) ...
                // Note: Keep your existing FormData append and fetch block here.
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

    // Helper to generate the list item HTML so we don't repeat code
    function injectAssetIntoList(name, cat, statusText, statusColor) {
        const li = document.createElement('li');
        li.className = 'p-6 hover:bg-gray-50 transition-colors flex items-center justify-between gap-4 animate-pulse';
        li.innerHTML = `
            <div class="flex items-center gap-4 min-w-0">
                <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-gray-500">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"></path></svg>
                </div>
                <div class="truncate">
                    <p class="text-sm font-bold text-gray-900 truncate">${name}</p>
                    <p class="text-xs text-gray-500">Category: ${cat} • Uploaded just now</p>
                </div>
            </div>
            <span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-medium bg-${statusColor}-50 text-${statusColor}-700 border border-${statusColor}-200 shrink-0">
                <span class="w-1.5 h-1.5 rounded-full bg-${statusColor}-600"></span> ${statusText}
            </span>
        `;
        assetList.prepend(li);
    }
};