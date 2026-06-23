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

    // Lifecycle state machine (assistant-lifecycle-epic). Fall back to legacy fields.
    const lifecycle = assistant.lifecycleStatus
      || (assistant.status === 'pending' ? 'provisioning' : (assistant.isActive === false ? 'paused' : 'working'));
    const DIR_BADGE = {
        provisioning:   { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500 animate-pulse',   label: 'Setup in Progress' },
        ready_for_work: { cls: 'bg-blue-50 text-blue-700 border-blue-200',          dot: 'bg-blue-500',                  label: 'Ready for Work' },
        working:        { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500 animate-pulse', label: 'Active' },
        paused:         { cls: 'bg-gray-100 text-gray-600 border-gray-200',         dot: 'bg-gray-400',                  label: 'Paused' },
        system_paused:  { cls: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500 animate-pulse',     label: 'Attention Required' },
        archived:       { cls: 'bg-gray-100 text-gray-500 border-gray-200',         dot: 'bg-gray-300',                  label: 'Archived' },
    };
    const db = DIR_BADGE[lifecycle] || DIR_BADGE.working;
    const statusHtml = `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold ${db.cls}"><span class="w-1.5 h-1.5 rounded-full ${db.dot}"></span> ${db.label}</span>`;

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


// Read-only "Your Onboarding Answers" summary — guarantees every answer the user gave
// during onboarding is visible on the detail page, regardless of which editable fields are
// wired below (e.g. Trigger/Content Source are captured as label strings the radios can't bind).
// Sourced from the structured onboardingContext (data.context) + configuration.inputs.
function _renderOnboardingSummary(data) {
    const host = document.getElementById('onboarding-summary');
    if (!host) return;
    const ctx = (data && data.context && typeof data.context === 'object') ? data.context : {};
    const inputs = (data && data.configuration && data.configuration.inputs) || {};
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const MISSING = '⚠️ [MISSING - PLEASE UPDATE]';
    const clean = (v) => (v === null || v === undefined) ? '' : String(v).trim();

    const objectiveLabels = { brand_awareness: 'Brand Awareness', lead_generation: 'Lead Generation', direct_sales: 'Direct Sales', community_engagement: 'Community & Engagement' };
    const objective = clean(ctx.primary_objective || inputs.primary_objective);
    const platforms = (Array.isArray(ctx.primary_platforms) && ctx.primary_platforms.length)
        ? ctx.primary_platforms
        : (Array.isArray(inputs.platforms) ? inputs.platforms : []);

    const rows = [
        ['Your Bottleneck', clean(ctx.problem_statement || inputs.problem)],
        ['Primary Objective', objective ? (objectiveLabels[objective] || objective) : ''],
        ['Core Message', clean(ctx.core_message || inputs.core_message)],
        ['Primary CTA', clean(ctx.cta || inputs.cta)],
        ['Incentive', clean(ctx.incentive || inputs.incentive)],
        ['Target Audience', clean(ctx.target_audience)],
        ['Content Pillars', clean(ctx.content_pillars)],
        ['Tone of Voice', clean(ctx.tone_of_voice)],
        ['Posting Frequency', clean(ctx.posting_frequency)],
        ['Platforms', platforms.map(clean).filter(Boolean).join(', ')],
        ['Trigger', clean(inputs.triggerText)],
        ['Content Source', clean(inputs.sourceText)],
    ].filter(([, v]) => v && v !== MISSING);

    // Knowledge base + guardrail rules (strictRules) — strip the leading "- " bullet prefix.
    const rules = (Array.isArray(inputs.strictRules) ? inputs.strictRules : [])
        .map(r => clean(r).replace(/^-\s*/, '')).filter(Boolean);

    if (!rows.length && !rules.length) {
        host.innerHTML = '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-sm text-gray-500">No onboarding answers were captured for this assistant.</div>';
        return;
    }

    const fieldCount = rows.length + (rules.length ? 1 : 0);
    host.innerHTML = `
      <details class="group bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <summary class="flex items-center justify-between gap-4 p-6 sm:px-8 cursor-pointer select-none list-none">
          <div>
            <h4 class="text-base font-bold text-gray-900">Your Onboarding Answers</h4>
            <p class="text-sm text-gray-500 mt-1">A read-only summary of everything you told us when setting up this assistant. Expand to review — you can edit any of it in the tabs below.</p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="text-xs font-semibold text-gray-400">${fieldCount} item${fieldCount === 1 ? '' : 's'}</span>
            <svg class="w-5 h-5 text-gray-400 transition-transform duration-200 group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          </div>
        </summary>
        <div class="px-6 sm:px-8 pb-6 sm:pb-8 pt-2 border-t border-gray-100">
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mt-4">
            ${rows.map(([label, value]) => `
              <div>
                <dt class="text-xs font-bold text-gray-400 uppercase tracking-wide">${esc(label)}</dt>
                <dd class="text-sm text-gray-900 mt-1 whitespace-pre-line">${esc(value)}</dd>
              </div>`).join('')}
          </dl>
          ${rules.length ? `
            <div class="mt-6 pt-5 border-t border-gray-100">
              <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Knowledge &amp; Guardrails</p>
              <ul class="list-disc pl-5 space-y-1 text-sm text-gray-900">
                ${rules.map(r => `<li class="whitespace-pre-line">${esc(r)}</li>`).join('')}
              </ul>
            </div>` : ''}
        </div>
      </details>`;
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

    // Radios — trigger / source.
    // Onboarding may store these as the radio value (e.g. "on_demand") OR as a human label
    // (e.g. "On Demand" in triggerText/sourceText). Normalise labels → value keys so the radio
    // pre-selects either way ("On Demand" → "on_demand", "Client Provided" → "client_provided").
    const _toOptionValue = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const _checkRadio = (name, ...candidates) => {
        for (const c of candidates) {
            const v = _toOptionValue(c);
            if (!v) continue;
            const r = document.querySelector(`input[name="${name}"][value="${v}"]`);
            if (r) { r.checked = true; return; }
        }
    };
    _checkRadio('edit_trigger', inputs.trigger_type, inputs.triggerText);
    _checkRadio('edit_source', inputs.content_source, inputs.sourceText);

    // Platforms are rendered dynamically in the Connections tab — see initAssistantConnections()

    // Guardrails — separate knowledge base out of strictRules
    const allStrict = inputs.strictRules || [];
    const kbLine = allStrict.find(r => r.includes('KNOWLEDGE BASE (TEXT)'));
    const otherRules = allStrict.filter(r => !r.includes('KNOWLEDGE BASE (TEXT)'));
    _detailSetVal('edit_strict_rules', otherRules.join('\n'));
    if (kbLine) {
        const m = kbLine.match(/:"([^"]+)"/);
        _detailSetVal('edit_knowledge', m ? m[1] : '');
    }

    // Per-assistant AI disclosure (EU AI Act Art. 52)
    _detailSetVal('edit_ai_disclosure', data.disclosureText || '');
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

    // Deep-link to a specific tab (e.g. post-OAuth returns to the Connections tab).
    if (window._assistantDetailInitialTab) {
        const target = document.querySelector(`.detail-tab-btn[data-tab="${window._assistantDetailInitialTab}"]`);
        window._assistantDetailInitialTab = null;
        if (target) target.click();
    }

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
        // Per-assistant AI disclosure (EU AI Act Art. 52) — saved alongside the context.
        const disclosureEl = document.getElementById('edit_ai_disclosure');
        const disclosureText = disclosureEl ? disclosureEl.value.trim() : undefined;
        try {
            const body = { assistantId: parseInt(assistantId), newContext, newConfiguration };
            if (newName) body.newName = newName;
            if (disclosureText !== undefined) body.disclosureText = disclosureText;
            const res = await fetch('/.netlify/functions/update-assistant-context', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                currentData.context = newContext;
                currentData.configuration = newConfiguration;
                if (disclosureText !== undefined) currentData.disclosureText = disclosureText;
                if (newName) {
                    document.getElementById('detail-avatar').textContent = newName.charAt(0).toUpperCase();
                    currentData.name = newName;
                }
                _detailSetSaveStatus('✓ Saved', 'text-emerald-600');
                setTimeout(() => _detailSetSaveStatus(''), 3000);
                // Refresh the Kick Off readiness so "AI disclosure acknowledged" (and any
                // other items affected by this save) re-evaluate without a page reload.
                if (typeof _renderKickOff === 'function') _renderKickOff(assistantId);
            } else {
                const err = await res.json().catch(() => ({}));
                _detailSetSaveStatus(err.error && /disclosure/i.test(err.error) ? 'Disclosure required' : 'Save failed', 'text-red-500');
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
            // Lifecycle state machine (assistant-lifecycle-epic). Fall back to legacy fields.
            const lifecycle = currentData.lifecycleStatus
              || (currentData.status === 'pending' ? 'provisioning' : (currentData.isActive === false ? 'paused' : 'working'));
            const PILL = {
                provisioning:   { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500 animate-pulse',   label: 'Provisioning',       toggle: 'Pause Assistant' },
                ready_for_work: { cls: 'bg-blue-50 text-blue-700 border-blue-200',          dot: 'bg-blue-500',                  label: 'Ready for Work',     toggle: 'Initiate Kick-Off' },
                working:        { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500 animate-pulse', label: 'Active',             toggle: 'Pause Assistant' },
                paused:         { cls: 'bg-gray-100 text-gray-600 border-gray-200',         dot: 'bg-gray-400',                  label: 'Paused',             toggle: 'Resume Assistant' },
                system_paused:  { cls: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500 animate-pulse',     label: 'Attention Required', toggle: 'Resume Assistant' },
                archived:       { cls: 'bg-gray-100 text-gray-500 border-gray-200',         dot: 'bg-gray-300',                  label: 'Archived',           toggle: 'Resume Assistant' },
            };
            const p = PILL[lifecycle] || PILL.working;
            statusEl.className = `inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold ${p.cls}`;
            statusEl.innerHTML = `<span class="w-2 h-2 rounded-full ${p.dot}"></span> ${p.label}`;
            if (toggleBtn) toggleBtn.textContent = p.toggle;
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
        _renderOnboardingSummary(currentData);
        _hydrateAutonomousToggle(currentData);
        attachAutoSave();
        _renderKickOff(assistantId);
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

    // ── Connections (full connect/manage UI, scoped to this assistant) ──
    await window.initAssistantConnections(assistantId, currentData);

    // ── Integrations ──────────────────────────────────────────────
    await window.fetchAndRenderIntegrations();

    // ── Workspace defaults (Brand Profile) ────────────────────────
    await _fetchAndRenderWorkspaceDefaults(assistantId, currentData, triggerAutoSave);

    // ── Per-assistant Assistant Rules (content_rules → this assistant's brief) ──
    await _fetchAndRenderAssistantRules(assistantId);
};

// ─────────────────────────────────────────────────────────────────
// Kick Off Meeting — readiness checklist + activation gate. Fetches
// get-assistant-readiness and renders the checklist; the Kick Off button is
// enabled only when all required items pass and the assistant isn't already
// working. Clicking it activates the assistant via manage-assistant (resume).
// ─────────────────────────────────────────────────────────────────
async function _renderKickOff(assistantId) {
    const card      = document.getElementById('kickoff-card');
    const listEl    = document.getElementById('kickoff-checklist');
    const btn       = document.getElementById('btn-kick-off');
    const hintEl    = document.getElementById('kickoff-hint');
    const subEl     = document.getElementById('kickoff-subtitle');
    if (!card || !listEl || !btn) return;

    card.classList.remove('hidden');

    let data;
    try {
        const res = await fetch(`/.netlify/functions/get-assistant-readiness?id=${assistantId}`);
        if (!res.ok) { card.classList.add('hidden'); return; }
        data = await res.json();
    } catch { card.classList.add('hidden'); return; }

    const items = data.items || [];
    const tick = `<svg class="w-4 h-4 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;
    const cross = `<svg class="w-4 h-4 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2"/></svg>`;

    listEl.innerHTML = items.map(it => `
        <li class="flex items-start gap-3">
            ${it.done ? tick : cross}
            <span class="min-w-0">
                <span class="block text-sm font-semibold ${it.done ? 'text-gray-800' : 'text-gray-500'}">${it.label}${it.required ? '' : ' <span class="text-xs font-normal text-gray-400">(recommended)</span>'}</span>
                ${it.done ? '' : `<span class="block text-xs text-gray-400 mt-0.5">${it.hint || ''}</span>`}
            </span>
        </li>`).join('') || '<li class="text-sm text-gray-400">No checklist items.</li>';

    // US3 AC3.1: summary — primary directive + active connections the user reviews before confirming.
    const summaryEl = document.getElementById('kickoff-summary');
    if (summaryEl) {
        const sm = data.summary || {};
        const CONN_LABELS = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };
        const conns = (sm.connections || []);
        const connPills = conns.length
            ? conns.map(c => `<span class="inline-flex items-center gap-1 text-xs font-semibold text-gray-700 bg-white border border-gray-200 px-2 py-0.5 rounded-full">${CONN_LABELS[c] || (c.charAt(0).toUpperCase() + c.slice(1))}</span>`).join(' ')
            : '<span class="text-xs text-gray-400 italic">No connected accounts yet</span>';
        summaryEl.innerHTML = `
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Primary directive</p>
            <p class="text-sm font-semibold text-gray-800 mb-3">${sm.directive || 'Digital Assistant'}</p>
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Active connections</p>
            <div class="flex flex-wrap gap-1.5">${connPills}</div>`;
        summaryEl.classList.toggle('hidden', !!data.working);
    }

    // Already working → confirmation state, no action needed.
    if (data.working) {
        const since = data.workingSince ? new Date(data.workingSince).toLocaleDateString('en-GB') : null;
        subEl.textContent = since ? `Your assistant is working (since ${since}).` : 'Your assistant is working.';
        btn.classList.add('hidden');
        hintEl.innerHTML = '<span class="inline-flex items-center gap-1 text-emerald-700 font-semibold">✓ Active</span>';
        return;
    }

    btn.classList.remove('hidden');
    const outstanding = items.filter(i => i.required && !i.done);
    if (data.allRequiredDone) {
        subEl.textContent = 'Everything is ready — kick off to put your assistant to work.';
        btn.disabled = false;
        hintEl.textContent = '';
    } else {
        subEl.textContent = 'A few things to confirm before your assistant can start working.';
        btn.disabled = true;
        hintEl.textContent = outstanding.length
            ? `Outstanding: ${outstanding.map(i => i.label).join(', ')}`
            : '';
    }

    // Wire the activation once (avoid stacking listeners across re-renders).
    btn.onclick = async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Starting…';
        try {
            // US3 AC3.2/AC3.3: canonical kick-off — transitions ready_for_work → working via the
            // state-machine helper (server-side readiness gate + audit), then unlocks the assistant.
            const res = await fetch(`/.netlify/functions/kickoff-assistant?id=${assistantId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                alert(d.error || 'Could not start the assistant. Please check the checklist and try again.');
                btn.disabled = false;
                btn.textContent = original;
                return;
            }
            // Reflect the new working state: refresh the kick-off card + the status pill.
            window.showToast?.('Your assistant is now working! 🚀', { icon: '🚀' });
            window.fireConfetti?.();
            await _renderKickOff(assistantId);
            const statusEl = document.getElementById('detail-status');
            if (statusEl) {
                statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
                statusEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Active';
            }
            const toggleBtn = document.getElementById('btn-toggle-status');
            if (toggleBtn) toggleBtn.textContent = 'Pause Assistant';
        } catch {
            alert('Network error — please try again.');
            btn.disabled = false;
            btn.textContent = original;
        }
    };
}

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


// fetchAndRenderIntegrations now delegates to the merged Connections tab
window.fetchAndRenderIntegrations = async function() {
    // No-op: connections are rendered in the Connections tab (initAssistantConnections, integrations.js)
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

    // ── Assistant Rules now live per-assistant — see _fetchAndRenderAssistantRules() ──

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

// ─────────────────────────────────────────────────────────────────
// Per-assistant Assistant Rules — editable rules stored in content_rules
// and injected into THIS assistant's brief (assemble-blueprint § 4-content-rules).
// Replaces the old global-rules-with-toggles view.
// ─────────────────────────────────────────────────────────────────
const RULE_CATEGORIES = [
    { id: 'tone_of_voice',       title: 'Tone of Voice & Personality', placeholder: 'e.g. Always maintain a professional yet friendly tone.' },
    { id: 'response_formatting', title: 'Response Formatting',          placeholder: 'e.g. Always use short paragraphs; never use technical jargon.' },
    { id: 'core_knowledge',      title: 'Core Business Facts',          placeholder: 'e.g. Our flagship service is X, launched in 2024.' },
    { id: 'target_audience',     title: 'Target Audience Context',      placeholder: 'e.g. Speak to busy small-business owners aged 30–50.' },
];
const RULE_CATEGORY_TITLES = Object.fromEntries(RULE_CATEGORIES.map(c => [c.id, c.title]));

let _rulesAssistantId = null;
const RULES_API = '/.netlify/functions/content-rules';

function _setRulesStatus(text, isError) {
    const el = document.getElementById('assistant-rules-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = `text-sm font-bold shrink-0 transition-all ${isError ? 'text-red-600' : 'text-emerald-600'}`;
    if (text && !isError && /Saved/.test(text)) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2000);
}

async function _fetchAndRenderAssistantRules(assistantId) {
    _rulesAssistantId = parseInt(assistantId);
    const editor = document.getElementById('assistant-rules-editor');
    if (!editor) return;

    let rules = [];
    try {
        const res = await fetch(`${RULES_API}?assistantId=${_rulesAssistantId}`);
        if (res.ok) rules = (await res.json()).rules || [];
    } catch (e) {
        console.warn('Could not load assistant rules:', e);
    }

    // Group rules by known category; anything else (legacy / rejection_feedback) → "Other rules"
    const byCat = {};
    RULE_CATEGORIES.forEach(c => { byCat[c.id] = []; });
    const other = [];
    rules.forEach(r => {
        if (r.category && byCat[r.category]) byCat[r.category].push(r);
        else other.push(r);
    });

    editor.innerHTML = '';
    RULE_CATEGORIES.forEach(cat => {
        editor.appendChild(_buildRuleCategoryCard(cat.id, cat.title, cat.placeholder, byCat[cat.id], false));
    });
    if (other.length) {
        editor.appendChild(_buildRuleCategoryCard('', 'Other rules', '', other, true));
    }
}

function _buildRuleCategoryCard(catId, title, placeholder, rules, readOnlyAdd) {
    const card = document.createElement('div');
    card.className = 'border border-gray-200 rounded-xl overflow-hidden';
    card.innerHTML = `
        <div class="px-4 py-3 bg-gray-50/60 border-b border-gray-100 flex items-center justify-between">
            <h4 class="text-sm font-bold text-gray-800">${_escapeHtml(title)}</h4>
            ${readOnlyAdd ? '' : `<button type="button" data-cat="${catId}" class="ar-add-btn text-sm font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1 bg-emerald-50 px-3 py-1.5 rounded-md transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>Add Rule</button>`}
        </div>
        <div class="ar-rows divide-y divide-gray-100" data-cat="${catId}"></div>`;

    const rowsEl = card.querySelector('.ar-rows');
    if (rules && rules.length) {
        rules.forEach(r => rowsEl.appendChild(_buildRuleRow(catId, placeholder, r)));
    } else if (!readOnlyAdd) {
        rowsEl.appendChild(_buildEmptyHint(rowsEl));
    }

    const addBtn = card.querySelector('.ar-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
        const hint = rowsEl.querySelector('.ar-empty-hint');
        if (hint) hint.remove();
        const row = _buildRuleRow(catId, placeholder, null);
        rowsEl.appendChild(row);
        row.querySelector('.ar-input')?.focus();
    });
    return card;
}

function _buildEmptyHint() {
    const div = document.createElement('div');
    div.className = 'ar-empty-hint px-4 py-3 text-sm text-gray-400';
    div.textContent = 'No rules yet — click “Add Rule” to create one.';
    return div;
}

function _buildRuleRow(catId, placeholder, rule) {
    const tr = document.createElement('div');
    tr.className = 'ar-row flex items-start gap-3 px-4 py-3 group';
    if (rule?.id) tr.dataset.ruleId = String(rule.id);
    tr.dataset.cat = catId;
    const active = rule ? rule.isActive !== false : true;
    const isFeedback = rule?.origin === 'rejection_feedback';

    tr.innerHTML = `
        <div class="flex-1 min-w-0">
            <textarea rows="1" placeholder="${_escapeHtml(placeholder || 'Describe the rule…')}"
                class="ar-input w-full px-3 py-2 text-sm rounded-lg border border-transparent hover:border-gray-300 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none bg-transparent focus:bg-white resize-none overflow-hidden ${active ? '' : 'text-gray-400 line-through'}">${_escapeHtml(rule?.ruleText || '')}</textarea>
            ${isFeedback ? '<p class="text-xs text-amber-600 font-semibold px-3 mt-0.5">From rejected-post feedback</p>' : ''}
        </div>
        <button type="button" aria-checked="${active}" class="ar-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1 ${active ? 'bg-emerald-500' : 'bg-gray-300'}">
            <span class="${active ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out"></span>
        </button>
        <button type="button" class="ar-del text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>`;

    const input = tr.querySelector('.ar-input');
    const toggle = tr.querySelector('.ar-toggle');
    const dot = toggle.querySelector('span');

    const autoResize = () => { input.style.height = ''; input.style.height = input.scrollHeight + 'px'; };
    requestAnimationFrame(autoResize);

    let saveTimer;
    input.addEventListener('input', () => {
        autoResize();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => _saveRuleRow(tr), 700);
    });
    input.addEventListener('blur', () => { clearTimeout(saveTimer); _saveRuleRow(tr); });

    toggle.addEventListener('click', async () => {
        const nowActive = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', nowActive);
        toggle.className = `ar-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1 ${nowActive ? 'bg-emerald-500' : 'bg-gray-300'}`;
        dot.className = `${nowActive ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out`;
        nowActive ? input.classList.remove('text-gray-400', 'line-through') : input.classList.add('text-gray-400', 'line-through');
        if (tr.dataset.ruleId) {
            _setRulesStatus('Saving…');
            try {
                const r = await fetch(RULES_API, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(tr.dataset.ruleId), isActive: nowActive }) });
                _setRulesStatus(r.ok ? '✓ Saved' : 'Error saving', !r.ok);
            } catch { _setRulesStatus('Error saving', true); }
        }
    });

    tr.querySelector('.ar-del').addEventListener('click', async () => {
        if (tr.dataset.ruleId) {
            if (!confirm('Delete this rule? It will no longer be applied to this assistant.')) return;
            _setRulesStatus('Saving…');
            try {
                const r = await fetch(`${RULES_API}?id=${tr.dataset.ruleId}`, { method: 'DELETE' });
                if (!r.ok) { _setRulesStatus('Error deleting', true); return; }
                _setRulesStatus('✓ Saved');
            } catch { _setRulesStatus('Error deleting', true); return; }
        }
        const rows = tr.parentElement;
        tr.remove();
        if (rows && !rows.querySelector('.ar-row') && rows.dataset.cat) rows.appendChild(_buildEmptyHint());
    });

    return tr;
}

// Create-on-first-save, then patch on subsequent edits. No-op for empty text on a new row.
async function _saveRuleRow(tr) {
    const input = tr.querySelector('.ar-input');
    const text = (input?.value || '').trim();
    const id = tr.dataset.ruleId ? Number(tr.dataset.ruleId) : null;

    if (!text) {
        // Empty existing rule → delete it; empty brand-new row → ignore
        if (id) {
            try { await fetch(`${RULES_API}?id=${id}`, { method: 'DELETE' }); } catch {}
            delete tr.dataset.ruleId;
        }
        return;
    }
    if (tr.dataset.savedText === text) return; // unchanged since last save

    _setRulesStatus('Saving…');
    try {
        let res;
        if (id) {
            res = await fetch(RULES_API, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ruleText: text }) });
        } else {
            res = await fetch(RULES_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistantId: _rulesAssistantId, ruleText: text, category: tr.dataset.cat || null }) });
            if (res.ok) {
                const data = await res.json();
                if (data.rule?.id) tr.dataset.ruleId = String(data.rule.id);
            }
        }
        if (res.ok) { tr.dataset.savedText = text; _setRulesStatus('✓ Saved'); }
        else _setRulesStatus('Error saving', true);
    } catch { _setRulesStatus('Error saving', true); }
}

