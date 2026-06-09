// calendar.js — Interactive Content Calendar & Post Governance

// ── Config ────────────────────────────────────────────────────────
const PLATFORM_META = {
    facebook:  { label: 'Facebook',   emoji: '📘', bg: 'bg-blue-600',   text: 'text-white' },
    instagram: { label: 'Instagram',  emoji: '📸', bg: 'bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400', text: 'text-white' },
    linkedin:  { label: 'LinkedIn',   emoji: '💼', bg: 'bg-blue-700',   text: 'text-white' },
    x:         { label: 'X (Twitter)', emoji: '✕', bg: 'bg-gray-950',   text: 'text-white' },
};

const STATUS_META = {
    draft:      { label: 'Draft',       badge: 'bg-gray-100 text-gray-600 border-gray-300',   chipBorder: 'border-gray-400',    dot: 'bg-gray-400' },
    in_review:  { label: 'In Review',   badge: 'bg-amber-100 text-amber-700 border-amber-300', chipBorder: 'border-amber-400',   dot: 'bg-amber-400' },
    approved:   { label: 'Approved',    badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    scheduled:  { label: 'Scheduled',   badge: 'bg-yellow-100 text-yellow-700 border-yellow-300', chipBorder: 'border-yellow-500', dot: 'bg-yellow-500' },
    published:  { label: 'Published',   badge: 'bg-emerald-100 text-emerald-700 border-emerald-300', chipBorder: 'border-emerald-500', dot: 'bg-emerald-500' },
    rejected:   { label: 'Rejected',    badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    cancelled:  { label: 'Cancelled',   badge: 'bg-gray-100 text-gray-400 border-gray-200',   chipBorder: 'border-gray-300',    dot: 'bg-gray-300' },
};

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── State ─────────────────────────────────────────────────────────
let _view = 'month';             // 'month' | 'week' | 'list'
let _anchor = new Date();        // date anchor for current view
_anchor.setHours(0, 0, 0, 0);
let _posts = [];                 // all loaded posts
let _openPostId = null;          // currently open panel post id
let _editMode = false;           // panel edit mode
let _dragPostId = null;          // drag source
let _dragTargetDate = null;      // drop target
let _pendingReschedule = null;   // { postId, newDate }

// ── Init ──────────────────────────────────────────────────────────
window.initCalendar = async function () {
    document.getElementById('cal-btn-prev')?.addEventListener('click', _navPrev);
    document.getElementById('cal-btn-next')?.addEventListener('click', _navNext);
    document.getElementById('cal-btn-today')?.addEventListener('click', _navToday);
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        btn.addEventListener('click', () => _setView(btn.dataset.view));
    });
    await _loadAndRender();
};

// ── Navigation ────────────────────────────────────────────────────
function _navPrev() {
    if (_view === 'month') _anchor.setMonth(_anchor.getMonth() - 1);
    else if (_view === 'week') _anchor.setDate(_anchor.getDate() - 7);
    else _anchor.setMonth(_anchor.getMonth() - 1);
    _render();
}
function _navNext() {
    if (_view === 'month') _anchor.setMonth(_anchor.getMonth() + 1);
    else if (_view === 'week') _anchor.setDate(_anchor.getDate() + 7);
    else _anchor.setMonth(_anchor.getMonth() + 1);
    _render();
}
function _navToday() {
    _anchor = new Date(); _anchor.setHours(0,0,0,0);
    _render();
}
function _setView(v) {
    _view = v;
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        const active = btn.dataset.view === v;
        btn.className = `cal-view-btn px-3 py-1.5 text-sm font-bold rounded-lg transition cursor-pointer ${active ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`;
    });
    _render();
}

// ── Load posts from API ───────────────────────────────────────────
async function _loadAndRender() {
    try {
        const { from, to } = _getDateRange();
        const res = await fetch(`/.netlify/functions/scheduled-posts?from=${from.toISOString()}&to=${to.toISOString()}`);
        if (res.ok) {
            const data = await res.json();
            _posts = data.posts || [];
        }
    } catch (e) { console.warn('Calendar load error:', e); }
    _render();
}

