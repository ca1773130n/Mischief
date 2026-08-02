import test from 'node:test';
import assert from 'node:assert/strict';
import { defineConfig, resolveConfig, ConfigError } from '../src/config.mjs';
import { resolveRoutes, normalizeRoute } from '../src/routes.mjs';
import { resolveMutators } from '../src/mutators/index.mjs';
import { defaultClassifyResponse } from '../src/collect.mjs';
import { DEFAULT_CONFIG } from '../src/defaults.mjs';

test('defineConfig rejects a typo in a top-level key', () => {
  assert.throws(() => defineConfig({ baseURL: 'http://localhost:3000' }), ConfigError);
  assert.doesNotThrow(() => defineConfig({ baseUrl: 'http://localhost:3000' }));
});

test('defineConfig rejects a typo in a NESTED key — every safety switch lives one level down', () => {
  // A one-level check meant the documented remedy for a false exit 3 could be
  // misspelled into a no-op: the report says "set guardrails.forceOpenShadowRoots:
  // true", and `forceOpenShadowRoot` produced a byte-identical report and no error.
  const bad = [
    { guardrails: { forceOpenShadowRoot: true } },
    { auth: { detectLoginScreens: false } },
    { guardrails: { requireClickabl: false } },
    { probes: { textSkipSelectr: '.x' } },
    { timing: { gotoWaitUntill: 'load' } },
    { report: { outdir: './r' } },
  ];
  for (const cfg of bad) {
    assert.throws(() => defineConfig({ baseUrl: 'http://localhost:3000', ...cfg }), ConfigError, JSON.stringify(cfg));
  }
  // The error has to name the key that was rejected AND what was valid there.
  try {
    defineConfig({ guardrails: { forceOpenShadowRoot: true } });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /guardrails\.forceOpenShadowRoot/);
    assert.match(e.message, /forceOpenShadowRoots/);
  }
});

test('defineConfig still accepts every legitimately free-form nested shape', () => {
  // Stopping at two levels is deliberate: level 3 is where user-chosen names live.
  assert.doesNotThrow(() =>
    defineConfig({
      baseUrl: 'http://localhost:3000',
      mutators: { weights: { myOwnMutator: 5, randomClick: 1 }, options: { offlineMs: 100 } },
      viewports: { mobile: { width: 320, height: 480, deviceScaleFactor: 1, mobile: true } },
      network: { slow3g: { offline: false, latency: 900, downloadThroughput: 1, uploadThroughput: 1 } },
      input: { invalidValuesByType: { number: ['1e400'] } },
      guardrails: { forceOpenShadowRoots: true, requireEffectiveSteps: false },
    }),
  );
});

test('allowedHosts is fail-closed: an unlisted host is refused', () => {
  assert.throws(() => resolveConfig({ baseUrl: 'https://app.example.com' }), /REFUSED/);
});

test('--allow-prod overrides the allowlist for one run', () => {
  const cfg = resolveConfig({ baseUrl: 'https://app.example.com' }, { allowProd: true });
  assert.equal(cfg.baseOrigin, 'https://app.example.com');
});

test('a listed host runs without a flag; leading-dot entries match subdomains', () => {
  assert.doesNotThrow(() => resolveConfig({ baseUrl: 'http://localhost:5173' }));
  const cfg = resolveConfig({ baseUrl: 'https://staging.example.com', allowedHosts: ['.example.com'] });
  assert.equal(cfg.baseOrigin, 'https://staging.example.com');
  assert.throws(() => resolveConfig({ baseUrl: 'https://example.com', allowedHosts: ['.example.com'] }), /REFUSED/);
});

test('overrides beat the config file, which beats the defaults', () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000', steps: 5 }, { steps: 9 });
  assert.equal(cfg.steps, 9);
  assert.equal(cfg.report.consoleCap, DEFAULT_CONFIG.report.consoleCap);
});

test('a RegExp survives the merge instead of being flattened into an object', () => {
  const re = /danger/i;
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000', guardrails: { dangerPattern: re } });
  assert.ok(cfg.guardrails.dangerPattern instanceof RegExp);
  assert.equal(cfg.guardrails.dangerPattern.source, 'danger');
  assert.equal(cfg.guardrails.ignoreAttribute, 'data-qa-ignore'); // sibling default kept
});

