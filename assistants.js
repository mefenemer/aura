// ==========================================
// GLOBAL STATE
// ==========================================
window.activeAssistantId = null;
window.cachedContext = {};

// ==========================================
// 1. SHARED CARD GENERATOR (Dashboard & Directory)
// ==========================================
window.generateAssistantCardHTML = function(assistant) {
    const initial = assistant.name ? assistant.name.charAt(0).toUpperCase() : 'A';
    const role = assistant.role || 'Custom Assistant';

    let statusHtml = '';
    // Adapt to database provisioningStatus or isActive states
    if (assistant.status === 'pending') {
        statusHtml = `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Provisioning</span>`;
    } else if (assistant.isActive === false) {
        statusHtml = `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200"><span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span> Paused</span>`;
    } else {
        statusHtml = `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Active</span>`;
    }

    return `
    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow p-6 flex flex-col cursor-pointer group" onclick="window.routeToAssistantDetail('${assistant.id}')">
        <div class="flex justify-between items-start mb-4">
            <div class="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-lg shadow-sm">
                ${initial}
            </div>
            ${statusHtml}
        </div>
        <h3 class="text-lg font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">${assistant.name}</h3>
        <p class="text-sm text-gray-500 mb-6">${role}</p>
        <div class="mt-auto pt-4 border-t border-gray-50 flex justify-end">
            <span class="text-sm font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">Board Room &rarr;</span>
        </div>
    </div>`;
};

// ==========================================
// 2. FETCH & RENDER ENGINE
// ==========================================
window.fetchAndRenderAssistants = async function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        if (!res.ok) throw new Error("Failed to fetch");

        const data = await res.json();
        container.innerHTML = ''; // Clear the "Gathering your team..." placeholder

        if (!data.assistants || data.assistants.length === 0) {
            container.innerHTML = `
              <div class="col-span-full py-12 text-center text-gray-500 font-medium bg-white rounded-2xl border border-gray-100 shadow-sm">
                  Your team is currently empty. <a href="#" onclick="loadView('catalog')" class="text-emerald-600 hover:underline">Hire an assistant</a>.
              </div>`;
            return;
        }

        data.assistants.forEach(assistant => {
            container.insertAdjacentHTML('beforeend', window.generateAssistantCardHTML(assistant));
        });
    } catch (error) {
        container.innerHTML = `<div class="col-span-full text-center text-red-500">Could not connect to the database to load your team.</div>`;
    }
};

// ==========================================
// 3. SPA ROUTER INITIALIZATION HOOKS
// ==========================================
window.initDashboard = async function() {
    await window.fetchAndRenderAssistants('dashboard-assistants-grid');
};

window.initAssistantsDirectory = async function(loadViewCb) {
    await window.fetchAndRenderAssistants('directory-assistants-grid');

    const catalogBtn = document.getElementById('route-to-catalog-from-dir');
    if (catalogBtn) {
        catalogBtn.addEventListener('click', () => loadViewCb('catalog'));
    }
};

// ==========================================
// 4. ASSISTANT DETAIL CONTROLLER (The Control Room)
// ==========================================

// Name generator pool
const _namePool = [
    'Aria', 'Nova', 'Echo', 'Sage', 'Luna', 'Atlas', 'Ember', 'Orion',
    'Lyra', 'Zara', 'Finn', 'Cleo', 'Rex', 'Mira', 'Axel', 'Skye',
    'Juno', 'Blaze', 'Ivy', 'Max', 'Stella', 'Cole', 'Pip', 'Dawn',
    'Felix', 'Nova', 'Cyra', 'Dex', 'Wren', 'Lux'
];
let _namePoolIdx = Math.floor(Math.random() * _namePool.length);

function _detailSetVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
}

function _detailToggleHandle(p) {
    const chk = document.getElementById('plat_' + p);
    const wrap = document.getElementById('handle-' + p);
    if (chk && wrap) wrap.classList.toggle('hidden', !chk.checked);
}

