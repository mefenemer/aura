// src/i18n.js
// US-I18N-1.1: Client-side i18n utility for public pages.
//
// Usage:
//   <script src="/src/i18n.js"></script>
//   Elements: <span data-i18n="nav.pricing"></span>
//   Attrs:    <input data-i18n-placeholder="common.submit">
//             <button data-i18n-title="common.close">
//   Page meta: <title data-i18n-title-key="pricing.title">
//              <meta name="description" data-i18n-meta-key="pricing.subtitle">
//
// Call window.i18n.apply() after dynamic content is injected.

(function () {
  const SUPPORTED = ['en', 'fr', 'de', 'es', 'pt'];
  const FALLBACK = 'en';
  const STORAGE_KEY = 'aura_lang';

  // Cache of loaded locale data
  const _cache = {};

  // Active translations object
  let _t = {};
  let _lang = FALLBACK;

  function detectBrowserLang() {
    const nav = navigator.language || navigator.userLanguage || '';
    const code = nav.slice(0, 2).toLowerCase();
    return SUPPORTED.includes(code) ? code : null;
  }

  function getStoredLang() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function storeLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }

  function resolveLang() {
    const stored = getStoredLang();
    if (stored && SUPPORTED.includes(stored)) return stored;
    const browser = detectBrowserLang();
    if (browser) return browser;
    return FALLBACK;
  }

  async function loadLocale(lang) {
    if (_cache[lang]) return _cache[lang];
    try {
      const res = await fetch(`/locales/${lang}.json`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();
      _cache[lang] = data;
      return data;
    } catch {
      if (lang !== FALLBACK) return loadLocale(FALLBACK);
      return {};
    }
  }

  // Resolve a dotted key like "nav.pricing" from translations object
  function resolve(key) {
    if (!key) return '';
    const parts = key.split('.');
    let obj = _t;
    for (const p of parts) {
      if (obj == null || typeof obj !== 'object') return key;
      obj = obj[p];
    }
    // Fallback: if value is missing, try English cache
    if (obj == null && _lang !== FALLBACK && _cache[FALLBACK]) {
      let fb = _cache[FALLBACK];
      for (const p of parts) {
        if (fb == null || typeof fb !== 'object') return key;
        fb = fb[p];
      }
      return fb != null ? String(fb) : key;
    }
    return obj != null ? String(obj) : key;
  }

  // Apply translations to all data-i18n elements in a container
  function apply(root) {
    root = root || document;

    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = resolve(key);
      if (val !== key) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.value = val;
        } else {
          el.textContent = val;
        }
      }
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const val = resolve(el.getAttribute('data-i18n-placeholder'));
      if (val) el.placeholder = val;
    });

    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const val = resolve(el.getAttribute('data-i18n-title'));
      if (val) el.title = val;
    });

    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const val = resolve(el.getAttribute('data-i18n-html'));
      if (val !== el.getAttribute('data-i18n-html')) el.innerHTML = val;
    });

    // Page title
    const titleKeyEl = document.querySelector('[data-i18n-title-key]');
    if (titleKeyEl) {
      const val = resolve(titleKeyEl.getAttribute('data-i18n-title-key'));
      if (val) document.title = val + ' | Aura-Assist';
    }

    // Meta description
    const metaEl = document.querySelector('meta[data-i18n-meta-key]');
    if (metaEl) {
      const val = resolve(metaEl.getAttribute('data-i18n-meta-key'));
      if (val) metaEl.setAttribute('content', val);
    }
  }

  // Inject hreflang link tags (SC4)
  function injectHreflang() {
    const base = window.location.origin + window.location.pathname;
    SUPPORTED.forEach(lang => {
      const existing = document.querySelector(`link[hreflang="${lang}"]`);
      if (!existing) {
        const link = document.createElement('link');
        link.rel = 'alternate';
        link.hreflang = lang;
        link.href = base + `?lang=${lang}`;
        document.head.appendChild(link);
      }
    });
    // x-default
    if (!document.querySelector('link[hreflang="x-default"]')) {
      const def = document.createElement('link');
      def.rel = 'alternate';
      def.hreflang = 'x-default';
      def.href = base;
      document.head.appendChild(def);
    }
  }

  // Public: switch to a language and re-render
  async function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    _lang = lang;
    storeLang(lang);
    _t = await loadLocale(lang);
    document.documentElement.lang = lang;
    apply();
    // Update selector if present
    document.querySelectorAll('.i18n-lang-selector').forEach(sel => { sel.value = lang; });
    // Dispatch event so page-specific scripts can react
    window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
  }

  // Public: get a translation value
  function t(key) { return resolve(key); }

  // Bootstrap on DOMContentLoaded
  async function init() {
    // Allow ?lang= query param to override
    const urlLang = new URLSearchParams(window.location.search).get('lang');
    const targetLang = (urlLang && SUPPORTED.includes(urlLang)) ? urlLang : resolveLang();
    _lang = targetLang;
    if (urlLang && SUPPORTED.includes(urlLang)) storeLang(urlLang);

    _t = await loadLocale(_lang);
    document.documentElement.lang = _lang;
    apply();
    injectHreflang();
  }

  // Expose global API
  window.i18n = { init, setLang, t, apply, SUPPORTED, resolveLang };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