test('consoleIgnore strings are refused at load, not thrown from a page handler', () => {
  // A plain string reaches collect.mjs's `re.test(text)` and throws from inside
  // a page 'console' handler — uncaught, so the run dies on whatever route it
  // first hits, writes no log.json, and exits 1, which is indistinguishable
  // from real HIGH findings. The mistake is natural because
  // presets.consoleIgnore is keyed by framework name.
  const base = { baseUrl: 'http://localhost:3000' };
  assert.throws(
    () => resolveConfig({ ...base, network: { consoleIgnore: ['vite', 'vue'] } }),
    /must be RegExp/,
  );
  assert.throws(
    () => resolveConfig({ ...base, network: { consoleIgnore: [/ok/, null] } }),
    /must be RegExp/,
  );
  // The legitimate shapes still resolve.
  assert.ok(resolveConfig({ ...base, network: { consoleIgnore: [/\[vite\] connect/] } }));
  assert.ok(resolveConfig({ ...base, network: { consoleIgnore: [] } }));
  assert.ok(resolveConfig(base));
});

test('auth misconfiguration is caught before a browser opens', () => {
  const base = { baseUrl: 'http://localhost:3000' };
  assert.throws(() => resolveConfig({ ...base, auth: { strategy: 'localStorage', from: 'x.json' } }), /needs auth.key/);
  assert.throws(() => resolveConfig({ ...base, auth: { strategy: 'cookies' } }), /needs auth.from/);
  assert.throws(() => resolveConfig({ ...base, auth: { strategy: 'nope' } }), /auth.strategy must be/);
  assert.throws(
    () => resolveConfig({ ...base, browser: { mode: 'attach' }, auth: { strategy: 'storageState', from: 's.json' } }),
    /cannot be applied in browser.mode 'attach'/,
  );
});

test('guardrails.maxScanNodes must be usable, because a bad value truncates every scan', () => {
  const base = { baseUrl: 'http://localhost:3000' };
  for (const bad of [0, -1, NaN, 'abc', null]) {
    assert.throws(() => resolveConfig({ ...base, guardrails: { maxScanNodes: bad } }), /maxScanNodes must be a number/);
  }
  assert.equal(resolveConfig(base).guardrails.maxScanNodes, DEFAULT_CONFIG.guardrails.maxScanNodes);
});

test('a user-supplied clickableSelector survives the merge intact', () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000', guardrails: { clickableSelector: 'button, my-btn' } });
  assert.equal(cfg.guardrails.clickableSelector, 'button, my-btn');
  assert.equal(cfg.guardrails.ignoreAttribute, 'data-qa-ignore'); // sibling default kept
});

test('the goto default is not networkidle, which no app with an open socket reaches', () => {
  // HMR sockets, SSE, realtime clients and analytics heartbeats all made every
  // route burn the full gotoTimeoutMs and record a 'goto' finding.
  assert.equal(resolveConfig({ baseUrl: 'http://localhost:3000' }).timing.gotoWaitUntil, 'domcontentloaded');
});

test('gotoWaitUntil is validated like its enum neighbours', () => {
  // Unvalidated, a one-character typo made EVERY page.goto reject, the whole run
  // happened on about:blank, and the report diagnosed it by naming a different key.
  const base = { baseUrl: 'http://localhost:3000' };
  for (const bad of ['domcontentLoaded', 'idle', '', null]) {
    assert.throws(() => resolveConfig({ ...base, timing: { gotoWaitUntil: bad } }), /gotoWaitUntil must be one of/);
  }
  for (const good of ['load', 'domcontentloaded', 'networkidle', 'commit']) {
    assert.equal(resolveConfig({ ...base, timing: { gotoWaitUntil: good } }).timing.gotoWaitUntil, good);
  }
});

test('maxCandidates gets the validation its sibling got, for the same reason', () => {
  // The walk aborts on `out.length >= maxCandidates`, and `0 >= null` is true, so a
  // bad value returned an empty candidate list and reported it as "nothing to click".
  const base = { baseUrl: 'http://localhost:3000' };
  for (const bad of [0, -1, null, 'many']) {
    assert.throws(() => resolveConfig({ ...base, guardrails: { maxCandidates: bad } }), /maxCandidates must be a number/);
  }
});

