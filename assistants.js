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
    // A gate-blocked assistant reads as lifecycle 'provisioning' but needs user action, so it gets
    // its own "Action Required" badge instead of the passive "Setup in Progress" spinner.
    const lifecycle = assistant.status === 'blocked' ? 'blocked' : (assistant.lifecycleStatus
      || (assistant.status === 'pending' ? 'provisioning' : (assistant.isActive === false ? 'paused' : 'working')));
    const DIR_BADGE = {
        blocked:        { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500',                 label: 'Action Required' },
        provisioning:   { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500 animate-pulse',   label: 'Setup in Progress' },
        ready_for_work: { cls: 'bg-blue-50 text-blue-700 border-blue-200',          dot: 'bg-blue-500',                  label: 'Ready for Work' },
        working:        { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500 animate-pulse', label: 'Active' },
        paused:         { cls: 'bg-gray-100 text-gray-600 border-gray-200',         dot: 'bg-gray-400',                  label: 'Paused' },
        system_paused:  { cls: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500 animate-pulse',     label: 'Attention Required' },
        archived:       { cls: 'bg-gray-100 text-gray-500 border-gray-200',         dot: 'bg-gray-300',                  label: 'Archived' },
    };
    const db = DIR_BADGE[lifecycle] || DIR_BADGE.working;
    const statusHtml = `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold ${db.cls}"><span class="w-1.5 h-1.5 rounded-full ${db.dot}"></span> ${db.label}</span>`;

    // SMART Goals AC2.1.1 — "X On Track | Y Off Track" micro-summary + Review Progress button (AC2.2.1).
    // When no goals exist yet, show a prompt that deep-links to the assistant's Goals tab so the
    // user is nudged (and able) to set measurable targets.
    const gs = assistant.goalSummary || { onTrack: 0, offTrack: 0, total: 0 };
    const goalsHtml = gs.total > 0 ? `
        <div class="flex items-center gap-4 text-xs font-semibold mb-5">
            <span class="inline-flex items-center gap-1.5 text-emerald-600"><span class="w-2 h-2 rounded-full bg-emerald-500"></span>${gs.onTrack} On Track</span>
            <span class="inline-flex items-center gap-1.5 text-red-600"><span class="w-2 h-2 rounded-full bg-red-500"></span>${gs.offTrack} Off Track</span>
        </div>` : `
        <button type="button" onclick="event.stopPropagation(); window._assistantDetailInitialTab='goals'; window.routeToAssistantDetail('${assistant.id}')"
            class="flex items-center gap-2 text-xs font-semibold text-gray-400 hover:text-emerald-700 mb-5 cursor-pointer transition-colors text-left">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v8m4-4H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            No goals set yet — <span class="underline">add goals to track performance</span>
        </button>`;
    const reviewBtn = gs.total > 0
        ? `<button type="button" onclick="event.stopPropagation(); window._reviewProgressOnLoad=true; window.routeToAssistantDetail('${assistant.id}')" class="text-sm font-bold text-emerald-700 hover:text-emerald-800 transition-colors cursor-pointer">Review Progress</button>`
        : '';

    return `
    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow p-6 flex flex-col cursor-pointer group" onclick="window.routeToAssistantDetail('${assistant.id}')">
        <div class="flex justify-between items-start mb-4">
            <div class="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-lg shadow-sm">
                ${initial}
            </div>
            ${statusHtml}
        </div>
        <h3 class="text-lg font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">${assistant.name}</h3>
        <p class="text-sm text-gray-500 mb-4">${role}</p>
        ${goalsHtml}
        <div class="mt-auto pt-4 border-t border-gray-50 flex justify-between items-center">
            ${reviewBtn || '<span></span>'}
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

        // US6 AC5.3: archived assistants are removed from active views (history kept server-side).
        const visible = (data.assistants || []).filter(a => a.lifecycleStatus !== 'archived' && a.status !== 'cancelled');

        if (visible.length === 0) {
            container.innerHTML = `
              <div class="col-span-full py-12 text-center text-gray-500 font-medium bg-white rounded-2xl border border-gray-100 shadow-sm">
                  Your team is currently empty. <a href="#" onclick="loadView('catalog')" class="text-emerald-600 hover:underline">Hire an assistant</a>.
              </div>`;
            return;
        }

        visible.forEach(assistant => {
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

// Posting Frequency is now a discrete <select>. A legacy/custom stored value (free text like
// "twice a day", or a key like "3x_week") won't match a built-in option, so inject it as a
// selectable option to preserve it — the backend cadence parser still understands it.
function _setFrequencySelect(val) {
    const sel = document.getElementById('edit_frequency');
    if (!sel) return;
    const value = (val || '').toString();
    if (value && !Array.from(sel.options).some(o => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        sel.appendChild(opt);
    }
    sel.value = value;
}

// Content Pillars are stored as a discrete array. Parse the comma/semicolon/newline-separated
// entry field into a deduped, trimmed list of up to 5 themes.
function _parsePillars(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : String(raw ?? ''))
        .toString()
        .split(/[,;\n]/)
        .map(p => p.trim())
        .filter(p => {
            if (!p) return false;
            const key = p.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 5);
}

// Render a live chip preview of the discrete pillars below the entry field.
function _renderPillarChips() {
    const host = document.getElementById('pillars-chips');
    if (!host) return;
    const pillars = _parsePillars(document.getElementById('edit_pillars')?.value);
    if (!pillars.length) { host.innerHTML = ''; return; }
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    host.innerHTML = pillars.map(p =>
        `<span class="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">${esc(p)}</span>`
    ).join('');
}

// Brief fields that auto-grow with their content. These can hold a lot of text (especially the
// AI-wand fields), so they're rendered as textareas that expand to keep everything visible —
// no inner scrollbar, no truncation. Heights must be recomputed when a hidden tab is revealed,
// since scrollHeight is 0 while the panel is display:none.
const _AUTOGROW_FIELDS = ['edit_problem', 'edit_core_message', 'edit_audience', 'edit_tone', 'edit_pillars', 'edit_offerings', 'edit_objections'];

function _autoGrowField(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function _initBriefAutoGrow() {
    _AUTOGROW_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.autogrow) return;
        el.dataset.autogrow = '1';
        el.addEventListener('input', () => _autoGrowField(el));
    });
    // Keep the discrete pillar chips in sync as the user types (and on wand-applied changes,
    // which dispatch an 'input' event on edit_pillars).
    const pillarsEl = document.getElementById('edit_pillars');
    if (pillarsEl && !pillarsEl.dataset.chipsync) {
        pillarsEl.dataset.chipsync = '1';
        pillarsEl.addEventListener('input', _renderPillarChips);
    }
}

function _resizeBriefAutoGrow() {
    _AUTOGROW_FIELDS.forEach(id => _autoGrowField(document.getElementById(id)));
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
        ['Content Pillars', Array.isArray(ctx.content_pillars) ? ctx.content_pillars.join(', ') : clean(ctx.content_pillars)],
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
    _setFrequencySelect(ctx.posting_frequency || '');

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
    _detailSetVal('edit_pillars', Array.isArray(ctx.content_pillars) ? ctx.content_pillars.join(', ') : (ctx.content_pillars || ''));
    _renderPillarChips();
    // Sales context — feeds the auto-responder objection playbook (P4) and DM drafting.
    _detailSetVal('edit_offerings', ctx.service_offerings || '');
    _detailSetVal('edit_objections', ctx.sales_objections || '');
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

    // Per-assistant AI disclosure (EU AI Act transparency rules — Art. 50)
    _detailSetVal('edit_ai_disclosure', data.disclosureText || '');
    _renderDisclosureHelp(data);

    // Size the auto-growing brief fields to their loaded content (visible tab only — the rest
    // are resized when their tab is first shown, see the tab-switching handler).
    _initBriefAutoGrow();
    requestAnimationFrame(_resizeBriefAutoGrow);
}

// Tailor the AI-disclosure guidance to what this assistant actually produces.
// Social/posting assistants generate images, video and text published under the user's
// brand → the deployer (the user's business) must label AI-generated media (EU AI Act
// Art. 50). Conversational/other assistants need the "you're talking to an AI" notice.
function _isSocialPostingAssistant(data) {
    const role = `${data.role || ''} ${data.category || ''}`.toLowerCase();
    if (/social|media|content|community|marketing|post/.test(role)) return true;
    const platforms = []
        .concat(data.context?.primary_platforms || [])
        .concat(data.configuration?.inputs?.platforms || [])
        .map(p => String(p).toLowerCase());
    return platforms.some(p => /instagram|facebook|linkedin|twitter|^x$|tiktok|youtube|threads|pinterest/.test(p));
}

function _renderDisclosureHelp(data) {
    const box = document.getElementById('disclosure-examples');
    const desc = document.getElementById('disclosure-desc');
    const field = document.getElementById('edit_ai_disclosure');
    if (!box) return;

    // A single post can mix image, video and text — each may need its own disclosure line.
    // Each example is therefore a TOGGLE that adds/removes its line, so several can be combined.
    const example = (icon, label, text, note) => `
        <div class="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
            <span class="text-base leading-5 shrink-0">${icon}</span>
            <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-gray-700">${label}</p>
                <p class="text-xs text-gray-600 italic">&ldquo;${text}&rdquo;</p>
                <p class="text-[11px] text-gray-400 mt-0.5">${note}</p>
            </div>
            <button type="button" role="switch" aria-checked="false" data-disclosure-example="${_escapeHtml(text)}"
                title="Include this disclosure"
                class="ar-disclosure-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none self-center bg-gray-300">
                <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out translate-x-0"></span>
            </button>
        </div>`;

    if (_isSocialPostingAssistant(data)) {
        if (desc) desc.textContent = "How this assistant labels the content it publishes as AI-generated, as required by the EU AI Act's transparency rules (Art. 50). A single post can mix image, video and text — switch on every disclosure that applies and they'll be combined. This must be set before the assistant can be activated in the Kick Off Meeting.";
        if (field) field.placeholder = 'Switch on the disclosures that apply above, or write your own — e.g. Some content on this account is created with the help of Be More Swan AI.';
        box.innerHTML = `
            <p class="text-xs font-semibold text-gray-500 mb-2">Switch on every disclosure that applies — combine image, video and text as needed, then fine-tune the wording below:</p>
            <div class="space-y-2">
                ${example('🖼️', 'AI-generated images', 'Image created with Be More Swan AI.',
                    'Required for realistic or altered AI images (Art. 50 — “deepfake” labelling).')}
                ${example('🎬', 'AI-generated video', 'Video generated with Be More Swan AI.',
                    'Required for AI-generated or AI-manipulated video.')}
                ${example('✍️', 'AI-generated text / captions', 'Written with the help of Be More Swan AI.',
                    'Required only for posts on matters of public interest (news, politics, health) where no human took editorial responsibility — routine marketing copy is generally exempt.')}
            </div>`;
    } else {
        if (desc) desc.textContent = "The notice shown to people interacting with this assistant, confirming they're dealing with an AI system, as required by the EU AI Act's transparency rules (Art. 50). This must be set before the assistant can be activated in the Kick Off Meeting.";
        if (field) field.placeholder = "e.g. You're chatting with an AI assistant working on behalf of [your business]. Responses are AI-generated.";
        box.innerHTML = `
            <p class="text-xs font-semibold text-gray-500 mb-2">Switch on the disclosure to use it, or write your own:</p>
            <div class="space-y-2">
                ${example('💬', 'AI interaction notice', "You're chatting with an AI assistant working on behalf of [your business]. Responses are AI-generated.",
                    'Shown to people the moment they interact with the assistant (Art. 50 — AI-interaction transparency).')}
            </div>`;
    }

    // Each toggle adds/removes its disclosure line so multiple content types can be combined in
    // one post. The textarea stays the saved source of truth; toggling fires its input listener
    // (the existing auto-save) and keeps the switch in sync with what's actually in the field.
    const fieldLines = () => (field?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    const setToggleVisual = (btn, on) => {
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.classList.toggle('bg-emerald-500', on);
        btn.classList.toggle('bg-gray-300', !on);
        const dot = btn.querySelector('span');
        if (dot) { dot.classList.toggle('translate-x-5', on); dot.classList.toggle('translate-x-0', !on); }
    };

    const toggles = Array.from(box.querySelectorAll('.ar-disclosure-toggle'));
    const syncToggles = () => {
        const present = fieldLines();
        toggles.forEach(b => setToggleVisual(b, present.includes((b.dataset.disclosureExample || '').trim())));
    };

    toggles.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!field) return;
            const line = (btn.dataset.disclosureExample || '').trim();
            const lines = fieldLines();
            const idx = lines.indexOf(line);
            if (idx >= 0) lines.splice(idx, 1); else lines.push(line);
            field.value = lines.join('\n');
            field.dispatchEvent(new Event('input', { bubbles: true }));
            _autoGrowField(field);
            syncToggles();
        });
    });

    // Reflect the saved disclosure (and any manual edits) in the switches.
    syncToggles();
    if (field && !field._disclosureSyncBound) {
        field._disclosureSyncBound = true;
        field.addEventListener('input', syncToggles);
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

    // update-assistant-context REPLACES onboarding_context wholesale, so spread the existing
    // context first to preserve fields not surfaced in this form (business_bio/profile_bios,
    // business_hours, business_category, etc.) — otherwise a save here would wipe them.
    const newContext = {
        ...(currentData.context || {}),
        problem_statement: document.getElementById('edit_problem')?.value || '',
        primary_objective: document.querySelector('input[name="edit_objective"]:checked')?.value || '',
        core_message: document.getElementById('edit_core_message')?.value || '',
        cta: document.getElementById('edit_cta')?.value || '',
        incentive: document.getElementById('edit_incentive')?.value || '',
        posting_frequency: document.getElementById('edit_frequency')?.value || '',
        target_audience: document.getElementById('edit_audience')?.value || '',
        tone_of_voice: document.getElementById('edit_tone')?.value || '',
        content_pillars: _parsePillars(document.getElementById('edit_pillars')?.value),
        service_offerings: document.getElementById('edit_offerings')?.value || '',
        sales_objections: document.getElementById('edit_objections')?.value || '',
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

    // ── Goals section — relocated out of the tab bar to sit directly under Recent Activity.
    // The markup still lives in #tab-goals (further down the page); move it into place on load.
    (function relocateGoalsSection() {
        const goals = document.getElementById('tab-goals');
        const activityCard = document.getElementById('recent-activity-list')?.closest('.bg-white');
        if (goals && activityCard && activityCard.parentNode) {
            activityCard.parentNode.insertBefore(goals, activityCard.nextSibling);
            goals.classList.remove('hidden');
        }
    })();

    // ── Tab switching ─────────────────────────────────────────────
    document.querySelectorAll('.detail-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.remove('active-tab'));
            document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.add('hidden'));
            btn.classList.add('active-tab');
            const panel = document.getElementById('tab-' + btn.dataset.tab);
            if (panel) panel.classList.remove('hidden');
            // Recompute auto-grow heights now the panel is visible (scrollHeight was 0 while hidden).
            _resizeBriefAutoGrow();
        });
    });

    // Deep-link to a specific tab (e.g. post-OAuth returns to the Connections tab). Goals is no
    // longer a tab — it's a section under Recent Activity — so for 'goals' we scroll to it instead.
    if (window._assistantDetailInitialTab) {
        const wanted = window._assistantDetailInitialTab;
        window._assistantDetailInitialTab = null;
        if (wanted === 'goals') {
            document.getElementById('tab-goals')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            const target = document.querySelector(`.detail-tab-btn[data-tab="${wanted}"]`);
            if (target) target.click();
        }
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
            // Gate-blocked assistants read as lifecycle 'provisioning' but need action → own pill.
            const lifecycle = currentData.status === 'blocked' ? 'blocked' : (currentData.lifecycleStatus
              || (currentData.status === 'pending' ? 'provisioning' : (currentData.isActive === false ? 'paused' : 'working')));
            const PILL = {
                blocked:        { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500',                 label: 'Action Required',    toggle: 'Initiate Kick-Off' },
                provisioning:   { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500 animate-pulse',   label: 'Setup in Progress',  toggle: 'Pause Assistant' },
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

        // US6 AC5.1: Archive Assistant — permanent end-of-life, then return to the dashboard.
        const archiveBtn = document.getElementById('btn-archive-assistant');
        if (archiveBtn) archiveBtn.onclick = async () => {
            const name = currentData.name || 'this assistant';
            if (!confirm(`Archive "${name}"?\n\nThis permanently stops the assistant and removes it from your active workspace. Its history is kept for reporting, but this cannot be undone.`)) return;
            archiveBtn.disabled = true;
            try {
                const r = await fetch(`/.netlify/functions/manage-assistant?id=${assistantId}`, { method: 'DELETE' });
                if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'Failed to archive assistant.'); archiveBtn.disabled = false; return; }
                window.showToast?.('Assistant archived.');
                window.loadView?.('dashboard');
            } catch { alert('Network error — please try again.'); archiveBtn.disabled = false; }
        };

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
            // Brief "casting" flourish so the click registers as an action even though it's instant.
            const wandImg = genBtn.querySelector('img');
            if (wandImg) {
                wandImg.classList.add('is-casting');
                setTimeout(() => wandImg.classList.remove('is-casting'), 600);
            }
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

    // ── SMART Goals (Feature 1) ───────────────────────────────────
    await _fetchAndRenderGoals(assistantId);

    // ── AC6: Daily Relationship-Building Checklist ────────────────
    await _fetchAndRenderRelationshipChecklist(assistantId);
};

// ─────────────────────────────────────────────────────────────────
// AC6: Daily Relationship-Building Checklist — loads today's actions, renders
// tickable items, persists completion. The card stays hidden for non-social
// assistants (the endpoint returns 403 CONNECTION_NOT_RELEVANT).
// ─────────────────────────────────────────────────────────────────
async function _fetchAndRenderRelationshipChecklist(assistantId) {
    const card = document.getElementById('relationship-checklist-card');
    const list = document.getElementById('rbc-list');
    if (!card || !list) return;
    window._rbcAssistantId = assistantId;
    try {
        const res = await fetch(`/.netlify/functions/relationship-checklist?assistantId=${assistantId}`);
        if (!res.ok) { card.classList.add('hidden'); return; }  // 403 for non-social assistants → stay hidden
        const data = await res.json();
        card.classList.remove('hidden');
        _rbcRender(data.items || []);
    } catch {
        card.classList.add('hidden');
    }
}

function _rbcRender(items) {
    const list = document.getElementById('rbc-list');
    const progress = document.getElementById('rbc-progress');
    if (!list) return;
    if (!items.length) {
        list.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No checklist items today.</p>';
        if (progress) progress.textContent = '';
        return;
    }
    const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const CAT = {
        engagement: { label: 'Engage', cls: 'bg-emerald-50 text-emerald-700' },
        outreach:   { label: 'Outreach', cls: 'bg-blue-50 text-blue-700' },
        community:  { label: 'Community', cls: 'bg-violet-50 text-violet-700' },
        follow_up:  { label: 'Follow-up', cls: 'bg-amber-50 text-amber-700' },
    };
    list.innerHTML = items.map(item => {
        const cat = CAT[item.category];
        const badge = cat ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${cat.cls} shrink-0">${cat.label}</span>` : '';
        return `<label class="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-emerald-200 transition cursor-pointer" id="rbc-item-${item.id}">
            <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="window._rbcToggle(${item.id}, this.checked)" class="mt-0.5 w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500 cursor-pointer">
            <span class="flex-1 min-w-0">
                <span class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-semibold ${item.completed ? 'text-gray-400 line-through' : 'text-gray-800'}" id="rbc-title-${item.id}">${esc(item.title)}</span>
                    ${badge}
                </span>
                ${item.description ? `<span class="block text-xs text-gray-500 mt-0.5">${esc(item.description)}</span>` : ''}
            </span>
        </label>`;
    }).join('');
    _rbcUpdateProgress(items);
    window._rbcItems = items;
}

function _rbcUpdateProgress(items) {
    const progress = document.getElementById('rbc-progress');
    if (!progress) return;
    const done = items.filter(i => i.completed).length;
    progress.textContent = `${done} of ${items.length} done${done === items.length ? ' — nice work! 🎉' : ''}`;
}

window._rbcToggle = async function (taskId, completed) {
    // Optimistic UI: update title styling + progress immediately, persist in the background.
    const titleEl = document.getElementById(`rbc-title-${taskId}`);
    if (titleEl) {
        titleEl.classList.toggle('line-through', completed);
        titleEl.classList.toggle('text-gray-400', completed);
        titleEl.classList.toggle('text-gray-800', !completed);
    }
    const item = (window._rbcItems || []).find(i => i.id === taskId);
    if (item) { item.completed = completed; _rbcUpdateProgress(window._rbcItems); }
    try {
        const res = await fetch('/.netlify/functions/relationship-checklist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, completed }),
        });
        if (!res.ok) throw new Error('save failed');
    } catch {
        // Revert on failure.
        const cb = document.querySelector(`#rbc-item-${taskId} input[type=checkbox]`);
        if (cb) cb.checked = !completed;
        if (titleEl) {
            titleEl.classList.toggle('line-through', !completed);
            titleEl.classList.toggle('text-gray-400', !completed);
            titleEl.classList.toggle('text-gray-800', completed);
        }
        if (item) { item.completed = !completed; _rbcUpdateProgress(window._rbcItems); }
        window.showToast?.('Could not save — please try again.');
    }
};

