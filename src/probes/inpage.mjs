// Functions in this file are SERIALIZED INTO THE PAGE by page.evaluate().
// They therefore cannot close over anything — no imports, no module constants.
// Everything they need arrives as a single JSON-serializable argument, which is
// also why regexes are passed as { source, flags } rather than as RegExp.
//
// ---------------------------------------------------------------------------
// qaWalk — why it exists, and why it is COPY-PASTED into four functions
// ---------------------------------------------------------------------------
// document.querySelectorAll does not pierce shadow roots, and neither does a
// TreeWalker. On any app built out of custom elements (Lit, Stencil, Ionic,
// Vaadin, LWC, most design systems) that meant zero click candidates, zero text
// scanned and zero a11y counts: the monkey logged "no candidate" for all 40
// steps and the run exited 0 CLEAN. A false green from a harness that never
// touched the app is the exact failure this package exists to refuse.
//
// The serialization rule above forbids a shared module helper, so the walk is
// duplicated verbatim between `/* @qa-walk */` markers in every probe that needs
// it. test/inpage.walk.test.mjs asserts the copies are byte-identical — that
// assertion is what makes the duplication safe. Edit one, edit all of them.
//
// TRAVERSAL ORDER IS A REPLAY KEY: element -> its open shadow tree -> its
// slotted light children, children in DOM order. Children are pushed in reverse
// so they pop in DOM order; shadow children are pushed last so they pop first.
// On a page with no shadow roots that is exactly document order — exactly what
// querySelectorAll returned — so seeds recorded before this change still replay.
//
// A light child of a shadow host is included only when it has an assignedSlot,
// i.e. only when it renders somewhere. An earlier draft of this comment claimed
// slot assignment was "deliberately not resolved"; reading `assignedSlot` IS
// reading resolved slot assignment, so that was simply wrong. What is not
// resolved is the FLAT TREE: no assignedNodes() walk, no { flatten: true }, so a
// slotted child is still visited at its light-DOM position rather than at the
// slot's, and one element is visited exactly once. Including unassigned children
// instead is not an option — an unslotted child's getComputedStyle does not say
// display:none, so the text probe would report text that renders NOWHERE, and the
// a11y probe would count controls no user can reach. (The membership of that set
// does depend on whether component JS has run, but so does the existence of the
// shadow tree itself: any scan of a hydrating DOM sees a hydrating DOM. The
// candidate-settle poll in browser/guardrails.mjs is what buys stability, not the
// filter.)
//
// `ignoreAttribute` is applied as a top-down PRUNE rather than the el.closest()
// it replaces: closest() stops dead at a ShadowRoot, so `data-qa-ignore` on a
// host never protected that host's shadow tree. Pruning makes the inheritance
// structural — prune a host and its shadow tree is never pushed.
//
// CLOSED shadow roots stay unreachable: el.shadowRoot is null and nothing in
// page script can reach them. They are COUNTED (closedSuspects) and reported
// instead of silently missed; guardrails.forceOpenShadowRoots is the opt-in
// escape hatch. Iframes are likewise out of reach — page.evaluate is main-frame
// only, and per-frame scanning needs coordinate translation.
//
// closedSuspects is a SUSPICION, and its heuristic has to earn that: a defined
// custom element with no open root and no element children. Without the
// textContent test as well, `<my-badge>New</my-badge>` and an `<x-icon>` that
// draws itself with CSS — both defined, both childless, neither hiding anything —
// were counted, and the report then stated the closed-root diagnosis as fact and
// told the user to switch on forceOpenShadowRoots, which changes the app under
// test, for a root that does not exist.

/**
 * Enumerate clickable candidates, CLIPPED TO THE VIEWPORT.
 *
 * The viewport clip is load-bearing: because every candidate's click point is
 * the centre of its VISIBLE intersection, no scrolling is needed before the
 * click. Scrolling first would make clicks race lazy-loading and infinite lists,
 * and a seeded replay would stop reproducing.
 *
 * Returns the candidate list PLUS the census that proves it was really empty:
 * `truncated` (scan budget hit — coverage is partial), `capped` (config cap hit
 * — the tail was never offered) and `shadow` (what piercing found). A bare empty
 * array cannot tell "nothing to click" from "the probe never looked".
 */
