// integrations.js — Connections page controller

// ── Platform catalogue ───────────────────────────────────────────
const PLATFORMS = [
    {
        id: 'Facebook',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/meta-oauth?action=start',
        emoji: '📘',
        iconBg: 'bg-blue-600',
        iconText: 'text-white',
        label: 'Facebook',
        tagline: 'Post to your Facebook Page and reach your audience directly.',
        handleLabel: 'Facebook Page URL',
        handlePlaceholder: 'https://facebook.com/yourpagename',
        handleHelp: 'The full URL of the Facebook Page you want this assistant to post to.',
        tokenLabel: 'Page Access Token',
        tokenHelp: 'A token that authorises Aura-Assist to post on behalf of your Page. Never expires if generated correctly.',
        steps: [
            { text: 'Open the Meta Graph API Explorer', url: 'https://developers.facebook.com/tools/explorer/' },
            { text: 'Sign in with the Facebook account that has <strong>Admin</strong> access to your Page.' },
            { text: 'Click <strong>"Generate Access Token"</strong> at the top right.' },
            { text: 'From the dropdown, choose your <strong>Page</strong> (not "User Token").' },
            { text: 'Click <strong>"Generate"</strong>, approve all permissions, then copy the token shown.' },
            { text: 'Paste the token into the field below.' },
        ],
        note: 'You must be an Admin of the Facebook Page. If your page does not appear in the dropdown, check your role in Page Settings → Page Roles.',
    },
    {
        id: 'Instagram',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/meta-oauth?action=start',
        emoji: '📸',
        iconBg: 'bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400',
        iconText: 'text-white',
        label: 'Instagram',
        tagline: 'Publish posts, Reels, and Stories to your Instagram Business account.',
        handleLabel: 'Instagram Username',
        handlePlaceholder: '@yourbrand',
        handleHelp: 'Your Instagram username. The account must be a Business or Creator account.',
        tokenLabel: 'Instagram Access Token',
        tokenHelp: 'Instagram uses the same Meta API as Facebook. If you have already connected Facebook, the same token works here.',
        steps: [
            { text: 'Make sure your Instagram is a <strong>Business</strong> or <strong>Creator</strong> account — go to Instagram → Settings → Account → Switch to Professional Account if needed.' },
            { text: 'In Instagram Settings, go to <strong>Account → Linked Accounts</strong> and connect it to your Facebook Page.' },
            { text: 'Open the Meta Graph API Explorer', url: 'https://developers.facebook.com/tools/explorer/' },
            { text: 'Sign in and generate a <strong>Page Access Token</strong> for the connected Facebook Page (this token covers Instagram too).' },
            { text: 'Copy the token and paste it below.' },
        ],
        note: 'Personal Instagram accounts cannot be used with third-party tools — the account must be Business or Creator and linked to a Facebook Page.',
    },
    {
        id: 'LinkedIn',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/social-oauth-init?platform=linkedin',
        emoji: '💼',
        iconBg: 'bg-blue-700',
        iconText: 'text-white',
        label: 'LinkedIn',
        tagline: 'Share thought leadership, company updates, and job posts.',
        handleLabel: 'LinkedIn Page or Profile URL',
        handlePlaceholder: 'https://linkedin.com/company/yourcompany',
        handleHelp: 'Your LinkedIn Company Page URL, or your personal profile URL if posting as yourself.',
        tokenLabel: 'LinkedIn Access Token',
        tokenHelp: 'An OAuth 2.0 access token from the LinkedIn Developer Portal.',
        steps: [
            { text: 'Go to LinkedIn Developer Portal', url: 'https://www.linkedin.com/developers/apps/new' },
            { text: 'Click <strong>"Create App"</strong>. Give it a name and associate it with your Company Page.' },
            { text: 'In the App, go to the <strong>"Auth"</strong> tab and request the following permissions: <code>r_liteprofile</code>, <code>w_member_social</code>, and <code>rw_company_admin</code>.' },
            { text: 'Go to the <strong>"OAuth 2.0 Tools"</strong> tab and click <strong>"Create token"</strong> with those scopes.' },
            { text: 'Copy the access token and paste it below.' },
        ],
        note: 'To post on behalf of a Company Page, your LinkedIn account must be an Admin of that page.',
    },
    {
        id: 'X',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/social-oauth-init?platform=x',
        emoji: '✕',
        iconBg: 'bg-gray-950',
        iconText: 'text-white',
        label: 'X (Twitter)',
        tagline: 'Post threads, replies, and real-time content to X.',
        handleLabel: 'X Username',
        handlePlaceholder: '@yourbrand',
        handleHelp: 'Your X username with or without the @.',
        tokenLabel: 'Bearer Token',
        tokenHelp: 'A Bearer Token from the X Developer Portal gives read and write access to your account.',
        steps: [
            { text: 'Go to the X Developer Portal', url: 'https://developer.twitter.com/en/portal/dashboard' },
            { text: 'Sign in (or create a free developer account — it takes about 2 minutes).' },
            { text: 'Create a new <strong>Project</strong> and <strong>App</strong> inside it.' },
            { text: 'In your App settings, go to <strong>"User authentication settings"</strong> and enable <strong>Read and Write</strong> permissions.' },
            { text: 'Go to <strong>"Keys and Tokens"</strong> and copy the <strong>Bearer Token</strong>.' },
            { text: 'Paste it into the field below.' },
        ],
        note: 'X requires a free Developer account. The sign-up takes a few minutes and asks what you plan to build — describe it as "scheduling and publishing social media posts".',
    },
];