window._rbcRegenerate = async function () {
    const assistantId = window._rbcAssistantId;
    if (!assistantId) return;
    const btn = document.getElementById('rbc-regenerate-btn');
    const list = document.getElementById('rbc-list');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    if (list) list.innerHTML = '<div class="h-10 bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-sm text-gray-400">Generating a fresh checklist…</div>';
    try {
        const res = await fetch('/.netlify/functions/relationship-checklist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId, regenerate: true }),
        });
        const data = await res.json();
        if (data.ok) _rbcRender(data.items || []);
        else window.showToast?.(data.error || 'Could not regenerate the checklist.');
    } catch {
        window.showToast?.('Network error — please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }
    }
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

    // US5 AC5.2: system_paused → red "Attention Required" diagnostic + targeted fix CTA,
    // replacing the normal kick-off flow (the kick-off endpoint also 409s on system_paused).
    if (data.attention) {
        const attn = data.attention;
        const CONN_LABELS = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };
        const svc = (attn.services || []).map(s => CONN_LABELS[s] || (s.charAt(0).toUpperCase() + s.slice(1)));
        let reason, ctaLabel, ctaKind;
        if (attn.kind === 'connection') {
            reason = `Reconnect ${svc.join(', ')} to put this assistant back to work.`;
            ctaLabel = `Reconnect ${svc[0] || 'account'}`; ctaKind = 'platforms';
        } else if (attn.kind === 'billing') {
            reason = 'Your subscription needs attention before this assistant can run.';
            ctaLabel = 'Fix Billing'; ctaKind = 'billing';
        } else if (attn.kind === 'limit') {
            reason = "This assistant is paused because your plan's assistant limit was exceeded.";
            ctaLabel = 'Manage Plan'; ctaKind = 'billing';
        } else {
            reason = 'This assistant needs attention before it can run again.';
            ctaLabel = 'Review Connections'; ctaKind = 'platforms';
        }
        subEl.textContent = 'Attention required — resolve the issue below to resume.';
        listEl.innerHTML = '';
        const panel = document.getElementById('kickoff-summary');
        if (panel) {
            panel.className = 'mb-5 p-4 rounded-xl bg-red-50 border border-red-200';
            panel.innerHTML = `
                <p class="text-xs font-bold text-red-500 uppercase tracking-wider mb-1">⚠ Attention required</p>
                <p class="text-sm font-semibold text-red-800 mb-3">${reason}</p>
                <button type="button" id="btn-fix-attention" class="px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition cursor-pointer">${ctaLabel}</button>`;
            const fix = document.getElementById('btn-fix-attention');
            if (fix) fix.onclick = () => {
                if (ctaKind === 'billing') window.loadView?.('billing');
                else document.querySelector('.detail-tab-btn[data-tab="platforms"]')?.click();
            };
        }
        btn.classList.add('hidden');
        hintEl.textContent = '';
        return;
    }

    // A compliance gate blocked provisioning → amber "Action Required" panel + Retry, replacing the
    // normal kick-off flow (kickoff-assistant also 409s with PROVISIONING_BLOCKED). Once the user
    // satisfies the precondition, retry re-fires provisioning and the assistant advances.
    if (data.blocked) {
        const b = data.blocked;
        subEl.textContent = 'Action required before this assistant can start.';
        listEl.innerHTML = '';
        const panel = document.getElementById('kickoff-summary');
        if (panel) {
            panel.className = 'mb-5 p-4 rounded-xl bg-amber-50 border border-amber-200';
            panel.innerHTML = `
                <p class="text-xs font-bold text-amber-600 uppercase tracking-wider mb-1">⚠ ${b.title || 'Action required'}</p>
                <p class="text-sm font-semibold text-amber-800 mb-3">${b.message || 'An action is needed before setup can finish.'}</p>
                <button type="button" id="btn-retry-prov" class="px-4 py-2 text-sm font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-sm transition cursor-pointer">${b.cta || 'Retry'} &amp; retry</button>`;
            const r = document.getElementById('btn-retry-prov');
            if (r) r.onclick = () => window.retryProvisioning?.(assistantId, r);
        }
        btn.classList.add('hidden');
        hintEl.textContent = '';
        return;
    }

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
        summaryEl.className = 'mb-5 p-4 rounded-xl bg-gray-50 border border-gray-100' + (data.working ? ' hidden' : '');
        summaryEl.innerHTML = `
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Primary directive</p>
            <p class="text-sm font-semibold text-gray-800 mb-3">${sm.directive || 'Digital Assistant'}</p>
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Active connections</p>
            <div class="flex flex-wrap gap-1.5">${connPills}</div>`;
    }

    // Already working → confirmation state + a Pause control (US4 AC4.1: pause in settings).
    if (data.working) {
        const since = data.workingSince ? new Date(data.workingSince).toLocaleDateString('en-GB') : null;
        subEl.textContent = since ? `Your assistant is working (since ${since}).` : 'Your assistant is working.';
        btn.classList.add('hidden');
        hintEl.innerHTML = `<span class="inline-flex items-center gap-1 text-emerald-700 font-semibold">✓ Active</span>
            <button type="button" id="btn-pause-working" class="ml-3 px-3 py-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition cursor-pointer">⏸ Pause Assistant</button>`;
        const pauseBtn = document.getElementById('btn-pause-working');
        if (pauseBtn) pauseBtn.onclick = async () => {
            if (!confirm('Pause this assistant? It will stop all actions until you kick it off again.')) return;
            pauseBtn.disabled = true;
            try {
                // US4 AC4.2/4.3: working → paused (immediate halt).
                const r = await fetch(`/.netlify/functions/manage-assistant?id=${assistantId}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }),
                });
                if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not pause the assistant.'); pauseBtn.disabled = false; return; }
                window.showToast?.('Assistant paused.');
                // Re-render: card flips to the Kick-Off state so the user can confirm to resume (AC4.4).
                await _renderKickOff(assistantId);
                const statusEl = document.getElementById('detail-status');
                if (statusEl) {
                    statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200';
                    statusEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-gray-400"></span> Paused';
                }
                const toggleBtn = document.getElementById('btn-toggle-status');
                if (toggleBtn) toggleBtn.textContent = 'Resume Assistant';
            } catch { alert('Network error — please try again.'); pauseBtn.disabled = false; }
        };
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

        // Meaningful Engagement (AC8) — saves + shares + comments over reach, the value-weighted
        // headline. Trend shows the raw value signals so success isn't judged on views alone.
        if (valEl('value')) {
            valEl('value').textContent = pct(m.meaningfulEngagementRate);
            const c = data.current || {};
            const parts = [];
            if (c.saves != null)  parts.push(`${c.saves} saves`);
            if (c.shares != null) parts.push(`${c.shares} shares`);
            if (parts.length) trendEl('value').textContent = parts.join(' · ');
            if (m.meaningfulEngagementRate != null) {
                setDot('value', m.valueScoreGrowth != null && m.valueScoreGrowth < 0 ? 'down' : 'up');
            }
            // Recognise high-value / low-reach posts as wins.
            const wins = (data.topValuePosts || []).filter(p => p.lowReachHighValue).length;
            const winsEl = document.getElementById('metric-value-wins');
            if (winsEl && wins > 0) {
                winsEl.textContent = `★ ${wins} post${wins === 1 ? '' : 's'} converted strongly on saves/shares despite low reach — counted as wins.`;
                winsEl.classList.remove('hidden');
            }
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
    // ── Assistant Rules now live per-assistant — see _fetchAndRenderAssistantRules() ──

    // ── Business Information & Brand Knowledge ─────────────────────
    // There is no longer a separate "Brand Profile". The documents and links the user adds in
    // Business Information are mandatory context: they're always applied to this assistant as a
    // strict rule that can't be turned off — so this panel is informational only, no toggle.
    const knowledgeContainer = document.getElementById('business-knowledge-content');
    if (knowledgeContainer) {
        let assets = [];
        try {
            const aRes = await fetch('/.netlify/functions/get-workspace-assets');
            if (aRes.ok) assets = (await aRes.json()).assets || [];
        } catch { /* non-fatal — still show the strict-rule notice below */ }

        const strictNote = `
            <div class="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800 mb-4">
                <svg class="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                <span>Your business details and every document or link in Business Information are considered by Be More Swan AI whenever it generates content. This is applied as a <strong>strict rule that can't be turned off</strong>.</span>
            </div>`;

        const catLabel = (c) => ({ tone_of_voice: 'Tone of Voice', logo: 'Brand Logo', product_info: 'Product Knowledge', general: 'General Context' }[c] || 'General Context');

        if (!assets.length) {
            knowledgeContainer.innerHTML = strictNote + `
                <div class="flex flex-col items-center justify-center py-4 text-center gap-2">
                    <p class="text-sm text-gray-500">No documents or links added yet.</p>
                    <a href="#" onclick="window.loadView('assets')" class="text-sm font-bold text-emerald-600 hover:underline cursor-pointer">Add documents or links in Business Information →</a>
                </div>`;
        } else {
            knowledgeContainer.innerHTML = strictNote + `
                <ul class="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
                    ${assets.map(a => `
                        <li class="flex items-center justify-between gap-3 px-4 py-3">
                            <div class="min-w-0">
                                <p class="text-sm font-semibold text-gray-800 truncate">${_escapeHtml(a.name)}</p>
                                <p class="text-xs text-gray-400 mt-0.5">${a.isFile ? 'Document' : 'Link'} · ${_escapeHtml(catLabel(a.category))}</p>
                            </div>
                            ${(a.externalUrl && !a.isFile) ? `<a href="${_escapeHtml(a.externalUrl)}" target="_blank" rel="noopener" class="text-xs font-bold text-emerald-700 hover:underline shrink-0">Open</a>` : ''}
                        </li>`).join('')}
                </ul>
                <div class="mt-3 text-right">
                    <a href="#" onclick="window.loadView('assets')" class="text-sm font-bold text-emerald-600 hover:underline cursor-pointer">Manage in Business Information →</a>
                </div>`;
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

    // "Copy from another assistant" only makes sense with 2+ assistants — hide it otherwise.
    _toggleCopyRulesButton();
}

// Show the copy-rules button only when the user has another assistant to copy from.
// NOTE: the button is `inline-flex`, and in the prebuilt style.css `.inline-flex` is declared
// AFTER `.hidden`, so the `hidden` class can't hide it (display:inline-flex wins). We must toggle
// visibility via inline style.display, which beats any class-based display rule.
async function _toggleCopyRulesButton() {
    const btn = document.getElementById('btn-copy-rules');
    if (!btn) return;
    btn.style.display = 'none'; // default hidden until we confirm another assistant exists
    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        if (!res.ok) return;
        const data = await res.json();
        const others = (data.assistants || []).filter(a =>
            a && a.id && parseInt(a.id) !== _rulesAssistantId &&
            a.lifecycleStatus !== 'archived' && a.status !== 'cancelled');
        if (others.length) btn.style.display = 'inline-flex'; // reveal with correct icon/text layout
    } catch { /* leave hidden on error — copying needs a successful list anyway */ }
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

// ══════════════════════════════════════════════════════════════════
// SMART Goals (Feature 1) — per-assistant goal builder + list
// ══════════════════════════════════════════════════════════════════
const GOALS_API = '/.netlify/functions/manage-goals';
let _goalsAssistantId = null;
let _goalMetrics = [];   // available metric catalog entries for this workspace (AC1.1.3)
let _goalsCache = [];    // last-loaded goals for this assistant (for the header bar + review modal)
let _goalEntitlements = { aiRecommendations: false, magicWand: false, autonomous: false }; // Feature 3 tier gates
let _autonomousGoalSeeking = false;
let _autonomousMediaEnabled = false;   // Epic 2 US5
let _autonomousMediaCap = 20;

const _GOAL_STATUS_META = {
    pending:            { label: 'Pending',        dot: 'bg-gray-300',    text: 'text-gray-500'   },
    on_track:           { label: 'On Track',       dot: 'bg-emerald-500', text: 'text-emerald-600' },
    at_risk:            { label: 'At Risk',        dot: 'bg-amber-500',   text: 'text-amber-600'  },
    off_track:          { label: 'Off Track',      dot: 'bg-red-500',     text: 'text-red-600'    },
    data_disconnected:  { label: 'Data Disconnected', dot: 'bg-gray-400', text: 'text-gray-500'   },
};

function _goalMetricLabel(key) {
    const m = _goalMetrics.find(x => x.key === key);
    return m ? { label: m.label, unit: m.unit } : { label: key, unit: '' };
}

async function _fetchAndRenderGoals(assistantId) {
    _goalsAssistantId = parseInt(assistantId);
    const list = document.getElementById('goals-list');
    if (!list) return;

    let goals = [];
    try {
        const res = await fetch(`${GOALS_API}?assistantId=${_goalsAssistantId}`);
        if (res.ok) {
            const data = await res.json();
            goals = data.goals || [];
            _goalMetrics = data.availableMetrics || [];
            _goalEntitlements = data.entitlements || _goalEntitlements;
            _autonomousGoalSeeking = !!data.autonomousGoalSeeking;
            _autonomousMediaEnabled = !!data.autonomousMediaEnabled;
            _autonomousMediaCap = data.autonomousMediaMonthlyCap ?? 20;
        }
    } catch (e) {
        console.warn('Could not load goals:', e);
    }

    _goalsCache = goals;
    _populateGoalMetricDropdown();
    _renderPrimaryGoalHeader();
    _syncReviewButton();
    _applyGoalEntitlementsUi();
    _applyAutonomousMediaUi();

    if (!goals.length) {
        list.innerHTML = `<div class="py-8 text-center text-sm text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            No goals yet. Click <span class="font-bold text-emerald-600">Add New Goal</span> to set your first target.</div>`;
        return;
    }
    list.innerHTML = goals.map(_buildGoalCard).join('');

    // AC2.2.1 — a dashboard "Review Progress" click deep-links here; open the modal once.
    if (window._reviewProgressOnLoad) {
        window._reviewProgressOnLoad = false;
        setTimeout(() => window._openReviewProgress(), 150);
    }
}

// AC2.1.2 — primary goal progress bar in the assistant detail header.
function _renderPrimaryGoalHeader() {
    const box = document.getElementById('detail-primary-goal');
    if (!box) return;
    const primary = _goalsCache.find(g => g.isPrimary) || _goalsCache[0];
    if (!primary) { box.classList.add('hidden'); box.innerHTML = ''; return; }

    const meta = _GOAL_STATUS_META[primary.status] || _GOAL_STATUS_META.pending;
    const { label, unit } = _goalMetricLabel(primary.metricKey);
    const target = Number(primary.targetValue);
    const latest = primary.latestValue != null ? Number(primary.latestValue) : null;
    const pct = (latest != null && target > 0) ? Math.max(0, Math.min(100, Math.round((latest / target) * 100))) : 0;
    const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

    box.classList.remove('hidden');
    box.innerHTML = `
        <div class="flex items-center justify-between text-xs mb-1">
            <span class="font-bold text-gray-700">${_escapeHtml(label)}</span>
            <span class="inline-flex items-center gap-1.5 font-bold ${meta.text}"><span class="w-2 h-2 rounded-full ${meta.dot}"></span>${meta.label}</span>
        </div>
        <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
            <div class="h-full ${meta.dot} transition-all" style="width:${pct}%"></div>
        </div>
        <p class="text-[11px] text-gray-400 mt-1">${latest != null ? fmt(latest) : '—'} / ${fmt(target)} ${_escapeHtml(unit)}</p>`;
}

function _syncReviewButton() {
    const btn = document.getElementById('btn-review-progress');
    if (btn) btn.classList.toggle('hidden', _goalsCache.length === 0);
}

// US-01 AC1.1/AC1.2 — the Objective dropdown drives which metrics appear; AC1.1.3 still gates the
// metrics by which apps are actually connected. Selecting an objective instantly (re)populates the
// Metric dropdown with that objective's measurable metrics.
function _populateGoalMetricDropdown() {
    const objSel = document.getElementById('goal-objective');
    const sel = document.getElementById('goal-metric');
    const help = document.getElementById('goal-metric-help');
    if (!objSel || !sel) return;

    const renderMetrics = () => {
        const objective = objSel.value;
        if (help) help.textContent = '';
        if (!objective) {
            sel.innerHTML = '<option value="">Select an objective first…</option>';
            sel.disabled = true;
            return;
        }
        const metrics = _goalMetrics.filter(m => m.objective === objective);
        if (!metrics.length) {
            sel.innerHTML = '<option value="">No measurable metrics for this objective yet</option>';
            sel.disabled = true;
            if (help) help.innerHTML = 'Connect a social or data app on the <span class="font-semibold">Connections</span> tab to unlock metrics for this objective.';
            return;
        }
        sel.disabled = false;
        sel.innerHTML = '<option value="">Select a metric…</option>' +
            metrics.map(m => `<option value="${m.key}" data-unit="${_escapeHtml(m.unit)}">${_escapeHtml(m.label)}</option>`).join('');
    };

    objSel.onchange = renderMetrics;
    sel.onchange = () => {
        const m = _goalMetrics.find(x => x.key === sel.value);
        if (help) help.textContent = m ? m.description : '';
    };
    renderMetrics();
}

function _buildGoalCard(g) {
    const meta = _GOAL_STATUS_META[g.status] || _GOAL_STATUS_META.pending;
    const { label, unit } = _goalMetricLabel(g.metricKey);
    const target = Number(g.targetValue);
    const latest = g.latestValue != null ? Number(g.latestValue) : null;
    const pct = (latest != null && target > 0) ? Math.max(0, Math.min(100, Math.round((latest / target) * 100))) : 0;
    const due = g.targetDate ? new Date(g.targetDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

    return `<div class="border border-gray-200 rounded-xl p-4">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <h4 class="text-sm font-bold text-gray-900">${_escapeHtml(label)}</h4>
                    ${g.isPrimary ? '<span class="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">Primary</span>' : ''}
                </div>
                <p class="text-xs text-gray-500 mt-0.5">Target: <span class="font-semibold text-gray-700">${fmt(target)} ${_escapeHtml(unit)}</span> by ${due}</p>
            </div>
            <div class="flex items-center gap-3 shrink-0">
                <span class="inline-flex items-center gap-1.5 text-xs font-bold ${meta.text}">
                    <span class="w-2 h-2 rounded-full ${meta.dot}"></span>${meta.label}
                </span>
                <button type="button" onclick="window._deleteGoal(${g.id})" aria-label="Delete goal" class="text-gray-300 hover:text-red-500 transition cursor-pointer">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>
        </div>
        <div class="mt-3">
            <div class="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                <span>${latest != null ? fmt(latest) + ' ' + _escapeHtml(unit) : 'Awaiting first data sync'}</span>
                <span>${latest != null ? pct + '%' : ''}</span>
            </div>
            <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                <div class="h-full ${meta.dot} transition-all" style="width:${pct}%"></div>
            </div>
        </div>
    </div>`;
}

window._toggleGoalBuilder = function (show) {
    const builder = document.getElementById('goal-builder');
    const err = document.getElementById('goal-builder-error');
    if (!builder) return;
    if (err) err.classList.add('hidden');
    if (show) {
        builder.classList.remove('hidden');
        const t = document.getElementById('goal-target'); if (t) t.value = '';
        const d = document.getElementById('goal-date'); if (d) d.value = '';
        const o = document.getElementById('goal-objective'); if (o) o.value = '';
        const m = document.getElementById('goal-metric'); if (m) m.value = '';
        const p = document.getElementById('goal-primary'); if (p) p.checked = false;
        const help = document.getElementById('goal-metric-help'); if (help) help.textContent = '';
        // Reset the Metric dropdown back to its "select an objective first" state.
        _populateGoalMetricDropdown();
    } else {
        builder.classList.add('hidden');
    }
};

window._saveGoal = async function () {
    const err = document.getElementById('goal-builder-error');
    const btn = document.getElementById('btn-save-goal');
    const metricKey = document.getElementById('goal-metric')?.value;
    const targetValue = document.getElementById('goal-target')?.value;
    const targetDate = document.getElementById('goal-date')?.value;
    const isPrimary = document.getElementById('goal-primary')?.checked || false;

    const fail = (msg) => { if (err) { err.textContent = msg; err.classList.remove('hidden'); } };
    if (err) err.classList.add('hidden');
    if (!metricKey) return fail('Please choose a target metric.');
    if (!targetValue || Number(targetValue) <= 0) return fail('Enter a positive target value.');
    if (!targetDate || new Date(targetDate).getTime() <= Date.now()) return fail('Choose a target date in the future.');

    if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
    try {
        const res = await fetch(GOALS_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: _goalsAssistantId, metricKey, targetValue: Number(targetValue), targetDate, isPrimary }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); return fail(e.error || 'Could not save goal.'); }
        window._toggleGoalBuilder(false);
        await _fetchAndRenderGoals(_goalsAssistantId);
    } catch {
        fail('Could not save goal. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60'); }
    }
};

