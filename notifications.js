// notifications.js

// --- GLOBAL NOTIFICATION BADGE CONTROLLER ---
window.updateNotificationBadge = async function() {
    try {
        const res = await fetch('/.netlify/functions/notifications?action=count');
        if (res.ok) {
            const data = await res.json();
            const badge = document.getElementById('sidebar-nav-badge');
            if (badge) {
                // Badge reflects open ACTION items ("things you must deal with"), not
                // every unread update. Falls back to unreadCount for older responses.
                const count = (typeof data.actionCount === 'number') ? data.actionCount : (data.unreadCount || 0);
                if (count > 0) {
                    badge.textContent = count;
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
            invoice_ready: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
            welcome: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>`,
            onboarding_prompt: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>`,
            setup_complete: `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
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
    const go = (view) => () => window.loadView?.(view);

    // type → primary call-to-action. Action-kind types should all resolve to a CTA so
    // every action card has one clear next step; info types are mostly passive.
    const ACTIONS_BY_TYPE = {
        invoice_ready:                 { label: 'View invoice',        run: routeToBilling },
        ticket_created:                { label: 'View ticket',         run: () => window.routeToSupportTicket?.() },
        ticket_reply:                  { label: 'View ticket',         run: () => window.routeToSupportTicket?.() },
        onboarding_prompt:             { label: 'View setup checklist', run: go('getting-started') },
        onboarding_incomplete:         { label: 'View setup checklist', run: go('getting-started') },
        welcome:                       { label: 'Get started',         run: go('getting-started') },
        setup_complete:                { label: 'Go to dashboard',     run: go('dashboard') },
        // Approvals — folds the review queue into the action surface.
        hitl_approval_required:        { label: 'Review post',         run: go('review-queue') },
        review_red_urgency:            { label: 'Review post',         run: go('review-queue') },
        // Billing / plan actions.
        billing_payment_failed:        { label: 'Update payment',      run: routeToBilling },
        missing_stripe_sub:            { label: 'Go to billing',       run: routeToBilling },
        stripe_cancelled_but_db_active:{ label: 'Go to billing',       run: routeToBilling },
        tier_mismatch:                 { label: 'Go to billing',       run: routeToBilling },
        subscription_paused:           { label: 'Go to billing',       run: routeToBilling },
        assistants_paused_downgrade:   { label: 'Go to billing',       run: routeToBilling },
        trial_expiring_soon:           { label: 'Upgrade plan',        run: routeToBilling },
        trial_expired:                 { label: 'Upgrade plan',        run: routeToBilling },
        task_limit_warning:            { label: 'Upgrade plan',        run: routeToBilling },
        task_limit_reached:            { label: 'Upgrade plan',        run: routeToBilling },
        run_cost_warning:              { label: 'Review usage',        run: routeToBilling },
        run_budget_suspended:          { label: 'Review usage',        run: routeToBilling },
        // Connection actions.
        social_oauth_revoked:          { label: 'Reconnect',           run: go('integrations') },
        instagram_token_refresh_failed:{ label: 'Reconnect',           run: go('integrations') },
        integration_alert:             { label: 'Reconnect',           run: go('integrations') },
        // Content actions.
        post_publish_failed:           { label: 'View content',        run: go('my-content') },
        post_missed:                   { label: 'View content',        run: go('my-content') },
        post_generation_failed:        { label: 'View content',        run: go('my-content') },
    };

    const getNotificationAction = (notif) => {
        const meta = notif.metadata || {};
        if (meta.action === 'view_invoices') return ACTIONS_BY_TYPE.invoice_ready;
        if (meta.action === 'view_ticket')   return ACTIONS_BY_TYPE.ticket_created;
        if (meta.action === 'getting_started') return ACTIONS_BY_TYPE.onboarding_prompt;
        if (ACTIONS_BY_TYPE[notif.type]) return ACTIONS_BY_TYPE[notif.type];
        // Any remaining action-kind item still needs a way in — default to the dashboard.
        if (notif.kind === 'action') return { label: 'Review', run: go('dashboard') };
        return null;
    };

    // Urgent action types get a red accent (vs the default emerald) so the most
    // pressing items read as pressing.
    const URGENT_TYPES = new Set([
        'billing_payment_failed', 'trial_expired', 'run_budget_suspended',
        'post_publish_failed', 'post_missed', 'post_generation_failed',
        'security', 'agent_anomaly', 'social_oauth_revoked', 'instagram_token_refresh_failed',
        'task_limit_reached', 'subscription_paused', 'assistants_paused_downgrade',
    ]);

    // Client fallback if the server response predates kind annotation.
    const ACTION_TYPES_FALLBACK = new Set([
        'onboarding_prompt', 'onboarding_incomplete', 'hitl_approval_required', 'review_red_urgency',
        'billing_payment_failed', 'missing_stripe_sub', 'stripe_cancelled_but_db_active', 'tier_mismatch',
        'subscription_paused', 'assistants_paused_downgrade', 'social_oauth_revoked',
        'instagram_token_refresh_failed', 'integration_alert', 'post_publish_failed', 'post_missed',
        'post_generation_failed', 'trial_expiring_soon', 'trial_expired', 'task_limit_reached',
        'task_limit_warning', 'run_budget_suspended', 'run_cost_warning', 'security', 'agent_anomaly',
        'risk_assessment_submitted',
    ]);
    const kindOf = (n) => n.kind || (ACTION_TYPES_FALLBACK.has(n.type) ? 'action' : 'info');

    const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let activeTab = 'action';

    const tabActionBtn = document.getElementById('tab-action');
    const tabUpdatesBtn = document.getElementById('tab-updates');
    const tabActionCount = document.getElementById('tab-action-count');

    const setTabStyles = () => {
        const active = 'flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800';
        const inactive = 'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-transparent text-gray-500 hover:text-gray-700';
        if (tabActionBtn) tabActionBtn.className = activeTab === 'action' ? active : inactive;
        if (tabUpdatesBtn) tabUpdatesBtn.className = activeTab === 'updates' ? active : inactive;
    };

    const loadData = async () => {
        try {
            const response = await fetch('/.netlify/functions/notifications');
            if (response.ok) {
                const data = await response.json();
                notificationsData = data.notifications || [];
                // Open the tab that has something waiting: actions first, else updates.
                activeTab = notificationsData.some(n => kindOf(n) === 'action' && !n.isRead) ? 'action' : 'updates';
                renderList();
            }
        } catch (error) {
            console.error('Failed to load notifications:', error);
            if (loadingEl) loadingEl.textContent = "Failed to load notifications. Please try again.";
        }
    };

    // ACTION card: a bounded card with one clear CTA. Cleared by acting, not reading.
    const renderActionItem = (notif) => {
        const action = getNotificationAction(notif) || { label: 'Review', run: () => window.loadView?.('dashboard') };
        const urgent = URGENT_TYPES.has(notif.type);
        const handled = notif.isRead; // an action the user has already acted on
        const li = document.createElement('li');
        li.className = `flex items-center gap-3 p-4 ${handled ? 'opacity-60' : ''}`;
        li.innerHTML = `
            <div class="w-10 h-10 rounded-full ${urgent ? 'bg-red-50 text-red-600 border-red-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'} border flex items-center justify-center shrink-0">
                ${getIconForType(notif.type)}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <p class="text-sm font-bold text-gray-900">${notif.title}</p>
                    ${urgent && !handled ? '<span class="text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">Urgent</span>' : ''}
                    ${handled ? '<span class="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">Done</span>' : ''}
                </div>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-0.5 line-clamp-2">${notif.message}</p>` : ''}
                <p class="text-xs text-gray-400 mt-1">${fmtDate(notif.createdAt)}</p>
            </div>
            <button type="button" class="action-cta px-4 py-2 ${urgent ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'} text-white text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap">${action.label}</button>
        `;
        li.querySelector('.action-cta').addEventListener('click', (e) => {
            e.stopPropagation();
            setRead(notif.id, true);
            action.run();
        });
        return li;
    };

    // UPDATE row: informational, read/unread. Some info items still carry a useful link
    // (e.g. invoice_ready → "View invoice", ticket_reply → "View ticket") — those keep a
    // visible CTA even though they live in Updates. Read state is toggled with an explicit
    // button so it's obvious (no more "click the row and hope").
    const renderUpdateItem = (notif) => {
        const li = document.createElement('li');
        const action = getNotificationAction(notif); // null for purely passive updates
        const bgClass = notif.isRead ? 'bg-white hover:bg-gray-50' : 'bg-emerald-50/30 hover:bg-emerald-50/50';
        const textClass = notif.isRead ? 'text-gray-600 font-normal' : 'text-gray-900 font-bold';
        const dot = notif.isRead ? '' : `<div class="w-2.5 h-2.5 rounded-full bg-emerald-600 shrink-0 mt-1.5"></div>`;
        li.className = `group p-5 transition-colors flex gap-4 ${bgClass}`;
        li.innerHTML = `
            ${dot}
            <div class="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0 border border-gray-200">
                ${getIconForType(notif.type)}
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-sm ${textClass}">${notif.title}</p>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-1 line-clamp-2">${notif.message}</p>` : ''}
                <p class="text-xs text-gray-400 mt-2">${fmtDate(notif.createdAt)}</p>
                ${action ? `<button type="button" class="update-cta mt-2 inline-flex items-center gap-1 text-sm font-bold text-emerald-700 hover:text-emerald-800">${action.label}<span aria-hidden="true">&rarr;</span></button>` : ''}
            </div>
            <button type="button" class="update-toggle-read shrink-0 self-start text-xs font-semibold px-2.5 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 whitespace-nowrap">
                ${notif.isRead ? 'Mark as unread' : 'Mark as read'}
            </button>
        `;
        // Actionable updates (invoice, ticket) keep their link — navigate, and mark read since acting implies seen.
        li.querySelector('.update-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            setRead(notif.id, true);
            action.run();
        });
        // Explicit read/unread toggle.
        li.querySelector('.update-toggle-read').addEventListener('click', (e) => {
            e.stopPropagation();
            setRead(notif.id, !notif.isRead);
        });
        return li;
    };

    const renderList = () => {
        const searchTerm = (searchInput?.value || '').toLowerCase();
        const matchesSearch = (n) => n.title.toLowerCase().includes(searchTerm) || (n.message && n.message.toLowerCase().includes(searchTerm));

        const actions = notificationsData.filter(n => kindOf(n) === 'action');
        const updates = notificationsData.filter(n => kindOf(n) === 'info');
        const openActions = actions.filter(n => !n.isRead).length;

        if (tabActionCount) {
            tabActionCount.textContent = openActions;
            tabActionCount.classList.toggle('hidden', openActions === 0);
        }
        setTabStyles();

        // Mark-all-read only applies to the Updates tab.
        if (markAllBtn) {
            const showMarkAll = activeTab === 'updates' && updates.some(n => !n.isRead);
            markAllBtn.classList.toggle('hidden', !showMarkAll);
        }

        let list = (activeTab === 'action' ? actions : updates).filter(matchesSearch);
        // Open actions float to the top of the action tab.
        if (activeTab === 'action') list = list.slice().sort((a, b) => (a.isRead ? 1 : 0) - (b.isRead ? 1 : 0));

        listEl.innerHTML = '';
        if (list.length === 0) {
            if (emptyStateEl) {
                emptyStateEl.classList.remove('hidden');
                const title = emptyStateEl.querySelector('[data-empty-title]');
                const sub = emptyStateEl.querySelector('[data-empty-sub]');
                if (title) title.textContent = activeTab === 'action' ? "You're all caught up" : 'No updates';
                if (sub) sub.textContent = activeTab === 'action' ? 'Nothing needs your attention right now.' : "We'll let you know when something happens.";
            }
            return;
        }
        if (emptyStateEl) emptyStateEl.classList.add('hidden');

        list.forEach(notif => listEl.appendChild(
            activeTab === 'action' ? renderActionItem(notif) : renderUpdateItem(notif)));
    };

    const setRead = async (id, isRead) => {
        const notif = notificationsData.find(n => n.id === id);
        if (!notif || notif.isRead === isRead) return;

        notif.isRead = isRead;
        renderList();

        fetch('/.netlify/functions/notifications', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notificationId: id, isRead })
        }).then(() => {
            if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge();
        }).catch(err => console.error("Sync failed:", err));
    };

    if (markAllBtn) {
        markAllBtn.addEventListener('click', () => {
            // Only clears informational updates; action items are cleared by acting.
            notificationsData.filter(n => kindOf(n) === 'info').forEach(n => n.isRead = true);
            renderList();
            fetch('/.netlify/functions/notifications', { method: 'PUT' })
                .then(() => { if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge(); })
                .catch(err => console.error("Bulk sync failed:", err));
        });
    }

    if (tabActionBtn) tabActionBtn.addEventListener('click', () => { activeTab = 'action'; renderList(); });
    if (tabUpdatesBtn) tabUpdatesBtn.addEventListener('click', () => { activeTab = 'updates'; renderList(); });
    if (searchInput) searchInput.addEventListener('input', renderList);

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