let _connToDelete = null;
let _userConnections = [];

// ── Init ─────────────────────────────────────────────────────────
window.initIntegrations = async function () {
    await _loadConnections();

    // Disconnect confirm button
    const confirmBtn = document.getElementById('btn-confirm-disconnect');
    if (confirmBtn) {
        const newBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
        newBtn.addEventListener('click', _doDisconnect);
    }
};

// ── Load & render platform cards ─────────────────────────────────
async function _loadConnections() {
    const grid = document.getElementById('connections-grid');
    if (!grid) return;

    try {
        const res = await fetch('/.netlify/functions/integrations');
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        _userConnections = (data.connections || []).filter(c => c.userId !== null);
    } catch (e) {
        console.warn('Could not load connections:', e);
    }

    grid.innerHTML = '';
    PLATFORMS.forEach(platform => {
        const conn = _userConnections.find(c => c.serviceName === platform.id);
        grid.insertAdjacentHTML('beforeend', _platformCard(platform, conn));
    });
}

function _platformCard(platform, conn) {
    const isConnected = !!conn;
    const handle = conn?.externalUserId || '';

    // US-GAP-10.1.1 SC4: Active / Expiring Soon / Disconnected badges
    let statusBadge;
    if (!isConnected) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-gray-500 bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span> Not connected</span>`;
    } else if (conn.status === 'expired' || conn.status === 'failed' || conn.status === 'revoked') {
        statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Disconnected</span>`;
    } else if (conn.tokenExpiresAt) {
        const daysLeft = Math.ceil((new Date(conn.tokenExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft <= 7 && daysLeft > 0) {
            statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Expiring in ${daysLeft}d</span>`;
        } else if (daysLeft <= 0) {
            statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Disconnected</span>`;
        } else {
            statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Active</span>`;
        }
    } else {
        statusBadge = conn.status === 'active'
            ? `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Active</span>`
            : `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Needs attention</span>`;
    }

    // US-SMM-4.1.1 / 4.1.2: OAuth platforms use redirect; manual token entry kept for non-OAuth
    const connectBtn = platform.oauthPlatform
        ? `<a href="${platform.oauthUrl}" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg shadow transition cursor-pointer inline-block">Connect with ${platform.label}</a>`
        : `<button onclick="window._intOpenModal('${platform.id}')" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg shadow transition cursor-pointer" type="button">Connect</button>`;

    const reconnectBtn = platform.oauthPlatform
        ? `<a href="${platform.oauthUrl}" class="text-sm font-bold text-gray-500 hover:text-gray-800 transition cursor-pointer">Reconnect</a>`
        : `<button onclick="window._intOpenModal('${platform.id}')" class="text-sm font-bold text-gray-500 hover:text-gray-800 transition cursor-pointer" type="button">Update token</button>`;

    // US-SMM-4.3.2: preflight audit status badge
    const meta = conn?.metadata ?? {};
    const preflightStatus = meta.preflightStatus;
    const preflightChecks = meta.preflightAuditResults ?? [];
    let preflightBadge = '';
    if (isConnected && preflightStatus) {
        const colour = preflightStatus === 'passed' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : preflightStatus === 'partial' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
        const dot    = preflightStatus === 'passed' ? 'bg-emerald-500' : preflightStatus === 'partial' ? 'bg-amber-500 animate-pulse' : 'bg-red-500 animate-pulse';
        const label  = preflightStatus === 'passed' ? 'Audit passed' : preflightStatus === 'partial' ? 'Needs attention' : 'Audit failed';
        preflightBadge = `<span class="inline-flex items-center gap-1 text-xs font-bold ${colour} border px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${label}</span>`;
    }

    // US-SMM-4.3.2: failed check cards with deep links + "I've done this" verification button
    const failedChecks = preflightChecks.filter(c => c.status === 'fail');
    let troubleshootingHtml = '';
    if (isConnected && failedChecks.length > 0) {
        const cards = failedChecks.map(chk => `
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-col gap-2" id="trouble-card-${conn?.id}-${chk.id}">
                <p class="text-xs font-bold text-amber-800">${chk.id}: ${chk.label}</p>
                <p class="text-xs text-amber-700">${chk.detail ?? ''}</p>
                <p class="text-xs text-amber-600 italic hidden" id="trouble-chat-${conn?.id}-${chk.id}"></p>
                <div class="flex items-center gap-2 flex-wrap">
                    ${chk.deepLink ? `<a href="${chk.deepLink}" target="_blank" rel="noopener noreferrer" class="text-xs font-bold text-amber-700 underline">Open Settings ↗</a>` : ''}
                    <button onclick="window._intVerifyCheck('${conn?.id ?? ''}','${platform.id.toLowerCase()}','${chk.id}','${(chk.label || '').replace(/'/g, "\\'")}','${(chk.detail || '').replace(/'/g, "\\'")}',this)" class="text-xs font-bold text-emerald-700 bg-white border border-emerald-300 rounded-lg px-2 py-0.5 cursor-pointer hover:bg-emerald-50 transition" type="button" id="verify-btn-${conn?.id}-${chk.id}">I've done this</button>
                    <span id="verify-spin-${conn?.id}-${chk.id}" class="hidden text-xs text-gray-400">Checking…</span>
                </div>
            </div>`).join('');
        troubleshootingHtml = `<div class="flex flex-col gap-2 pt-3 border-t border-amber-100">${cards}</div>`;
    }

    // US-SMM-4.2.2 / 4.2.1: Sync Profile and Generate Auto-Responder for Meta/LinkedIn
    const syncBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook' || platform.id === 'LinkedIn'))
        ? `<button onclick="window._intSyncProfile('${platform.id.toLowerCase()}')" class="text-xs font-bold text-blue-600 hover:text-blue-800 transition cursor-pointer" type="button">Sync Profile</button>`
        : '';
    const autoRespBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook'))
        ? `<button onclick="window._intGenerateAutoResponder()" class="text-xs font-bold text-purple-600 hover:text-purple-800 transition cursor-pointer" type="button">Auto-Responder</button>`
        : '';

    const action = isConnected
        ? `<div class="flex items-center gap-2 flex-wrap">
               ${syncBtn}
               ${autoRespBtn}
               ${reconnectBtn}
               <button onclick="window._intPromptDisconnect(${conn.id})" class="text-sm font-bold text-red-500 hover:text-red-700 transition cursor-pointer" type="button">Disconnect</button>
           </div>`
        : connectBtn;

    return `
        <div class="bg-white rounded-2xl border ${isConnected ? 'border-emerald-200 shadow-md' : 'border-gray-200 shadow-sm'} p-6 flex flex-col gap-4">
            <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-xl ${platform.iconBg} ${platform.iconText} flex items-center justify-center font-bold text-xl shadow-sm shrink-0">
                    ${platform.emoji}
                </div>
                <div class="flex-1 min-w-0">
                    <h3 class="font-extrabold text-gray-900">${platform.label}</h3>
                    <p class="text-sm text-gray-500 mt-0.5 truncate">${isConnected && handle ? handle : platform.tagline}</p>
                </div>
            </div>
            <div class="flex items-center justify-between pt-3 border-t border-gray-100">
                <div class="flex items-center gap-2 flex-wrap">
                    ${statusBadge}
                    ${preflightBadge}
                </div>
                ${action}
            </div>
            ${troubleshootingHtml}
        </div>`;
}

// ── US-SMM-4.3.2: Verify a single pre-flight check ───────────────
// AC: 10 re-check attempts per platform per 24h (server-side) + client-side guard via localStorage
window._intVerifyCheck = async function (connId, platform, checkId, checkLabel, checkDetail) {
    const spinEl = document.getElementById(`verify-spin-${connId}-${checkId}`);
    const btnEl  = document.getElementById(`verify-btn-${connId}-${checkId}`);
    const chatEl = document.getElementById(`trouble-chat-${connId}-${checkId}`);
    if (!btnEl) return;

    // Client-side rate limit guard (mirrors server-side; avoids wasting LLM calls)
    const rlKey = `smc_rl_${platform}`;
    const now = Date.now();
    let rlData = JSON.parse(localStorage.getItem(rlKey) || '{"count":0,"windowStart":0}');
    if (now - rlData.windowStart > 86400000) rlData = { count: 0, windowStart: now };
    if (rlData.count >= 10) {
        if (chatEl) { chatEl.textContent = 'You\'ve reached the daily re-check limit (10 per 24h). Please try again tomorrow.'; chatEl.classList.remove('hidden'); }
        return;
    }
    rlData.count++;
    localStorage.setItem(rlKey, JSON.stringify(rlData));

    btnEl.disabled = true;
    if (spinEl) spinEl.classList.remove('hidden');

    try {
        // Fetch LLM-generated contextual troubleshooting message
        const chatRes = await fetch('/.netlify/functions/social-troubleshoot-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, checkId, checkLabel, checkDetail }),
        });
        if (chatRes.ok) {
            const chatData = await chatRes.json();
            if (chatEl && chatData.message) {
                chatEl.textContent = chatData.message;
                chatEl.classList.remove('hidden');
            }
            if (chatData.rateLimited) {
                if (chatEl) { chatEl.textContent = chatData.error; chatEl.classList.remove('hidden'); }
                return;
            }
        }

        // Run the actual pre-flight audit to recheck
        const auditRes = await fetch('/.netlify/functions/social-preflight-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform }),
        });
        if (auditRes.ok) {
            await _loadConnections(); // Refresh to show updated check results
        }
    } catch { /* ignore */ } finally {
        if (spinEl) spinEl.classList.add('hidden');
        if (btnEl) btnEl.disabled = false;
    }
};

// ── Open connect modal ────────────────────────────────────────────
window._intOpenModal = function (platformId) {
    const platform = PLATFORMS.find(p => p.id === platformId);
    if (!platform) return;

    // US-SMM-4.1.1: OAuth platforms redirect instead of showing the token modal
    if (platform.oauthPlatform) {
        window.location.href = platform.oauthUrl;
        return;
    }

    const existing = _userConnections.find(c => c.serviceName === platformId);

    // Header
    document.getElementById('modal-platform-icon').className = `w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold shadow-sm shrink-0 ${platform.iconBg} ${platform.iconText}`;
    document.getElementById('modal-platform-icon').textContent = platform.emoji;
    document.getElementById('modal-platform-name').textContent = platform.label;
    document.getElementById('modal-platform-desc').textContent = platform.tagline;

    // Steps
    const stepsEl = document.getElementById('modal-steps');
    stepsEl.innerHTML = platform.steps.map((s, i) => {
        const link = s.url ? ` <a href="${s.url}" target="_blank" rel="noopener" class="text-emerald-600 hover:underline font-semibold inline-flex items-center gap-1">${s.text} <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg></a>` : `<span>${s.text}</span>`;
        return `<li class="flex items-start gap-3">
            <span class="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">${i + 1}</span>
            <p class="text-sm text-gray-700 leading-relaxed">${s.url ? link : s.text}</p>
        </li>`;
    }).join('');

    // Note
    const noteEl = document.getElementById('modal-note');
    if (platform.note) {
        noteEl.classList.remove('hidden');
        noteEl.innerHTML = `<svg class="w-4 h-4 shrink-0 text-amber-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>${platform.note}</span>`;
    } else {
        noteEl.classList.add('hidden');
    }

    // Form labels
    document.getElementById('handle-label').textContent = platform.handleLabel;
    document.getElementById('handle-help').textContent = platform.handleHelp;
    document.getElementById('conn-handle').placeholder = platform.handlePlaceholder;
    document.getElementById('conn-handle').value = existing?.externalUserId || '';
    document.getElementById('token-label').textContent = platform.tokenLabel;
    document.getElementById('token-help').textContent = platform.tokenHelp;
    document.getElementById('conn-token').value = '';
    document.getElementById('conn-token').type = 'password';
    document.getElementById('conn-service-name').value = platformId;
    document.getElementById('conn-type').value = 'api_key';
    document.getElementById('conn-error').classList.add('hidden');

    // Update submit button label
    document.getElementById('btn-connect-submit').innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
        ${existing ? 'Update Connection' : 'Encrypt &amp; Connect'}`;

    document.getElementById('modal-connect').classList.remove('hidden');
};

// ── Toggle token visibility ───────────────────────────────────────
window._intToggleToken = function () {
    const input = document.getElementById('conn-token');
    input.type = input.type === 'password' ? 'text' : 'password';
};

// ── Submit credentials ────────────────────────────────────────────
window._intSubmit = async function (e) {
    if (e) e.preventDefault();

    const btn = document.getElementById('btn-connect-submit');
    const errorEl = document.getElementById('conn-error');
    const token = document.getElementById('conn-token').value.trim();
    const handle = document.getElementById('conn-handle').value.trim();
    const serviceName = document.getElementById('conn-service-name').value;

    if (!token) {
        errorEl.textContent = 'Please enter your access token.';
        errorEl.classList.remove('hidden');
        return;
    }

    errorEl.classList.add('hidden');
    btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Encrypting…';
    btn.disabled = true;

    try {
        const res = await fetch('/.netlify/functions/integrations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serviceName, connectionType: 'api_key', apiKey: token, handle }),
        });

        if (res.ok) {
            document.getElementById('modal-connect').classList.add('hidden');
            await _loadConnections(); // Refresh cards
        } else {
            const body = await res.json().catch(() => ({}));
            errorEl.textContent = body.error || 'Connection failed. Please check your token and try again.';
            errorEl.classList.remove('hidden');
        }
    } catch {
        errorEl.textContent = 'Network error — please check your connection and try again.';
        errorEl.classList.remove('hidden');
    } finally {
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg> Encrypt &amp; Connect';
        btn.disabled = false;
    }
};

// ── Disconnect ────────────────────────────────────────────────────
window._intPromptDisconnect = function (connId) {
    _connToDelete = connId;
    document.getElementById('modal-disconnect').classList.remove('hidden');
};

// ── US-SMM-4.2.2: Sync Profile ───────────────────────────────────
window._intSyncProfile = async function (platform) {
    const feedback = document.getElementById('revoke-all-feedback');
    if (feedback) { feedback.textContent = 'Syncing profile…'; feedback.classList.remove('hidden', 'text-red-700'); feedback.classList.add('text-blue-700'); }
    try {
        const res = await fetch('/.netlify/functions/social-profile-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (feedback) {
            const ok = Object.values(data.results ?? {}).some(r => r.status === 'ok');
            feedback.textContent = ok ? 'Profile synced successfully.' : 'Profile sync completed (some platforms skipped).';
            feedback.classList.remove('text-blue-700');
            feedback.classList.add(ok ? 'text-emerald-700' : 'text-amber-700');
            setTimeout(() => feedback.classList.add('hidden'), 4000);
        }
    } catch {
        if (feedback) { feedback.textContent = 'Profile sync failed. Please try again.'; feedback.classList.add('text-red-700'); }
    }
};

// ── US-SMM-4.2.1: Generate Auto-Responder ────────────────────────
window._intGenerateAutoResponder = async function () {
    const feedback = document.getElementById('revoke-all-feedback');
    if (feedback) { feedback.textContent = 'Generating auto-responder messages…'; feedback.classList.remove('hidden', 'text-red-700', 'text-emerald-700', 'text-amber-700'); feedback.classList.add('text-blue-700'); }
    try {
        const res = await fetch('/.netlify/functions/social-auto-responder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (feedback) {
            feedback.textContent = data.ok ? 'Auto-responder messages generated. Check your notifications.' : (data.error ?? 'Generation failed.');
            feedback.classList.remove('text-blue-700');
            feedback.classList.add(data.ok ? 'text-emerald-700' : 'text-red-700');
            setTimeout(() => feedback.classList.add('hidden'), 5000);
        }
    } catch {
        if (feedback) { feedback.textContent = 'Auto-responder generation failed. Please try again.'; feedback.classList.add('text-red-700'); }
    }
};

async function _doDisconnect() {
    if (!_connToDelete) return;
    try {
        const res = await fetch(`/.netlify/functions/integrations?id=${_connToDelete}`, { method: 'DELETE' });
        if (res.ok) {
            document.getElementById('modal-disconnect').classList.add('hidden');
            _connToDelete = null;
            await _loadConnections();
        }
    } catch {
        alert('Could not disconnect. Please try again.');
    }
}
