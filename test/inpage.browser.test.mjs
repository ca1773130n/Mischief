// Shadow-DOM coverage for the four in-page probes.
//
// The defect this file exists for is silent: on an app built out of custom
// elements every probe read ZERO — no click candidates, no text scanned, no a11y
// counts, no broken images — and the run exited 0 CLEAN with nothing in the
// report saying "I found nothing to look at".
//
// Skipped when no Chrome/Edge is installed — playwright-core ships no browsers.
// It is NOT skipped for convenience: if you have a browser, this must pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  a11yPassInPage,
  brokenImagesInPage,
  gatherCandidatesInPage,
  initScriptInPage,
  textPatternsInPage,
} from '../src/probes/inpage.mjs';
import { builtinMutators } from '../src/mutators/index.mjs';
import { resolveConfig } from '../src/config.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { browserOrNull } from './browser.mjs';

const SEL = 'a, button, [role="button"], input[type="submit"], select, [tabindex]';
const BTN = 'style="width:120px;height:24px"';

/** The argument gatherCandidatesInPage takes in production, with per-test overrides. */
const arg = (over = {}) => ({
  selector: SEL,
  dangerSource: 'zzz-never-matches',
  dangerFlags: 'i',
  ignoreAttribute: 'data-qa-ignore',
  maxCandidates: 400,
  maxScanNodes: 20000,
  ...over,
});

const texts = (res) => res.candidates.map((c) => c.text);

/** A host whose shadow root holds `inner`, defined under `tag`. */
const component = (tag, inner, mode = 'open') => `<script>
  customElements.define('${tag}', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: '${mode}' }).innerHTML = ${JSON.stringify(inner)}; }
  });
</script>`;

const doc = (body) => `<!doctype html><meta charset=utf-8><body style="margin:0">${body}</body>`;

