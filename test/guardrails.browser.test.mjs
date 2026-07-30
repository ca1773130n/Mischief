// Browser test for the one mechanism that, if it silently stopped working,
// would let the monkey click "Delete account" on a real user's account.
//
// Skipped when no Chrome/Edge is installed — playwright-core ships no browsers.
// It is NOT skipped for convenience: if you have a browser, this must pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { activationDangerInPage, gatherCandidatesInPage } from '../src/probes/inpage.mjs';
import { builtinMutators } from '../src/mutators/index.mjs';
import { chooseClickPoint } from '../src/browser/guardrails.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { resolveConfig } from '../src/config.mjs';
import * as presets from '../src/presets.mjs';
import { browserOrNull } from './browser.mjs';

const PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0">
  <button style="width:200px;height:40px">Delete account</button>
  <button style="width:200px;height:40px">로그아웃</button>
  <button style="width:200px;height:40px">Cancel subscription</button>
  <button style="width:200px;height:40px">Safe action</button>
  <div data-qa-ignore><button style="width:200px;height:40px">Ignored button</button></div>
  <button style="width:200px;height:40px" aria-label="Delete row">🗑</button>
  <button style="width:200px;height:40px" disabled>Disabled</button>
  <!-- padding/border must be zeroed too: a plain width:0 button is still ~6px wide in Chrome -->
  <button style="width:0;height:0;padding:0;border:0">Zero size</button>
  <button style="display:none">Hidden</button>
</body>`;

// A design-system component: the danger guardrail must pierce it, or the monkey
// clicks "Delete account" inside a web component with nothing recorded.
const SHADOW_PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0">
  <button style="width:200px;height:40px">Outer safe</button>
  <qa-card></qa-card>
  <div data-qa-ignore><qa-card></qa-card></div>
  <script>
    class QaCard extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<button style="width:200px;height:40px">Delete account</button>' +
          '<button style="width:200px;height:40px">Inner safe</button>';
      }
    }
    customElements.define('qa-card', QaCard);
  </script>
</body>`;

/** The exact argument chooseClickPoint passes, so the probe is exercised as used. */
function arg(config, over = {}) {
  const g = config.guardrails;
  return {
    selector: g.clickableSelector,
    dangerSource: g.dangerPattern.source,
    dangerFlags: g.dangerPattern.flags || 'i',
    ignoreAttribute: g.ignoreAttribute,
    maxCandidates: g.maxCandidates,
    maxScanNodes: g.maxScanNodes,
    ...over,
  };
}