function _detailHydrate(data) {
    const ctx = data.context || {};
    const cfg = data.configuration || {};
    const inputs = cfg.inputs || {};

    _detailSetVal('edit_problem', ctx.problem_statement || inputs.problem || '');
    _detailSetVal('edit_frequency', ctx.posting_frequency || '');

    // Objective
    const objectiveVal = ctx.primary_objective || inputs.primary_objective || '';
    if (objectiveVal) {
        const r = document.querySelector(`input[name="edit_objective"][value="${objectiveVal}"]`);
        if (r) r.checked = true;
    }
    // Core message + CTA
    _detailSetVal('edit_core_message', ctx.core_message || inputs.core_message || '');
    _detailSetVal('edit_cta', ctx.cta || inputs.cta || '');
    _detailSetVal('edit_incentive', ctx.incentive || inputs.incentive || '');
    _detailSetVal('edit_audience', ctx.target_audience || '');
    _detailSetVal('edit_tone', ctx.tone_of_voice || '');
    _detailSetVal('edit_pillars', ctx.content_pillars || '');
    // workflowText is Aura-Assist IP — not displayed to the user

    // Radios — trigger
    const triggerVal = inputs.trigger_type || '';
    if (triggerVal) {
        const r = document.querySelector(`input[name="edit_trigger"][value="${triggerVal}"]`);
        if (r) r.checked = true;
    }
    // Radios — source
    const sourceVal = inputs.content_source || inputs.sourceText || '';
    if (sourceVal) {
        const r = document.querySelector(`input[name="edit_source"][value="${sourceVal}"]`);
        if (r) r.checked = true;
    }

    // Platforms
    const platforms = ctx.primary_platforms || [];
    const platformHandles = {};
    (inputs.platforms || []).forEach(p => {
        const match = p.match(/^([a-z]+)\s*\(([^)]+)\)/i);
        if (match) platformHandles[match[1]] = match[2];
    });
    ['fb', 'ig', 'li', 'x'].forEach(p => {
        const chk = document.getElementById('plat_' + p);
        if (!chk) return;
        const active = platforms.includes(p) || (inputs.platforms || []).some(s => s.startsWith(p));
        chk.checked = active;
        _detailToggleHandle(p);
        if (active && platformHandles[p]) _detailSetVal('handle_' + p, platformHandles[p]);
    });

    // Guardrails — separate knowledge base out of strictRules
    const allStrict = inputs.strictRules || [];
    const kbLine = allStrict.find(r => r.includes('KNOWLEDGE BASE (TEXT)'));
    const otherRules = allStrict.filter(r => !r.includes('KNOWLEDGE BASE (TEXT)'));
    _detailSetVal('edit_strict_rules', otherRules.join('\n'));
    if (kbLine) {
        const m = kbLine.match(/:"([^"]+)"/);
        _detailSetVal('edit_knowledge', m ? m[1] : '');
    }
}

function _detailCollect(currentData) {
    const platforms = [];
    const platformsRaw = [];
    ['fb', 'ig', 'li', 'x'].forEach(p => {
        if (document.getElementById('plat_' + p)?.checked) {
            platforms.push(p);
            const handle = document.getElementById('handle_' + p)?.value || '';
            platformsRaw.push(handle ? `${p} (${handle})` : p);
        }
    });

    const strictLines = (document.getElementById('edit_strict_rules')?.value || '')
        .split('\n').map(l => l.trim()).filter(Boolean);
    const knowledge = document.getElementById('edit_knowledge')?.value || '';
    if (knowledge) strictLines.push(`- KNOWLEDGE BASE (TEXT): Consider the following brand stories and context: "${knowledge}"`);

    const newContext = {
        problem_statement: document.getElementById('edit_problem')?.value || '',
        primary_objective: document.querySelector('input[name="edit_objective"]:checked')?.value || '',
        core_message: document.getElementById('edit_core_message')?.value || '',
        cta: document.getElementById('edit_cta')?.value || '',
        incentive: document.getElementById('edit_incentive')?.value || '',
        posting_frequency: document.getElementById('edit_frequency')?.value || '',
        target_audience: document.getElementById('edit_audience')?.value || '',
        tone_of_voice: document.getElementById('edit_tone')?.value || '',
        content_pillars: document.getElementById('edit_pillars')?.value || '',
        primary_platforms: platforms,
    };

    const newConfiguration = {
        ...(currentData.configuration || {}),
        inputs: {
            ...(currentData.configuration?.inputs || {}),
            problem: document.getElementById('edit_problem')?.value || '',
            trigger_type: document.querySelector('input[name="edit_trigger"]:checked')?.value || '',
            triggerText: document.querySelector('input[name="edit_trigger"]:checked')?.value || '',
            content_source: document.querySelector('input[name="edit_source"]:checked')?.value || '',
            sourceText: document.querySelector('input[name="edit_source"]:checked')?.value || '',
            platforms: platformsRaw,
            generalPreferences: [
                document.getElementById('edit_audience')?.value ? `- Target Audience: ${document.getElementById('edit_audience').value}` : '',
                document.getElementById('edit_pillars')?.value ? `- Core Topics: ${document.getElementById('edit_pillars').value}` : '',
                document.getElementById('edit_tone')?.value ? `- Preferred Tone: ${document.getElementById('edit_tone').value}` : '',
            ].filter(Boolean),
            workflowText: currentData.configuration?.inputs?.workflowText || '', // preserved, not editable
            strictRules: strictLines,
        }
    };

    return { newContext, newConfiguration };
}

