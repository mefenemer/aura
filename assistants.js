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
    // workflowText is Be More Swan IP — not displayed to the user

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

    // Platforms are rendered dynamically from global connections — see _renderPlatformsTab()

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
    // Platforms are managed via the dynamic platforms tab — preserve existing values
    const platforms = currentData.context?.primary_platforms || [];
    const platformsRaw = currentData.configuration?.inputs?.platforms || [];

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
    window._currentAssistantId = assistantId;

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
            '[id^="edit_"]',
            'input[name="edit_trigger"]', 'input[name="edit_source"]', 'input[name="edit_objective"]',
            '#detail-name-input'
        ].join(', ');
        document.querySelectorAll(selectors).forEach(el => {
            el.addEventListener('input', triggerAutoSave);
            el.addEventListener('change', triggerAutoSave);
        });
    }

    // ── Load & hydrate ────────────────────────────────────────────
    try {
        const res = await fetch(`/.netlify/functions/get-assistant-context?id=${assistantId}`);
        if (res.status === 403) {
            const errBody = await res.json().catch(() => ({}));
            if (errBody.code === 'DPA_REQUIRED') {
                // Show blocking DPA acceptance modal — user cannot view assistant config until accepted
                const modal = document.getElementById('modal-dpa-required');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    // Wire up accept button with the assistantId so we can reload after acceptance
                    const acceptBtn = document.getElementById('btn-dpa-accept');
                    if (acceptBtn) acceptBtn.dataset.assistantId = assistantId;
                }
                return;
            }
            throw new Error('Failed to load');
        }
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

        // US-ADM-4.1.1: Show deprecation banner if assistant's master role is deprecated
        const existingBanner = document.getElementById('deprecated-assistant-banner');
        if (existingBanner) existingBanner.remove();
        if (currentData.lifecycleState === 'deprecated') {
            const banner = document.createElement('div');
            banner.id = 'deprecated-assistant-banner';
            banner.className = 'mx-4 mt-4 p-4 bg-orange-50 border border-orange-200 rounded-xl flex items-start gap-3';
            banner.innerHTML = `
                <span class="text-2xl flex-shrink-0">⚠️</span>
                <div class="flex-1">
                    <p class="text-sm font-bold text-orange-800">This assistant is being retired.</p>
                    <p class="text-sm text-orange-700 mt-0.5">
                        This assistant role will be archived soon and may lose functionality.
                        ${currentData.replacementAssistantId
                            ? `A recommended replacement is available — <a href="#" onclick="window.routeToAssistantDetail && window.routeToAssistantDetail(${currentData.replacementAssistantId}); return false;" class="underline font-semibold">switch now</a>.`
                            : 'Contact support for guidance on migrating your workflows.'}
                    </p>
                </div>`;
            // Insert before main content area or at top of detail container
            const detailEl = document.getElementById('assistant-detail-view') || document.getElementById('content-container');
            if (detailEl) detailEl.prepend(banner);
        }

        // Set window.cachedContext so fetchAndRenderIntegrations can use it
        window.cachedContext = currentData.context || {};

        _detailHydrate(currentData);
        _hydrateAutonomousToggle(currentData);
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

    // ── Performance Metrics (post_insights aggregation) ───────────
    await _loadAssistantMetrics(assistantId);

    // ── Platforms (from global connections) ───────────────────────
    await _renderPlatformsTab(assistantId, currentData);

    // ── Integrations ──────────────────────────────────────────────
    await window.fetchAndRenderIntegrations();

    // ── Workspace defaults (Brand Profile + Assistant Rules) ──────
    await _fetchAndRenderWorkspaceDefaults(assistantId, currentData, triggerAutoSave);
};