export function gatherCandidatesInPage({ selector, dangerSource, dangerFlags, ignoreAttribute, maxCandidates, maxScanNodes }) {
  /* @qa-walk */
  function qaWalk(root, opts, visit) {
    const INERT = { HEAD: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const attr = opts.pruneAttribute || '';
    const pruneSel = opts.pruneSelector || '';
    const maxNodes = opts.maxNodes > 0 ? opts.maxNodes : 20000;
    const stack = [root];
    const hosts = [];
    let visited = 0, truncated = false, openRoots = 0, closedSuspects = 0, undefinedEls = 0;
    while (stack.length) {
      const el = stack.pop();
      if (INERT[el.tagName]) continue;
      if (attr && el.hasAttribute(attr)) continue;
      if (pruneSel) {
        try {
          if (el.matches(pruneSel)) continue;
        } catch {}
      }
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      visited++;
      if (visit(el) === false) break;
      const sr = el.shadowRoot;
      const custom = el.localName.indexOf('-') > 0 && el.namespaceURI === 'http://www.w3.org/1999/xhtml';
      if (sr) openRoots++;
      else if (custom) {
        const defined = !!(window.customElements && customElements.get(el.localName));
        if (!defined) undefinedEls++;
        // textContent too, not just children: a text-only component is childless. See header.
        else if (!el.children.length && !(el.textContent || '').trim()) {
          closedSuspects++;
          if (hosts.indexOf(el.localName) < 0 && hosts.length < 5) hosts.push(el.localName);
        }
      }
      const kids = el.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        if (sr && !kids[i].assignedSlot) continue;
        stack.push(kids[i]);
      }
      if (sr) {
        const sk = sr.children;
        for (let i = sk.length - 1; i >= 0; i--) stack.push(sk[i]);
      }
    }
    return { visited, truncated, openRoots, closedSuspects, undefinedEls, hosts };
  }
  /* @qa-walk-end */

  const danger = new RegExp(dangerSource, dangerFlags || 'i');
  const sel = selector || 'a, button, [role="button"], input[type="submit"], select, [tabindex]';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = [];
  const scan = qaWalk(document.documentElement, { pruneAttribute: ignoreAttribute, maxNodes: maxScanNodes }, (el) => {
    if (out.length >= maxCandidates) return false;
    // A user-supplied clickableSelector that does not parse must not take the
    // whole scan down: safeEval would swallow the throw and the run would read
    // as "nothing to click".
    let matched = false;
    try {
      matched = el.matches(sel);
    } catch {}
    if (!matched) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const L = Math.max(r.left, 0);
    const T = Math.max(r.top, 0);
    const R = Math.min(r.right, vw);
    const B = Math.min(r.bottom, vh);
    if (R - L < 2 || B - T < 2) return;
    // getComputedStyle is the layout-forcing call, so it stays LAST: gated
    // behind matches() it runs once per candidate, not once per node.
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || parseFloat(cs.opacity) === 0)
      return;
    const label = ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''))
      .replace(/\s+/g, ' ')
      .trim();
    out.push({
      x: Math.round((L + R) / 2),
      y: Math.round((T + B) / 2),
      tag: el.tagName.toLowerCase(),
      text: label.slice(0, 40),
      danger: danger.test(label),
      // Identity, for the dead-control probe. `text` alone is empty on an
      // icon-only button (the same blind spot a11yPassInPage counts as
      // unlabeledButtons), and an identity of `button ""` merges every unlabeled
      // control on the page into one — which would report the wrong control by
      // name. `role` also decides eligibility: a <div role="button"> is a real
      // control, a bare [tabindex] div is not.
      id: el.id || '',
      role: el.getAttribute('role') || '',
    });
  });
  return {
    candidates: out,
    selector: sel,
    scanned: scan.visited,
    truncated: scan.truncated,
    capped: out.length >= maxCandidates,
    shadow: {
      openRoots: scan.openRoots,
      closedSuspects: scan.closedSuspects,
      undefinedEls: scan.undefinedEls,
      hosts: scan.hosts,
    },
  };
}