window._deleteGoal = async function (id) {
    if (!confirm('Delete this goal? This cannot be undone.')) return;
    try {
        const res = await fetch(`${GOALS_API}?id=${id}`, { method: 'DELETE' });
        if (res.ok) await _fetchAndRenderGoals(_goalsAssistantId);
    } catch { /* no-op */ }
};

// ── Review Progress (US2.2) — trendline vs trajectory chart + base-tier manual path ──
const GOAL_TELEMETRY_API = '/.netlify/functions/get-goal-telemetry';

const _REVIEW_BANNER = {
    on_track:          { tone: 'emerald', text: 'On track to hit your target by the deadline.' },
    at_risk:           { tone: 'amber',   text: 'Slightly behind pace. A small adjustment now keeps you on target.' },
    off_track:         { tone: 'red',     text: 'Off track — at the current rate this goal will miss its target.' },
    pending:           { tone: 'gray',    text: 'Gathering data. Status appears once a few data points are in.' },
    data_disconnected: { tone: 'gray',    text: 'We lost connection to the data source. Re-authenticate to resume tracking.' },
};
const _REVIEW_TONE_CLS = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    amber:   'bg-amber-50 border-amber-200 text-amber-800',
    red:     'bg-red-50 border-red-200 text-red-800',
    gray:    'bg-gray-50 border-gray-200 text-gray-600',
};

