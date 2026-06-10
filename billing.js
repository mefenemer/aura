// billing.js — Billing & Subscription page controller
(function () {

    // ── Module state ──────────────────────────────────────────────
    let _subscriptions  = [];
    let _cancelTarget   = null;

    // Stripe Elements state
    let _stripe         = null;
    let _elements       = null;
    let _cardNumber     = null;
    let _cardExpiry     = null;
    let _cardCvc        = null;
    let _setupClientSecret = null;

    // ── Public entry point ────────────────────────────────────────
    window.initBilling = async function () {
        _cancelTarget = null;
        _showState('loading');
        try {
            const res = await fetch('/.netlify/functions/billing-data');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const { subscriptions, paymentHistory } = await res.json();
            _subscriptions = subscriptions || [];
            _render(_subscriptions, paymentHistory || []);
        } catch (e) {
            console.error('[billing]', e);
            const msg = document.getElementById('billing-error-msg');
            if (msg) msg.textContent = e.message || 'Unable to load billing data.';
            _showState('error');
        }
    };

    // ── Card Modal ────────────────────────────────────────────────
    window._billingOpenCardModal = async function () {
        // Reset modal state
        _setupClientSecret = null;
        _stripe = null;
        _cardNumber = _cardExpiry = _cardCvc = null;

        const modal      = document.getElementById('modal-card-form');
        const loadingEl  = document.getElementById('card-form-loading');
        const fieldsEl   = document.getElementById('card-form-fields');
        const errorEl    = document.getElementById('card-form-error');
        const saveBtn    = document.getElementById('btn-save-card');

        // Show modal in loading state
        modal.classList.remove('hidden');
        loadingEl.classList.remove('hidden');
        fieldsEl.classList.add('hidden');
        errorEl.classList.add('hidden');
        saveBtn.disabled = true;
        document.getElementById('card-holder-name').value = '';

        try {
            // 1. Get SetupIntent client secret + publishable key from our backend
            const res  = await fetch('/.netlify/functions/billing-setup-intent', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            _setupClientSecret = data.clientSecret;
            const publishableKey = data.publishableKey;
            if (!publishableKey) throw new Error('Stripe is not configured on this account.');

            // 2. Load Stripe.js lazily (avoid loading on every page)
            if (!window.Stripe) {
                await _loadStripeJs();
            }
            _stripe = window.Stripe(publishableKey);

            // 3. Mount individual Elements for custom styling
            const elementStyle = {
                base: {
                    fontSize: '14px',
                    color: '#111827',
                    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
                    fontSmoothing: 'antialiased',
                    '::placeholder': { color: '#9ca3af' },
                },
                invalid: { color: '#dc2626', iconColor: '#dc2626' },
            };

            _elements   = _stripe.elements();
            _cardNumber = _elements.create('cardNumber', { style: elementStyle, showIcon: true });
            _cardExpiry = _elements.create('cardExpiry', { style: elementStyle });
            _cardCvc    = _elements.create('cardCvc',    { style: elementStyle });

            _cardNumber.mount('#stripe-card-number');
            _cardExpiry.mount('#stripe-card-expiry');
            _cardCvc.mount('#stripe-card-cvc');

            // Enable save once card number is valid
            _cardNumber.on('change', e => {
                saveBtn.disabled = !e.complete;
                if (e.error) {
                    errorEl.textContent = e.error.message;
                    errorEl.classList.remove('hidden');
                } else {
                    errorEl.classList.add('hidden');
                }
            });

            // Show fields
            loadingEl.classList.add('hidden');
            fieldsEl.classList.remove('hidden');

        } catch (e) {
            console.error('[billing-card-modal]', e);
            loadingEl.innerHTML = `<p class="text-sm text-red-500">${e.message || 'Failed to load card form.'}</p>`;
        }
    };

    window._billingCloseCardModal = function () {
        document.getElementById('modal-card-form').classList.add('hidden');
        // Unmount Elements to avoid double-mount errors if re-opened
        if (_cardNumber) { try { _cardNumber.unmount(); } catch (_) {} _cardNumber = null; }
        if (_cardExpiry) { try { _cardExpiry.unmount(); } catch (_) {} _cardExpiry = null; }
        if (_cardCvc)    { try { _cardCvc.unmount();    } catch (_) {} _cardCvc    = null; }
        _stripe = null;
        _elements = null;
        _setupClientSecret = null;
    };

    window._billingSaveCard = async function () {
        if (!_stripe || !_setupClientSecret || !_cardNumber) return;

        const saveBtn  = document.getElementById('btn-save-card');
        const errorEl  = document.getElementById('card-form-error');
        const nameEl   = document.getElementById('card-holder-name');

        saveBtn.disabled = true;
        saveBtn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Saving…`;
        errorEl.classList.add('hidden');

        try {
            // Confirm the SetupIntent — Stripe tokenises the card in its iframe,
            // no raw card data touches our servers
            const { setupIntent, error } = await _stripe.confirmCardSetup(_setupClientSecret, {
                payment_method: {
                    card: _cardNumber,
                    billing_details: { name: nameEl.value.trim() || undefined },
                },
            });

            if (error) throw new Error(error.message);
            if (!setupIntent?.payment_method) throw new Error('Card setup did not complete.');

            // Attach the PaymentMethod to the customer + set as default
            const res  = await fetch('/.netlify/functions/billing-attach-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paymentMethodId: setupIntent.payment_method }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            // Update the payment method section in the UI immediately (no full reload)
            if (data.paymentMethod) {
                _updatePaymentMethodUI(data.paymentMethod);
            }

            window._billingCloseCardModal();

        } catch (e) {
            console.error('[billing-save-card]', e);
            errorEl.textContent = e.message || 'Failed to save card. Please try again.';
            errorEl.classList.remove('hidden');
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg> Save Card`;
        }
    };

    // ── Cancel Subscription ───────────────────────────────────────
    window._billingOpenCancelModal = function (stripeSubscriptionId, planName, renewalDate) {
        _cancelTarget = { stripeSubscriptionId, planName, renewalDate };

        const msg     = document.getElementById('cancel-sub-msg');
        const endDate = renewalDate ? _fmtDate(renewalDate) : 'the end of the billing period';
        if (msg) {
            msg.textContent = `"${planName}" will remain active until ${endDate}, then it will not renew. You will lose access to this assistant at that point.`;
        }

        const errEl = document.getElementById('cancel-sub-error');
        if (errEl) errEl.classList.add('hidden');

        const confirmBtn = document.getElementById('btn-confirm-cancel');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Cancel'; }

        document.getElementById('modal-cancel-sub').classList.remove('hidden');
    };

    window._billingCloseCancelModal = function () {
        document.getElementById('modal-cancel-sub').classList.add('hidden');
        _cancelTarget = null;
    };

    window._billingConfirmCancel = async function () {
        if (!_cancelTarget) return;
        const { stripeSubscriptionId } = _cancelTarget;

        const confirmBtn = document.getElementById('btn-confirm-cancel');
        const errEl      = document.getElementById('cancel-sub-error');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Cancelling…'; }
        if (errEl) errEl.classList.add('hidden');

        try {
            const res  = await fetch('/.netlify/functions/billing-cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stripeSubscriptionId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            document.getElementById('modal-cancel-sub').classList.add('hidden');
            _cancelTarget = null;
            await window.initBilling();

        } catch (e) {
            console.error('[billing-cancel]', e);
            if (errEl) { errEl.textContent = e.message || 'Failed to cancel. Please try again.'; errEl.classList.remove('hidden'); }
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Cancel'; }
        }
    };

    // ── State helpers ─────────────────────────────────────────────
    function _showState(state) {
        document.getElementById('billing-loading').classList.toggle('hidden', state !== 'loading');
        document.getElementById('billing-error').classList.toggle('hidden', state !== 'error');
        document.getElementById('billing-content').classList.toggle('hidden', state !== 'content');
    }

    // ── Main render ───────────────────────────────────────────────
    function _render(subscriptions, paymentHistory) {
        _renderSubscriptions(subscriptions);
        _renderPaymentMethod(subscriptions);
        _renderHistory(paymentHistory);

        const badge = document.getElementById('billing-sync-badge');
        if (badge) { badge.classList.remove('hidden'); badge.classList.add('flex'); }

        _showState('content');
    }

    // ── Subscriptions ─────────────────────────────────────────────
    function _renderSubscriptions(subs) {
        const list  = document.getElementById('subscriptions-list');
        const empty = document.getElementById('subscriptions-empty');

        const active = subs.filter(s =>
            ['active', 'trialing'].includes(s.stripeStatus || '') || s.status === 'active'
        );

        if (active.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
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
        const sm     = statusMeta[sub.stripeStatus || sub.status] || statusMeta['active'];
        const cycle  = sub.billingCycle === 'year' ? 'Annually' : 'Monthly';
        const amount = sub.amountGbp ? `£${parseFloat(sub.amountGbp).toFixed(2)}`
                     : sub.currency  ? `${sub.currency.toUpperCase()} —` : '—';

        const renewalLine = sub.cancelAtPeriodEnd
            ? `<span class="text-amber-600 font-semibold">Cancels on ${_fmtDate(sub.renewalDate)}</span>`
            : sub.renewalDate
                ? `Renews <span class="font-semibold text-gray-800">${_fmtDate(sub.renewalDate)}</span>`
                : `Started <span class="font-semibold text-gray-800">${_fmtDate(sub.startedAt)}</span>`;

        const canCancel = sub.stripeSubscriptionId && !sub.cancelAtPeriodEnd &&
                          !['cancelled', 'canceled'].includes(sub.stripeStatus || sub.status);
        const cancelBtn = canCancel
            ? `<button onclick="window._billingOpenCancelModal('${_esc(sub.stripeSubscriptionId)}','${_esc(sub.planName)}','${sub.renewalDate || ''}')"
                 class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-600 hover:text-red-700 border border-red-200 hover:border-red-300 bg-red-50 hover:bg-red-100 rounded-lg transition cursor-pointer">
                 <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                 Cancel Subscription
               </button>`
            : sub.cancelAtPeriodEnd
                ? `<span class="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">Cancels at period end</span>`
                : '';

        return `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1 flex-wrap">
                <h3 class="text-base font-extrabold text-gray-900">${_esc(sub.planName)}</h3>
                <span class="text-xs font-bold px-2.5 py-1 rounded-full border ${sm.cls}">${sm.label}</span>
              </div>
              <p class="text-sm text-gray-500">${cycle} billing · ${renewalLine}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="text-2xl font-extrabold text-gray-900">${amount}</p>
              <p class="text-xs text-gray-400">per ${_esc(sub.billingCycle || 'month')}</p>
            </div>
          </div>
          ${cancelBtn ? `<div class="mt-4 pt-4 border-t border-gray-100 flex justify-end">${cancelBtn}</div>` : ''}
        </div>`;
    }

    // ── Payment Method ────────────────────────────────────────────
    function _renderPaymentMethod(subs) {
        const cardEl  = document.getElementById('payment-method-card');
        const emptyEl = document.getElementById('payment-method-empty');
        const pm      = subs.find(s => s.paymentMethod)?.paymentMethod || null;

        if (!pm) { cardEl.classList.add('hidden'); emptyEl.classList.remove('hidden'); return; }
        emptyEl.classList.add('hidden');
        cardEl.classList.remove('hidden');
        _applyPaymentMethodToUI(pm);
    }

    function _applyPaymentMethodToUI(pm) {
        const brandBadge = document.getElementById('pm-brand-badge');
        if (brandBadge) brandBadge.innerHTML = _brandBadgeHtml(pm.brand);

        const brandLabel = document.getElementById('pm-brand-label');
        if (brandLabel) brandLabel.textContent = pm.brand || 'Card';

        const last4El = document.getElementById('pm-last4');
        if (last4El) last4El.textContent = pm.last4 || '';

        const expiryEl = document.getElementById('pm-expiry');
        if (expiryEl) expiryEl.textContent = `${String(pm.expMonth).padStart(2, '0')} / ${pm.expYear}`;

        const warnEl = document.getElementById('pm-expiry-warn');
        if (warnEl && pm.expMonth && pm.expYear) {
            const expiryDate = new Date(pm.expYear, pm.expMonth - 1, 1);
            const soon       = new Date(); soon.setDate(soon.getDate() + 60);
            warnEl.classList.toggle('hidden', expiryDate > soon);
        }
    }

    // Called after a card is saved — updates the UI without a full reload
    function _updatePaymentMethodUI(pm) {
        const cardEl  = document.getElementById('payment-method-card');
        const emptyEl = document.getElementById('payment-method-empty');
        emptyEl.classList.add('hidden');
        cardEl.classList.remove('hidden');
        _applyPaymentMethodToUI(pm);
    }

    function _brandBadgeHtml(brand) {
        const b = (brand || '').toLowerCase();
        const badges = {
            visa:       `<span class="text-blue-800 font-extrabold text-sm tracking-widest">VISA</span>`,
            mastercard: `<span class="text-red-600 font-extrabold text-sm">MC</span>`,
            amex:       `<span class="text-blue-500 font-extrabold text-xs tracking-wide">AMEX</span>`,
            discover:   `<span class="text-orange-500 font-extrabold text-xs">DISC</span>`,
        };
        return badges[b] || `<svg class="w-7 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`;
    }

    // ── Payment History ───────────────────────────────────────────
    function _renderHistory(payments) {
        const wrap  = document.getElementById('history-wrap');
        const empty = document.getElementById('history-empty');
        const tbody = document.getElementById('history-tbody');

        if (payments.length === 0) { wrap.classList.add('hidden'); empty.classList.remove('hidden'); return; }
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
            const sm       = statusMeta[(p.status || '').toLowerCase()] || { label: p.status || '—', cls: 'bg-gray-100 text-gray-600' };
            const currency = (p.currency || 'GBP').toUpperCase();
            const symbol   = currency === 'GBP' ? '£' : `${currency} `;
            const amount   = p.amount ? `${symbol}${parseFloat(p.amount).toFixed(2)}` : '—';

            let pmCell = '—';
            if (p.paymentMethod && typeof p.paymentMethod === 'object') {
                pmCell = `<div class="flex items-center gap-1.5">${_cardIconSvg(p.paymentMethod.brand)}<span class="capitalize">${_esc(p.paymentMethod.brand)}</span> ···· ${_esc(p.paymentMethod.last4)}</div>`;
            } else if (typeof p.paymentMethod === 'string' && p.paymentMethod) {
                pmCell = _esc(p.paymentMethod);
            }

            const receiptCell = p.receiptUrl
                ? `<a href="${p.receiptUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 font-bold text-sm transition">
                     <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>Invoice
                   </a>`
                : `<span class="text-gray-300 text-xs">—</span>`;

            return `
            <tr class="hover:bg-gray-50 transition">
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${_fmtDate(p.date)}</td>
              <td class="px-5 py-4 font-medium text-gray-900">${_esc(p.description || '—')}</td>
              <td class="px-5 py-4 font-bold text-gray-900 whitespace-nowrap">${amount}</td>
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${pmCell}</td>
              <td class="px-5 py-4"><span class="text-xs font-bold px-2.5 py-1 rounded-full ${sm.cls}">${sm.label}</span></td>
              <td class="px-5 py-4 text-right">${receiptCell}</td>
            </tr>`;
        }).join('');
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _loadStripeJs() {
        return new Promise((resolve, reject) => {
            if (document.getElementById('stripe-js')) { resolve(); return; }
            const s    = document.createElement('script');
            s.id       = 'stripe-js';
            s.src      = 'https://js.stripe.com/v3/';
            s.onload   = resolve;
            s.onerror  = () => reject(new Error('Failed to load Stripe.js'));
            document.head.appendChild(s);
        });
    }

    function _fmtDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function _esc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _cardIconSvg(brand) {
        const colors = { visa: 'text-blue-700', mastercard: 'text-red-600', amex: 'text-blue-500', discover: 'text-orange-600' };
        const cls = colors[(brand || '').toLowerCase()] || 'text-gray-500';
        return `<svg class="w-5 h-5 shrink-0 ${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`;
    }

})();