/**
 * Scan rendered TEXT for markup that should have been rendered away.
 *
 * This probe exists because assertions on JS exceptions, HTTP status, a11y and
 * layout say nothing about what the page SAYS. In the harness this was extracted
 * from, 22.8% of one table's rows rendered raw LaTeX and every automated run
 * scored a clean pass; a human found it. Patterns are supplied by config
 * precisely because "is `\frac` a defect" has no app-independent answer.
 *
 * Deliberately does NOT honour ignoreAttribute: that would REDUCE findings
 * versus a subtree the user only meant to keep the monkey's hands off.
 *
 * Returns { hits, truncated, capped } rather than a bare array: hits default to
 * severity 'high' and therefore move the exit code, so a scan that stopped early
 * must be able to say so. A bare array made "no leaked markup" and "stopped
 * looking after 25" the same answer.
 */
export function textPatternsInPage({ patterns, skipSelector, maxHits, maxScanNodes }) {
  /* @qa-walk */
  function qaWalk(root, opts, visit) {
    const INERT = { HEAD: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const attr = opts.pruneAttribute || '';
    const pruneSel = opts.pruneSelector || '';
    const maxNodes = opts.maxNodes > 0 ? opts.maxNodes : 20000;
    const stack = [root];
    const hosts = [];
    let visited = 0, truncated = false, openRoots = 0, closedSuspects = 0, undefinedEls = 0;
    while (stack.length) {
      const el = stack.pop();
      if (INERT[el.tagName]) continue;
      if (attr && el.hasAttribute(attr)) continue;
      if (pruneSel) {
        try {
          if (el.matches(pruneSel)) continue;
        } catch {}
      }
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      visited++;
      if (visit(el) === false) break;
      const sr = el.shadowRoot;
      const custom = el.localName.indexOf('-') > 0 && el.namespaceURI === 'http://www.w3.org/1999/xhtml';
      if (sr) openRoots++;
      else if (custom) {
        const defined = !!(window.customElements && customElements.get(el.localName));
        if (!defined) undefinedEls++;
        // textContent too, not just children: a text-only component is childless. See header.
        else if (!el.children.length && !(el.textContent || '').trim()) {
          closedSuspects++;
          if (hosts.indexOf(el.localName) < 0 && hosts.length < 5) hosts.push(el.localName);
        }
      }
      const kids = el.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        if (sr && !kids[i].assignedSlot) continue;
        stack.push(kids[i]);
      }
      if (sr) {
        const sk = sr.children;
        for (let i = sk.length - 1; i >= 0; i--) stack.push(sk[i]);
      }
    }
    return { visited, truncated, openRoots, closedSuspects, undefinedEls, hosts };
  }
  /* @qa-walk-end */

  // CODE/PRE/TEXTAREA are probe-specific: markup shown ON PURPOSE is not a leak.
  const SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  const compiled = patterns.map((p) => ({ name: p.name, severity: p.severity, re: new RegExp(p.source, p.flags || '') }));

  // The fallback content of a FILLED <slot> renders nowhere, and — exactly like an
  // unslotted light child — its computed style is not 'none', so the style gate
  // below cannot see it. Piercing shadow roots is what made this reachable at all;
  // the old TreeWalker never entered a shadow tree. Evaluated lazily, only for
  // elements that actually own text, so the walk stays cheap.
  const inFilledSlot = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.tagName === 'SLOT' && n.assignedNodes && n.assignedNodes().length) return true;
      n = n.parentNode; // a ShadowRoot is nodeType 11, which ends the walk
    }
    return false;
  };

  const hits = [];
  let capped = false;
  const scan = qaWalk(document.documentElement, { pruneSelector: skipSelector, maxNodes: maxScanNodes }, (el) => {
    if (hits.length >= maxHits) {
      capped = true;
      return false;
    }
    if (SKIP[el.tagName]) return;
    const sr = el.shadowRoot;
    let cs = null;
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = (node.nodeValue || '').trim();
      if (text.length < 3) continue;
      // A light child of a shadow host renders only where a slot places it, and
      // an unassigned one renders nowhere — yet its computed style is not 'none',
      // so the gate below cannot see that it is invisible.
      if (sr && !node.assignedSlot) continue;
      if (cs === null) {
        cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (inFilledSlot(el)) return;
      }
      for (const { name, severity, re } of compiled) {
        if (!re.test(text)) continue;
        hits.push({ kind: name, severity, text: text.slice(0, 120), where: el.tagName.toLowerCase() });
        break;
      }
      if (hits.length >= maxHits) {
        capped = true;
        return false;
      }
    }
  });
  return { hits, truncated: scan.truncated, capped };
}