test('the danger guardrail is not English-only by default', () => {
  // presets.danger.en was the default, so a Korean, Japanese or Chinese app got
  // ZERO destructive-click protection out of the box and the only hint was a
  // Recipes section in the README.
  const re = resolveConfig({ baseUrl: 'http://localhost:3000' }).guardrails.dangerPattern;
  for (const label of ['Delete account', 'Log out', '삭제', '계정 삭제', '로그아웃', '削除', '退会', '删除', '登出']) {
    assert.ok(re.test(label), `the default guardrail must refuse "${label}"`);
  }
  assert.ok(!re.test('Save changes'), 'and must not refuse everything');
  assert.ok(!re.test('저장'), 'nor everything Korean');
});

test('requiresAuth without waitFor WARNS — it must never refuse to run', () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000', routes: [{ path: '/x', requiresAuth: true }] });
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /\/x/);
  assert.match(cfg.warnings[0], /waitFor/);
});

test('attach mode WARNS that ignoreHTTPSErrors cannot apply — found by a live run', () => {
  // A real run against a Vite dev server on a self-signed cert failed every
  // navigation with ERR_CERT_AUTHORITY_INVALID while the config plainly said
  // ignoreHTTPSErrors: true. The setting is a newContext() option and attach
  // adopts an existing context, so it was dropped in silence.
  const attach = resolveConfig({ baseUrl: 'http://localhost:3000', browser: { mode: 'attach', ignoreHTTPSErrors: true } });
  assert.equal(attach.warnings.length, 1);
  assert.match(attach.warnings[0], /ignoreHTTPSErrors/);
  assert.match(attach.warnings[0], /attach/);

  // Launch mode applies it, so there is nothing to say.
  assert.equal(
    resolveConfig({ baseUrl: 'http://localhost:3000', browser: { mode: 'launch', ignoreHTTPSErrors: true } }).warnings.length,
    0,
  );
  // Nor when the option is off in attach mode.
  assert.equal(
    resolveConfig({ baseUrl: 'http://localhost:3000', browser: { mode: 'attach', ignoreHTTPSErrors: false } }).warnings.length,
    0,
  );
});

test('a gated route with waitFor warns about nothing, and warnings always exists', () => {
  // Reporters read config.warnings unconditionally, so the field must be an array
  // even on a default config.
  assert.equal(resolveConfig({ baseUrl: 'http://localhost:3000', routes: [{ path: '/x', requiresAuth: true, waitFor: '#x' }] }).warnings.length, 0);
  assert.ok(Array.isArray(resolveConfig({ baseUrl: 'http://localhost:3000' }).warnings));
});

test('routes normalize from strings and objects alike', () => {
  assert.deepEqual(normalizeRoute('one').path, '/one');
  const r = normalizeRoute({ path: '/a', requiresAuth: true, waitFor: '#x' });
  assert.equal(r.requiresAuth, true);
  assert.equal(r.waitFor, '#x');
  assert.equal(r.steps, null);
});

test('a resolver returning nothing drops its route loudly, not silently', async () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000' });
  const dropped = [];
  const routes = await resolveRoutes(
    ['/', { path: '/things/:id', resolve: async () => null }],
    cfg,
    (r, why) => dropped.push([r.path, why]),
  );
  assert.deepEqual(routes.map((r) => r.path), ['/']);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0][1], /returned nothing/);
});

test('a throwing resolver drops its route rather than killing the run', async () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000' });
  const dropped = [];
  const routes = await resolveRoutes(
    ['/', { path: '/x/:id', resolve: async () => { throw new Error('API down'); } }],
    cfg,
    (r, why) => dropped.push(why),
  );
  assert.deepEqual(routes.map((r) => r.path), ['/']);
  assert.match(dropped[0], /API down/);
});

test('mutator weights: the three named ones are fixed, the rest split 45', () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000' });
  const { entries } = resolveMutators(cfg);
  const byName = Object.fromEntries(entries);
  assert.equal(byName.randomClick, 30);
  assert.equal(byName.invalidInput, 15);
  assert.equal(byName.keyboardSpam, 10);
  // 10 built-ins, 3 named -> 7 share the remaining 45. Same as the original harness.
  assert.equal(byName.refresh, 45 / 7);
  assert.ok(Math.abs(entries.reduce((s, [, w]) => s + w, 0) - 100) < 1e-9); // 45/7 does not sum back to 45 exactly
});