test('in-page probes and the shadow DOM', async (t) => {
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  const page = await browser.newPage();

  await t.test('candidates are found three shadow levels deep', async () => {
    await page.setContent(
      doc(
        `<qa-l1></qa-l1>` +
          component('qa-l3', `<button ${BTN}>deep-3</button>`) +
          component('qa-l2', `<button ${BTN}>deep-2</button><qa-l3></qa-l3>`) +
          component('qa-l1', `<button ${BTN}>deep-1</button><qa-l2></qa-l2>`),
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(texts(res), ['deep-1', 'deep-2', 'deep-3']);
    assert.equal(res.shadow.openRoots, 3, 'every nested root must be counted');
  });

  await t.test('order is element -> its shadow tree -> its light siblings', async () => {
    // This pins the push order. Swapping the two pushes in qaWalk changes every
    // seeded pick with no other test failing.
    await page.setContent(
      doc(
        `<button ${BTN}>light-a</button><qa-mix></qa-mix><button ${BTN}>light-b</button>` +
          component('qa-mix', `<button ${BTN}>shadow-1</button><button ${BTN}>shadow-2</button>`),
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(texts(res), ['light-a', 'shadow-1', 'shadow-2', 'light-b']);
  });

  await t.test('a host visits its shadow tree BEFORE its slotted light children', async () => {
    await page.setContent(
      doc(
        `<qa-slot><button ${BTN}>slotted-a</button><button ${BTN}>slotted-b</button></qa-slot>` +
          component('qa-slot', `<button ${BTN}>shadow-1</button><slot></slot>`),
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(texts(res), ['shadow-1', 'slotted-a', 'slotted-b']);
  });

  await t.test('a light-DOM-only page yields exactly what querySelectorAll did', async () => {
    // The "existing seeds still replay" guarantee: pre-order over .children from
    // documentElement IS document order, element for element and index for index.
    await page.setContent(
      doc(`
      <a href="#a" ${BTN}>a1</a>
      <div><button ${BTN}>b1</button><span><button ${BTN}>b2</button></span></div>
      <select ${BTN}><option>o</option></select>
      <div role="button" ${BTN}>r1</div>
      <input type="submit" value="s1" ${BTN}>
      <div tabindex="0" ${BTN}>t1</div>
      <ul><li><button ${BTN}>b3</button></li><li><a href="#c" ${BTN}>a2</a></li></ul>
    `),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    const legacy = await page.evaluate((sel) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
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
        out.push({ x: Math.round((L + R) / 2), y: Math.round((T + B) / 2), tag: el.tagName.toLowerCase() });
      }
      return out;
    }, SEL);
    assert.ok(legacy.length >= 8, 'the fixture must actually produce candidates');
    assert.deepEqual(
      res.candidates.map((c) => [c.tag, c.x, c.y]),
      legacy.map((c) => [c.tag, c.x, c.y]),
    );
  });

  await t.test('data-qa-ignore prunes through a shadow host, and inside one', async () => {
    await page.setContent(
      doc(
        `<qa-ig data-qa-ignore><button ${BTN}>slotted-into-ignored</button></qa-ig>` +
          `<qa-ig2></qa-ig2>` +
          component('qa-ig', `<button ${BTN}>inside-ignored-host</button><slot></slot>`) +
          component('qa-ig2', `<div data-qa-ignore><button ${BTN}>inner-ignored</button></div><button ${BTN}>inner-kept</button>`),
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(texts(res), ['inner-kept']);
  });

  await t.test('a closed shadow root is counted and named, never silently missed', async () => {
    await page.setContent(doc(`<qa-shut></qa-shut>` + component('qa-shut', `<button ${BTN}>unreachable</button>`, 'closed')));
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(res.candidates, [], 'nothing in page script can reach a closed root');
    assert.equal(res.shadow.openRoots, 0);
    assert.ok(res.shadow.closedSuspects >= 1);
    assert.ok(res.shadow.hosts.includes('qa-shut'), 'the report must be able to name the host');
  });

  await t.test('forceOpenShadowRoots opens it — and the init script runs early enough', async () => {
    const p2 = await browser.newPage();
    await p2.addInitScript(initScriptInPage, { blockWindowOpen: false, forceOpenShadowRoots: true });
    await p2.goto('about:blank'); // addInitScript applies to the NEXT document
    await p2.setContent(doc(`<qa-shut2></qa-shut2>` + component('qa-shut2', `<button ${BTN}>now-visible</button>`, 'closed')));
    const res = await p2.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(texts(res), ['now-visible']);
    assert.equal(res.shadow.closedSuspects, 0);
    await p2.close();
  });

  await t.test('an unregistered custom element is a broken bundle, not a closed root', async () => {
    await page.setContent(doc(`<qa-never-defined><span>x</span></qa-never-defined>`));
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.equal(res.shadow.undefinedEls, 1);
    assert.equal(res.shadow.closedSuspects, 0);
  });

  await t.test('the scan budget truncates VISIBLY, and the config cap does not masquerade as it', async () => {
    // 20, not more: candidates are clipped to the viewport, so a taller stack
    // would be dropped for a reason that has nothing to do with the scan budget.
    const many = Array.from({ length: 20 }, (_, i) => `<div><button ${BTN}>b${i}</button></div>`).join('');
    await page.setContent(doc(many));
    const full = await page.evaluate(gatherCandidatesInPage, arg());
    assert.equal(full.truncated, false);
    assert.equal(full.capped, false);
    assert.equal(full.candidates.length, 20);

    const clipped = await page.evaluate(gatherCandidatesInPage, arg({ maxScanNodes: 5 }));
    assert.equal(clipped.truncated, true, 'exhausting the budget must be reported, never silent');
    assert.ok(clipped.candidates.length < 20);

    const capped = await page.evaluate(gatherCandidatesInPage, arg({ maxCandidates: 2 }));
    assert.equal(capped.candidates.length, 2);
    assert.deepEqual(texts(capped), ['b0', 'b1'], 'the cap keeps the FIRST two in traversal order');
    assert.equal(capped.capped, true);
    assert.equal(capped.truncated, false, 'a config cap is not a scan-budget failure');
  });

  await t.test('an invalid clickableSelector degrades to zero, not to a swallowed throw', async () => {
    await page.setContent(doc(`<button ${BTN}>x</button>`));
    const res = await page.evaluate(gatherCandidatesInPage, arg({ selector: 'a:::broken(' }));
    assert.deepEqual(res.candidates, []);
    assert.ok(res.scanned > 1, 'the scan must survive the bad selector rather than dying on element 1');
  });

  await t.test('returned coordinates click the component INSIDE its shadow root', async () => {
    await page.setContent(
      doc(
        `<qa-click></qa-click>` +
          component(
            'qa-click',
            `<button ${BTN} onclick="window.__hit = (window.__hit || 0) + 1">press me</button>`,
          ),
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    const pick = res.candidates.find((c) => c.text === 'press me');
    assert.ok(pick, 'the shadow button must be a candidate');
    await page.mouse.click(pick.x, pick.y);
    assert.equal(await page.evaluate(() => window.__hit), 1, 'rect coordinates must stay valid across the boundary');
  });

  await t.test('unslotted light children render nowhere and must not be reported', async () => {
    // getComputedStyle on an unslotted child does NOT say display:none, so the
    // style gate cannot catch this — the assignedSlot filter in the walk is what does.
    await page.setContent(
      doc(
        `<qa-noslot><button ${BTN}>never-rendered</button><span>NEVERRENDEREDTEXT</span></qa-noslot>` +
          `<qa-yesslot><button ${BTN}>is-rendered</button><span>ISRENDEREDTEXT</span></qa-yesslot>` +
          component('qa-noslot', `<button ${BTN}>shadow-only</button>`) +
          component('qa-yesslot', `<slot></slot>`),
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.deepEqual(texts(res), ['shadow-only', 'is-rendered']);

    const res2 = await page.evaluate(textPatternsInPage, {
      patterns: [{ name: 'marker', severity: 'high', source: '(NEVER|IS)RENDEREDTEXT', flags: '' }],
      skipSelector: '',
      maxHits: 25,
      maxScanNodes: 20000,
    });
    assert.deepEqual(res2.hits.map((h) => h.text), ['ISRENDEREDTEXT']);
  });

  await t.test('the fallback content of a FILLED slot renders nowhere and is not a text hit', async () => {
    // New surface opened by piercing: the old TreeWalker never entered a shadow
    // tree, so it could not see a <slot>'s fallback. Its computed style is not
    // 'none', so the style gate cannot catch it — and text hits default to
    // severity 'high', so this would flip a clean run to exit 1.
    await page.setContent(
      doc(
        `<qa-fb>FILLEDTEXT</qa-fb><qa-fb2></qa-fb2>` +
          component('qa-fb', `<slot>FALLBACKTEXT</slot>`) +
          component('qa-fb2', `<slot>SHOWNFALLBACK</slot>`),
      ),
    );
    const res = await page.evaluate(textPatternsInPage, {
      patterns: [{ name: 'marker', severity: 'high', source: '(FILLED|FALLBACK|SHOWNFALLBACK)TEXT|SHOWNFALLBACK', flags: '' }],
      skipSelector: '',
      maxHits: 25,
      maxScanNodes: 20000,
    });
    const texts2 = res.hits.map((h) => h.text).sort();
    assert.ok(texts2.includes('FILLEDTEXT'), 'the slotted content DOES render');
    assert.ok(texts2.includes('SHOWNFALLBACK'), 'an EMPTY slot really does show its fallback');
    assert.ok(!texts2.includes('FALLBACKTEXT'), 'the filled slot\'s fallback renders nowhere');
  });

  await t.test('the text scan reports being cut short instead of stopping silently', async () => {
    await page.setContent(doc(Array.from({ length: 8 }, () => `<p>LEAKED markup here</p>`).join('')));
    const argT = (maxHits) => ({
      patterns: [{ name: 'marker', severity: 'high', source: 'LEAKED', flags: '' }],
      skipSelector: '',
      maxHits,
      maxScanNodes: 20000,
    });
    const full = await page.evaluate(textPatternsInPage, argT(25));
    assert.equal(full.hits.length, 8);
    assert.equal(full.capped, false);
    const cut = await page.evaluate(textPatternsInPage, argT(3));
    assert.equal(cut.hits.length, 3);
    assert.equal(cut.capped, true, 'a hit cap that reports nothing is the same false negative one level down');
  });

  await t.test('textPatternsInPage reads text that exists only inside a shadow root', async () => {
    await page.setContent(
      doc(`<qa-text></qa-text>` + component('qa-text', `<p>value is $\\frac{1}{2}$ here</p>`)),
    );
    const pattern = { name: 'latex-math', severity: 'high', source: '\\$[^$]{1,80}\\$', flags: '' };
    const res = await page.evaluate(textPatternsInPage, {
      patterns: [pattern],
      skipSelector: '',
      maxHits: 25,
      maxScanNodes: 20000,
    });
    assert.equal(res.hits.length, 1);
    assert.equal(res.hits[0].kind, 'latex-math');
    assert.equal(res.hits[0].where, 'p', 'the hit must name the element it was found in');

    // textSkipSelector must prune through the host, which p.closest() could not.
    const skipped = await page.evaluate(textPatternsInPage, {
      patterns: [pattern],
      skipSelector: 'qa-text',
      maxHits: 25,
      maxScanNodes: 20000,
    });
    assert.deepEqual(skipped.hits, []);
  });

  await t.test('a11y counts pierce, and ids are scoped to their own root', async () => {
    await page.setContent(
      doc(
        `<qa-a11y></qa-a11y>` +
          `<label for="outside">outer label</label>` +
          `<qa-collide></qa-collide>` +
          `<label>wraps a component <qa-wrapped></qa-wrapped></label>` +
          component('qa-a11y', `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><input id="inside"><label for="inside">in-root label</label>`) +
          component('qa-collide', `<input id="outside">`) +
          component('qa-wrapped', `<input>`),
      ),
    );
    const a = await page.evaluate(a11yPassInPage, { maxScanNodes: 20000 });
    assert.equal(a.imgsNoAlt.count, 1, 'an alt-less img inside a shadow root must be counted');
    // #inside is labelled within its own root => not flagged.
    // #outside is labelled only in the OUTER document => ids are per-root, so flagged.
    // qa-wrapped's input is inside a light-DOM <label> across a host boundary => not flagged.
    assert.equal(a.unlabeledInputs.count, 1);
  });

  await t.test('invalidInput refuses an input inside an IGNORED shadow host', async () => {
    // Playwright's CSS engine already pierced, so page.$$() has always returned
    // these inputs and the monkey has always typed into them: el.closest() could
    // not see the data-qa-ignore on the host. A safety hole, not a coverage one.
    await page.setContent(
      doc(
        `<qa-inp data-qa-ignore></qa-inp><qa-inp2></qa-inp2>` +
          component('qa-inp', `<input class="off" ${BTN}>`) +
          component('qa-inp2', `<input class="on" ${BTN}>`),
      ),
    );
    const config = resolveConfig({ baseUrl: 'http://localhost:3000' });
    const notes = [];
    const ctx = { page, config, rng: mulberry32(3), state: {}, log: (m, target, note) => notes.push(note) };
    for (let i = 0; i < 6; i++) await builtinMutators.invalidInput(ctx);
    const filled = await page.evaluate(() => ({
      off: document.querySelector('qa-inp').shadowRoot.querySelector('input').value,
      on: document.querySelector('qa-inp2').shadowRoot.querySelector('input').value,
    }));
    assert.equal(filled.off, '', 'an ignored shadow host must protect its own inputs');
    assert.ok(filled.on.length > 0 || notes.some((n) => n && n.includes('chars')), 'the un-ignored one must still be usable');
  });

  await t.test('brokenImagesInPage finds a 404 inside a shadow root', async () => {
    await page.setContent(doc(`<qa-img></qa-img>` + component('qa-img', `<img src="/definitely-not-here.png">`)));
    await page.waitForTimeout(200);
    const broken = await page.evaluate(brokenImagesInPage, { maxScanNodes: 20000 });
    assert.equal(broken.images.length, 1);
    assert.ok(broken.images[0].endsWith('/definitely-not-here.png'));
    assert.equal(broken.truncated, false, 'every walk must be able to say it was cut short');
  });

  await t.test('a text-only custom element is not reported as a closed-root suspect', async () => {
    // `!children.length` alone counted `<my-badge>New</my-badge>` and an <x-icon>
    // that draws with CSS, so the report told a component-app user to switch on
    // forceOpenShadowRoots — which changes the app under test — for a root that
    // does not exist.
    await page.setContent(
      doc(
        `<qa-badge>New</qa-badge><qa-empty></qa-empty>` +
          `<script>customElements.define('qa-badge', class extends HTMLElement {});` +
          `customElements.define('qa-empty', class extends HTMLElement {});</script>`,
      ),
    );
    const res = await page.evaluate(gatherCandidatesInPage, arg());
    assert.equal(res.shadow.closedSuspects, 1, 'only the one that exposes nothing at all');
    assert.deepEqual(res.shadow.hosts, ['qa-empty']);
  });

  await browser.close();
});