/**
 * Cheap accessibility counts. Not an axe-core replacement — three checks that
 * are unambiguous, need no ruleset, and correlate with the monkey's own blind
 * spot: an unlabeled button is also invisible to the danger guardrail.
 */
export function a11yPassInPage({ maxScanNodes }) {
  /* @qa-walk */
  function qaWalk(root, opts, visit) {
    const INERT = { HEAD: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const attr = opts.pruneAttribute || '';
    const pruneSel = opts.pruneSelector || '';
    const maxNodes = opts.maxNodes > 0 ? opts.maxNodes : 20000;
    const stack = [root];
    const hosts = [];
    let visited = 0, truncated = false, openRoots = 0, closedSuspects = 0, undefinedEls = 0;
    while (stack.length) {
      const el = stack.pop();
      if (INERT[el.tagName]) continue;
      if (attr && el.hasAttribute(attr)) continue;
      if (pruneSel) {
        try {
          if (el.matches(pruneSel)) continue;
        } catch {}
      }
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      visited++;
      if (visit(el) === false) break;
      const sr = el.shadowRoot;
      const custom = el.localName.indexOf('-') > 0 && el.namespaceURI === 'http://www.w3.org/1999/xhtml';
      if (sr) openRoots++;
      else if (custom) {
        const defined = !!(window.customElements && customElements.get(el.localName));
        if (!defined) undefinedEls++;
        // textContent too, not just children: a text-only component is childless. See header.
        else if (!el.children.length && !(el.textContent || '').trim()) {
          closedSuspects++;
          if (hosts.indexOf(el.localName) < 0 && hosts.length < 5) hosts.push(el.localName);
        }
      }
      const kids = el.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        if (sr && !kids[i].assignedSlot) continue;
        stack.push(kids[i]);
      }
      if (sr) {
        const sk = sr.children;
        for (let i = sk.length - 1; i >= 0; i--) stack.push(sk[i]);
      }
    }
    return { visited, truncated, openRoots, closedSuspects, undefinedEls, hosts };
  }
  /* @qa-walk-end */

  const imgs = [];
  const btns = [];
  const inputs = [];
  const scan = qaWalk(document.documentElement, { maxNodes: maxScanNodes }, (el) => {
    if (el.tagName === 'IMG') imgs.push(el);
    try {
      if (el.matches('button, a, [role="button"]')) btns.push(el);
      else if (el.matches('input:not([type=hidden]), textarea, select')) inputs.push(el);
    } catch {}
  });
  // Walking up must hop the shadow boundary: el.closest('label') terminates at a
  // ShadowRoot, so a light-DOM <label> wrapping a custom element read as unlabeled.
  const inLabel = (el) => {
    let n = el;
    while (n) {
      if (n.nodeType === 1 && n.tagName === 'LABEL') return true;
      n = n.parentNode;
      if (n && n.nodeType === 11 && n.host) n = n.host;
    }
    return false;
  };
  const noAlt = imgs.filter((i) => !i.hasAttribute('alt'));
  const unnamed = btns.filter((el) => {
    const txt = (el.innerText || '').trim();
    return !txt && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
  });
  const unlabeled = inputs.filter((el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder')) return false;
    // ids are scoped PER SHADOW ROOT, so document.querySelector would match a
    // same-id label in an unrelated tree. getRootNode() is document for
    // light-DOM elements, which keeps this identical there.
    if (el.id && el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
    if (inLabel(el)) return false;
    return true;
  });
  return {
    imgsNoAlt: { count: noAlt.length, samples: noAlt.slice(0, 5).map((i) => (i.currentSrc || i.src || '').slice(0, 120)) },
    unlabeledButtons: { count: unnamed.length, samples: unnamed.slice(0, 5).map((b) => b.outerHTML.slice(0, 120)) },
    unlabeledInputs: { count: unlabeled.length },
    // The a11y walk has its own budget exhaustion, independent of whether the
    // clickable census even ran. Dropping it made the truncation silent, which is
    // exactly what the maxScanNodes comment forbids.
    truncated: scan.truncated,
  };
}

/**
 * Images the browser finished loading with zero natural width — i.e. 404s.
 * Returns { images, truncated } so a budget-limited walk is not silent.
 */
export function brokenImagesInPage({ maxScanNodes }) {
  /* @qa-walk */
  function qaWalk(root, opts, visit) {
    const INERT = { HEAD: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const attr = opts.pruneAttribute || '';
    const pruneSel = opts.pruneSelector || '';
    const maxNodes = opts.maxNodes > 0 ? opts.maxNodes : 20000;
    const stack = [root];
    const hosts = [];
    let visited = 0, truncated = false, openRoots = 0, closedSuspects = 0, undefinedEls = 0;
    while (stack.length) {
      const el = stack.pop();
      if (INERT[el.tagName]) continue;
      if (attr && el.hasAttribute(attr)) continue;
      if (pruneSel) {
        try {
          if (el.matches(pruneSel)) continue;
        } catch {}
      }
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      visited++;
      if (visit(el) === false) break;
      const sr = el.shadowRoot;
      const custom = el.localName.indexOf('-') > 0 && el.namespaceURI === 'http://www.w3.org/1999/xhtml';
      if (sr) openRoots++;
      else if (custom) {
        const defined = !!(window.customElements && customElements.get(el.localName));
        if (!defined) undefinedEls++;
        // textContent too, not just children: a text-only component is childless. See header.
        else if (!el.children.length && !(el.textContent || '').trim()) {
          closedSuspects++;
          if (hosts.indexOf(el.localName) < 0 && hosts.length < 5) hosts.push(el.localName);
        }
      }
      const kids = el.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        if (sr && !kids[i].assignedSlot) continue;
        stack.push(kids[i]);
      }
      if (sr) {
        const sk = sr.children;
        for (let i = sk.length - 1; i >= 0; i--) stack.push(sk[i]);
      }
    }
    return { visited, truncated, openRoots, closedSuspects, undefinedEls, hosts };
  }
  /* @qa-walk-end */

  const out = [];
  const scan = qaWalk(document.documentElement, { maxNodes: maxScanNodes }, (el) => {
    if (el.tagName !== 'IMG') return;
    if (el.complete && el.naturalWidth === 0 && el.src && !el.src.startsWith('data:')) out.push(el.src.slice(0, 200));
  });
  return { images: out, truncated: scan.truncated };
}

/**
 * Facts about credential fields on screen. FACTS ONLY — the "is this a sign-in
 * screen" judgement lives in judgeLoginSignals() in node, where it is unit
 * testable without a browser and where a false positive can be reasoned about.
 *
 * Visibility is checked but the viewport is NOT: unlike a click candidate, a
 * login form below the fold is still a login form. Checking visibility at all is
 * mandatory in the other direction — SPAs routinely leave a portal-rendered
 * login modal in the DOM at display:none on every page of the app.
 */
export function loginSignalsInPage({ skipSelector }) {
  // __qaDeep arrives via addInitScript. It is absent when a test evaluates this
  // against setContent(), and in attach mode on a document the script never
  // touched — so the fallback is required, and `pierced` says which ran.
  const deepAll =
    (window.__qaDeep && window.__qaDeep.queryAll) || ((sel, root) => [...(root || document).querySelectorAll(sel)]);
  const deepClosest =
    (window.__qaDeep && window.__qaDeep.closest) || ((el, sel) => (el.closest ? el.closest(sel) : null));

  const visible = (el) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return !(cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0);
  };

  // `~=` not `=`: autocomplete is a TOKEN LIST, so "section-blue current-password"
  // is a current-password field and an exact match would miss it.
  //
  // one-time-code is here so a second-factor / emailed-code screen is at least
  // COUNTED. It is judged much more narrowly than a password field (see
  // judgeLoginSignals) because an OTP prompt on an authenticated page is a normal
  // thing for an app to show.
  const fields = deepAll(
    'input[type=password], input[autocomplete~="current-password"], input[autocomplete~="new-password"], input[autocomplete~="one-time-code"]',
  )
    .filter(visible)
    .filter((el) => !(skipSelector && deepClosest(el, skipSelector)));

  // A sign-in form asks WHO you are as well as for the secret; a "re-enter your
  // password to confirm" form does not. Counted per scope because that difference
  // is the only app- and locale-independent way to tell the two apart, and getting
  // it wrong in the wrong direction aborts a healthy run with exit 3.
  const IDENT = 'input[type=email], input[type=tel], input[type=text], input[autocomplete~="username"]';
  const identifiersIn = (root) =>
    (root === 'document' ? deepAll(IDENT) : [...root.querySelectorAll(IDENT)]).filter(
      // A credential field is never its own identifier: an
      // `input[type=text][autocomplete=current-password]` matches IDENT, and
      // counting it would make every such scope look like a full sign-in form.
      (el) => visible(el) && fields.indexOf(el) < 0,
    ).length;

  const tokens = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  // Never outerHTML and never `value`: Chrome autofills password fields, and
  // log.json is written to disk and pasted into CI output.
  const describe = (el) =>
    '<input ' +
    ['type', 'name', 'id', 'autocomplete', 'aria-label']
      .map((a) => (el.getAttribute(a) ? `${a}="${el.getAttribute(a)}"` : null))
      .filter(Boolean)
      .join(' ') +
    '>';

  // Grouped by <form> because the shape of a scope is what separates sign-in
  // (one field) from change-password (current + new + confirm).
  const scopes = new Map();
  for (const el of fields) {
    const k = deepClosest(el, 'form') || 'document';
    if (!scopes.has(k)) scopes.set(k, []);
    scopes.get(k).push(el);
  }
  return {
    total: fields.length,
    pierced: !!window.__qaDeep,
    inShadow: fields.some((el) => el.getRootNode() !== document),
    scopes: [...scopes.entries()].map(([k, els]) => ({
      action: k !== 'document' ? k.getAttribute('action') || '' : '',
      count: els.length,
      masked: els.filter((e) => e.type === 'password').length,
      current: els.filter((e) => tokens(e).includes('current-password')).length,
      fresh: els.filter((e) => tokens(e).includes('new-password')).length,
      otp: els.filter((e) => tokens(e).includes('one-time-code')).length,
      identifiers: identifiersIn(k),
      sample: describe(els[0]),
    })),
  };
}