window._openReviewProgress = function (goalId) {
    const modal = document.getElementById('modal-review-progress');
    const sel = document.getElementById('review-goal-select');
    if (!modal || !sel || !_goalsCache.length) return;
    sel.innerHTML = _goalsCache.map(g => {
        const { label } = _goalMetricLabel(g.metricKey);
        return `<option value="${g.id}">${_escapeHtml(label)}${g.isPrimary ? ' (Primary)' : ''}</option>`;
    }).join('');
    const initial = goalId || (_goalsCache.find(g => g.isPrimary) || _goalsCache[0]).id;
    sel.value = String(initial);
    modal.classList.remove('hidden');
    window._renderReviewChart(Number(initial));
};

window._renderReviewChart = async function (goalId) {
    const chart = document.getElementById('review-chart');
    const banner = document.getElementById('review-status-banner');
    const footer = document.getElementById('review-footer');
    if (!chart) return;
    chart.innerHTML = '<span class="text-sm text-gray-400">Loading chart…</span>';
    if (banner) banner.innerHTML = '';
    if (footer) footer.innerHTML = '';

    let data = null;
    try {
        const res = await fetch(`${GOAL_TELEMETRY_API}?id=${goalId}`);
        if (res.ok) data = await res.json();
    } catch { /* handled below */ }
    if (!data) { chart.innerHTML = '<span class="text-sm text-red-500">Could not load telemetry.</span>'; return; }

    const status = data.goal.status;
    const b = _REVIEW_BANNER[status] || _REVIEW_BANNER.pending;
    if (banner) {
        banner.innerHTML = `<div class="flex items-start gap-2 text-sm font-medium border rounded-lg px-3 py-2.5 ${_REVIEW_TONE_CLS[b.tone]}">
            <span class="font-bold">${(_GOAL_STATUS_META[status] || _GOAL_STATUS_META.pending).label}:</span><span>${b.text}</span></div>`;
    }

    chart.innerHTML = _buildTelemetrySvg(data.actual || [], data.trajectory || []);

    const recsBox = document.getElementById('review-recommendations');
    if (recsBox) { recsBox.classList.add('hidden'); recsBox.innerHTML = ''; }

    // Footer: premium "Get AI Recommendations" (padlock if base tier, AC3.1.1) + base-tier
    // manual "Edit Assistant Brief" when off pace (AC2.2.3).
    if (footer) {
        const offPace = status === 'off_track' || status === 'at_risk';
        const lock = _goalEntitlements.aiRecommendations ? '' : '🔒 ';
        // US-03 — the headline resolution flow for a failing goal: diagnosis + a one-click strategy fix.
        // It's the primary CTA when off pace; "Get AI Recommendations" drops to a secondary outline.
        const fixBtn = offPace
            ? `<button type="button" onclick="window._openStrategyFix(${goalId})" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg shadow transition cursor-pointer">${lock}One-Click Fix</button>`
            : '';
        const recsCls = offPace
            ? 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow';
        const recsBtn = `<button type="button" onclick="window._getAiRecommendations(${goalId})" class="px-5 py-2 ${recsCls} text-sm font-bold rounded-lg transition cursor-pointer">${lock}Get AI Recommendations</button>`;
        const editBtn = offPace
            ? `<button type="button" onclick="window._editBriefFromReview()" class="px-5 py-2 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-bold rounded-lg transition cursor-pointer">Edit Assistant Brief</button>`
            : '';
        footer.innerHTML = editBtn + recsBtn + fixBtn;
    }
};

