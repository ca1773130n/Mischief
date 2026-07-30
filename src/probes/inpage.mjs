// Functions in this file are SERIALIZED INTO THE PAGE by page.evaluate().
// They therefore cannot close over anything — no imports, no module constants.
// Everything they need arrives as a single JSON-serializable argument, which is
// also why regexes are passed as { source, flags } rather than as RegExp.

/**
 * Enumerate clickable candidates, CLIPPED TO THE VIEWPORT.
 *
 * The viewport clip is load-bearing: because every candidate's click point is
 * the centre of its VISIBLE intersection, no scrolling is needed before the
 * click. Scrolling first would make clicks race lazy-loading and infinite lists,
 * and a seeded replay would stop reproducing.
 */
export function gatherCandidatesInPage({ dangerSource, dangerFlags, ignoreAttribute, maxCandidates }) {
  const danger = new RegExp(dangerSource, dangerFlags || 'i');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = [];
  const els = document.querySelectorAll('a, button, [role="button"], input[type="submit"], select, [tabindex]');
  for (const el of els) {
    if (out.length >= maxCandidates) break;
    if (ignoreAttribute && el.closest(`[${ignoreAttribute}]`)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const L = Math.max(r.left, 0);
    const T = Math.max(r.top, 0);
    const R = Math.min(r.right, vw);
    const B = Math.min(r.bottom, vh);
    if (R - L < 2 || B - T < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || parseFloat(cs.opacity) === 0)
      continue;
    const label = ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''))
      .replace(/\s+/g, ' ')
      .trim();
    out.push({
      x: Math.round((L + R) / 2),
      y: Math.round((T + B) / 2),
      tag: el.tagName.toLowerCase(),
      text: label.slice(0, 40),
      danger: danger.test(label),
    });
  }
  return out;
}

/**
 * Scan rendered TEXT for markup that should have been rendered away.
 *
 * This probe exists because assertions on JS exceptions, HTTP status, a11y and
 * layout say nothing about what the page SAYS. In the harness this was extracted
 * from, 22.8% of one table's rows rendered raw LaTeX and every automated run
 * scored a clean pass; a human found it. Patterns are supplied by config
 * precisely because "is `\frac` a defect" has no app-independent answer.
 */
export function textPatternsInPage({ patterns, skipSelector, maxHits }) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'NOSCRIPT']);
  const compiled = patterns.map((p) => ({ name: p.name, severity: p.severity, re: new RegExp(p.source, p.flags || '') }));
  const hits = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (skipSelector && p.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
      const cs = window.getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walk.nextNode()) && hits.length < maxHits) {
    const text = (node.nodeValue || '').trim();
    if (text.length < 3) continue;
    for (const { name, severity, re } of compiled) {
      if (!re.test(text)) continue;
      hits.push({ kind: name, severity, text: text.slice(0, 120), where: node.parentElement.tagName.toLowerCase() });
      break;
    }
  }
  return hits;
}

/**
 * Cheap accessibility counts. Not an axe-core replacement — three checks that
 * are unambiguous, need no ruleset, and correlate with the monkey's own blind
 * spot: an unlabeled button is also invisible to the danger guardrail.
 */
export function a11yPassInPage() {
  const imgs = [...document.images].filter((i) => !i.hasAttribute('alt'));
  const btns = [...document.querySelectorAll('button, a, [role="button"]')].filter((el) => {
    const txt = (el.innerText || '').trim();
    return !txt && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
  });
  const inputs = [...document.querySelectorAll('input:not([type=hidden]), textarea, select')].filter((el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder')) return false;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
    if (el.closest('label')) return false;
    return true;
  });
  return {
    imgsNoAlt: { count: imgs.length, samples: imgs.slice(0, 5).map((i) => (i.currentSrc || i.src || '').slice(0, 120)) },
    unlabeledButtons: { count: btns.length, samples: btns.slice(0, 5).map((b) => b.outerHTML.slice(0, 120)) },
    unlabeledInputs: { count: inputs.length },
  };
}

/** Images the browser finished loading with zero natural width — i.e. 404s. */
export function brokenImagesInPage() {
  return [...document.images]
    .filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith('data:'))
    .map((i) => i.src.slice(0, 200));
}

/** Horizontal overflow at the current viewport. +1 tolerance for sub-pixel rounding. */
export function overflowInPage() {
  return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
}

/** Perf snapshot; window.__qaPerf is filled by the init script's observers. */
export function perfInPage() {
  const nav = performance.getEntriesByType('navigation')[0];
  const q = window.__qaPerf || { lcp: 0, cls: 0 };
  return {
    lcp: q.lcp || 0,
    cls: q.cls || 0,
    dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
    load: nav ? Math.round(nav.loadEventEnd) : 0,
  };
}

/**
 * Installed via addInitScript, so it applies to EVERY document this tab loads.
 * A plain evaluate() would be lost on the next navigation, and this harness
 * navigates constantly.
 */
export function initScriptInPage({ blockWindowOpen }) {
  if (blockWindowOpen) {
    try {
      window.open = () => null;
    } catch {}
  }
  window.__qaPerf = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((l) => {
      const es = l.getEntries();
      if (es.length) window.__qaPerf.lcp = es[es.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__qaPerf.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
}
