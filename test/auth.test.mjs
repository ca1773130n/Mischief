// Session verification, with no browser.
//
// The policy half of the inline-login check is deliberately pure so that its
// false-positive surface can be reasoned about here rather than discovered on
// someone's settings page: aborting a healthy run with exit 3 is exactly as bad
// as the false green it was added to fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeLoginSignals, verifyAuth } from '../src/auth/index.mjs';
import { resolveConfig } from '../src/config.mjs';
import { normalizeRoute } from '../src/routes.mjs';
import { samePath, slugOf, uniqueSlugs } from '../src/util.mjs';

const LOGIN_ADJACENT = /login|signin|sign-in|auth|session|oauth/i;
// identifiers defaults to 0: a lone password field with nothing beside it is the
// AMBIGUOUS shape (sign-in, or a "confirm your password" prompt), so tests that
// mean "this is really a sign-in screen" have to say which signal makes it one.
const scope = (over) => ({
  action: '', count: 1, masked: 1, current: 0, fresh: 0, otp: 0, identifiers: 0,
  sample: '<input type="password">', ...over,
});
const signals = (scopes, over = {}) => ({
  total: scopes.reduce((n, s) => n + s.count, 0),
  pierced: true,
  inShadow: false,
  scopes,
  ...over,
});

const cfg = (over = {}) =>
  resolveConfig({
    baseUrl: 'http://localhost:3000',
    timing: { settleMs: 1 },
    ...over,
  });

/** Minimal page double: url() plus a counted evaluate(). */
function fakePage(url, facts) {
  const p = {
    calls: 0,
    url: () => url,
    async evaluate() {
      p.calls++;
      if (facts instanceof Error) throw facts;
      return facts;
    },
  };
  return p;
}

const route = normalizeRoute({ path: '/dash', requiresAuth: true, waitFor: '#x' });

// ---------------------------------------------------------------- the policy

test('one masked field beside an identifier field is a sign-in screen', () => {
  const hit = judgeLoginSignals(signals([scope({ identifiers: 1 })]), { loginAdjacent: LOGIN_ADJACENT });
  assert.ok(hit);
  assert.match(hit.why, /1 visible password field/);
  assert.equal(hit.confidence, 'sign-in');
});

test('one masked field with NOTHING beside it is ambiguous, not a sign-in screen', () => {
  // The sudo-mode / "re-enter your password to confirm" prompt GitHub, Stripe and
  // AWS all ship. Same shape as sign-in, opposite meaning — so it is reported and
  // the run continues, because a false exit 3 is as bad as the false green.
  const hit = judgeLoginSignals(signals([scope()]), { loginAdjacent: LOGIN_ADJACENT });
  assert.ok(hit, 'it must still be seen and named');
  assert.equal(hit.confidence, 'ambiguous');
});

test('a login-adjacent form action is enough on its own — two-step sign-in has no identifier on screen', () => {
  const hit = judgeLoginSignals(signals([scope({ action: '/api/login' })]), { loginAdjacent: LOGIN_ADJACENT });
  assert.equal(hit.confidence, 'sign-in');
});

test('a one-time-code field alone is only sign-in on a login-adjacent form', () => {
  // A 2FA / email-confirmation prompt on an authenticated page is normal.
  const bare = judgeLoginSignals(signals([scope({ masked: 0, otp: 1 })]), { loginAdjacent: LOGIN_ADJACENT });
  assert.equal(bare, null);
  const gated = judgeLoginSignals(signals([scope({ masked: 0, otp: 1, action: '/auth/verify' })]), {
    loginAdjacent: LOGIN_ADJACENT,
  });
  assert.match(gated.why, /one-time-code/);
  assert.equal(gated.confidence, 'sign-in');
});

test('a lone current-password field counts even when it is not type=password', () => {
  const hit = judgeLoginSignals(signals([scope({ masked: 0, current: 1 })]), { loginAdjacent: LOGIN_ADJACENT });
  assert.ok(hit);
  assert.match(hit.why, /autocomplete=current-password/);
});

