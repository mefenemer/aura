document.addEventListener('DOMContentLoaded', () => {

    // --- 1. TAB TOGGLING (FILE vs URL) ---
    const btnFile = document.getElementById('btn-tab-file');
    const btnUrl = document.getElementById('btn-tab-url');
    const zoneFile = document.getElementById('zone-file');
    const zoneUrl = document.getElementById('zone-url');
    const inputUrl = document.getElementById('external-url');
    const inputFile = document.getElementById('file-upload');

    let currentMode = 'file'; // 'file' or 'url'

    btnFile.addEventListener('click', () => {
        currentMode = 'file';
        // Styling
        btnFile.className = 'flex-1 py-2 text-sm font-bold bg-white text-gray-900 rounded-md shadow-sm transition-all';
        btnUrl.className = 'flex-1 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 transition-all';
        // Visibility
        zoneFile.classList.remove('hidden');
        zoneFile.classList.add('block');
        zoneUrl.classList.remove('block');
        zoneUrl.classList.add('hidden');
        // Clear conflicting input
        inputUrl.value = '';
    });

    btnUrl.addEventListener('click', () => {
        currentMode = 'url';
        // Styling
        btnUrl.className = 'flex-1 py-2 text-sm font-bold bg-white text-gray-900 rounded-md shadow-sm transition-all';
        btnFile.className = 'flex-1 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 transition-all';
        // Visibility
        zoneUrl.classList.remove('hidden');
        zoneUrl.classList.add('block');
        zoneFile.classList.remove('block');
        zoneFile.classList.add('hidden');
        // Clear conflicting input
        inputFile.value = '';
        document.getElementById('file-name-display').classList.add('hidden');
    });

    // --- 2. DRAG & DROP HANDLING ---
    const dropZone = document.getElementById('drop-zone');
    const fileNameDisplay = document.getElementById('file-name-display');

    // Prevent default browser behavior (opening the file)
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // Highlight drop zone
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('border-emerald-500', 'bg-emerald-50'), false);
    });

    // Un-highlight drop zone
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('border-emerald-500', 'bg-emerald-50'), false);
    });

    // Handle dropped files
    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    });

    // Handle manual file selection
    inputFile.addEventListener('change', function() {
        handleFiles(this.files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            // Validate size (e.g., 10MB max)
            if (file.size > 10 * 1024 * 1024) {
                alert("File is too large. Maximum size is 10MB.");
                inputFile.value = '';
                return;
            }
            // Display filename
            fileNameDisplay.textContent = `Selected: ${file.name}`;
            fileNameDisplay.classList.remove('hidden');

            // Sync with hidden input if dragged
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            inputFile.files = dataTransfer.files;
        }
    }

    // --- 3. FORM SUBMISSION (OPTIMISTIC UI) ---
    const form = document.getElementById('asset-upload-form');
    const assetList = document.getElementById('asset-list');
    const submitBtn = document.getElementById('submit-asset-btn');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const category = document.getElementById('asset-category').value;
        if (!category) return alert("Please select an asset category.");

        let assetName = '';
        let payload = new FormData();
        payload.append('category', category);

        if (currentMode === 'file') {
            const file = inputFile.files[0];
            if (!file) return alert("Please select a file to upload.");
            assetName = file.name;
            payload.append('file', file);
        } else {
            const url = inputUrl.value.trim();
            if (!url) return alert("Please enter a valid URL.");
            assetName = url;
            payload.append('url', url);
        }

        // 1. UI Loading State
        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading...';
        submitBtn.classList.add('opacity-75', 'cursor-not-allowed');

        try {
            // NOTE: In production, this fetch points to your Netlify function (e.g., '/.netlify/functions/upload-asset')
            // For now, we simulate a successful network response to build the UI:
            await new Promise(resolve => setTimeout(resolve, 800));

            // 2. Optimistic UI Update (Scenario 4 - Processing State)
            const iconSvg = currentMode === 'url'
                ? `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>`
                : `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>`;

            const newListItem = document.createElement('li');
            newListItem.className = 'p-6 hover:bg-gray-50 transition-colors flex items-center justify-between gap-4 animate-pulse';
            newListItem.innerHTML = `
                <div class="flex items-center gap-4 min-w-0">
                    <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-gray-500">
                        ${iconSvg}
                    </div>
                    <div class="truncate">
                        <p class="text-sm font-bold text-gray-900 truncate">${assetName}</p>
                        <p class="text-xs text-gray-500">Category: ${category.replace('_', ' ')} • Uploaded just now</p>
                    </div>
                </div>
                <span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 shrink-0">
                    <svg class="animate-spin w-3 h-3 text-amber-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    Processing AI Context...
                </span>
            `;

            // Insert at top of list
            assetList.prepend(newListItem);

            // 3. Reset Form
            form.reset();
            fileNameDisplay.classList.add('hidden');
            inputFile.value = '';

        } catch (error) {
            console.error('Upload failed:', error);
            alert("Failed to upload asset. Please try again.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save & Process Asset';
            submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        }
    });
});