window._editBriefFromReview = function () {
    document.getElementById('modal-review-progress')?.classList.add('hidden');
    document.querySelector('.detail-tab-btn[data-tab="guardrails"]')?.click();
    setTimeout(() => {
        const el = document.getElementById('edit_strict_rules');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
    }, 120);
};

// Dependency-free line chart: actual (solid emerald) vs required trajectory (dashed grey).
function _buildTelemetrySvg(actual, trajectory) {
    const all = [...actual, ...trajectory];
    if (!all.length) return '<span class="text-sm text-gray-400">No data yet — the first sync will populate this chart.</span>';

    const W = 560, H = 220, PAD = { l: 52, r: 16, t: 14, b: 28 };
    const xs = all.map(p => new Date(p.date).getTime());
    const ys = all.map(p => Number(p.value));
    let minX = Math.min(...xs), maxX = Math.max(...xs);
    let minY = Math.min(0, ...ys), maxY = Math.max(...ys);
    if (maxX === minX) maxX = minX + 1;
    if (maxY === minY) maxY = minY + 1;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const sx = t => PAD.l + ((t - minX) / (maxX - minX)) * plotW;
    const sy = v => PAD.t + (1 - (v - minY) / (maxY - minY)) * plotH;
    const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(new Date(p.date).getTime()).toFixed(1)},${sy(Number(p.value)).toFixed(1)}`).join(' ');

    const trajPath = trajectory.length >= 2 ? `<path d="${path(trajectory)}" fill="none" stroke="#9ca3af" stroke-width="2" stroke-dasharray="5 5"/>` : '';
    const actPath = actual.length >= 2 ? `<path d="${path(actual)}" fill="none" stroke="#059669" stroke-width="2.5"/>` : '';
    const actDots = actual.map(p => `<circle cx="${sx(new Date(p.date).getTime()).toFixed(1)}" cy="${sy(Number(p.value)).toFixed(1)}" r="3" fill="#059669"/>`).join('');

    const fmtV = v => Number(v).toLocaleString();
    const fmtD = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const axis = `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}" stroke="#e5e7eb"/><line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" stroke="#e5e7eb"/>`;
    const labels =
        `<text x="${PAD.l - 6}" y="${(sy(maxY) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${fmtV(maxY)}</text>` +
        `<text x="${PAD.l - 6}" y="${(sy(minY) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${fmtV(minY)}</text>` +
        `<text x="${PAD.l}" y="${H - 8}" text-anchor="start" font-size="10" fill="#9ca3af">${fmtD(minX)}</text>` +
        `<text x="${W - PAD.r}" y="${H - 8}" text-anchor="end" font-size="10" fill="#9ca3af">${fmtD(maxX)}</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" xmlns="http://www.w3.org/2000/svg">${axis}${trajPath}${actPath}${actDots}${labels}</svg>`;
}

