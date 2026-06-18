// notifications.js

// --- GLOBAL NOTIFICATION BADGE CONTROLLER ---
window.updateNotificationBadge = async function() {
    try {
        const res = await fetch('/.netlify/functions/notifications?action=count');
        if (res.ok) {
            const data = await res.json();
            const badge = document.getElementById('sidebar-nav-badge');
            if (badge) {
                if (data.unreadCount > 0) {
                    badge.textContent = data.unreadCount;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        }
    } catch (e) {
        console.error("Failed to fetch notification badge count", e);
    }
};

window.initNotifications = async function() {
    const listEl = document.getElementById('notif-list');
    const loadingEl = document.getElementById('notif-loading');
    const emptyStateEl = document.getElementById('notif-empty-state');
    const searchInput = document.getElementById('notif-search');
    const filterSelect = document.getElementById('notif-filter');
    const markAllBtn = document.getElementById('btn-mark-all-read');

    if (!listEl) return;

    // Clear badge logic when entering the notifications page
    if (typeof window.updateNotificationBadge === 'function') {
        window.updateNotificationBadge();
    }

    let notificationsData = [];

    const getIconForType = (type) => {
        const icons = {
            assistant_task: `<svg class="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>`,
            payment_confirmation: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
            account_update: `<svg class="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37..."></path></svg>`,
            ticket_created: `<svg class="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>`,
            invoice_ready: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`
        };
        return icons[type] || `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>`;
    };

    // Navigate to Invoice History inside the workspace shell (billing is a VIEW fragment).
    // Falls back to a deep-link if loadView isn't available (e.g. viewed outside the workspace).
    const routeToBilling = () => {
        if (typeof window.loadView === 'function') {
            Promise.resolve(window.loadView('billing')).then(() => {
                document.getElementById('invoice-history-section')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        } else {
            window.location.href = 'workspace.html?view=billing';
        }
    };

    // Resolve a notification's "click for more information" destination, if any.
    // Returns { label, run } for actionable notifications, or null for passive ones.
    // The label drives the visible affordance so users can tell which rows go somewhere.
    const getNotificationAction = (notif) => {
        const meta = notif.metadata || {};
        if (notif.type === 'invoice_ready' || meta.action === 'view_invoices') {
            return { label: 'View invoice', run: routeToBilling };
        }
        if (notif.type === 'ticket_created' || meta.action === 'view_ticket') {
            return { label: 'View ticket', run: () => window.routeToSupportTicket?.() };
        }
        return null;
    };

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

    const renderList = () => {
        const searchTerm = searchInput.value.toLowerCase();
        const filterVal = filterSelect.value;

        const filtered = notificationsData.filter(n => {
            const matchesSearch = n.title.toLowerCase().includes(searchTerm) || (n.message && n.message.toLowerCase().includes(searchTerm));
            const matchesType = filterVal === 'all' || (filterVal === 'unread' && !n.isRead) || n.type === filterVal;
            return matchesSearch && matchesType;
        });

        listEl.innerHTML = '';
        if (filtered.length === 0) {
            emptyStateEl.classList.remove('hidden');
            if (markAllBtn) markAllBtn.classList.add('hidden');
            return;
        } else {
            emptyStateEl.classList.add('hidden');
            const hasUnread = notificationsData.some(n => !n.isRead);
            if (markAllBtn) hasUnread ? markAllBtn.classList.remove('hidden') : markAllBtn.classList.add('hidden');
        }

        filtered.forEach(notif => {
            const dateStr = new Date(notif.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const action = getNotificationAction(notif);
            const li = document.createElement('li');
            const bgClass = notif.isRead ? 'bg-white hover:bg-gray-50' : 'bg-emerald-50/30 hover:bg-emerald-50/50';
            const textClass = notif.isRead ? 'text-gray-600 font-normal' : 'text-gray-900 font-bold';
            const dotIndicator = notif.isRead ? '' : `<div class="w-2.5 h-2.5 rounded-full bg-emerald-600 shrink-0 mt-1.5"></div>`;

            // Actionable notifications get a labelled call-to-action plus a trailing
            // chevron so it's obvious they lead somewhere; passive ones get neither.
            const ctaHtml = action
                ? `<p class="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 mt-2">
                       ${action.label}
                       <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"></path></svg>
                   </p>`
                : '';
            const chevronHtml = action
                ? `<div class="flex items-center shrink-0">
                       <svg class="w-5 h-5 text-gray-300 group-hover:text-emerald-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                   </div>`
                : '';

            li.className = `group p-5 transition-colors ${action ? 'cursor-pointer' : 'cursor-default'} flex gap-4 ${bgClass}`;
            li.innerHTML = `
                ${dotIndicator}
                <div class="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0 border border-gray-200 shadow-sm">
                    ${getIconForType(notif.type)}
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm ${textClass}">${notif.title}</p>
                    ${notif.message ? `<p class="text-sm text-gray-500 mt-1 line-clamp-2">${notif.message}</p>` : ''}
                    <p class="text-xs text-gray-400 mt-2">${dateStr}</p>
                    ${ctaHtml}
                </div>
                ${chevronHtml}
            `;

            li.addEventListener('click', () => {
                markAsRead(notif.id);
                if (action) action.run();
            });
            listEl.appendChild(li);
        });
    };

    const markAsRead = async (id) => {
        const notif = notificationsData.find(n => n.id === id);
        if (!notif || notif.isRead) return;

        notif.isRead = true;
        renderList();

        fetch('/.netlify/functions/notifications', {
            method: 'PATCH',
            body: JSON.stringify({ notificationId: id })
        }).then(() => {
            if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge();
        }).catch(err => console.error("Sync failed:", err));
    };

    if (markAllBtn) {
        markAllBtn.addEventListener('click', () => {
            notificationsData.forEach(n => n.isRead = true);
            renderList();
            fetch('/.netlify/functions/notifications', { method: 'PUT' })
                .then(() => { if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge(); })
                .catch(err => console.error("Bulk sync failed:", err));
        });
    }

    searchInput.addEventListener('input', renderList);
    filterSelect.addEventListener('change', renderList);

    loadData();
};

// Global click handler for routing to the Support area
window.routeToSupportTicket = function() {
    loadView('help');
    setTimeout(() => {
        const ticketTab = document.getElementById('tab-btn-tickets');
        if (ticketTab) ticketTab.click();
    }, 100);
};