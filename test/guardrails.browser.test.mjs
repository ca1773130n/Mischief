// Browser test for the one mechanism that, if it silently stopped working,
// would let the monkey click "Delete account" on a real user's account.
//
// Skipped when no Chrome/Edge is installed — playwright-core ships no browsers.
// It is NOT skipped for convenience: if you have a browser, this must pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { gatherCandidatesInPage } from '../src/probes/inpage.mjs';
import { chooseClickPoint } from '../src/browser/guardrails.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { resolveConfig } from '../src/config.mjs';
import * as presets from '../src/presets.mjs';

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

async function browserOrNull() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch {}
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return null;
  }
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
    const cands = await page.evaluate(gatherCandidatesInPage, {
      dangerSource: config.guardrails.dangerPattern.source,
      dangerFlags: 'i',
      ignoreAttribute: 'data-qa-ignore',
      maxCandidates: 400,
    });
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
  });

  await t.test('chooseClickPoint never returns a danger target, over many draws', async () => {
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

  await browser.close();
});