// ══════════════════════════════════════════════════════════════════
// Feature 3 — Premium AI Optimization (recommendations, magic wand, autonomous)
// ══════════════════════════════════════════════════════════════════
const GOAL_AI_API = '/.netlify/functions/goal-ai';
const _WAND_FIELD_LABELS = { tone_of_voice: 'Brand Voice', target_audience: 'Target Audience', content_pillars: 'Content Strategy', core_message: 'Core Message', problem_statement: 'Your Bottleneck', service_offerings: 'Products & Services' };

function _openUpgrade(msg) {
    if (typeof window.openUpgradeModal === 'function') {
        window.openUpgradeModal('Upgrade your plan', 'Premium AI optimization', msg);
    } else {
        alert(msg);
    }
}

// Reflect tier entitlements + autonomous state onto the UI (toggle, premium lock chip).
function _applyGoalEntitlementsUi() {
    const tog = document.getElementById('toggle-autonomous-goals');
    const dot = document.getElementById('toggle-autonomous-goals-dot');
    const lock = document.getElementById('autonomous-lock');
    if (tog && dot) {
        const on = _autonomousGoalSeeking;
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.classList.toggle('bg-emerald-600', on);
        tog.classList.toggle('bg-gray-300', !on);
        dot.classList.toggle('translate-x-5', on);
        dot.classList.toggle('translate-x-0', !on);
    }
    if (lock) lock.classList.toggle('hidden', _goalEntitlements.autonomous);
}