function _getDateRange() {
    if (_view === 'week') {
        const weekStart = _weekStart(_anchor);
        const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6); weekEnd.setHours(23,59,59,999);
        return { from: weekStart, to: weekEnd };
    }
    // Month and list: whole month
    const from = new Date(_anchor.getFullYear(), _anchor.getMonth(), 1);
    const to   = new Date(_anchor.getFullYear(), _anchor.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from, to };
}

// ── Master render ─────────────────────────────────────────────────
function _render() {
    // Update title
    const titleEl = document.getElementById('cal-title');
    if (titleEl) {
        if (_view === 'month' || _view === 'list') {
            titleEl.textContent = `${MONTH_NAMES[_anchor.getMonth()]} ${_anchor.getFullYear()}`;
        } else {
            const ws = _weekStart(_anchor);
            const we = new Date(ws); we.setDate(we.getDate() + 6);
            titleEl.textContent = `${ws.getDate()} ${MONTH_NAMES[ws.getMonth()]} – ${we.getDate()} ${MONTH_NAMES[we.getMonth()]} ${we.getFullYear()}`;
        }
    }

    const main = document.getElementById('cal-main');
    if (!main) return;

    if (_view === 'month') main.innerHTML = _renderMonth();
    else if (_view === 'week') main.innerHTML = _renderWeek();
    else main.innerHTML = _renderList();

    _attachDragDrop();
}

// ── Month View ────────────────────────────────────────────────────
function _renderMonth() {
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    // Day headers
    let html = `<div class="sticky top-0 z-10 grid grid-cols-7 bg-white border-b border-gray-200">`;
    DAY_NAMES_SHORT.forEach(d => {
        html += `<div class="py-2 text-center text-xs font-bold text-gray-400 uppercase tracking-wide">${d}</div>`;
    });
    html += `</div><div class="grid grid-cols-7 auto-rows-[minmax(100px,auto)] border-l border-gray-200">`;

    // Blank cells before month start
    for (let i = 0; i < firstDay; i++) {
        html += `<div class="border-r border-b border-gray-100 bg-gray-50/50"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateKey = _dateKey(date);
        const isToday = _dateKey(today) === dateKey;
        const dayPosts = _postsOnDate(date);

        const tdClass = `relative border-r border-b border-gray-100 ${isToday ? 'bg-emerald-50/40' : 'bg-white hover:bg-gray-50/60'} transition p-1.5`;

        html += `<div class="${tdClass}" data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">`;
        html += `<div class="flex items-center justify-end mb-1">
            <span class="${isToday ? 'w-6 h-6 bg-emerald-600 text-white rounded-full flex items-center justify-center text-xs font-extrabold' : 'text-xs font-bold text-gray-500 px-1'}">${day}</span>
        </div>`;
        html += `<div class="space-y-1">${dayPosts.map(p => _postChip(p, 'month')).join('')}</div>`;
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

// ── Week View ─────────────────────────────────────────────────────
function _renderWeek() {
    const ws = _weekStart(_anchor);
    const today = new Date(); today.setHours(0,0,0,0);

    let html = `<div class="grid grid-cols-7 sticky top-0 z-10 bg-white border-b border-gray-200">`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(ws); d.setDate(d.getDate() + i);
        const isToday = _dateKey(d) === _dateKey(today);
        html += `<div class="py-3 text-center border-r border-gray-100 last:border-0">
            <p class="text-xs font-bold text-gray-400 uppercase">${DAY_NAMES_SHORT[d.getDay()]}</p>
            <p class="${isToday ? 'w-7 h-7 bg-emerald-600 text-white rounded-full flex items-center justify-center text-sm font-extrabold mx-auto mt-0.5' : 'text-lg font-extrabold text-gray-800 mt-0.5'}">${d.getDate()}</p>
        </div>`;
    }
    html += `</div>`;

    html += `<div class="grid grid-cols-7 border-l border-gray-200">`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(ws); d.setDate(d.getDate() + i);
        const dateKey = _dateKey(d);
        const dayPosts = _postsOnDate(d);
        html += `<div class="border-r border-b border-gray-100 min-h-[300px] p-2 space-y-1.5 bg-white hover:bg-gray-50/40 transition"
            data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">
            ${dayPosts.length > 0 ? dayPosts.map(p => _postChip(p, 'week')).join('') : ''}
        </div>`;
    }
    html += `</div>`;
    return html;
}