test('danger guardrail', async (t) => {
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  const page = await browser.newPage();
  await page.setContent(PAGE);

  const config = resolveConfig({
    baseUrl: 'http://localhost:3000',
    guardrails: { dangerPattern: presets.combinePatterns(presets.danger.en, presets.danger.ko) },
  });

  await t.test('the in-page gatherer flags danger and honours every exclusion', async () => {
    const res = await page.evaluate(gatherCandidatesInPage, arg(config));
    const cands = res.candidates;
    const byText = Object.fromEntries(cands.map((c) => [c.text, c]));

    assert.equal(byText['Delete account'].danger, true);
    assert.equal(byText['로그아웃'].danger, true, 'Korean logout must match the ko preset');
    assert.equal(byText['Cancel subscription'].danger, true);
    assert.equal(byText['Safe action'].danger, false);

    // aria-label is part of the label, so an icon-only button WITH a name is covered.
    assert.ok(cands.some((c) => c.danger && c.text.includes('Delete row')), 'aria-label must be matched');

    assert.ok(!('Ignored button' in byText), 'data-qa-ignore subtree must be excluded');
    assert.ok(!('Disabled' in byText), 'disabled must be excluded');
    assert.ok(!('Zero size' in byText), 'zero-size must be excluded');
    assert.ok(!('Hidden' in byText), 'display:none must be excluded');

    // The census that turns "no candidate" from silence into a finding.
    assert.equal(res.truncated, false);
    assert.equal(res.capped, false);
    assert.equal(res.selector, config.guardrails.clickableSelector);
    assert.ok(res.scanned > 5, 'the scan must report how many nodes it visited');
    assert.deepEqual(res.shadow, { openRoots: 0, closedSuspects: 0, undefinedEls: 0, hosts: [] });
  });

  await t.test('the danger rail pierces open shadow roots, and so does data-qa-ignore', async () => {
    // Before piercing, querySelectorAll returned NOTHING from inside qa-card:
    // "Delete account" was neither offered nor refused — it was invisible, and a
    // component app scored 0 candidates on every step and exited 0 CLEAN.
    await page.setContent(SHADOW_PAGE);
    const res = await page.evaluate(gatherCandidatesInPage, arg(config));
    const byText = Object.fromEntries(res.candidates.map((c) => [c.text, c]));

    assert.ok('Delete account' in byText, 'a candidate inside an open shadow root must be found');
    assert.equal(byText['Delete account'].danger, true, 'the danger rail must pierce too');
    // One, not two: pruning an ignored host means its shadow root is never
    // pushed, which is how the attribute now inherits across the boundary at all.
    assert.equal(res.shadow.openRoots, 1);

    // el.closest() stops at a ShadowRoot, so data-qa-ignore on a HOST used to
    // protect nothing inside it. One "Inner safe" survives, not two.
    assert.equal(res.candidates.filter((c) => c.text === 'Inner safe').length, 1);
    assert.equal(res.candidates.filter((c) => c.text === 'Delete account').length, 1);

    const state = { skippedDanger: [], currentRoutePath: '/', actionLog: [] };
    let refusals = 0;
    for (let i = 0; i < 60; i++) {
      const ctx = {
        page,
        config,
        rng: mulberry32(i),
        state,
        log: (m, target, note) => {
          if (note === 'skipped-danger') refusals++;
        },
      };
      const pick = await chooseClickPoint(ctx, 'randomClick');
      if (pick) assert.notEqual(pick.text, 'Delete account', 'a shadow-DOM danger target must never be returned');
    }
    assert.ok(refusals > 0, 'the shadow-DOM danger control must have been refused at least once');
    assert.ok(state.skippedDanger.some((s) => s.text === 'Delete account'), 'the refusal must be recorded');
  });

  await t.test('chooseClickPoint records the census on route stats without drawing rng', async () => {
    await page.setContent(PAGE);
    const ps = { clickable: { atEnter: null, attempts: 0, empty: 0, max: 0, scanTruncated: false, capped: false, probeFailed: false, selector: null, shadow: null } };
    const state = { skippedDanger: [], currentRoutePath: '/', actionLog: [], ps };

    // Same seed, once with bookkeeping and once against a bare state: an extra
    // rng draw for the counters would shift the pick and break every seed.
    const withPs = await chooseClickPoint({ page, config, rng: mulberry32(7), state, log: () => {} }, 'randomClick');
    const withoutPs = await chooseClickPoint(
      { page, config, rng: mulberry32(7), state: { skippedDanger: [], currentRoutePath: '/', actionLog: [] }, log: () => {} },
      'randomClick',
    );
    assert.deepEqual(withPs, withoutPs, 'recording the census must consume no rng');
    assert.equal(ps.clickable.attempts, 1);
    assert.equal(ps.clickable.empty, 0);
    assert.ok(ps.clickable.max > 0);

    await page.setContent('<body style="margin:0">nothing to click</body>');
    await chooseClickPoint({ page, config, rng: mulberry32(1), state, log: () => {} }, 'randomClick');
    assert.equal(ps.clickable.attempts, 2);
    assert.equal(ps.clickable.empty, 1, 'an empty draw must be counted, not silently dropped');
  });

  await t.test('chooseClickPoint never returns a danger target, over many draws', async () => {
    await page.setContent(PAGE); // each subtest sets its own fixture — they must not depend on order
    const state = { skippedDanger: [], currentRoutePath: '/', actionLog: [] };
    const actions = [];
    let refusals = 0;
    for (let i = 0; i < 200; i++) {
      const ctx = {
        page,
        config,
        rng: mulberry32(i),
        state,
        log: (m, target, note) => {
          actions.push({ target, note });
          if (note === 'skipped-danger') refusals++;
        },
      };
      const pick = await chooseClickPoint(ctx, 'randomClick');
      if (pick) assert.equal(pick.danger, false, `returned a danger target: ${pick.text}`);
    }
    // With 4 danger candidates out of 5, 200 draws that never hit one would mean
    // the flag is not being read at all.
    assert.ok(refusals > 0, 'the guardrail must have actually refused something');
    assert.equal(state.skippedDanger.length, refusals, 'every refusal must be recorded for the report');
    assert.ok(
      state.skippedDanger.some((s) => /Delete account|로그아웃|Cancel subscription|Delete row/.test(s.text)),
      'refusals must name the control',
    );
  });

  await t.test('with only danger candidates, it returns nothing rather than clicking one', async () => {
    await page.setContent('<button style="width:200px;height:40px">Delete everything</button>');
    const state = { skippedDanger: [], currentRoutePath: '/', actionLog: [] };
    const ctx = { page, config, rng: mulberry32(1), state, log: () => {} };
    assert.equal(await chooseClickPoint(ctx, 'randomClick'), null);
    assert.equal(state.skippedDanger.length, 1);
  });

  // ------------------------------------------- the KEYBOARD half of the guardrail

  await t.test('the guardrail sees a focused destructive control, and the form it submits', async () => {
    // The guardrail used to live only in chooseClickPoint, i.e. it covered the mouse
    // and nothing else — while KEY_POOL contains Tab, Enter and Space.
    await page.setContent(`<!doctype html><body style="margin:0">
      <button id="safe" style="width:200px;height:40px">Save changes</button>
      <button id="kill" style="width:200px;height:40px">Delete account</button>
      <form action="/api/workspace/delete">
        <input id="confirm" style="width:200px;height:24px">
        <button style="width:200px;height:40px">Delete workspace</button>
      </form>
    </body>`);
    const dangerArg = { dangerSource: config.guardrails.dangerPattern.source, dangerFlags: 'i' };
    const at = async (id) => {
      await page.focus(id);
      return page.evaluate(activationDangerInPage, dangerArg);
    };
    assert.equal(await at('#safe'), null, 'a safe control must not be refused');
    const kill = await at('#kill');
    assert.equal(kill.via, 'focused control');
    assert.match(kill.text, /Delete account/);
    // Enter in a text field submits its form: "type DELETE to confirm" is a
    // destructive activation with no click anywhere in it.
    const viaForm = await at('#confirm');
    assert.equal(viaForm.via, 'form submit');
    assert.match(viaForm.text, /Delete workspace/);
  });

  await t.test('keyboardSpam refuses Enter and Space on a focused destructive control', async () => {
    await page.setContent(
      `<!doctype html><body style="margin:0"><button id="kill" style="width:200px;height:40px"` +
        ` onclick="window.__boom = true">Delete account</button></body>`,
    );
    await page.focus('#kill');
    const state = { skippedDanger: [], currentRoutePath: '/', actionLog: [] };
    const notes = [];
    // Only the activation keys, so every one of the 15 presses is a refusal test.
    const cfg2 = resolveConfig({
      baseUrl: 'http://localhost:3000',
      guardrails: { dangerPattern: config.guardrails.dangerPattern },
      input: { keyPool: ['Enter', 'Space'] },
    });
    await builtinMutators.keyboardSpam({
      page,
      config: cfg2,
      rng: mulberry32(5),
      state,
      log: (m, target, note) => notes.push(note),
    });
    assert.equal(await page.evaluate(() => window.__boom), undefined, 'the monkey must not have activated it');
    assert.equal(state.skippedDanger.length, 15, 'every refusal is recorded for the report');
    assert.ok(state.skippedDanger.every((s) => s.text.includes('Delete account')));
    assert.ok(notes.some((n) => n && n.includes('15 refused')), 'the action log must say the keys were refused');
  });

  await t.test('keyboardSpam still presses freely when nothing dangerous has focus', async () => {
    await page.setContent(`<!doctype html><body style="margin:0"><input id="t" style="width:200px;height:24px"></body>`);
    await page.focus('#t');
    const state = { skippedDanger: [], currentRoutePath: '/', actionLog: [] };
    const cfg2 = resolveConfig({ baseUrl: 'http://localhost:3000', input: { keyPool: ['Enter', 'Space', 'a'] } });
    await builtinMutators.keyboardSpam({ page, config: cfg2, rng: mulberry32(5), state, log: () => {} });
    assert.equal(state.skippedDanger.length, 0, 'a false refusal costs coverage on every app');
  });

  await browser.close();
});