// Epic 2 US5 — reflect autonomous media-suggestion state on the toggle + cap input.
function _applyAutonomousMediaUi() {
    const tog = document.getElementById('toggle-autonomous-media');
    const dot = document.getElementById('toggle-autonomous-media-dot');
    const capRow = document.getElementById('autonomous-media-cap-row');
    const capInput = document.getElementById('autonomous-media-cap');
    if (tog && dot) {
        const on = _autonomousMediaEnabled;
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.classList.toggle('bg-emerald-600', on);
        tog.classList.toggle('bg-gray-300', !on);
        dot.classList.toggle('translate-x-5', on);
        dot.classList.toggle('translate-x-0', !on);
    }
    if (capRow) capRow.classList.toggle('hidden', !_autonomousMediaEnabled);
    if (capInput) capInput.value = _autonomousMediaCap;
}

async function _setAutonomousMedia(patch) {
    const res = await fetch('/.netlify/functions/set-autonomous-media', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantId: _goalsAssistantId, ...patch }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
}

window._toggleAutonomousMedia = async function () {
    const next = !_autonomousMediaEnabled;
    try {
        const data = await _setAutonomousMedia({ enabled: next });
        _autonomousMediaEnabled = !!data.autonomousMediaEnabled;
        _autonomousMediaCap = data.autonomousMediaMonthlyCap ?? _autonomousMediaCap;
        _applyAutonomousMediaUi();
    } catch (e) { alert('Could not update the setting: ' + e.message); }
};

window._saveAutonomousMediaCap = async function () {
    const input = document.getElementById('autonomous-media-cap');
    const cap = parseInt(input?.value, 10);
    if (!Number.isFinite(cap) || cap < 0) { input.value = _autonomousMediaCap; return; }
    try {
        const data = await _setAutonomousMedia({ monthlyCap: cap });
        _autonomousMediaCap = data.autonomousMediaMonthlyCap ?? cap;
        _applyAutonomousMediaUi();
    } catch (e) { alert('Could not update the cap: ' + e.message); input.value = _autonomousMediaCap; }
};

// AC3.1 — premium AI recommendations for an off-track goal.
window._getAiRecommendations = async function (goalId) {
    if (!_goalEntitlements.aiRecommendations) {
        return _openUpgrade('AI Recommendations are available on the Saver and Employee plans.');
    }
    const box = document.getElementById('review-recommendations');
    if (box) { box.classList.remove('hidden'); box.innerHTML = '<p class="text-sm text-gray-400 mt-3">Analysing your goal…</p>'; }
    try {
        const res = await fetch(GOAL_AI_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recommend', goalId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) { if (box) box.classList.add('hidden'); return _openUpgrade('AI Recommendations require a higher plan.'); }
        if (!res.ok || !Array.isArray(data.recommendations)) {
            if (box) box.innerHTML = `<p class="text-sm text-red-500 mt-3">${_escapeHtml(data.error || 'Could not generate recommendations.')}</p>`;
            return;
        }
        // US-02 — the diagnosis is steered by the metric's funnel stage; label it so the user sees why.
        const funnelTag = data.funnelStage
            ? `<span class="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">${_escapeHtml(data.funnelStage)}</span>`
            : '';
        if (box) box.innerHTML = `<div class="mt-3 space-y-2">
            <div class="flex items-center gap-2 flex-wrap">
                <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">AI Recommendations</p>
                ${funnelTag}
            </div>
            ${data.recommendations.map(r => `<div class="flex items-start gap-2 text-sm text-gray-700 bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-2"><span class="text-emerald-600 font-bold">✦</span><span>${_escapeHtml(r)}</span></div>`).join('')}
        </div>`;
    } catch {
        if (box) box.innerHTML = '<p class="text-sm text-red-500 mt-3">Could not generate recommendations.</p>';
    }
};

// AC3.2 — goal-aware field rewrite (magic wand).
window._magicWand = async function (field, inputId, btn) {
    if (!_goalEntitlements.magicWand) {
        return _openUpgrade('The AI Magic Wand is available on the Saver and Employee plans.');
    }
    const input = document.getElementById(inputId);
    if (!input) return;
    const wandImg = btn ? btn.querySelector('img') : null;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }
    wandImg?.classList.add('is-casting');   // visible "something's happening" feedback
    try {
        const res = await fetch(GOAL_AI_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'rewrite', assistantId: _goalsAssistantId, field, text: input.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) return _openUpgrade('The AI Magic Wand requires a higher plan.');
        if (!res.ok || !data.suggestion) { alert(data.error || 'Could not generate a suggestion.'); return; }
        _showWandSuggestion(field, inputId, data.suggestion);
    } catch {
        alert('Could not generate a suggestion.');
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        wandImg?.classList.remove('is-casting');
    }
};