// ── Copy rules from another assistant ─────────────────────────────
window._openCopyRules = async function () {
    const sel = document.getElementById('copy-rules-source');
    const errEl = document.getElementById('copy-rules-error');
    const preview = document.getElementById('copy-rules-preview');
    if (errEl) errEl.classList.add('hidden');
    if (preview) preview.textContent = '';
    if (sel) sel.innerHTML = '<option value="">Loading assistants…</option>';
    document.getElementById('modal-copy-rules')?.classList.remove('hidden');

    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        const data = res.ok ? await res.json() : {};
        const list = (data.assistants || data || []).filter(a => a && a.id && parseInt(a.id) !== _rulesAssistantId);
        if (!sel) return;
        if (!list.length) {
            sel.innerHTML = '<option value="">No other assistants found</option>';
            return;
        }
        sel.innerHTML = '<option value="">Select an assistant…</option>' +
            list.map(a => `<option value="${a.id}">${_escapeHtml(a.name || ('Assistant #' + a.id))}</option>`).join('');
    } catch {
        if (sel) sel.innerHTML = '<option value="">Could not load assistants</option>';
    }
};

window._confirmCopyRules = async function () {
    const sel = document.getElementById('copy-rules-source');
    const errEl = document.getElementById('copy-rules-error');
    const btn = document.getElementById('btn-copy-rules-confirm');
    const sourceId = sel?.value ? Number(sel.value) : null;
    if (errEl) errEl.classList.add('hidden');
    if (!sourceId) { if (errEl) { errEl.textContent = 'Please select a source assistant.'; errEl.classList.remove('hidden'); } return; }

    if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
    try {
        const res = await fetch(`${RULES_API}?assistantId=${sourceId}`);
        const srcRules = res.ok ? ((await res.json()).rules || []) : [];
        const toCopy = srcRules.filter(r => r.ruleText && r.isActive !== false);
        if (!toCopy.length) {
            if (errEl) { errEl.textContent = 'That assistant has no active rules to copy.'; errEl.classList.remove('hidden'); }
            return;
        }
        for (const r of toCopy) {
            await fetch(RULES_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assistantId: _rulesAssistantId, ruleText: r.ruleText, category: r.category || null, platform: r.platform || null }) });
        }
        document.getElementById('modal-copy-rules')?.classList.add('hidden');
        await _fetchAndRenderAssistantRules(_rulesAssistantId);
        _setRulesStatus(`✓ Copied ${toCopy.length} rule${toCopy.length === 1 ? '' : 's'}`);
    } catch {
        if (errEl) { errEl.textContent = 'Could not copy rules. Please try again.'; errEl.classList.remove('hidden'); }
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60'); }
    }
};

