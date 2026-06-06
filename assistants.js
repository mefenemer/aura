// assistants.js

// Mock Data for UI Demonstration
const mockAssistants = [
    { id: 'ast_1', name: 'Marketing Mike', role: 'SEO Content Writer', status: 'live', icon: 'M' },
    { id: 'ast_2', name: 'Support Sarah', role: 'Customer Service Tier 1', status: 'paused', icon: 'S' },
    { id: 'ast_3', name: 'Data Dan', role: 'Analytics Researcher', status: 'live', icon: 'D' }
];

window.initAssistantsDirectory = async function(loadViewCallback) {
    const grid = document.getElementById('assistants-grid');
    const catalogBtn = document.getElementById('route-to-catalog-from-dir');
    if (!grid) return;

    if (catalogBtn) {
        catalogBtn.addEventListener('click', () => loadViewCallback('catalog'));
    }

    try {
        // In the future, replace this with: await fetch('/.netlify/functions/get-assistants')
        const data = await new Promise(resolve => setTimeout(() => resolve(mockAssistants), 400));

        if (data.length === 0) {
            grid.innerHTML = `<div class="col-span-full py-12 text-center text-gray-500 font-medium bg-white rounded-2xl border border-gray-100 shadow-sm">You haven't provisioned any assistants yet.</div>`;
            return;
        }

        grid.innerHTML = data.map(ast => `
            <div class="bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow p-6 flex flex-col cursor-pointer group" onclick="window.routeToAssistantDetail('${ast.id}')">
                <div class="flex justify-between items-start mb-4">
                    <div class="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-lg shadow-sm">
                        ${ast.icon}
                    </div>
                    ${ast.status === 'live'
            ? `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Live</span>`
            : `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200"><span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span> Paused</span>`
        }
                </div>
                <h3 class="text-lg font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">${ast.name}</h3>
                <p class="text-sm text-gray-500 mb-6">${ast.role}</p>
                <div class="mt-auto pt-4 border-t border-gray-50 flex justify-end">
                    <span class="text-sm font-bold text-gray-900 group-hover:text-emerald-700">Manage &rarr;</span>
                </div>
            </div>
        `).join('');

    } catch (error) {
        grid.innerHTML = `<div class="col-span-full text-center text-red-500">Failed to load assistants.</div>`;
    }
};

window.initAssistantDetail = async function(assistantId, loadViewCallback) {
    const btnBack = document.getElementById('btn-back-assistants');
    if (!btnBack) return;

    // --- BREADCRUMB ROUTING ---
    btnBack.addEventListener('click', () => loadViewCallback('assistants'));

    // --- FETCH DATA ---
    // Mock fetch single assistant
    const ast = mockAssistants.find(a => a.id === assistantId);
    if (!ast) {
        document.getElementById('detail-name').textContent = "Assistant Not Found";
        return;
    }

    // --- HYDRATE HEADER ---
    document.getElementById('detail-name').textContent = ast.name;
    document.getElementById('detail-role').textContent = `Role: ${ast.role}`;
    document.getElementById('detail-avatar').textContent = ast.icon;

    const statusEl = document.getElementById('detail-status');
    const toggleBtn = document.getElementById('btn-toggle-status');

    if (ast.status === 'live') {
        statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Live`;
        statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
        toggleBtn.textContent = 'Pause Assistant';
    } else {
        statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span> Paused`;
        statusEl.className = 'inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200';
        toggleBtn.textContent = 'Activate Assistant';
    }

    // --- TABBED INTERFACE LOGIC ---
    const tabs = ['settings', 'integrations', 'logs'];
    tabs.forEach(tab => {
        const btn = document.getElementById(`tab-btn-${tab}`);
        const content = document.getElementById(`tab-content-${tab}`);

        btn.addEventListener('click', () => {
            // Reset all
            tabs.forEach(t => {
                document.getElementById(`tab-content-${t}`).classList.add('hidden');
                document.getElementById(`tab-content-${t}`).classList.remove('block');
                const tBtn = document.getElementById(`tab-btn-${t}`);
                tBtn.className = 'tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300';
            });
            // Activate selected
            content.classList.remove('hidden');
            content.classList.add('block');
            btn.className = 'tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-bold text-sm border-emerald-500 text-emerald-600';
        });
    });

    // --- ACTIONS LOGIC ---
    document.getElementById('btn-delete-assistant').addEventListener('click', () => {
        if(confirm(`Are you sure you want to permanently delete ${ast.name}? This cannot be undone.`)) {
            // Delete logic here
            alert("Deleted (Mock). Returning to directory.");
            loadViewCallback('assistants');
        }
    });
};