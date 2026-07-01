// BMS favicon cursor — shows while hovering a button, not just the mousedown/mouseup flash
(function () {
  const CURSOR_VALUE = 'url("/favicon/favicon-32x32.png") 16 16, pointer';

  function showFavicon(el) {
    el.style.cursor = CURSOR_VALUE;
  }

  function hideFavicon(el) {
    el.style.cursor = '';
  }

  function attachSwanCursor(btn) {
    btn.addEventListener('mouseenter', () => showFavicon(btn));
    btn.addEventListener('mouseleave', () => hideFavicon(btn));
  }

  function initSwanCursor() {
    document.querySelectorAll('button, [type="button"], [type="submit"], [role="button"]')
      .forEach(attachSwanCursor);

    // Watch for dynamically added buttons (modals etc.)
    new MutationObserver(mutations => {
      mutations.forEach(m => m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches('button, [type="button"], [type="submit"], [role="button"]')) {
          attachSwanCursor(node);
        }
        node.querySelectorAll && node.querySelectorAll(
          'button, [type="button"], [type="submit"], [role="button"]'
        ).forEach(attachSwanCursor);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSwanCursor);
  } else {
    initSwanCursor();
  }
})();