// ── Safe Content Benchmark modal + safety feedback (moved from instructions page) ──
window._openSafetyBenchmark = function () {
    document.getElementById('modal-safety-benchmark')?.classList.remove('hidden');
};

window._openSafetyFeedback = function () {
    const s = document.getElementById('safety-suggestion'); if (s) s.value = '';
    const c = document.getElementById('safety-context'); if (c) c.value = '';
    document.getElementById('safety-feedback-error')?.classList.add('hidden');
    document.getElementById('safety-feedback-success')?.classList.add('hidden');
    const btn = document.getElementById('btn-safety-submit');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Submit Suggestion'; }
    document.getElementById('modal-safety-feedback')?.classList.remove('hidden');
};

window._submitSafetyFeedback = async function () {
    const suggestion = (document.getElementById('safety-suggestion')?.value || '').trim();
    const context = (document.getElementById('safety-context')?.value || '').trim();
    const errorEl = document.getElementById('safety-feedback-error');
    const successEl = document.getElementById('safety-feedback-success');
    const btn = document.getElementById('btn-safety-submit');
    errorEl?.classList.add('hidden');
    successEl?.classList.add('hidden');
    if (!suggestion) { if (errorEl) { errorEl.textContent = 'Please describe your suggested safety rule.'; errorEl.classList.remove('hidden'); } return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Sending…'; }
    try {
        const res = await fetch('/.netlify/functions/safety-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestion, context }) });
        if (res.ok) {
            successEl?.classList.remove('hidden');
            if (btn) btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Sent!';
            setTimeout(() => document.getElementById('modal-safety-feedback')?.classList.add('hidden'), 2200);
        } else {
            const data = await res.json().catch(() => ({}));
            if (errorEl) { errorEl.textContent = data.error || 'Submission failed. Please try again.'; errorEl.classList.remove('hidden'); }
            if (btn) { btn.disabled = false; btn.innerHTML = 'Submit Suggestion'; }
        }
    } catch {
        if (errorEl) { errorEl.textContent = 'Network error. Please check your connection and try again.'; errorEl.classList.remove('hidden'); }
        if (btn) { btn.disabled = false; btn.innerHTML = 'Submit Suggestion'; }
    }
};

// ==========================================
// 6. INTEGRATIONS — merged into Connections tab (integrations.js initAssistantConnections)

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