/**
 * The danger label that pressing an ACTIVATION key right now would trigger, or
 * null.
 *
 * The danger guardrail used to live only in chooseClickPoint, i.e. it covered the
 * mouse and nothing else. keyboardSpam presses Enter and Space from its key pool
 * and invalidInput presses Enter after filling a field, so 'Tab' then 'Enter'
 * reached a focused "Delete account" — in attach mode, in the user's real profile,
 * under a banner advertising the guardrail. This is the keyboard's half of it.
 *
 * Two things can be activated: the focused control itself, and — when the focus is
 * in a form field — that form's default submit, which is how Enter in a
 * "type DELETE to confirm" box destroys a workspace.
 */
export function activationDangerInPage({ dangerSource, dangerFlags }) {
  const danger = new RegExp(dangerSource, dangerFlags || 'i');
  // activeElement returns the HOST for focus inside a shadow tree, so descend.
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;

  const labelOf = (n) =>
    ((n.innerText || n.value || '') + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || ''))
      .replace(/\s+/g, ' ')
      .trim();

  const own = labelOf(el);
  if (danger.test(own)) return { tag: el.tagName.toLowerCase(), text: own.slice(0, 40), via: 'focused control' };

  const form = el.form || (el.closest ? el.closest('form') : null);
  if (form) {
    for (const sub of form.querySelectorAll('button:not([type=button]), input[type=submit], [type=submit]')) {
      const t = labelOf(sub);
      if (danger.test(t)) return { tag: sub.tagName.toLowerCase(), text: t.slice(0, 40), via: 'form submit' };
    }
  }
  return null;
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
 * Read AND RESET every dead-control observable in one round trip.
 *
 * One evaluate, not four: this runs immediately before every judged click and
 * once after it, so a per-observable read would be four CDP round trips per
 * click on a page the harness is already hammering.
 *
 * `installed: false` is the load-bearing field. The init script may never have
 * run — attach mode joins a tab that already loaded, and setContent-based tests
 * never navigate — and a missing observer reads as "no mutations" which is
 * exactly the false "dead" verdict this probe exists to refuse. The caller turns
 * it into UNKNOWN, never into evidence.
 *
 * `x`/`y` are the click point on the pre-click read and null otherwise. The hit
 * test descends OPEN shadow roots because document.elementFromPoint stops at the
 * host: on a component app the host's tag never equals the candidate's, so every
 * click would be dropped as "landed somewhere else".
 */