test('a change-password form is NOT a login screen', () => {
  // The false positive that would abort a healthy run on every settings page.
  assert.equal(judgeLoginSignals(signals([scope({ count: 2, masked: 2, current: 1, fresh: 1 })]), {}), null);
  assert.equal(judgeLoginSignals(signals([scope({ count: 3, masked: 3, current: 1, fresh: 2 })]), {}), null);
});

test('a new-password field is sign-up or rotation, never sign-in', () => {
  assert.equal(judgeLoginSignals(signals([scope({ fresh: 1 })]), {}), null);
});

test('no fields at all, and no signals at all, decide nothing', () => {
  assert.equal(judgeLoginSignals({ total: 0, scopes: [] }, {}), null);
  assert.equal(judgeLoginSignals(null, {}), null);
});

test('scopes are judged per <form>, not by counting the whole document', () => {
  // A page with both a change-password form and a lone login field is still a
  // login screen; whole-document counting would call it 4 fields and pass.
  const hit = judgeLoginSignals(
    signals([scope({ action: '/api/account', count: 3, masked: 3, current: 1, fresh: 2 }), scope({ action: '/api/login' })]),
    { loginAdjacent: LOGIN_ADJACENT },
  );
  assert.ok(hit);
  assert.match(hit.why, /form action \/api\/login/);
});

test('a login-adjacent form action never overrides the shape rules', () => {
  // /api/auth/password matches /auth/, and a change-password form must still pass.
  const hit = judgeLoginSignals(signals([scope({ action: '/api/auth/password', count: 2, masked: 2, current: 1, fresh: 1 })]), {
    loginAdjacent: LOGIN_ADJACENT,
  });
  assert.equal(hit, null);
});

// ---------------------------------------------------------------- verifyAuth

test('a user-supplied auth.verify stays authoritative and byte-exact', () => {
  // report.test.mjs asserts the literal 'AUTHENTICATED — verified (auth.verify())'.
  const page = fakePage('http://localhost:3000/dash', signals([]));
  return verifyAuth({ page, config: cfg({ auth: { verify: async () => true } }), route, baseOrigin: 'http://localhost:3000' }).then(
    (v) => {
      assert.equal(v.ok, true);
      assert.equal(v.how, 'auth.verify()');
    },
  );
});

test('a login field under a passing auth.verify is a NOTE, never fatal', async () => {
  const page = fakePage('http://localhost:3000/dash', signals([scope({ identifiers: 1 })]));
  const v = await verifyAuth({
    page,
    config: cfg({ auth: { verify: async () => true } }),
    route,
    baseOrigin: 'http://localhost:3000',
  });
  assert.equal(v.ok, true, 'ANDing the heuristic onto a working verify() would break it on upgrade');
  assert.match(v.how, /^auth\.verify\(\) — note: /);
});

test('a path mismatch is reported without even running the probe', async () => {
  const page = fakePage('http://localhost:3000/login', signals([scope()]));
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, false);
  assert.match(v.how, /wanted \/dash/);
  assert.match(v.how, /got \/login/);
  assert.equal(page.calls, 0, 'the redirect is the more informative message, and it saves an evaluate');
});

test('INLINE gating fails verification even though the url never changed', async () => {
  const page = fakePage(
    'http://localhost:3000/dash',
    signals([scope({ identifiers: 1, sample: '<input type="password" name="pw">' })]),
  );
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, false, 'a landed-path check alone passes here — that is the defect');
  assert.match(v.how, /^inline-login check on \/dash/);
  assert.match(v.detail, /auth\.detectLoginScreen: false/);
  assert.match(v.detail, /<input type="password" name="pw">/);
});

test('an AMBIGUOUS lone password field is reported but does not abort the run', async () => {
  // "Enter your password to confirm" on a settings page. Failing here would abort a
  // healthy run with exit 3 having tested nothing; saying nothing would hide a real
  // login screen. It says so and continues.
  const page = fakePage('http://localhost:3000/dash', signals([scope({ action: '/api/workspace/delete' })]));
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, true);
  assert.match(v.how, /ambiguous password field/);
  assert.match(v.detail, /re-authentication prompt/);
  assert.match(v.detail, /auth\.loginSkipSelector/);
});