function _detailSetSaveStatus(msg, colour) {
    const el = document.getElementById('detail-save-status');
    if (!el) return;
    el.className = `text-sm font-semibold transition-all ${colour || 'text-emerald-600'}`;
    el.textContent = msg;
}

window.initAssistantDetail = async function(assistantId, loadViewCb) {
    if (!assistantId) return;
    window.activeAssistantId = assistantId;

    // Back button
    const btnBack = document.getElementById('btn-back-assistants');
    if (btnBack) {
        const newBtn = btnBack.cloneNode(true);
        btnBack.parentNode.replaceChild(newBtn, btnBack);
        newBtn.addEventListener('click', () => loadViewCb('assistants'));
    }

    // ── Tab switching ─────────────────────────────────────────────
    document.querySelectorAll('.detail-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.remove('active-tab'));
            document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.add('hidden'));
            btn.classList.add('active-tab');
            const panel = document.getElementById('tab-' + btn.dataset.tab);
            if (panel) panel.classList.remove('hidden');
        });
    });

    // ── Platform handle toggles ───────────────────────────────────
    ['fb', 'ig', 'li', 'x'].forEach(p => {
        const chk = document.getElementById('plat_' + p);
        if (chk) chk.addEventListener('change', () => _detailToggleHandle(p));
    });

    // ── Load assistant data ───────────────────────────────────────
    let currentData = {};
    let saveTimeout = null;

    async function persistChanges() {
        _detailSetSaveStatus('Saving…', 'text-gray-400');
        const { newContext, newConfiguration } = _detailCollect(currentData);
        // Also save the name
        const nameInput = document.getElementById('detail-name-input');
        const newName = nameInput ? nameInput.value.trim() : null;
        try {
            const body = { assistantId: parseInt(assistantId), newContext, newConfiguration };
            if (newName) body.newName = newName;
            const res = await fetch('/.netlify/functions/update-assistant-context', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                currentData.context = newContext;
                currentData.configuration = newConfiguration;
                if (newName) {
                    document.getElementById('detail-avatar').textContent = newName.charAt(0).toUpperCase();
                    currentData.name = newName;
                }
                _detailSetSaveStatus('✓ Saved', 'text-emerald-600');
                setTimeout(() => _detailSetSaveStatus(''), 3000);
            } else {
                _detailSetSaveStatus('Save failed', 'text-red-500');
            }
        } catch {
            _detailSetSaveStatus('Save failed', 'text-red-500');
        }
    }

    function triggerAutoSave() {
        _detailSetSaveStatus('Unsaved changes…', 'text-gray-400');
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(persistChanges, 1200);
    }

    function attachAutoSave() {
        const selectors = [
            '[id^="edit_"]', '[id^="handle_"]',
            'input[name="edit_trigger"]', 'input[name="edit_source"]', 'input[name="edit_objective"]',
            '.platform-edit-chk', '#detail-name-input'
        ].join(', ');
        document.querySelectorAll(selectors).forEach(el => {
            el.addEventListener('input', triggerAutoSave);
            el.addEventListener('change', triggerAutoSave);
        });
    }

    // ── Load & hydrate ────────────────────────────────────────────
    try {
        const res = await fetch(`/.netlify/functions/get-assistant-context?id=${assistantId}`);
        if (!res.ok) throw new Error('Failed to load');
        currentData = await res.json();

        // Hero header
        const nameInput = document.getElementById('detail-name-input');
        if (nameInput) nameInput.value = currentData.name || 'Your Assistant';

        const avatarEl = document.getElementById('detail-avatar');
        if (avatarEl) avatarEl.textContent = (currentData.name || 'A').charAt(0).toUpperCase();

        const roleEl = document.getElementById('detail-role');
        if (roleEl) roleEl.textContent = currentData.role || 'Digital Assistant';

        const statusEl = document.getElementById('detail-status');
        const toggleBtn = document.getElementById('btn-toggle-status');
        if (statusEl) {
            const s = currentData.status || 'pending';
            if (s === 'active') {
                statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
                statusEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Active';
                if (toggleBtn) toggleBtn.textContent = 'Pause Assistant';
            } else if (s === 'pending') {
                statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200';
                statusEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> Provisioning';
                if (toggleBtn) toggleBtn.textContent = 'Pause Assistant';
            } else {
                statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200';
                statusEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-gray-400"></span> ' + s.charAt(0).toUpperCase() + s.slice(1);
                if (toggleBtn) toggleBtn.textContent = 'Resume Assistant';
            }
        }

        // Set window.cachedContext so fetchAndRenderIntegrations can use it
        window.cachedContext = currentData.context || {};

        _detailHydrate(currentData);
        attachAutoSave();
    } catch (e) {
        console.error('Failed to load assistant detail:', e);
    }

    // ── Name generator ────────────────────────────────────────────
    const genBtn = document.getElementById('btn-generate-name');
    if (genBtn) {
        genBtn.addEventListener('click', () => {
            _namePoolIdx = (_namePoolIdx + 1) % _namePool.length;
            const nameInput = document.getElementById('detail-name-input');
            if (nameInput) {
                nameInput.value = _namePool[_namePoolIdx];
                triggerAutoSave();
            }
        });
    }

    // ── Recent Activity ───────────────────────────────────────────
    const activityList = document.getElementById('recent-activity-list');
    if (activityList) {
        try {
            const res = await fetch(`/.netlify/functions/get-assistant-activity?id=${assistantId}`);
            if (res.ok) {
                const { logs } = await res.json();
                if (logs && logs.length > 0) {
                    activityList.innerHTML = logs.map(log => `
                        <div class="flex items-start gap-3 py-2.5 border-b border-gray-100 last:border-0">
                            <div class="w-2 h-2 rounded-full bg-emerald-400 mt-1.5 shrink-0"></div>
                            <div class="flex-1 min-w-0">
                                <p class="text-sm text-gray-700">${log.description || log.actionType}</p>
                                <p class="text-xs text-gray-400 mt-0.5">${log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</p>
                            </div>
                        </div>`).join('');
                } else {
                    activityList.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No activity yet — your assistant is ready to get to work.</p>';
                }
            } else {
                activityList.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No activity yet.</p>';
            }
        } catch {
            activityList.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No activity yet.</p>';
        }
    }

    // ── Integrations ──────────────────────────────────────────────
    await window.fetchAndRenderIntegrations();

    // ── Workspace defaults (Brand Profile + Assistant Rules) ──────
    await _fetchAndRenderWorkspaceDefaults(assistantId, currentData, triggerAutoSave);
};