export function inertProbeInPage({ x, y }) {
  const m = window.__qaMut;
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  // .value / .checked / .selectedIndex are PROPERTIES, and a MutationObserver
  // cannot see a property write at all. Without this channel, ticking a checkbox
  // and every fill() into an uncontrolled input produce zero records, so a
  // perfectly working field reads as dead on every single step.
  let frm = '';
  try {
    for (const e of document.querySelectorAll('input,select,textarea')) {
      frm += (e.checked ? 1 : 0) + '|' + (e.selectedIndex == null ? -1 : e.selectedIndex) + '|' + (e.value || '') + ';';
    }
  } catch {}
  let hit = null;
  if (x != null && y != null) {
    try {
      let el = document.elementFromPoint(x, y);
      for (let i = 0; i < 8 && el && el.shadowRoot; i++) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      hit = el ? el.tagName.toLowerCase() : null;
    } catch {}
  }
  const out = {
    installed: !!m,
    n: m ? m.n : 0,
    sigs: m ? Object.keys(m.sigs) : [],
    capped: m ? !!m.capped : false,
    roots: m ? m.roots : 0,
    docId: m ? m.docId : null,
    frm: hash(frm),
    opened: window.__qaOpenBlocked || 0,
    hit,
  };
  if (m) {
    m.n = 0;
    m.sigs = {};
    m.capped = false;
  }
  return out;
}

