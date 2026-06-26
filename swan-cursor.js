// Pink swan feet paddling cursor — shows on button mousedown, gone on mouseup/mouseleave
(function () {
  // SVG frames: two poses of pink webbed feet paddling
  const FRAMES = [
    // Frame A — feet spread wide
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <!-- left foot -->
      <ellipse cx="10" cy="28" rx="7" ry="4" fill="#FF69B4" transform="rotate(-20,10,28)"/>
      <line x1="10" y1="24" x2="7"  y2="16" stroke="#FF69B4" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="10" y1="24" x2="10" y2="15" stroke="#FF69B4" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="10" y1="24" x2="13" y2="16" stroke="#FF69B4" stroke-width="2.5" stroke-linecap="round"/>
      <!-- right foot -->
      <ellipse cx="30" cy="28" rx="7" ry="4" fill="#FF69B4" transform="rotate(20,30,28)"/>
      <line x1="30" y1="24" x2="27" y2="16" stroke="#FF69B4" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="30" y1="24" x2="30" y2="15" stroke="#FF69B4" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="30" y1="24" x2="33" y2="16" stroke="#FF69B4" stroke-width="2.5" stroke-linecap="round"/>
      <!-- ripple -->
      <ellipse cx="20" cy="34" rx="14" ry="3" fill="none" stroke="#FF69B4" stroke-width="1" opacity="0.5"/>
    </svg>`,
    // Frame B — feet tucked in (mid-stroke)
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <!-- left foot -->
      <ellipse cx="12" cy="30" rx="6" ry="3.5" fill="#FF1493" transform="rotate(-10,12,30)"/>
      <line x1="12" y1="27" x2="10" y2="18" stroke="#FF1493" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="12" y1="27" x2="13" y2="18" stroke="#FF1493" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="12" y1="27" x2="16" y2="19" stroke="#FF1493" stroke-width="2.5" stroke-linecap="round"/>
      <!-- right foot -->
      <ellipse cx="28" cy="30" rx="6" ry="3.5" fill="#FF1493" transform="rotate(10,28,30)"/>
      <line x1="28" y1="27" x2="24" y2="19" stroke="#FF1493" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="28" y1="27" x2="27" y2="18" stroke="#FF1493" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="28" y1="27" x2="30" y2="18" stroke="#FF1493" stroke-width="2.5" stroke-linecap="round"/>
      <!-- ripple -->
      <ellipse cx="20" cy="36" rx="12" ry="2.5" fill="none" stroke="#FF1493" stroke-width="1" opacity="0.5"/>
    </svg>`
  ];

  function svgToDataUrl(svg) {
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  const urls = FRAMES.map(svgToDataUrl);
  const cursorValues = urls.map(u => `url("${u}") 20 35, auto`);

  let frame = 0;
  let timer = null;

  function startPaddling(el) {
    frame = 0;
    el.style.cursor = cursorValues[frame];
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      el.style.cursor = cursorValues[frame];
    }, 150);
  }

  function stopPaddling(el) {
    clearInterval(timer);
    timer = null;
    el.style.cursor = '';
  }

  function attachSwanCursor(btn) {
    btn.addEventListener('mousedown', () => startPaddling(btn));
    btn.addEventListener('mouseup',   () => stopPaddling(btn));
    btn.addEventListener('mouseleave',() => stopPaddling(btn));
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
