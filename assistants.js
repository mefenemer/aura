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
        <p class="text-sm text-gray-500 mb-6">Job: ${role}</p>
        <div class="mt-auto pt-4 border-t border-gray-50 flex justify-end">
            <span class="text-sm font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">Control Room &rarr;</span>
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
window.initAssistantDetail = async function(assistantId, loadViewCb) {
    if (!assistantId) return;
    window.activeAssistantId = assistantId;

    // Pass the ID so the detail HTML's inline script can load the right assistant.
    // The new assistant-detail.html manages its own tabs, hydration, and saving.
    window._detailAssistantId = assistantId;

    // Back button — re-wire after SPA HTML inject to avoid duplicate listeners
    const btnBack = document.getElementById('btn-back-assistants');
    if (btnBack) {
        const newBtn = btnBack.cloneNode(true);
        btnBack.parentNode.replaceChild(newBtn, btnBack);
        newBtn.addEventListener('click', () => loadViewCb('assistants'));
    }

    // Trigger the detail page's own load function if it has already registered
    if (typeof window.loadAssistantDetail === 'function') {
        await window.loadAssistantDetail(assistantId);
    }
};

// ==========================================
// 5. HYDRATION ENGINE
// ==========================================
window.hydrateAssistantContext = async function() {
    try {
        const response = await fetch(`/.netlify/functions/get-assistant-context?id=${window.activeAssistantId}`);
        if (response.ok) {
            const data = await response.json();
            window.cachedContext = data.context || {};

            // Update Headers
            const nameEl = document.getElementById('detail-name');
            if (nameEl) nameEl.innerText = data.name || 'Assistant';

            const roleEl = document.getElementById('detail-role');
            if (roleEl) roleEl.innerText = `Job: ${data.role || 'Digital Assistant'}`;

            const avatarEl = document.getElementById('detail-avatar');
            if (avatarEl) avatarEl.innerText = data.name ? data.name.charAt(0).toUpperCase() : 'A';

            // Update Status Badge
            const statusBadge = document.getElementById('detail-status');
            const toggleBtn = document.getElementById('btn-toggle-status');
            if (statusBadge) {
                if (data.status === 'pending') {
                    statusBadge.className = "inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200";
                    statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> Provisioning';
                    if(toggleBtn) toggleBtn.textContent = 'Pause Assistant';
                } else if (data.status === 'failed') {
                    statusBadge.className = "inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-red-50 text-red-700 border border-red-200";
                    statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span> Failed';
                    if(toggleBtn) toggleBtn.textContent = 'Retry Provisioning';
                } else {
                    statusBadge.className = "inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200";
                    statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Active';
                    if(toggleBtn) toggleBtn.textContent = 'Pause Assistant';
                }
            }

            // Fill Context Inputs
            if(document.getElementById('edit_audience')) document.getElementById('edit_audience').value = window.cachedContext.target_audience || '';
            if(document.getElementById('edit_tone')) document.getElementById('edit_tone').value = window.cachedContext.tone_of_voice || '';
            if(document.getElementById('edit_pillars')) document.getElementById('edit_pillars').value = window.cachedContext.content_pillars || '';
            if(document.getElementById('edit_frequency')) document.getElementById('edit_frequency').value = window.cachedContext.posting_frequency || 'On Demand';

            if (window.cachedContext.primary_platforms) {
                document.querySelectorAll('.platform-chk').forEach(chk => {
                    chk.checked = window.cachedContext.primary_platforms.includes(chk.value);
                });
            }
        }
    } catch (e) {
        console.error("Hydration Error:", e);
    }

    // After loading the main context, fetch the integrations assigned to this assistant
    await window.fetchAndRenderIntegrations();
};

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