function _showWandSuggestion(field, inputId, suggestion) {
    const lbl = document.getElementById('wand-field-label');
    const sug = document.getElementById('wand-suggestion');
    const accept = document.getElementById('wand-accept');
    if (lbl) lbl.textContent = _WAND_FIELD_LABELS[field] || field;
    if (sug) sug.textContent = suggestion;
    if (accept) accept.onclick = () => {            // AC3.2.3 — one-click apply (then autosave)
        const input = document.getElementById(inputId);
        if (input) { input.value = suggestion; input.dispatchEvent(new Event('input', { bubbles: true })); }
        document.getElementById('modal-wand')?.classList.add('hidden');
    };
    document.getElementById('modal-wand')?.classList.remove('hidden');
}

// ── US-03 One-Click Fix — diagnosis + side-by-side strategy diff + apply-all ──
// Strategy field (onboardingContext key) → the Guardrails-tab input that holds it. Applying a fix
// just writes these inputs and lets the detail page's debounced autosave persist them (the same
// path the Magic Wand uses), so all changed fields save together in one round-trip (AC3.4).
const _STRATEGY_FIELD_INPUTS = { tone_of_voice: 'edit_tone', target_audience: 'edit_audience', content_pillars: 'edit_pillars' };

window._openStrategyFix = async function (goalId) {
    if (!_goalEntitlements.aiRecommendations) {
        return _openUpgrade('One-Click Fix is available on the Saver and Employee plans.');
    }
    const modal = document.getElementById('modal-strategy-fix');
    const body = document.getElementById('strategy-fix-body');
    const footer = document.getElementById('strategy-fix-footer');
    if (!modal || !body) return;
    footer?.classList.add('hidden');
    body.innerHTML = '<div class="flex items-center justify-center py-10 text-sm text-gray-400">Analysing your strategy…</div>';
    modal.classList.remove('hidden');

    try {
        const res = await fetch(GOAL_AI_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'strategy', goalId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) { modal.classList.add('hidden'); return _openUpgrade('One-Click Fix requires a higher plan.'); }
        if (!res.ok) {
            body.innerHTML = `<p class="text-sm text-red-500 py-6 text-center">${_escapeHtml(data.error || 'Could not generate a strategy fix.')}</p>`;
            return;
        }
        _renderStrategyFix(data);
    } catch {
        body.innerHTML = '<p class="text-sm text-red-500 py-6 text-center">Could not generate a strategy fix.</p>';
    }
};

function _renderStrategyFix(data) {
    const body = document.getElementById('strategy-fix-body');
    const footer = document.getElementById('strategy-fix-footer');
    const accept = document.getElementById('strategy-fix-accept');
    const changes = Array.isArray(data.changes) ? data.changes : [];

    // AC3.2 — plain-text diagnosis of why the goal is failing.
    const funnelTag = data.funnelStage
        ? `<span class="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">${_escapeHtml(data.funnelStage)}</span>`
        : '';
    const diagnosis = data.diagnosis
        ? `<div class="space-y-2">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Diagnosis</p>${funnelTag}
              </div>
              <p class="text-sm text-gray-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5">${_escapeHtml(data.diagnosis)}</p>
           </div>`
        : '';

    if (!changes.length) {
        // Diagnosis only — nothing to apply. Offer manual editing instead.
        if (body) body.innerHTML = `${diagnosis || '<p class="text-sm text-gray-600">No strategy changes are recommended right now.</p>'}
            <p class="text-sm text-gray-500">Your current strategy already looks well-aligned to this goal — no automatic changes are recommended.</p>`;
        footer?.classList.remove('hidden');
        if (accept) { accept.textContent = 'Edit Assistant Brief'; accept.onclick = () => { document.getElementById('modal-strategy-fix')?.classList.add('hidden'); window._editBriefFromReview(); }; }
        return;
    }

    // AC3.3 — Git-style side-by-side Current vs AI-Suggested diff for each changed field.
    const diffRows = changes.map(c => `
        <div class="border border-gray-200 rounded-xl overflow-hidden">
            <div class="px-3 py-2 bg-gray-50 border-b border-gray-200"><p class="text-xs font-bold text-gray-700">${_escapeHtml(c.label)}</p></div>
            <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                <div class="p-3 bg-red-50/40">
                    <p class="text-[10px] font-bold uppercase tracking-wide text-red-400 mb-1">− Current</p>
                    <p class="text-sm text-gray-600 whitespace-pre-wrap">${c.current ? _escapeHtml(c.current) : '<span class="italic text-gray-400">(empty)</span>'}</p>
                </div>
                <div class="p-3 bg-emerald-50/50">
                    <p class="text-[10px] font-bold uppercase tracking-wide text-emerald-600 mb-1">+ AI-Suggested</p>
                    <p class="text-sm text-gray-800 whitespace-pre-wrap">${_escapeHtml(c.suggested)}</p>
                </div>
            </div>
        </div>`).join('');

    if (body) body.innerHTML = `${diagnosis}
        <div class="space-y-3">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Suggested strategy changes</p>
            ${diffRows}
        </div>`;
    footer?.classList.remove('hidden');
    if (accept) { accept.textContent = 'Accept & Update Strategy'; accept.onclick = () => _applyStrategyFix(changes); }
}

// AC3.4 — apply every suggested field at once. Writes the Guardrails inputs and fires the input
// event so the detail page's debounced autosave persists the whole brief in one save.
function _applyStrategyFix(changes) {
    let applied = 0;
    changes.forEach(c => {
        const inputId = _STRATEGY_FIELD_INPUTS[c.field];
        const input = inputId && document.getElementById(inputId);
        if (input) {
            input.value = c.suggested;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            if (window.cachedContext) window.cachedContext[c.field] = c.suggested;
            applied++;
        }
    });
    const modal = document.getElementById('modal-strategy-fix');
    if (!applied) {
        // Detail inputs weren't on the page — fall back to opening the brief for manual editing.
        modal?.classList.add('hidden');
        window._editBriefFromReview();
        return;
    }
    // Confirm in-place, then close both the fix modal and Review Progress.
    const body = document.getElementById('strategy-fix-body');
    const footer = document.getElementById('strategy-fix-footer');
    if (body) body.innerHTML = `<div class="flex flex-col items-center justify-center py-10 text-center gap-2">
        <div class="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 text-2xl">✓</div>
        <p class="text-sm font-bold text-gray-800">Strategy updated</p>
        <p class="text-xs text-gray-500">${applied} field${applied === 1 ? '' : 's'} updated and saving automatically.</p>
    </div>`;
    footer?.classList.add('hidden');
    setTimeout(() => {
        modal?.classList.add('hidden');
        document.getElementById('modal-review-progress')?.classList.add('hidden');
    }, 1600);
}

// AC3.3.1 — toggle Autonomous Goal Seeking (premium-gated).
window._toggleAutonomousGoals = async function () {
    if (!_goalEntitlements.autonomous && !_autonomousGoalSeeking) {
        return _openUpgrade('Autonomous Goal Seeking is available on the Saver and Employee plans.');
    }
    const next = !_autonomousGoalSeeking;
    try {
        const res = await fetch(GOALS_API, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: _goalsAssistantId, autonomousGoalSeeking: next }),
        });
        if (res.ok) { _autonomousGoalSeeking = next; _applyGoalEntitlementsUi(); }
        else if (res.status === 402) _openUpgrade('Autonomous Goal Seeking requires a higher plan.');
    } catch { /* no-op */ }
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