test('an unknown mutator name fails loudly', () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000', mutators: { enabled: ['randomClick', 'nope'] } });
  assert.throws(() => resolveMutators(cfg), /Unknown mutator\(s\): nope/);
});

test('default response classification: 5xx critical, 402/403 gate, 401 gate only near login', () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000' });
  const c = (status, url = 'http://localhost:3000/api/x') => defaultClassifyResponse({ status, url }, cfg);
  assert.equal(c(200), 'ignore');
  assert.equal(c(503), 'critical');
  assert.equal(c(402), 'gate');
  assert.equal(c(403), 'gate');
  assert.equal(c(401, 'http://localhost:3000/api/session'), 'gate');
  assert.equal(c(401, 'http://localhost:3000/api/things'), 'high');
  assert.equal(c(404), 'high');
});

test('loginAdjacent covers localized and token-named auth endpoints', () => {
  // English-only, every 401 from a localized auth endpoint was filed as HIGH and
  // drove exit code 1 on a perfectly normal gated request.
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000' });
  const gated = (url) => defaultClassifyResponse({ status: 401, url }, cfg);
  for (const url of ['/api/login', '/ko/로그인', '/anmelden', '/connexion', '/api/v1/token', '/auth/refresh']) {
    assert.equal(gated(url), 'gate', `401 from ${url} is a gate, not a defect`);
  }
  assert.equal(gated('/api/things/7'), 'high');
});

test('a cross-origin API is classified when watched, and ignored when not', () => {
  // The split frontend/API layout — the most common dev layout, and the layout of
  // this package's own example config — used to yield ZERO 4xx/5xx findings, because
  // every response off baseOrigin was dropped BEFORE classification and no report
  // line said the API had never been looked at.
  const plain = resolveConfig({ baseUrl: 'http://localhost:3000' });
  assert.deepEqual(plain.watchedOrigins, ['http://localhost:3000']);
  const apiUrl = 'http://localhost:8000/api/things';
  assert.equal(defaultClassifyResponse({ status: 500, url: apiUrl, watched: false }, plain), 'ignore');

  const watching = resolveConfig({
    baseUrl: 'http://localhost:3000',
    network: { watchOrigins: ['http://localhost:8000/ignored/path'] },
  });
  assert.deepEqual(watching.watchedOrigins, ['http://localhost:3000', 'http://localhost:8000']);
  assert.equal(defaultClassifyResponse({ status: 500, url: apiUrl, watched: true }, watching), 'critical');
  // A CDN 500 still is not this app's bug.
  assert.equal(defaultClassifyResponse({ status: 500, url: 'https://cdn.example/x.js', watched: false }, watching), 'ignore');
  assert.throws(() => resolveConfig({ baseUrl: 'http://localhost:3000', network: { watchOrigins: ['not a url'] } }), /not a URL/);
});

test('a consoleIgnore that is not an array is a ConfigError, not a raw TypeError', () => {
  // `|| []` only guards FALSY values. A bare RegExp — the array simply forgotten,
  // which is the most natural version of this mistake — is truthy and not
  // iterable, so the for...of threw TypeError before the instanceof check ran.
  // bin/mischief.mjs prints e.stack for anything that is not a ConfigError, so
  // the one misconfiguration this validation exists to explain got a stack trace.
  const base = { baseUrl: 'http://localhost:3000' };
  for (const bad of [/vite/, { 0: /vite/ }, 'vite', 42, true]) {
    assert.throws(
      () => resolveConfig({ ...base, network: { consoleIgnore: bad } }),
      (e) => e instanceof ConfigError && /consoleIgnore must be an array/.test(e.message),
      `consoleIgnore: ${String(bad)} must fail as a ConfigError`,
    );
  }
  // null/undefined still mean "unset", and arrays still take the per-entry path.
  assert.ok(resolveConfig({ ...base, network: { consoleIgnore: null } }));
  assert.throws(() => resolveConfig({ ...base, network: { consoleIgnore: ['vite'] } }), /must be RegExp/);
});