test('the reported element sample carries no value and no outerHTML', async () => {
  // Chrome autofills password fields and log.json is pasted into CI output.
  const page = fakePage(
    'http://localhost:3000/dash',
    signals([scope({ identifiers: 1, sample: '<input type="password" id="pw">' })]),
  );
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.ok(!/value=/.test(v.detail), 'a credential must never reach the report');
});

test('auth.detectLoginScreen: false restores the old behaviour exactly', async () => {
  const page = fakePage('http://localhost:3000/dash', signals([scope()]));
  const v = await verifyAuth({ page, config: cfg({ auth: { detectLoginScreen: false } }), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, true);
  assert.equal(page.calls, 0);
  assert.equal(v.how, 'landed on /dash');
});

test('a probe that cannot run fails OPEN, and SAYS it did not run', async () => {
  // CSP, a detached frame, navigation mid-evaluate, a closed shadow root: none of
  // them may abort a healthy run. Only the PRESENCE of a field can fail.
  //
  // But the report must not claim the check passed either. "no sign-in field
  // visible" was printed for a probe that never executed — a verified-sounding
  // assertion about a check that did not happen.
  const page = fakePage('http://localhost:3000/dash', new Error('Execution context was destroyed'));
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, true);
  assert.equal(v.how, 'landed on /dash + sign-in check did not run');
});

test('a probe that could not pierce shadow roots says THAT too', async () => {
  // Without the init script the fallback query does not enter shadow roots, so a
  // component app's login modal is invisible and the absence of a hit is not
  // evidence of arrival.
  const page = fakePage('http://localhost:3000/dash', signals([], { pierced: false }));
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, true);
  assert.match(v.how, /shadow roots NOT pierced/);
});

test('a passing verification names both signals', async () => {
  const page = fakePage('http://localhost:3000/dash', signals([]));
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, true);
  assert.match(v.how, /landed on \/dash/);
  assert.match(v.how, /no sign-in field visible/);
  assert.equal(page.calls, 2, 'a modal can render a beat after settle, so the probe looks twice');
});

// -------------------------------------------------- trailing-slash tolerance

test('one trailing slash is not a redirect, and a locale prefix still is', () => {
  assert.equal(samePath('http://x/one'), samePath('http://x/one/'));
  assert.equal(samePath('http://x/'), '/', 'the root must not collapse to empty');
  assert.notEqual(samePath('http://x/'), samePath('http://x/en'));
  assert.notEqual(samePath('http://x/a/b'), samePath('http://x/a'));
  assert.equal(samePath('http://x/a//'), '/a/', 'only ONE slash is stripped — /a// and /a are distinct paths');
});

test('verifyAuth tolerates the trailing slash its host added', async () => {
  // Next.js trailingSlash used to make every gated route fail verification.
  const page = fakePage('http://localhost:3000/dash/', signals([]));
  const v = await verifyAuth({ page, config: cfg(), route, baseOrigin: 'http://localhost:3000' });
  assert.equal(v.ok, true);
});

// ------------------------------------------------- screenshot names (src/util.mjs)

test('a non-Latin route path keeps its own screenshot name', () => {
  // `[^a-z0-9]` stripped every non-Latin character, so EVERY such path slugged to
  // the literal 'route': two of them wrote to the same page-route.jpeg, the second
  // silently overwrote the first, and both report rows pointed at the wrong page.
  assert.equal(slugOf('/'), 'home');
  assert.equal(slugOf('/some/page'), 'some-page', 'ASCII behaviour is unchanged');
  assert.equal(slugOf('/제품'), '제품');
  assert.notEqual(slugOf('/제품'), slugOf('/회사소개'));
  assert.equal(slugOf('/ru/каталог'), 'ru-каталог');
});

test('screenshot names are made injective across the resolved route list', () => {
  // Unicode alone is not enough: '/a/b' and '/a-b' still slug the same.
  assert.deepEqual(uniqueSlugs(['/a/b', '/a-b']), ['a-b', 'a-b-1']);
  assert.deepEqual(uniqueSlugs(['/', '/x', '/y']), ['home', 'x', 'y'], 'the common case is untouched');
});