// ─────────────────────────────────────────────────────────────────
// Performance Metrics — fetches get-assistant-metrics and populates the
// three KPI cards. Shows "—" honestly wherever a metric has no data or the
// platform doesn't expose it (e.g. CTR for Instagram's organic feed).
// ─────────────────────────────────────────────────────────────────
async function _loadAssistantMetrics(assistantId) {
    const valEl   = (k) => document.getElementById(`metric-${k}-value`);
    const trendEl = (k) => document.getElementById(`metric-${k}-trend`);
    const dotEl   = (k) => document.getElementById(`metric-${k}-dot`);
    if (!valEl('engagement')) return; // section not on this page

    // 0–1 fraction → "12.3%". Null/undefined → "—".
    const pct = (v) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(1)}%`;
    // Signed percentage for growth, with colour + arrow on the dot.
    const signedPct = (v) => {
        if (v === null || v === undefined) return '—';
        const s = `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
        return s;
    };
    const setDot = (k, state) => {
        const el = dotEl(k);
        if (!el) return;
        el.className = 'w-2 h-2 rounded-full ' + (
            state === 'up'   ? 'bg-emerald-400' :
            state === 'down' ? 'bg-rose-400' :
            state === 'live' ? 'bg-emerald-400' : 'bg-gray-200'
        );
    };

    try {
        const res = await fetch(`/.netlify/functions/get-assistant-metrics?id=${assistantId}`);
        if (!res.ok) return; // leave the "—" placeholders in place
        const data = await res.json();

        const note = document.getElementById('metrics-status-note');
        if (note) note.textContent = data.hasData
            ? `Last ${data.periodDays || 30} days`
            : 'No published-post data yet';

        if (!data.hasData) return; // keep placeholders

        const m = data.metrics || {};

        // Engagement Rate
        valEl('engagement').textContent = pct(m.engagementRate);
        if (m.engagementRate !== null && m.engagementRate !== undefined) {
            trendEl('engagement').textContent = `${(data.current?.posts) || 0} posts`;
            setDot('engagement', 'live');
        }

        // Organic Reach Growth (period-over-period; can be negative)
        valEl('reach').textContent = signedPct(m.reachGrowth);
        if (m.reachGrowth !== null && m.reachGrowth !== undefined) {
            trendEl('reach').textContent = m.reachGrowth >= 0 ? 'Growing' : 'Declining';
            setDot('reach', m.reachGrowth >= 0 ? 'up' : 'down');
        }

        // Click-Through Rate (null for IG organic — stays "—")
        valEl('ctr').textContent = pct(m.clickThroughRate);
        if (m.clickThroughRate !== null && m.clickThroughRate !== undefined) {
            setDot('ctr', 'live');
        } else {
            trendEl('ctr').textContent = 'Not tracked on Instagram';
        }
    } catch {
        // Network/parse failure — leave the static "—" placeholders untouched.
    }
}

// ─────────────────────────────────────────────────────────────────
// Connections tab renderer — merged Platforms + Integrations
// ─────────────────────────────────────────────────────────────────
const PLATFORM_ICONS = {
    facebook: '📘', instagram: '📷', linkedin: '💼',
    x: '𝕏', twitter: '𝕏', tiktok: '🎵', youtube: '▶️', pinterest: '📌',
};
const PLATFORM_KEY_MAP = { facebook: 'fb', instagram: 'ig', linkedin: 'li', x: 'x', twitter: 'x', tiktok: 'tt', youtube: 'yt', pinterest: 'pin' };
// Well-known platforms that always appear in the "not yet connected" section
const KNOWN_PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn', 'X', 'TikTok'];

