// instructions.js

// Auto-resize a textarea to fit its content.
// Must be called AFTER the element is attached to the DOM.
function _autoResize(textarea) {
    textarea.style.height = '';
    textarea.style.height = textarea.scrollHeight + 'px';
}

window.initInstructions = function() {

    const container = document.getElementById('rules-container');
    const saveStatus = document.getElementById('save-status');
    if (!container) return;

    const categories = [
        {
            id: 'tone_of_voice',
            title: 'Tone of Voice & Personality',
            placeholder: 'e.g., "Always maintain a professional yet friendly tone. Act as a supportive team member."'
        },
        {
            id: 'response_formatting',
            title: 'Response Formatting',
            placeholder: 'e.g., "Always use bullet points for lists. Never use technical jargon unless explicitly asked."'
        },
        {
            id: 'core_knowledge',
            title: 'Core Business Facts',
            placeholder: 'e.g., "Our flagship service is Aura-Assist, an AI-driven task delegation platform designed for SaaS teams."'
        },
        {
            id: 'target_audience',
            title: 'Target Audience Context',
            placeholder: 'e.g., "Assume you are speaking to enterprise IT directors who value efficiency and operational cost reduction."'
        }
    ];

    // --- 1. AUTO-SAVE DEBOUNCE ENGINE ---
    let saveTimeout;

    function updateStatusUI(state) {
        if (!saveStatus) return;
        saveStatus.classList.remove('opacity-0');

        if (state === 'saving') {
            saveStatus.innerHTML = `<svg class="animate-spin w-4 h-4 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" class="opacity-75"></path></svg><span class="text-amber-600">Saving changes...</span>`;
        } else if (state === 'saved') {
            saveStatus.innerHTML = `<svg class="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg><span class="text-emerald-600">All changes saved</span>`;
            setTimeout(() => saveStatus.classList.add('opacity-0'), 2500); // Fade out after 2.5s
        } else if (state === 'error') {
            saveStatus.innerHTML = `<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg><span class="text-red-600">Save failed. Retrying...</span>`;
        }
    }

    const triggerAutoSave = () => {
        updateStatusUI('saving');
        clearTimeout(saveTimeout);

        // Wait 800ms after the last action before hitting the API
        saveTimeout = setTimeout(async () => {
            const payload = categories.map(cat => {
                const rows = document.getElementById(`tbody-${cat.id}`).querySelectorAll('tr');
                return {
                    category: cat.id,
                    rules: Array.from(rows).map((row, index) => ({
                        priority: index + 1,
                        value: row.querySelector('.rule-input').value.trim(),
                        isActive: row.querySelector('.toggle-btn').getAttribute('aria-checked') === 'true'
                    })).filter(rule => rule.value !== '')
                };
            });

            try {
                const response = await fetch('/.netlify/functions/add-text-assets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error("Sync failed");
                updateStatusUI('saved');
            } catch (error) {
                console.error("Auto-save error:", error);
                updateStatusUI('error');
            }
        }, 800);
    };

    // --- 2. RENDER SECTIONS & TABLES ---
    container.innerHTML = categories.map(cat => `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div class="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                <h3 class="text-lg font-bold text-gray-900">${cat.title}</h3>
                <button type="button" data-category="${cat.id}" class="btn-add-rule text-sm font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1 bg-emerald-50 px-3 py-1.5 rounded-md transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                    Add Rule
                </button>
            </div>
            <div class="p-0">
                <table class="w-full text-sm text-left">
                    <tbody id="tbody-${cat.id}" class="sortable-tbody divide-y divide-gray-100">
                        <!-- Rows injected here -->
                    </tbody>
                </table>
            </div>
        </div>
    `).join('');

    // --- 3. ROW GENERATOR ---
    const createRow = (placeholderText) => {
        const tr = document.createElement('tr');
        tr.className = 'group bg-white hover:bg-gray-50 transition-colors cursor-grab';
        tr.draggable = true;

        tr.innerHTML = `
            <td class="p-4 w-12 text-gray-300 group-hover:text-gray-500 cursor-grab active:cursor-grabbing text-center">
                <svg class="w-5 h-5 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
            </td>
            <td class="p-4">
                <textarea rows="1" placeholder='${placeholderText}' class="rule-input w-full px-3 py-2 text-sm rounded-lg border border-transparent hover:border-gray-300 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none bg-transparent focus:bg-white resize-none overflow-hidden"></textarea>
            </td>
            <td class="p-4 w-28 text-center align-middle">
                <button type="button" aria-checked="true" class="toggle-btn relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none bg-green-500">
                    <span class="translate-x-5 pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"></span>
                </button>
            </td>
            <td class="p-4 w-16 text-center align-middle">
                <button type="button" class="btn-delete-rule text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100">
                    <svg class="w-5 h-5 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </td>
        `;

        // Input Typing Logic -> Auto-resize & Trigger Save
        const input = tr.querySelector('.rule-input');
        input.addEventListener('input', () => {
            _autoResize(input);
            triggerAutoSave();
        });

        // Toggle Logic -> Trigger Save
        const toggleBtn = tr.querySelector('.toggle-btn');
        const toggleDot = toggleBtn.querySelector('span');
        toggleBtn.addEventListener('click', () => {
            const isChecked = toggleBtn.getAttribute('aria-checked') === 'true';
            toggleBtn.setAttribute('aria-checked', !isChecked);
            toggleBtn.className = `toggle-btn relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${!isChecked ? 'bg-green-500' : 'bg-gray-300'}`;
            toggleDot.className = `${!isChecked ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`;

            !isChecked ? input.classList.remove('text-gray-400', 'line-through') : input.classList.add('text-gray-400', 'line-through');
            triggerAutoSave();
        });

        // Delete Logic -> Trigger Save
        tr.querySelector('.btn-delete-rule').addEventListener('click', () => {
            const confirmed = confirm("WARNING: Deleting this value will permanently remove it from all Assistant instructions globally.\n\nAre you sure you want to proceed?");
            if (confirmed) {
                tr.remove();
                triggerAutoSave();
            }
        });

        attachDragEvents(tr);
        return tr;
    };

    // --- 4. WIRE UP "ADD RULE" BUTTONS ---
    categories.forEach(cat => {
        document.querySelector(`button[data-category="${cat.id}"]`).addEventListener('click', () => {
            const tbody = document.getElementById(`tbody-${cat.id}`);
            tbody.appendChild(createRow(cat.placeholder));
            triggerAutoSave();
        });
    });

    // --- 5. LOAD EXISTING RULES FROM DB ---
    (async () => {
        try {
            const res = await fetch('/.netlify/functions/add-text-assets');
            if (!res.ok) throw new Error('Load failed');
            const data = await res.json();
            const grouped = data.rules || {};

            categories.forEach(cat => {
                const tbody = document.getElementById(`tbody-${cat.id}`);
                const savedRules = grouped[cat.id];

                if (savedRules && savedRules.length > 0) {
                    // Populate with saved data
                    savedRules.forEach(rule => {
                        const tr = createRow(cat.placeholder);
                        const input = tr.querySelector('.rule-input');
                        const toggleBtn = tr.querySelector('.toggle-btn');
                        const toggleDot = toggleBtn.querySelector('span');

                        input.value = rule.value;

                        // Apply toggle state
                        const isActive = rule.isActive !== false;
                        toggleBtn.setAttribute('aria-checked', isActive ? 'true' : 'false');
                        toggleBtn.className = `toggle-btn relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${isActive ? 'bg-green-500' : 'bg-gray-300'}`;
                        toggleDot.className = `${isActive ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`;
                        if (!isActive) input.classList.add('text-gray-400', 'line-through');

                        tbody.appendChild(tr);
                        // Resize AFTER element is in the DOM so scrollHeight is accurate
                        _autoResize(input);
                    });
                } else {
                    // No saved rules — show one empty row as a prompt
                    tbody.appendChild(createRow(cat.placeholder));
                }
            });
        } catch (e) {
            console.warn('Could not load saved rules:', e);
            // Fall back to empty rows
            categories.forEach(cat => {
                document.getElementById(`tbody-${cat.id}`).appendChild(createRow(cat.placeholder));
            });
        }
    })();

    // --- 6. SAFETY FEEDBACK MODAL ---
    window._openSafetyFeedback = function () {
        document.getElementById('safety-suggestion').value = '';
        document.getElementById('safety-context').value = '';
        document.getElementById('safety-feedback-error').classList.add('hidden');
        document.getElementById('safety-feedback-success').classList.add('hidden');
        const btn = document.getElementById('btn-safety-submit');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Submit Suggestion';
        }
        document.getElementById('modal-safety-feedback').classList.remove('hidden');
    };

    window._submitSafetyFeedback = async function () {
        const suggestion = document.getElementById('safety-suggestion').value.trim();
        const context = document.getElementById('safety-context').value.trim();
        const errorEl = document.getElementById('safety-feedback-error');
        const successEl = document.getElementById('safety-feedback-success');
        const btn = document.getElementById('btn-safety-submit');

        errorEl.classList.add('hidden');
        successEl.classList.add('hidden');

        if (!suggestion) {
            errorEl.textContent = 'Please describe your suggested safety rule.';
            errorEl.classList.remove('hidden');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Sending…';

        try {
            const res = await fetch('/.netlify/functions/safety-feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ suggestion, context }),
            });

            if (res.ok) {
                successEl.classList.remove('hidden');
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Sent!';
                setTimeout(() => {
                    document.getElementById('modal-safety-feedback').classList.add('hidden');
                }, 2200);
            } else {
                const data = await res.json().catch(() => ({}));
                errorEl.textContent = data.error || 'Submission failed. Please try again.';
                errorEl.classList.remove('hidden');
                btn.disabled = false;
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Submit Suggestion';
            }
        } catch {
            errorEl.textContent = 'Network error. Please check your connection and try again.';
            errorEl.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Submit Suggestion';
        }
    };

    // --- 7. HTML5 DRAG AND DROP ENGINE ---
    let draggedRow = null;

    function attachDragEvents(row) {
        row.addEventListener('dragstart', function(e) {
            draggedRow = this;
            this.classList.add('opacity-50');
            e.dataTransfer.effectAllowed = 'move';
        });

        row.addEventListener('dragend', function() {
            draggedRow = null;
            this.classList.remove('opacity-50');
            document.querySelectorAll('.asset-row-over').forEach(el => el.classList.remove('border-t-2', 'border-emerald-500', 'asset-row-over'));
        });

        row.addEventListener('dragover', function(e) {
            e.preventDefault();
            if (this === draggedRow || this.parentNode !== draggedRow.parentNode) return;

            const bounding = this.getBoundingClientRect();
            const offset = bounding.y + (bounding.height / 2);

            this.classList.add('asset-row-over');
            if (e.clientY - offset > 0) {
                this.style.borderBottom = '2px solid #10B981';
                this.style.borderTop = '';
            } else {
                this.style.borderTop = '2px solid #10B981';
                this.style.borderBottom = '';
            }
        });

        row.addEventListener('dragleave', function() {
            this.classList.remove('asset-row-over');
            this.style.borderTop = '';
            this.style.borderBottom = '';
        });

        row.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('asset-row-over');
            this.style.borderTop = '';
            this.style.borderBottom = '';

            if (this === draggedRow || this.parentNode !== draggedRow.parentNode) return;

            const bounding = this.getBoundingClientRect();
            const offset = bounding.y + (bounding.height / 2);

            if (e.clientY - offset > 0) {
                this.parentNode.insertBefore(draggedRow, this.nextSibling);
            } else {
                this.parentNode.insertBefore(draggedRow, this);
            }

            // Drag and Drop completes -> Trigger Save to update Priorities
            triggerAutoSave();
        });
    }
};