// ─────────────────────────────────────────────────────────────────
// Workspace Defaults renderer — Brand Profile + Assistant Rules
// ─────────────────────────────────────────────────────────────────
async function _fetchAndRenderWorkspaceDefaults(assistantId, currentData, triggerAutoSave) {
    const appliedDefaults = currentData.configuration?.appliedDefaults || {};

    let defaults = { assistantRules: [], brandProfile: null };
    try {
        const res = await fetch('/.netlify/functions/get-workspace-defaults');
        if (res.ok) defaults = await res.json();
    } catch (e) {
        console.warn('Could not load workspace defaults:', e);
    }

    // ── Assistant Rules ───────────────────────────────────────────
    const rulesContainer = document.getElementById('global-assistant-rules-list');
    if (rulesContainer) {
        if (!defaults.assistantRules || defaults.assistantRules.length === 0) {
            rulesContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-6 text-center gap-2">
                    <p class="text-sm text-gray-500">No global rules have been configured yet.</p>
                    <a href="#" onclick="window.loadView('instructions')" class="text-sm font-bold text-emerald-600 hover:underline cursor-pointer">Go to Assistant Rules settings →</a>
                </div>`;
        } else {
            rulesContainer.innerHTML = '';
            defaults.assistantRules.forEach(rule => {
                const isEnabled = appliedDefaults.assistantRules?.[rule.id] !== false; // default ON
                const rowId = `rule-toggle-${rule.id}`;
                rulesContainer.insertAdjacentHTML('beforeend', `
                    <div class="flex items-start gap-4 py-3.5 border-b border-gray-100 last:border-0">
                        <div class="flex-1 min-w-0">
                            <p class="text-sm text-gray-800 font-medium">${_escapeHtml(rule.text)}</p>
                            ${rule.category ? `<p class="text-xs text-gray-400 mt-0.5">${_escapeHtml(rule.category)}</p>` : ''}
                        </div>
                        <label class="flex items-center cursor-pointer relative shrink-0 mt-0.5">
                            <input type="checkbox" id="${rowId}" data-rule-id="${rule.id}" class="sr-only peer global-rule-toggle" ${isEnabled ? 'checked' : ''}>
                            <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                        </label>
                    </div>`);
            });

            // Auto-save on toggle
            rulesContainer.querySelectorAll('.global-rule-toggle').forEach(chk => {
                chk.addEventListener('change', async () => {
                    const ruleStates = {};
                    rulesContainer.querySelectorAll('.global-rule-toggle').forEach(c => {
                        ruleStates[c.dataset.ruleId] = c.checked;
                    });
                    const statusEl = document.getElementById('rules-save-status');
                    if (statusEl) statusEl.textContent = 'Saving…';
                    try {
                        const r = await fetch('/.netlify/functions/update-assistant-context', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                assistantId: parseInt(assistantId),
                                newContext: window.cachedContext,
                                appliedDefaults: { assistantRules: ruleStates },
                            }),
                        });
                        if (r.ok) {
                            if (!currentData.configuration) currentData.configuration = {};
                            if (!currentData.configuration.appliedDefaults) currentData.configuration.appliedDefaults = {};
                            currentData.configuration.appliedDefaults.assistantRules = ruleStates;
                            if (statusEl) { statusEl.textContent = '✓ Saved'; setTimeout(() => statusEl.textContent = '', 2000); }
                        }
                    } catch {
                        if (document.getElementById('rules-save-status')) document.getElementById('rules-save-status').textContent = 'Error saving';
                    }
                });
            });
        }
    }

    // ── Brand Profile ─────────────────────────────────────────────
    const brandContainer = document.getElementById('global-brand-profile-content');
    if (brandContainer) {
        if (!defaults.brandProfile || Object.keys(defaults.brandProfile).length === 0) {
            brandContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-6 text-center gap-2">
                    <p class="text-sm text-gray-500">No brand profile has been configured yet.</p>
                    <a href="#" onclick="window.loadView('assets')" class="text-sm font-bold text-emerald-600 hover:underline cursor-pointer">Go to Brand Profile settings →</a>
                </div>`;
        } else {
            const bp = defaults.brandProfile;
            const brandEnabled = appliedDefaults.brandProfile !== false; // default ON
            const fields = [
                { label: 'Business Name', value: bp.businessName },
                { label: 'Industry', value: bp.industry },
                { label: 'Brand Values', value: bp.brandValues },
                { label: 'Mission', value: bp.mission },
                { label: 'Website', value: bp.website },
            ].filter(f => f.value);

            brandContainer.innerHTML = `
                <div class="flex items-center justify-between mb-4 pb-4 border-b border-gray-100">
                    <p class="text-sm font-bold text-gray-700">Apply this Brand Profile to the assistant</p>
                    <label class="flex items-center cursor-pointer relative">
                        <input type="checkbox" id="brand-profile-toggle" class="sr-only peer" ${brandEnabled ? 'checked' : ''}>
                        <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                    </label>
                </div>
                <dl id="brand-profile-fields" class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 ${brandEnabled ? '' : 'opacity-40 pointer-events-none'}">
                    ${fields.map(f => `
                        <div>
                            <dt class="text-xs font-bold text-gray-400 uppercase tracking-wide">${_escapeHtml(f.label)}</dt>
                            <dd class="text-sm text-gray-800 mt-0.5">${_escapeHtml(f.value)}</dd>
                        </div>`).join('')}
                </dl>`;

            document.getElementById('brand-profile-toggle')?.addEventListener('change', async (e) => {
                const enabled = e.target.checked;
                const fieldsEl = document.getElementById('brand-profile-fields');
                if (fieldsEl) fieldsEl.className = fieldsEl.className.replace(/opacity-40 pointer-events-none/g, '') + (enabled ? '' : ' opacity-40 pointer-events-none');
                const statusEl = document.getElementById('brand-save-status');
                if (statusEl) statusEl.textContent = 'Saving…';
                try {
                    const r = await fetch('/.netlify/functions/update-assistant-context', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            assistantId: parseInt(assistantId),
                            newContext: window.cachedContext,
                            appliedDefaults: { brandProfile: enabled },
                        }),
                    });
                    if (r.ok) {
                        if (!currentData.configuration) currentData.configuration = {};
                        if (!currentData.configuration.appliedDefaults) currentData.configuration.appliedDefaults = {};
                        currentData.configuration.appliedDefaults.brandProfile = enabled;
                        if (statusEl) { statusEl.textContent = '✓ Saved'; setTimeout(() => statusEl.textContent = '', 2000); }
                    }
                } catch {
                    if (document.getElementById('brand-save-status')) document.getElementById('brand-save-status').textContent = 'Error saving';
                }
            });
        }
    }
}

