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

test('routes normalize from strings and objects alike', () => {
  assert.deepEqual(normalizeRoute('pricing').path, '/pricing');
  const r = normalizeRoute({ path: '/a', requiresAuth: true, waitFor: '#x' });
  assert.equal(r.requiresAuth, true);
  assert.equal(r.waitFor, '#x');
  assert.equal(r.steps, null);
});

test('a resolver returning nothing drops its route loudly, not silently', async () => {
  const cfg = resolveConfig({ baseUrl: 'http://localhost:3000' });
  const dropped = [];
  const routes = await resolveRoutes(
    ['/', { path: '/items/:id', resolve: async () => null }],
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
  assert.equal(c(401, 'http://localhost:3000/api/papers'), 'high');
  assert.equal(c(404), 'high');
});
