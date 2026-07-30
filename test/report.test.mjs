import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkdown } from '../src/report/markdown.mjs';
import { summarize, exitCodeFor, EXIT } from '../src/severity.mjs';
import { resolveConfig } from '../src/config.mjs';
import { newRouteStats, normalizeRoute } from '../src/routes.mjs';

/**
 * The structural contract, lifted verbatim from a real pre-extraction report
 * (HypePaper qa/reports/20260727-074043.md). Reports written months apart must
 * stay diffable, so headings may be ADDED but never renamed or reordered.
 */
const GOLDEN_SPINE = [
  '## Summary',
  '| page | steps | JS exc | net 4xx/5xx | console err | CLS | LCP | a11y flags | broken imgs | overflow? |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '## Findings',
  '### CRITICAL (',
  '### HIGH (',
  '### MEDIUM',
  '### LOW',
  '## Gates hit (',
  '## Skipped danger (',
];

const GOLDEN_HEADER_KEYS = ['- base:', '- seed:', '- pages:', '- session:', '- steps/page:', '- started:', '- totals:'];

function fixture(overrides = {}) {
  const config = resolveConfig({ baseUrl: 'http://localhost:3000', seed: 1, steps: 6, routes: ['/pricing'] });
  const routes = [normalizeRoute('/pricing')];
  const statsList = [newRouteStats(routes[0])];
  const state = {
    gates: [],
    skippedDanger: [],
    actionLog: [],
    authed: false,
    verified: true,
    verification: null,
    unverifiedReason: null,
    ...overrides.state,
  };
  Object.assign(statsList[0], overrides.ps || {});
  const summary = summarize(statsList, state, config);
  return {
    md: buildMarkdown({
      config,
      state,
      statsList,
      summary,
      startDate: new Date('2026-07-26T22:40:43.491Z'),
      durationMs: 6100,
      runId: '20260727-074043',
      routes,
    }),
    summary,
    state,
  };
}

test('the report keeps the golden section spine, in order', () => {
  const { md } = fixture();
  let cursor = 0;
  for (const marker of GOLDEN_SPINE) {
    const at = md.indexOf(marker, cursor);
    assert.ok(at >= 0, `missing section: ${marker}`);
    cursor = at + marker.length;
  }
});

test('the header keeps every golden key', () => {
  const { md } = fixture();
  for (const k of GOLDEN_HEADER_KEYS) assert.ok(md.includes(k), `missing header key: ${k}`);
  assert.ok(md.includes('- seed: **1**'), 'seed must be printed for replay');
});

test('a clean anonymous run on public routes reads as clean and exits 0', () => {
  const { md, summary, state } = fixture();
  assert.match(md, /### CRITICAL \(0\)/);
  assert.match(md, /### HIGH \(0\)/);
  assert.ok(md.includes('anonymous (no route declares requiresAuth)'));
  assert.equal(
    exitCodeFor({ verified: state.verified, fatal: null, critCount: summary.critCount, highCount: summary.highCount }),
    EXIT.CLEAN,
  );
});

test('the session line is DERIVED, not a hardcoded sentence about one app', () => {
  const config = resolveConfig({ baseUrl: 'http://localhost:3000', seed: 1, steps: 1, routes: ['/a'] });
  const routes = [normalizeRoute({ path: '/a', requiresAuth: true }), normalizeRoute('/b')];
  const statsList = routes.map(newRouteStats);
  const state = { gates: [], skippedDanger: [], actionLog: [], authed: false, verified: true, verification: null };
  const summary = summarize(statsList, state, config);
  const md = buildMarkdown({ config, state, statsList, summary, startDate: new Date(), durationMs: 1, runId: 'r', routes });
  assert.ok(md.includes('1 of 2 routes declare requiresAuth'), md.split('\n').find((l) => l.startsWith('- session:')));
});

test('a verified session says so, and names how it was verified', () => {
  const { md } = fixture({ state: { authed: true, verification: { ok: true, how: 'auth.verify()' } } });
  assert.ok(md.includes('AUTHENTICATED — verified (auth.verify())'));
});

test('an authenticated-but-unchecked run is never reported as verified', () => {
  const { md } = fixture({ state: { authed: true, verification: null } });
  assert.ok(md.includes('**AUTHENTICATED BUT UNVERIFIED**'));
});

test('a failed-verification run is titled NOT VERIFIED and warns against reading it as a pass', () => {
  const { md } = fixture({ state: { verified: false, unverifiedReason: 'session verification FAILED on /x' } });
  assert.match(md, /^# QA monkey report — 20260727-074043 — NOT VERIFIED/m);
  assert.ok(md.includes('THIS RUN PROVED NOTHING'));
  assert.ok(md.includes('session verification FAILED on /x'));
  assert.equal(exitCodeFor({ verified: false, fatal: null, critCount: 0, highCount: 0 }), EXIT.UNVERIFIED);
});

test('an unreached route is surfaced in the table and in Coverage gaps, not counted as a pass', () => {
  const { md, summary } = fixture({ ps: { unreached: 'waitFor "#arena" never appeared' } });
  assert.ok(md.includes('| /pricing (UNREACHED) |'));
  assert.ok(md.includes('## Coverage gaps'));
  assert.ok(md.includes('**NOT TESTED** /pricing'));
  assert.equal(summary.tot.unreached, 1);
  assert.ok(summary.findings.some((f) => f.kind === 'unreached'));
});

test('a redirected route shows its real destination — the stale-route-list detector', () => {
  const { md, summary } = fixture({ ps: { redirectedTo: '/explore' } });
  assert.ok(md.includes('| /pricing → /explore |'));
  assert.ok(md.includes('redirected to /explore'));
  assert.equal(summary.tot.redirected, 1);
});

test('a skipped route is labelled, so an anonymous run cannot look like coverage', () => {
  const { md } = fixture({ ps: { skipped: 'requiresAuth and this run has no session' } });
  assert.ok(md.includes('| /pricing (SKIPPED) |'));
  assert.ok(md.includes('skipped /pricing —'));
});

test('findings roll up into counts and exit codes', () => {
  const withCrit = fixture({
    ps: {
      jsExceptions: [{ message: 'boom', stack: '', duringOffline: false, action: 'randomClick', tail: [], shot: null }],
      net4xx: [{ method: 'GET', url: '/api/x', status: 404, action: 'randomClick' }],
    },
  });
  assert.equal(withCrit.summary.critCount, 1);
  assert.equal(withCrit.summary.highCount, 1);
  assert.match(withCrit.md, /### CRITICAL \(1\)/);
  assert.match(withCrit.md, /### HIGH \(1\)/);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: 1, highCount: 1 }), EXIT.CRITICAL);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: 0, highCount: 1 }), EXIT.HIGH);
});

test('a fatal crash is exit 3, distinguishable from "found HIGH findings"', () => {
  // The original harness returned 1 for both, so CI could not tell a broken
  // runner from a broken app.
  assert.equal(exitCodeFor({ verified: true, fatal: new Error('x'), critCount: 0, highCount: 5 }), EXIT.UNVERIFIED);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: 0, highCount: 5 }), EXIT.HIGH);
});

test('text-pattern hits are rendered and counted', () => {
  const { md, summary } = fixture({
    ps: { textHits: [{ kind: 'latex-math', severity: 'high', text: '$\\pi_0$+RoboVIP', where: 'td' }] },
  });
  assert.ok(md.includes('unrendered markup in visible text'));
  assert.ok(md.includes('latex-math'));
  assert.equal(summary.tot.text, 1);
});