// ── List View ─────────────────────────────────────────────────────
function _renderList() {
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const groups: { date: Date; posts: any[] }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month, d);
        const posts = _postsOnDate(date);
        if (posts.length > 0) groups.push({ date, posts });
    }

    if (groups.length === 0) {
        return `<div class="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <p class="text-sm font-medium">No posts this month.</p>
        </div>`;
    }

    let html = `<div class="max-w-3xl mx-auto px-4 py-6 space-y-8">`;
    groups.forEach(({ date, posts }) => {
        const today = new Date(); today.setHours(0,0,0,0);
        const isToday = _dateKey(date) === _dateKey(today);
        html += `<div>
            <div class="flex items-center gap-3 mb-3">
                <span class="text-sm font-extrabold ${isToday ? 'text-emerald-700' : 'text-gray-700'}">
                    ${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    ${isToday ? '<span class="ml-2 text-[10px] bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-bold">Today</span>' : ''}
                </span>
                <div class="flex-1 h-px bg-gray-200"></div>
            </div>
            <div class="space-y-2">${posts.map(p => _listRow(p)).join('')}</div>
        </div>`;
    });
    html += `</div>`;
    return html;
}

// ── Post chip (month/week) ────────────────────────────────────────
function _postChip(post, viewType) {
    const plat = PLATFORM_META[post.platform] || { emoji: '📣', bg: 'bg-gray-500', text: 'text-white' };
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const time = new Date(post.publishDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const isDraggable = ['draft', 'in_review', 'approved', 'scheduled'].includes(post.status);

    return `<div
        onclick="window._calOpenPost(${post.id})"
        ${isDraggable ? `draggable="true" ondragstart="window._calDragStart(event, ${post.id})"` : ''}
        data-post-id="${post.id}"
        class="group flex items-center gap-1.5 px-2 py-1 rounded-lg border-l-2 ${sm.chipBorder} bg-white hover:bg-gray-50 shadow-sm cursor-pointer transition select-none text-left w-full"
        title="${_escHtml(post.caption || post.platform)}">
        <span class="text-xs">${plat.emoji}</span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold text-gray-700 truncate">${time}</p>
            ${viewType === 'week' ? `<p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml((post.caption || '').substring(0, 40))}</p>` : ''}
        </div>
        <span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0"></span>
    </div>`;
}

// ── List row ──────────────────────────────────────────────────────
function _listRow(post) {
    const plat = PLATFORM_META[post.platform] || { emoji: '📣', label: post.platform, bg: 'bg-gray-500', text: 'text-white' };
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const dt = new Date(post.publishDate);
    const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    return `<div onclick="window._calOpenPost(${post.id})"
        class="flex items-start gap-4 bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-emerald-300 hover:shadow-sm cursor-pointer transition">
        <div class="w-9 h-9 rounded-xl ${plat.bg} ${plat.text} flex items-center justify-center text-base font-bold shrink-0 mt-0.5 shadow-sm">${plat.emoji}</div>
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900">${plat.label}</span>
                <span class="text-xs font-bold text-gray-400">${time}</span>
                ${post.isAutonomous ? `<span class="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded-full">100% AI</span>` : ''}
            </div>
            <p class="text-sm text-gray-600 truncate">${_escHtml((post.caption || '').substring(0, 120) || '(No caption)')}</p>
            ${post.hashtags ? `<p class="text-xs text-blue-500 mt-1 truncate">${_escHtml(post.hashtags.substring(0, 80))}</p>` : ''}
        </div>
        <span class="text-xs font-bold px-2.5 py-1 rounded-full border ${sm.badge} shrink-0 mt-1">${sm.label}</span>
    </div>`;
}

