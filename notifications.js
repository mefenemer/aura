// notifications.js
window.initNotifications = async function() {

    const listEl = document.getElementById('notif-list');
    const loadingEl = document.getElementById('notif-loading');
    const emptyStateEl = document.getElementById('notif-empty-state');
    const searchInput = document.getElementById('notif-search');
    const filterSelect = document.getElementById('notif-filter');
    const markAllBtn = document.getElementById('btn-mark-all-read');

    // Safety check for SPA injection
    if (!listEl) return;

    let notificationsData = [];

    // --- ICON MAPPING (Scenario 5 Fallbacks) ---
    const getIconForType = (type) => {
        const icons = {
            assistant_task: `<svg class="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>`,
            payment_confirmation: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
            account_update: `<svg class="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37..."></path></svg>`
        };
        // Generic bell fallback for unknown types
        return icons[type] || `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>`;
    };

    // --- FETCH NOTIFICATIONS ---
    const loadData = async () => {
        try {
            const response = await fetch('/.netlify/functions/notifications');
            if (response.ok) {
                const data = await response.json();
                notificationsData = data.notifications || [];
                renderList();
            }
        } catch (error) {
            console.error('Failed to load notifications:', error);
            if(loadingEl) loadingEl.textContent = "Failed to load notifications. Please try again.";
        }
    };

    // --- RENDER & FILTER ENGINE ---
    const renderList = () => {
        const searchTerm = searchInput.value.toLowerCase();
        const filterVal = filterSelect.value;

        // Apply filters
        const filtered = notificationsData.filter(n => {
            const matchesSearch = n.title.toLowerCase().includes(searchTerm) || (n.message && n.message.toLowerCase().includes(searchTerm));
            const matchesType = filterVal === 'all' ||
                (filterVal === 'unread' && !n.isRead) ||
                n.type === filterVal;
            return matchesSearch && matchesType;
        });

        // Toggle Empty State
        listEl.innerHTML = '';
        if (filtered.length === 0) {
            emptyStateEl.classList.remove('hidden');
            if (markAllBtn) markAllBtn.classList.add('hidden');
            return;
        } else {
            emptyStateEl.classList.add('hidden');

            // Only show 'Mark all as read' if there are actually unread notifications
            const hasUnread = notificationsData.some(n => !n.isRead);
            if (markAllBtn) hasUnread ? markAllBtn.classList.remove('hidden') : markAllBtn.classList.add('hidden');
        }

        // Build UI
        filtered.forEach(notif => {
            const dateStr = new Date(notif.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            const li = document.createElement('li');
            // Unread vs Read visual styling
            const bgClass = notif.isRead ? 'bg-white hover:bg-gray-50' : 'bg-emerald-50/30 hover:bg-emerald-50/50';
            const textClass = notif.isRead ? 'text-gray-600 font-normal' : 'text-gray-900 font-bold';
            const dotIndicator = notif.isRead ? '' : `<div class="w-2.5 h-2.5 rounded-full bg-emerald-600 shrink-0 mt-1.5"></div>`;

            li.className = `p-5 transition-colors cursor-pointer flex gap-4 ${bgClass}`;
            li.innerHTML = `
                ${dotIndicator}
                <div class="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0 border border-gray-200 shadow-sm">
                    ${getIconForType(notif.type)}
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm ${textClass}">${notif.title}</p>
                    ${notif.message ? `<p class="text-sm text-gray-500 mt-1 line-clamp-2">${notif.message}</p>` : ''}
                    <p class="text-xs text-gray-400 mt-2">${dateStr}</p>
                </div>
            `;

            // Click to mark as read (Scenario 2: Optimistic UI)
            li.addEventListener('click', () => markAsRead(notif.id));
            listEl.appendChild(li);
        });
    };

    // --- ACTIONS ---
    const markAsRead = async (id) => {
        const notif = notificationsData.find(n => n.id === id);
        if (!notif || notif.isRead) return;

        // 1. Optimistic Update Local State
        notif.isRead = true;
        renderList();

        // 2. Background Sync
        fetch('/.netlify/functions/notifications', {
            method: 'PATCH',
            body: JSON.stringify({ notificationId: id })
        }).catch(err => console.error("Sync failed:", err)); // Fails silently to user
    };

    if (markAllBtn) {
        markAllBtn.addEventListener('click', () => {
            // 1. Optimistic Update Local State
            notificationsData.forEach(n => n.isRead = true);
            renderList();

            // 2. Background Bulk Sync (Scenario 4)
            fetch('/.netlify/functions/notifications', { method: 'PUT' })
                .catch(err => console.error("Bulk sync failed:", err));
        });
    }

    // --- EVENT LISTENERS ---
    searchInput.addEventListener('input', renderList);
    filterSelect.addEventListener('change', renderList);

    // Init
    loadData();
};