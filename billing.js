// billing.js — Billing & Subscription page controller
// Wrapped in an IIFE to avoid polluting global scope with private helpers
// (prevents name collisions with calendar.js, my-content.js, etc.)

(function () {
    // ── Public entry point ────────────────────────────────────────
    window.initBilling = async function () {
        _showState('loading');
        try {
            const res = await fetch('/.netlify/functions/billing-data');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const { subscriptions, paymentHistory } = await res.json();
            _render(subscriptions || [], paymentHistory || []);
        } catch (e) {
            console.error('[billing]', e);
            const msg = document.getElementById('billing-error-msg');
            if (msg) msg.textContent = e.message || 'Unable to load billing data.';
            _showState('error');
        }
    };

    // ── State helpers ─────────────────────────────────────────────
    function _showState(state) {
        const el = id => document.getElementById(id);
        el('billing-loading').classList.toggle('hidden', state !== 'loading');
        el('billing-error').classList.toggle('hidden', state !== 'error');
        el('billing-content').classList.toggle('hidden', state !== 'content');
    }

    // ── Main render ───────────────────────────────────────────────
    function _render(subscriptions, paymentHistory) {
        _renderSubscriptions(subscriptions);
        _renderHistory(paymentHistory);

        const badge = document.getElementById('billing-sync-badge');
        if (badge) {
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        }

        _showState('content');
    }

    // ── Subscriptions ─────────────────────────────────────────────
    function _renderSubscriptions(subs) {
        const list  = document.getElementById('subscriptions-list');
        const empty = document.getElementById('subscriptions-empty');

        const active = subs.filter(s =>
            ['active', 'trialing'].includes(s.stripeStatus || '') || s.status === 'active'
        );

        if (active.length === 0) {
            list.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }

        empty.classList.add('hidden');
        list.innerHTML = active.map(_subscriptionCard).join('');
    }

    function _subscriptionCard(sub) {
        const statusMeta = {
            active:   { label: 'Active',   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
            trialing: { label: 'Trial',    cls: 'bg-blue-50 text-blue-700 border-blue-200' },
            past_due: { label: 'Past Due', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            cancelled:{ label: 'Cancelled',cls: 'bg-gray-100 text-gray-500 border-gray-200' },
        };
        const sm = statusMeta[sub.stripeStatus || sub.status] || statusMeta['active'];

        const cycle  = sub.billingCycle === 'year' ? 'Annually' : 'Monthly';
        const amount = sub.amountGbp
            ? `£${parseFloat(sub.amountGbp).toFixed(2)}`
            : sub.currency ? `${sub.currency.toUpperCase()} —` : '—';

        const renewalLine = sub.cancelAtPeriodEnd
            ? `<span class="text-amber-600 font-semibold">Cancels on ${_fmtDate(sub.renewalDate)}</span>`
            : sub.renewalDate
                ? `Renews <span class="font-semibold text-gray-800">${_fmtDate(sub.renewalDate)}</span>`
                : `Started <span class="font-semibold text-gray-800">${_fmtDate(sub.startedAt)}</span>`;

        const pmLine = sub.paymentMethod
            ? `<div class="flex items-center gap-2 text-sm text-gray-600 mt-2">
                 ${_cardIcon(sub.paymentMethod.brand)}
                 <span class="capitalize">${_esc(sub.paymentMethod.brand)}</span>
                 <span>ending in <strong>${_esc(sub.paymentMethod.last4)}</strong></span>
                 <span class="text-gray-400">· expires ${sub.paymentMethod.expMonth}/${sub.paymentMethod.expYear}</span>
               </div>`
            : '';

        return `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div class="flex items-start justify-between gap-4 mb-4">
            <div>
              <div class="flex items-center gap-2 mb-1">
                <h3 class="text-base font-extrabold text-gray-900">${_esc(sub.planName)}</h3>
                <span class="text-xs font-bold px-2.5 py-1 rounded-full border ${sm.cls}">${sm.label}</span>
                ${sub.cancelAtPeriodEnd ? `<span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200">Cancels at period end</span>` : ''}
              </div>
              <p class="text-sm text-gray-500">${cycle} billing · ${renewalLine}</p>
              ${pmLine}
            </div>
            <div class="text-right shrink-0">
              <p class="text-2xl font-extrabold text-gray-900">${amount}</p>
              <p class="text-xs text-gray-400">per ${_esc(sub.billingCycle || 'month')}</p>
            </div>
          </div>
        </div>`;
    }

    // ── Payment History ───────────────────────────────────────────
    function _renderHistory(payments) {
        const wrap  = document.getElementById('history-wrap');
        const empty = document.getElementById('history-empty');
        const tbody = document.getElementById('history-tbody');

        if (payments.length === 0) {
            wrap.classList.add('hidden');
            empty.classList.remove('hidden');
            return;
        }

        empty.classList.add('hidden');
        wrap.classList.remove('hidden');

        const statusMeta = {
            completed: { label: 'Paid',     cls: 'bg-emerald-50 text-emerald-700' },
            paid:      { label: 'Paid',     cls: 'bg-emerald-50 text-emerald-700' },
            pending:   { label: 'Pending',  cls: 'bg-amber-50 text-amber-700' },
            failed:    { label: 'Failed',   cls: 'bg-red-50 text-red-700' },
            refunded:  { label: 'Refunded', cls: 'bg-gray-100 text-gray-600' },
        };

        tbody.innerHTML = payments.map(p => {
            const sm = statusMeta[(p.status || '').toLowerCase()] ||
                       { label: p.status || '—', cls: 'bg-gray-100 text-gray-600' };

            const currency = (p.currency || 'GBP').toUpperCase();
            const symbol   = currency === 'GBP' ? '£' : `${currency} `;
            const amount   = p.amount ? `${symbol}${parseFloat(p.amount).toFixed(2)}` : '—';

            let pmCell = '—';
            if (p.paymentMethod && typeof p.paymentMethod === 'object') {
                pmCell = `<div class="flex items-center gap-1.5">
                    ${_cardIcon(p.paymentMethod.brand)}
                    <span class="capitalize">${_esc(p.paymentMethod.brand)}</span>
                    ···· ${_esc(p.paymentMethod.last4)}
                  </div>`;
            } else if (typeof p.paymentMethod === 'string' && p.paymentMethod) {
                pmCell = _esc(p.paymentMethod);
            }

            const receiptCell = p.receiptUrl
                ? `<a href="${p.receiptUrl}" target="_blank" rel="noopener"
                      class="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 font-bold text-sm transition">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                      Invoice
                   </a>`
                : `<span class="text-gray-300 text-xs">—</span>`;

            return `
            <tr class="hover:bg-gray-50 transition">
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${_fmtDate(p.date)}</td>
              <td class="px-5 py-4 font-medium text-gray-900">${_esc(p.description || '—')}</td>
              <td class="px-5 py-4 font-bold text-gray-900 whitespace-nowrap">${amount}</td>
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${pmCell}</td>
              <td class="px-5 py-4">
                <span class="text-xs font-bold px-2.5 py-1 rounded-full ${sm.cls}">${sm.label}</span>
              </td>
              <td class="px-5 py-4 text-right">${receiptCell}</td>
            </tr>`;
        }).join('');
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _fmtDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function _esc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _cardIcon(brand) {
        const colors = {
            visa: 'text-blue-700', mastercard: 'text-red-600', amex: 'text-blue-500',
            discover: 'text-orange-600',
        };
        const cls = colors[(brand || '').toLowerCase()] || 'text-gray-500';
        return `<svg class="w-5 h-5 shrink-0 ${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/>
        </svg>`;
    }
})();