// ── Open Aura Format panel ────────────────────────────────────────
window._calOpenPost = async function (postId) {
    _openPostId = postId;
    _editMode = false;

    const panel = document.getElementById('aura-panel');
    panel.classList.remove('hidden');

    // Load post detail (includes enriched assets)
    let post = _posts.find(p => p.id === postId);
    let assets = [];
    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`);
        if (res.ok) {
            const data = await res.json();
            post = data.post;
            assets = data.assets || [];
            // Update cached copy
            const idx = _posts.findIndex(p => p.id === postId);
            if (idx >= 0) _posts[idx] = post;
        }
    } catch (e) { /* use cached */ }

    if (!post) return;

    const plat = PLATFORM_META[post.platform] || { emoji: '📣', label: post.platform, bg: 'bg-gray-500', text: 'text-white' };
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const dt = new Date(post.publishDate);

    // ── Header ────────────────────────────────────────────────────
    const iconEl = document.getElementById('panel-platform-icon');
    iconEl.className = `w-9 h-9 rounded-xl flex items-center justify-center text-base font-bold shadow-sm shrink-0 ${plat.bg} ${plat.text}`;
    iconEl.textContent = plat.emoji;
    document.getElementById('panel-platform-name').textContent = plat.label;
    document.getElementById('panel-publish-date').textContent = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const badgeEl = document.getElementById('panel-status-badge');
    badgeEl.textContent = sm.label;
    badgeEl.className = `text-xs font-bold px-2.5 py-1 rounded-full border ${sm.badge}`;

    // ── Section 1: Logistics ──────────────────────────────────────
    document.getElementById('panel-logistics-platform').textContent = plat.label;
    document.getElementById('panel-logistics-datetime').textContent = dt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    document.getElementById('panel-logistics-format').textContent = (post.postFormat || '').replace(/_/g, ' ');

    // ── Section 2: Content ────────────────────────────────────────
    const captionDisplay = document.getElementById('panel-caption-display');
    const captionEdit = document.getElementById('panel-caption-edit');
    captionDisplay.textContent = post.caption || '(No caption)';
    captionEdit.value = post.caption || '';
    captionDisplay.classList.remove('hidden');
    captionEdit.classList.add('hidden');

    // Assets
    const assetsList = document.getElementById('panel-assets-list');
    const assetsWrap = document.getElementById('panel-assets-wrap');
    if (assets.length > 0) {
        assetsWrap.classList.remove('hidden');
        assetsList.innerHTML = assets.map(a => {
            if (a.assetType === 'image' && a.storageUrl) {
                return `<div class="aspect-square rounded-xl overflow-hidden border border-gray-200 bg-gray-100">
                    <img src="${a.storageUrl}" alt="${_escHtml(a.name)}" class="w-full h-full object-cover">
                </div>`;
            }
            if (a.assetType === 'video') {
                return `<div class="aspect-square rounded-xl border border-gray-200 bg-gray-100 flex flex-col items-center justify-center gap-1 text-gray-400">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.72v6.56a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                    <p class="text-[10px] text-center px-2 truncate w-full text-center">${_escHtml(a.name)}</p>
                </div>`;
            }
            if (a.externalUrl) {
                return `<a href="${a.externalUrl}" target="_blank" rel="noopener"
                    class="aspect-square rounded-xl border border-blue-200 bg-blue-50 flex flex-col items-center justify-center gap-1 text-blue-600 hover:bg-blue-100 transition">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                    <p class="text-[10px] px-2 truncate w-full text-center">${_escHtml(a.name)}</p>
                </a>`;
            }
            return '';
        }).join('');
    } else {
        assetsWrap.classList.add('hidden');
    }

    // Links
    const linksWrap = document.getElementById('panel-links-wrap');
    const linksContent = document.getElementById('panel-links-content');
    if (post.linkUrl || post.ctaText) {
        linksWrap.classList.remove('hidden');
        linksContent.innerHTML = '';
        if (post.linkUrl) {
            linksContent.innerHTML += `<a href="${_escHtml(post.linkUrl)}" target="_blank" rel="noopener" class="flex items-center gap-1 text-xs text-blue-600 hover:underline truncate">
                <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                ${_escHtml(post.linkUrl)}
            </a>`;
        }
        if (post.ctaText) {
            linksContent.innerHTML += `<p class="text-xs text-gray-700 mt-1">CTA: <span class="font-bold">${_escHtml(post.ctaText)}</span></p>`;
        }
        if (post.utmParams) {
            linksContent.innerHTML += `<p class="text-xs text-gray-400 mt-0.5 font-mono truncate">${_escHtml(post.utmParams)}</p>`;
        }
    } else { linksWrap.classList.add('hidden'); }

    // Tags
    const tagsWrap = document.getElementById('panel-tags-wrap');
    const tagsContent = document.getElementById('panel-tags-content');
    const tagText = [post.hashtags, post.mentions].filter(Boolean).join('  ');
    if (tagText) {
        tagsWrap.classList.remove('hidden');
        tagsContent.textContent = tagText;
    } else { tagsWrap.classList.add('hidden'); }

    // ── Section 3: Governance ─────────────────────────────────────
    document.getElementById('panel-gov-status').textContent = sm.label;
    document.getElementById('panel-gov-owner').textContent = post.ownerLabel || 'Aura-Assist';
    document.getElementById('panel-gov-campaign').textContent = post.campaign || '—';
    document.getElementById('panel-gov-pillar').textContent = post.pillar || '—';

    const autoRow = document.getElementById('panel-gov-autonomous-row');
    post.isAutonomous ? autoRow.classList.remove('hidden') : autoRow.classList.add('hidden');

    const rejRow = document.getElementById('panel-rejection-reason');
    if (post.status === 'rejected' && post.rejectionReason) {
        rejRow.textContent = `Rejected: ${post.rejectionReason}`;
        rejRow.classList.remove('hidden');
    } else { rejRow.classList.add('hidden'); }

    // ── Footer actions ────────────────────────────────────────────
    const publishedActions = document.getElementById('panel-actions-published');
    const editableActions = document.getElementById('panel-actions-editable');
    const saveBtn = document.getElementById('btn-panel-save');

    if (post.status === 'published') {
        publishedActions.classList.remove('hidden');
        editableActions.classList.add('hidden');
        const liveLink = document.getElementById('panel-live-link');
        if (post.platformPostUrl) {
            liveLink.href = post.platformPostUrl;
            liveLink.classList.remove('pointer-events-none', 'opacity-50');
        } else {
            liveLink.href = '#';
            liveLink.classList.add('pointer-events-none', 'opacity-50');
        }
    } else if (['cancelled', 'rejected'].includes(post.status)) {
        publishedActions.classList.add('hidden');
        editableActions.classList.add('hidden');
    } else {
        publishedActions.classList.add('hidden');
        editableActions.classList.remove('hidden');
        if (saveBtn) saveBtn.classList.add('hidden');
    }

    // Update Approve button label contextually
    const approveBtn = document.getElementById('btn-panel-approve');
    if (approveBtn) {
        if (post.status === 'approved') { approveBtn.textContent = '✓ Approved'; approveBtn.disabled = true; approveBtn.classList.add('opacity-50'); }
        else { approveBtn.textContent = '✓ Approve'; approveBtn.disabled = false; approveBtn.classList.remove('opacity-50'); }
    }
};

window._calClosePanel = function () {
    document.getElementById('aura-panel')?.classList.add('hidden');
    _openPostId = null;
    _editMode = false;
};

// ── Edit mode ─────────────────────────────────────────────────────
window._calToggleEdit = function () {
    _editMode = !_editMode;
    document.getElementById('panel-caption-display').classList.toggle('hidden', _editMode);
    document.getElementById('panel-caption-edit').classList.toggle('hidden', !_editMode);
    document.getElementById('btn-panel-save').classList.toggle('hidden', !_editMode);
    const editBtn = document.getElementById('btn-panel-edit');
    if (editBtn) editBtn.textContent = _editMode ? '✕ Cancel Edit' : '✏ Edit Copy';
};

window._calSaveEdits = async function () {
    if (!_openPostId) return;
    const newCaption = document.getElementById('panel-caption-edit').value;
    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${_openPostId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caption: newCaption }),
        });
        if (res.ok) {
            const { post } = await res.json();
            _updateLocalPost(post);
            // Refresh panel
            window._calToggleEdit();
            document.getElementById('panel-caption-display').textContent = newCaption || '(No caption)';
        }
    } catch (e) { alert('Save failed. Please try again.'); }
};

// ── Governance actions ────────────────────────────────────────────
window._calApprovePost = async function () {
    if (!_openPostId) return;
    await _patchStatus(_openPostId, 'approved');
};

window._calCancelPost = async function () {
    if (!_openPostId) return;
    if (!confirm('Cancel this post? It will be moved to Cancelled and removed from the publishing queue.')) return;
    await _patchStatus(_openPostId, 'cancelled');
    window._calClosePanel();
};

async function _patchStatus(postId, status, extra = {}) {
    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, ...extra }),
        });
        if (res.ok) {
            const { post } = await res.json();
            _updateLocalPost(post);
            // Refresh panel with new status
            await window._calOpenPost(postId);
            _render(); // re-render chips
        }
    } catch (e) { alert('Action failed. Please try again.'); }
}

// ── Drag & Drop rescheduling ──────────────────────────────────────
window._calDragStart = function (e, postId) {
    _dragPostId = postId;
    e.dataTransfer.effectAllowed = 'move';
    e.target.classList.add('opacity-50');
    setTimeout(() => e.target.classList.add('opacity-50'), 0);
};

window._calDragOver = function (e, dateKey) {
    e.preventDefault();
    _dragTargetDate = dateKey;
    const cell = e.currentTarget;
    cell.classList.add('ring-2', 'ring-emerald-400', 'ring-inset');
};

window._calDragLeave = function (e) {
    e.currentTarget.classList.remove('ring-2', 'ring-emerald-400', 'ring-inset');
};

window._calDrop = function (e, dateKey) {
    e.preventDefault();
    e.currentTarget.classList.remove('ring-2', 'ring-emerald-400', 'ring-inset');
    if (!_dragPostId) return;

    const post = _posts.find(p => p.id === _dragPostId);
    if (!post) { _dragPostId = null; return; }

    const [y, m, d] = dateKey.split('-').map(Number);
    const original = new Date(post.publishDate);
    const newDate = new Date(y, m - 1, d, original.getHours(), original.getMinutes());

    if (_dateKey(original) === dateKey) { _dragPostId = null; return; } // same day

    const oldLabel = original.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const newLabel = newDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    const msgEl = document.getElementById('reschedule-msg');
    if (msgEl) msgEl.textContent = `Move "${post.caption?.substring(0,40) || 'this post'}" from ${oldLabel} to ${newLabel}?`;

    _pendingReschedule = { postId: _dragPostId, newDate };
    document.getElementById('modal-reschedule')?.classList.remove('hidden');
    _dragPostId = null;
};

window._calCancelReschedule = function () {
    _pendingReschedule = null;
    document.getElementById('modal-reschedule')?.classList.add('hidden');
    _render(); // restore opacity
};

window._calConfirmReschedule = async function () {
    if (!_pendingReschedule) return;
    const { postId, newDate } = _pendingReschedule;
    document.getElementById('modal-reschedule')?.classList.add('hidden');
    _pendingReschedule = null;

    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publishDate: newDate.toISOString() }),
        });
        if (res.ok) {
            const { post } = await res.json();
            _updateLocalPost(post);
            // Reload range to include new date if needed
            await _loadAndRender();
        }
    } catch (e) { alert('Reschedule failed. Please try again.'); }
};

function _attachDragDrop() {
    // After DOM render, add dragend listeners to chips to clean up opacity
    document.querySelectorAll('[data-post-id]').forEach(el => {
        el.addEventListener('dragend', () => {
            el.classList.remove('opacity-50');
        });
    });
}

// ── Helpers ───────────────────────────────────────────────────────
function _postsOnDate(date) {
    const key = _dateKey(date);
    return _posts.filter(p => {
        if (!p.publishDate) return false;
        return _dateKey(new Date(p.publishDate)) === key;
    });
}

function _dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function _weekStart(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - day);
    d.setHours(0,0,0,0);
    return d;
}

function _escHtml(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _updateLocalPost(updated) {
    const idx = _posts.findIndex(p => p.id === updated.id);
    if (idx >= 0) _posts[idx] = updated;
    else _posts.push(updated);
}
