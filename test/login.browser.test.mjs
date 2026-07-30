// The facts half of the inline-login check, against a real layout engine.
//
// Visibility is the whole reason this needs a browser: SPAs routinely leave a
// portal-rendered login modal in the DOM at display:none on EVERY page, so a
// naive query fires everywhere; and a login form below the fold is still a login
// form, so the viewport clip that click candidates need must not apply here.
//
// Skipped when no Chrome/Edge is installed — playwright-core ships no browsers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { initScriptInPage, loginSignalsInPage } from '../src/probes/inpage.mjs';
import { judgeLoginSignals } from '../src/auth/index.mjs';
import { browserOrNull } from './browser.mjs';

const doc = (body) => `<!doctype html><meta charset=utf-8><body style="margin:0">${body}</body>`;
const FIELD = 'style="width:200px;height:24px"';

test('loginSignalsInPage', async (t) => {
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  const page = await browser.newPage();

  await t.test('a visible password field is reported; a hidden modal is not', async () => {
    await page.setContent(
      doc(`
      <form action="/api/login"><input type="password" autocomplete="current-password" name="pw" ${FIELD}></form>
      <div style="display:none"><form action="/login"><input type="password" name="modal-pw" ${FIELD}></form></div>
    `),
    );
    const facts = await page.evaluate(loginSignalsInPage, { skipSelector: '' });
    assert.equal(facts.total, 1, 'the display:none portal modal must not count');
    assert.equal(facts.scopes.length, 1);
    assert.equal(facts.scopes[0].action, '/api/login');
    assert.equal(facts.scopes[0].current, 1);
    assert.ok(!/value=/.test(facts.scopes[0].sample));
    assert.ok(judgeLoginSignals(facts, { loginAdjacent: /login/i }));
  });

  await t.test('a field 3000px below the fold still counts', async () => {
    await page.setContent(doc(`<div style="height:3000px"></div><input type="password" ${FIELD}>`));
    const facts = await page.evaluate(loginSignalsInPage, { skipSelector: '' });
    assert.equal(facts.total, 1, 'unlike a click candidate, a login form need not be in the viewport');
  });

  await t.test('autocomplete is a token list, not an exact string', async () => {
    await page.setContent(doc(`<input type="text" autocomplete="section-blue current-password" ${FIELD}>`));
    const facts = await page.evaluate(loginSignalsInPage, { skipSelector: '' });
    assert.equal(facts.scopes[0].current, 1, 'input[autocomplete="current-password"] would have missed this');
    assert.equal(facts.scopes[0].masked, 0);
    assert.ok(judgeLoginSignals(facts, {}));
  });

  await t.test('loginSkipSelector excludes a subtree', async () => {
    await page.setContent(doc(`<div id="mine"><input type="password" ${FIELD}></div>`));
    const facts = await page.evaluate(loginSignalsInPage, { skipSelector: '#mine' });
    assert.equal(facts.total, 0);
  });

  await t.test('a shadow-root field is MISSED without the init script, and says so', async () => {
    // pierced:false is the honest answer: a missed detection is the old behaviour,
    // which is safe. Only the PRESENCE of a field may ever fail verification.
    const bare = await browser.newPage();
    await bare.setContent(
      doc(
        `<qa-login></qa-login><script>
          customElements.define('qa-login', class extends HTMLElement {
            constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML =
              '<input type="password" ${FIELD}>'; }
          });
        </script>`,
      ),
    );
    const facts = await bare.evaluate(loginSignalsInPage, { skipSelector: '' });
    assert.equal(facts.pierced, false);
    assert.equal(facts.total, 0);
    assert.equal(judgeLoginSignals(facts, {}), null, 'and it must not throw');
    await bare.close();
  });

  await t.test('with __qaDeep installed it pierces, and groups into the host-document form', async () => {
    const p2 = await browser.newPage();
    await p2.addInitScript(initScriptInPage, { blockWindowOpen: false, forceOpenShadowRoots: false });
    await p2.goto('about:blank');
    await p2.setContent(
      doc(
        `<form action="/session/new"><qa-login2></qa-login2></form><script>
          customElements.define('qa-login2', class extends HTMLElement {
            constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML =
              '<input type="password" name="pw" ${FIELD}>'; }
          });
        </script>`,
      ),
    );
    const facts = await p2.evaluate(loginSignalsInPage, { skipSelector: '' });
    assert.equal(facts.pierced, true);
    assert.equal(facts.total, 1);
    assert.equal(facts.inShadow, true);
    // Without the boundary-hopping closest() this lands in the 'document' scope
    // and loses the per-form shape rules entirely.
    assert.equal(facts.scopes.length, 1);
    assert.equal(facts.scopes[0].action, '/session/new');
    const hit = judgeLoginSignals(facts, { loginAdjacent: /session/i });
    assert.ok(hit);
    assert.match(hit.why, /inside a shadow root/);
    await p2.close();
  });

  await browser.close();
});