function _escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ==========================================
// 6. INTEGRATIONS RENDER ENGINE
// ==========================================
window.fetchAndRenderIntegrations = async function() {
    try {
        const res = await fetch('/.netlify/functions/integrations');
        if (!res.ok) return;
        const data = await res.json();

        const container = document.getElementById('assistant-integrations-list');
        const emptyPrompt = document.getElementById('empty-integrations-prompt');

        if (!data.connections || data.connections.length === 0) {
            if(emptyPrompt) emptyPrompt.classList.remove('hidden');
            if(container) container.classList.add('hidden');
            return;
        }

        if(emptyPrompt) emptyPrompt.classList.add('hidden');
        if(container) {
            container.classList.remove('hidden');
            container.innerHTML = '';
        }

        const linkedIds = window.cachedContext.linked_integrations || [];

        // Helper inline mapping for smart defaults
        const mapServiceNameToKey = (name) => {
            const m = { 'Facebook': 'fb', 'Instagram': 'ig', 'LinkedIn': 'li', 'X': 'x' };
            return m[name] || name.toLowerCase();
        };

        data.connections.forEach(conn => {
            const isDefaultSelected = window.cachedContext.primary_platforms?.includes(mapServiceNameToKey(conn.serviceName));
            const isChecked = (linkedIds.includes(conn.id) || isDefaultSelected) ? 'checked' : '';

            container.insertAdjacentHTML('beforeend', `
              <div class="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition">
                <div class="flex items-center gap-4">
                  <div class="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center font-bold text-gray-700">${conn.serviceName.substring(0,2).toUpperCase()}</div>
                  <div>
                    <h4 class="font-bold text-gray-900">${conn.serviceName}</h4>
                    <p class="text-xs text-gray-500 uppercase">${conn.connectionType.replace('_', ' ')}</p>
                  </div>
                </div>
                <label class="flex items-center cursor-pointer relative">
                  <input type="checkbox" class="sr-only peer integration-toggle" value="${conn.id}" ${isChecked}>
                  <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>
            `);
        });

        // Attach Auto-Save to Integration Switches
        document.querySelectorAll('.integration-toggle').forEach(chk => {
            chk.addEventListener('change', async () => {
                const selectedIds = Array.from(document.querySelectorAll('.integration-toggle:checked')).map(c => parseInt(c.value));
                const newContext = { ...window.cachedContext, linked_integrations: selectedIds };
                const statusEl = document.getElementById('integration-save-status');

                if(statusEl) statusEl.innerText = "Updating access...";

                try {
                    const r = await fetch('/.netlify/functions/update-assistant-context', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ assistantId: parseInt(window.activeAssistantId), newContext })
                    });
                    if(r.ok) {
                        window.cachedContext = newContext;
                        if(statusEl) {
                            statusEl.innerText = "✓ Access Updated";
                            setTimeout(() => statusEl.innerText = "", 2000);
                        }
                    }
                } catch(e) {
                    if(statusEl) statusEl.innerText = "Error updating";
                }
            });
        });
    } catch (e) {
        console.error("Integrations render error:", e);
    }
};