/**
 * Installed via addInitScript, so it applies to EVERY document this tab loads.
 * A plain evaluate() would be lost on the next navigation, and this harness
 * navigates constantly.
 */
export function initScriptInPage({
  blockWindowOpen,
  forceOpenShadowRoots,
  deadControls,
  deadControlMaxSignatures,
  deadControlObserveShadowRoots,
}) {
  // Always defined, even when nothing increments it, so inertProbeInPage reads a
  // number rather than undefined on the very first sample.
  window.__qaOpenBlocked = 0;
  if (blockWindowOpen) {
    try {
      // Counted, not just stubbed: the HARNESS is what makes an "open in new
      // tab" control produce no DOM change, no request and no URL change, so
      // without this the dead-control probe reports its own guardrail as the
      // app's bug. A self-inflicted false positive, and free to remove.
      window.open = () => {
        window.__qaOpenBlocked++;
        return null;
      };
    } catch {}
  }
  // Off by default: shadowRoot.mode is observable and some libraries assert
  // closed-ness, so this makes the app under test no longer the shipped app. A
  // harness that silently alters its subject is its own kind of false report.
  if (forceOpenShadowRoots) {
    try {
      const orig = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        return orig.call(this, { ...init, mode: 'open' });
      };
    } catch {}
  }
  // Piercing helpers for probes that hold an ELEMENT rather than a tree, and so
  // cannot use qaWalk's top-down prune. Order is by root, not document order —
  // no seeded decision reads these, so only the set matters.
  window.__qaDeep = {
    // maxNodes for the same reason qaWalk has one: an unbounded querySelectorAll('*')
    // per shadow root is the one scan in this file with no ceiling.
    queryAll(selector, root, maxNodes) {
      const budget = maxNodes > 0 ? maxNodes : 20000;
      const out = [];
      const roots = [root || document];
      let seen = 0;
      for (let i = 0; i < roots.length && seen < budget; i++) {
        try {
          for (const el of roots[i].querySelectorAll(selector)) out.push(el);
          for (const el of roots[i].querySelectorAll('*')) {
            if (++seen > budget) break;
            if (el.shadowRoot) roots.push(el.shadowRoot);
          }
        } catch {
          break;
        }
      }
      return out;
    },
    closest(el, selector) {
      let n = el;
      while (n) {
        if (n.nodeType === 1) {
          try {
            if (n.matches(selector)) return n;
          } catch {
            return null;
          }
        }
        n = n.parentNode;
        if (n && n.nodeType === 11 && n.host) n = n.host;
      }
      return null;
    },
  };
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

  // ---- dead-control detection: WHICH subtrees changed, never how many records
  //
  // A raw record count cannot work, and that was measured rather than assumed: a
  // 100ms text clock produces 3 / 6 / 12 records over 300 / 600 / 1200ms of idle
  // with nobody touching the page, while a real click that changes one text node
  // produces exactly 1. Signal amplitude is an order of magnitude below noise, so
  // no threshold on a counter can separate them.
  //
  // Signatures subtract the noise by IDENTITY instead. A clock rewriting the same
  // node every tick is ONE signature however often it ticks, and — because a
  // childList record targets the PARENT — a whole-subtree innerHTML re-render
  // collapses to one signature too. The noisiest patterns real apps have are the
  // cheapest to baseline away, which is what makes the approach viable at all.
  // (CSS animations produce ZERO records, also measured, so animation is not a
  // noise source here; only DOM-writing timers are.)
  if (deadControls) {
    window.__qaMut = {
      n: 0,
      sigs: {},
      capped: false,
      roots: 1,
      // Identifies THIS document. addInitScript re-runs on every navigation, so
      // the counter resets to zero on exactly the steps where the app most
      // obviously did something; diffing across that would read a navigation as
      // "nothing happened". Random is fine: no seeded decision reads this value,
      // only equality with the previous sample.
      docId: Math.random().toString(36).slice(2),
    };
    try {
      const max = deadControlMaxSignatures > 0 ? deadControlMaxSignatures : 200;
      const opts = { subtree: true, childList: true, attributes: true, characterData: true };
      const sigOf = (rec) => {
        let el = rec.target;
        if (el && el.nodeType === 3) el = el.parentNode; // characterData targets the text node
        const parts = [];
        for (let i = 0; i < 3 && el; i++) {
          if (el.host) el = el.host; // a ShadowRoot has no tagName; its host does
          if (!el.tagName) break;
          const p = el.parentNode;
          const idx = p && p.children ? Array.prototype.indexOf.call(p.children, el) : 0;
          parts.unshift(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '[' + idx + ']');
          el = el.parentNode;
        }
        return rec.type[0] + ':' + parts.join('>') + (rec.attributeName ? '@' + rec.attributeName : '');
      };
      const obs = new MutationObserver((recs) => {
        const m = window.__qaMut;
        for (const rec of recs) {
          m.n++;
          const s = sigOf(rec);
          // Cap, then FLAG — never silently drop. A capped window is UNKNOWN, and
          // the caller refuses to accuse anything on a route that hit this.
          if (m.sigs[s] === undefined && Object.keys(m.sigs).length >= max) {
            m.capped = true;
            continue;
          }
          m.sigs[s] = (m.sigs[s] || 0) + 1;
        }
      });
      // `document`, NOT documentElement: at addInitScript time readyState is
      // 'loading' and documentElement does not exist yet, so observing it throws,
      // the catch swallows it, and every click on every route reads as dead.
      obs.observe(document, opts);
      // Off by default, and MILDER than forceOpenShadowRoots: this never touches
      // init.mode, so the app under test still ships the shadow roots it shipped.
      // It is needed because a document-level observer does NOT cross a shadow
      // boundary — measured: 0 records for a shadow-internal textContent change —
      // and inpage.mjs's header records that shadow-blind probes already produced
      // a false green on Lit/Stencil/Ionic. A shadow-blind mutation check would
      // call EVERY click dead on exactly those apps.
      if (deadControlObserveShadowRoots) {
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
          const root = orig.call(this, init);
          try {
            obs.observe(root, opts);
            window.__qaMut.roots++;
          } catch {}
          return root;
        };
      }
    } catch {}
  }
}