async function _renderPlatformsTab(assistantId, currentData) {
    const container = document.getElementById('assistant-platforms-list');
    if (!container) return;

    let allConnections = [];
    try {
        const res = await fetch('/.netlify/functions/integrations');
        if (res.ok) {
            const data = await res.json();
            allConnections = data.connections || [];
        }
    } catch (e) {
        console.warn('Could not load connections:', e);
    }

    // Split: active/connected vs unconnected
    const connected = allConnections.filter(c => c.status === 'active' && c.userId);
    const connectedNames = new Set(connected.map(c => c.serviceName.toLowerCase()));

    // Selected connection IDs for this assistant (from both platforms and linked_integrations)
    const selectedPlatformIds = new Set(
        (currentData.configuration?.appliedDefaults?.platforms || []).map(Number)
    );
    const linkedIds = new Set((window.cachedContext?.linked_integrations || []).map(Number));
    // Merge both sources — selected if in either
    const selectedIds = new Set([...selectedPlatformIds, ...linkedIds]);

    if (connected.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-10 text-center gap-3">
                <div class="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-2xl">🔌</div>
                <p class="text-sm font-semibold text-gray-700">No verified connections found</p>
                <p class="text-sm text-gray-500">Connect your platforms first, then return here to enable them for this assistant.</p>
                <a href="#" onclick="window.loadView('integrations')" class="mt-1 inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer">
                    Go to Connections →
                </a>
            </div>`;
    } else {
        container.innerHTML = '';
        connected.forEach(conn => {
            const key = conn.serviceName.toLowerCase();
            const icon = PLATFORM_ICONS[key] || '🔗';
            const isOn = selectedIds.has(conn.id);
            const handle = conn.externalUserId || '';
            container.insertAdjacentHTML('beforeend', `
                <div class="flex items-center justify-between p-4 border border-gray-200 rounded-xl hover:bg-gray-50 transition platform-conn-row" data-conn-id="${conn.id}" data-service="${_escapeHtml(key)}">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-xl shrink-0">${icon}</div>
                        <div>
                            <p class="font-bold text-gray-900 text-sm">${_escapeHtml(conn.serviceName)}</p>
                            ${handle ? `<p class="text-xs text-gray-500 mt-0.5">${_escapeHtml(handle)}</p>` : '<p class="text-xs text-emerald-600 mt-0.5 font-medium">● Connected</p>'}
                        </div>
                    </div>
                    <label class="flex items-center cursor-pointer relative shrink-0">
                        <input type="checkbox" class="sr-only peer platform-conn-chk" value="${conn.id}" ${isOn ? 'checked' : ''}>
                        <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                    </label>
                </div>`);
        });

        container.insertAdjacentHTML('beforeend', `
            <div class="pt-2 text-center">
                <a href="#" onclick="window.loadView('integrations')" class="text-sm text-emerald-600 hover:underline font-medium cursor-pointer">+ Connect more platforms →</a>
            </div>`);

        // Toggle handler — saves to both platforms and linked_integrations
        container.querySelectorAll('.platform-conn-chk').forEach(chk => {
            chk.addEventListener('change', async () => {
                const checkedIds = Array.from(container.querySelectorAll('.platform-conn-chk:checked')).map(c => parseInt(c.value));
                const checkedKeys = connected.filter(c => checkedIds.includes(c.id))
                    .map(c => PLATFORM_KEY_MAP[c.serviceName.toLowerCase()] || c.serviceName.toLowerCase());

                const statusEl = document.getElementById('platforms-save-status');
                if (statusEl) statusEl.textContent = 'Saving…';
                try {
                    const updatedContext = { ...window.cachedContext, primary_platforms: checkedKeys, linked_integrations: checkedIds };
                    const r = await fetch('/.netlify/functions/update-assistant-context', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ assistantId: parseInt(assistantId), newContext: updatedContext, appliedDefaults: { platforms: checkedIds } }),
                    });
                    if (r.ok) {
                        window.cachedContext = updatedContext;
                        if (!currentData.configuration) currentData.configuration = {};
                        if (!currentData.configuration.appliedDefaults) currentData.configuration.appliedDefaults = {};
                        currentData.configuration.appliedDefaults.platforms = checkedIds;
                        if (statusEl) { statusEl.textContent = '✓ Saved'; setTimeout(() => statusEl.textContent = '', 2500); }
                    }
                } catch {
                    const s = document.getElementById('platforms-save-status');
                    if (s) s.textContent = 'Error saving';
                }
            });
        });
    }

    // Show unconnected well-known platforms
    const unconnectedWrap = document.getElementById('assistant-platforms-unconnected');
    const unconnectedList = document.getElementById('assistant-platforms-unconnected-list');
    if (unconnectedWrap && unconnectedList) {
        const unconnected = KNOWN_PLATFORMS.filter(p => !connectedNames.has(p.toLowerCase()));
        if (unconnected.length > 0) {
            unconnectedList.innerHTML = unconnected.map(name => {
                const icon = PLATFORM_ICONS[name.toLowerCase()] || '🔗';
                return `<div class="flex items-center justify-between p-3 border border-dashed border-gray-200 rounded-xl bg-gray-50 opacity-75">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-xl bg-gray-200 flex items-center justify-center text-lg shrink-0">${icon}</div>
                        <div>
                            <p class="font-semibold text-gray-600 text-sm">${name}</p>
                            <p class="text-xs text-gray-400">Not connected</p>
                        </div>
                    </div>
                    <a href="#" onclick="window.loadView('integrations')" class="text-xs font-bold text-emerald-600 hover:underline cursor-pointer shrink-0">Connect →</a>
                </div>`;
            }).join('');
            unconnectedWrap.classList.remove('hidden');
        } else {
            unconnectedWrap.classList.add('hidden');
        }
    }
}

// fetchAndRenderIntegrations now delegates to the merged Connections tab
window.fetchAndRenderIntegrations = async function() {
    // No-op: integrations are now rendered in the Connections tab (_renderPlatformsTab)
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
            // Category display labels
            const CATEGORY_LABELS = {
                tone_of_voice: 'Tone of Voice & Personality',
                response_formatting: 'Response Formatting',
                core_knowledge: 'Core Business Facts',
                target_audience: 'Target Audience Context',
            };

            defaults.assistantRules.forEach(rule => {
                // Per-assistant override: if not set, default ON for globally active rules, OFF for globally inactive
                const perAssistantSet = appliedDefaults.assistantRules?.[rule.id];
                const isEnabled = perAssistantSet !== undefined ? perAssistantSet : rule.isActive;
                const rowId = `rule-toggle-${rule.id}`;
                const categoryLabel = CATEGORY_LABELS[rule.category] || rule.category;
                const globallyOff = !rule.isActive;

                rulesContainer.insertAdjacentHTML('beforeend', `
                    <div class="flex items-start gap-4 py-3.5 border-b border-gray-100 last:border-0 ${globallyOff && !isEnabled ? 'opacity-50' : ''}">
                        <div class="flex-1 min-w-0">
                            <p class="text-sm text-gray-800 font-medium">${_escapeHtml(rule.text)}</p>
                            <div class="flex items-center gap-2 mt-0.5">
                                <p class="text-xs text-gray-400">${_escapeHtml(categoryLabel)}</p>
                                ${globallyOff ? '<span class="text-xs text-amber-600 font-semibold">· Globally off</span>' : ''}
                            </div>
                        </div>
                        <label class="flex items-center cursor-pointer relative shrink-0 mt-0.5" title="${globallyOff ? 'This rule is disabled globally on the Assistant Rules page' : ''}">
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
// 6. INTEGRATIONS — merged into Connections tab (_renderPlatformsTab)

// ── Autonomous Posting Fallback toggle (US5) ─────────────────────
function _hydrateAutonomousToggle(data) {
    const isOn = data.configuration?.appliedDefaults?.autonomousFallback === true;
    _applyAutonomousToggleState(isOn);
}

function _applyAutonomousToggleState(isOn) {
    const btn = document.getElementById('toggle-autonomous');
    const dot = document.getElementById('toggle-autonomous-dot');
    const onMsg = document.getElementById('autonomous-on-msg');
    const offMsg = document.getElementById('autonomous-off-msg');
    if (!btn) return;

    btn.setAttribute('aria-checked', isOn ? 'true' : 'false');
    btn.className = `relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1 ${isOn ? 'bg-emerald-500' : 'bg-gray-300'}`;
    if (dot) dot.className = `${isOn ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`;
    if (onMsg) onMsg.classList.toggle('hidden', !isOn);
    if (offMsg) offMsg.classList.toggle('hidden', isOn);
}

window._toggleAutonomous = async function () {
    const btn = document.getElementById('toggle-autonomous');
    if (!btn) return;
    const currentlyOn = btn.getAttribute('aria-checked') === 'true';
    const newVal = !currentlyOn;
    _applyAutonomousToggleState(newVal);

    // Persist via update-assistant-context — get assistantId from URL/param
    const assistantId = window._currentAssistantId;
    if (!assistantId) return;

    try {
        await fetch('/.netlify/functions/update-assistant-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assistantId,
                appliedDefaults: { autonomousFallback: newVal },
            }),
        });
    } catch (e) {
        console.warn('Could not save autonomous toggle:', e);
        // Revert on failure
        _applyAutonomousToggleState(currentlyOn);
    }
};