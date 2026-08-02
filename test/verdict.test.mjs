// The run-level verdict: "did this run actually test anything, and can it say so".
//
// Everything here guards a FALSE GREEN. Each case below was verified to exit 0
// CLEAN before the fix, which is the outcome this package exists to make
// impossible: an empty findings list from a harness that never touched the app.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newRouteStats, normalizeRoute } from '../src/routes.mjs';
import { backOff, defaultClassifyResponse } from '../src/collect.mjs';
import { resolveConfig } from '../src/config.mjs';
import { runMonkey } from '../src/run.mjs';
import {
  EXIT,
  exitCodeFor,
  routeWasTested,
  summarize,
  unverifiedCoverageReason,
  unverifiedReasons,
} from '../src/severity.mjs';
import { browserOrNull } from './browser.mjs';

const ps = (path, over = {}) => Object.assign(newRouteStats(normalizeRoute(path)), over);
const clicked = (n = 3) => ({ atEnter: n, attempts: 1, empty: 0, max: n, scanTruncated: false, capped: false, probeFailed: false, selector: 'button', shadow: null });
const cfg = (over = {}) => resolveConfig({ baseUrl: 'http://localhost:3000', ...over });
const state = () => ({ gates: [], skippedDanger: [], actionLog: [], verified: true, verification: null });

// -------------------------------------------------------- routeWasTested / reason

test('an empty route list is named, not silently called clean', () => {
  // [].some() is false and [].every() is true, so this case has to be answered
  // explicitly or the message builder emits an empty, nonsensical list.
  assert.match(unverifiedCoverageReason([]), /no route survived resolution/);
});

test('ALL ROUTES SKIPPED is not a pass', () => {
  const list = [ps('/a', { skipped: 'requiresAuth and this run has no session' }), ps('/b', { skipped: 'route.skip() returned true' })];
  const why = unverifiedCoverageReason(list);
  assert.match(why, /NOTHING WAS TESTED/);
  assert.match(why, /2 SKIPPED/);
  assert.match(why, /\/a, \/b/);
  assert.equal(routeWasTested(list[0]), false);
});

test('skipped plus unreached, covering every route, names both categories', () => {
  const why = unverifiedCoverageReason([ps('/a', { skipped: 'x' }), ps('/b', { unreached: 'y' })]);
  assert.match(why, /1 SKIPPED/);
  assert.match(why, /1 never reached/);
});

test('routes that completed ZERO steps tested nothing', () => {
  // route.steps: 0 used to slip through normalizeRoute, so `route.steps ?? config.steps`
  // yielded 0 and the whole run exited 0 CLEAN.
  assert.match(unverifiedCoverageReason([ps('/a'), ps('/b')]), /2 that ran 0 steps/);
});

test('a route where EVERY step threw was not exercised', () => {
  const failures = Array.from({ length: 5 }, (_, i) => ({ step: i + 1, mutator: 'randomClick', error: 'boom' }));
  const one = ps('/a', { steps: 5, stepFailures: failures });
  assert.equal(routeWasTested(one), false);
  assert.match(unverifiedCoverageReason([one]), /1 where EVERY step failed/);
});

test('the boundary is exactly 100%: one step landing is a real run', () => {
  // A ratio threshold would need a tunable and would misfire on a flaky app.
  const failures = Array.from({ length: 11 }, (_, i) => ({ step: i + 1, mutator: 'refresh', error: 'boom' }));
  const one = ps('/a', { steps: 12, stepFailures: failures });
  assert.equal(routeWasTested(one), true);
  assert.equal(unverifiedCoverageReason([one]), null);
});

test('a PARTIALLY skipped run is still a real run', () => {
  // The regression guard: skipping is the documented purpose of --allow-anonymous
  // and route.skip(), so 1 skipped + 2 exercised must stay exit 0/1/2.
  const list = [ps('/a', { skipped: 'x' }), ps('/b', { steps: 12 }), ps('/c', { steps: 12 })];
  assert.equal(unverifiedCoverageReason(list), null);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: 0, highCount: 0 }), EXIT.CLEAN);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: 0, highCount: 1 }), EXIT.HIGH);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: 1, highCount: 0 }), EXIT.CRITICAL);
});

// --------------------------------------------------------------------- findings

test('a skipped route gets the finding it never had, at a severity that cannot move the exit code', () => {
  const list = [ps('/a', { skipped: 'x' }), ps('/b', { skipped: 'y' })];
  const s = summarize(list, state(), cfg());
  assert.equal(s.findings.filter((f) => f.kind === 'skipped').length, 2);
  assert.ok(s.findings.filter((f) => f.kind === 'skipped').every((f) => f.severity === 'unverified'));
  assert.equal(s.critCount, 0);
  assert.equal(s.highCount, 0);
});

test('an exception thrown while WE held the connection offline is not a critical', () => {
  // Found running mischief against a code-split Vue SPA: every offline window
  // failed a lazy route chunk, so 7 of 8 "criticals" were the offlineMode
  // mutator's own doing. `duringOffline` was already recorded on the record and
  // rendered in the markdown — it just never reached severity or critCount.
  const one = ps('/a', {
    steps: 12,
    clickable: clicked(),
    jsExceptions: [
      { message: 'Failed to fetch dynamically imported module: /src/views/Help.vue', duringOffline: true, action: 'offlineMode -' },
      { message: 'TypeError: cannot read properties of undefined', duringOffline: false, action: 'randomClick Save' },
    ],
  });
  const s = summarize([one], state(), cfg());
  const hits = s.findings.filter((f) => f.kind === 'js-exception');
  assert.equal(hits.length, 2, 'both are still reported');
  assert.equal(hits.filter((f) => f.severity === 'critical').length, 1);
  assert.equal(hits.filter((f) => f.severity === 'low').length, 1);
  assert.match(hits.find((f) => f.severity === 'low').message, /held the connection offline/);
  // The count has to move with the severity, or the headline and the list disagree.
  assert.equal(s.critCount, 1);
  assert.equal(s.tot.jsExc, 1);
  assert.equal(s.tot.jsExcOffline, 1);
});

test('an offline-only exception cannot on its own make the run exit CRITICAL', () => {
  const one = ps('/a', {
    steps: 12,
    clickable: clicked(),
    jsExceptions: [{ message: 'chunk load failed', duringOffline: true, action: 'offlineMode -' }],
  });
  const s = summarize([one], state(), cfg());
  assert.equal(s.critCount, 0);
  assert.equal(exitCodeFor({ verified: true, fatal: null, critCount: s.critCount, highCount: s.highCount }), EXIT.CLEAN);
});

test('zero clickable candidates is a finding about the RUN, not a HIGH about the app', () => {
  const one = ps('/a', {
    steps: 40,
    clickable: { atEnter: 0, attempts: 12, empty: 12, max: 0, scanTruncated: false, capped: false, probeFailed: false, selector: 'button', shadow: { openRoots: 2, closedSuspects: 1, undefinedEls: 0, hosts: ['my-card'] } },
  });
  const s = summarize([one], state(), cfg());
  const hits = s.findings.filter((f) => f.kind === 'no-clickable');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'unverified');
  assert.match(hits[0].message, /0 elements matched button/);
  assert.match(hits[0].message, /my-card/);
  assert.match(hits[0].message, /forceOpenShadowRoots/);
  assert.equal(s.tot.noClickable, 1);
  assert.equal(s.critCount, 0);
  assert.equal(s.highCount, 0);
});

test('a route that ran no steps produces no no-clickable finding', () => {
  // Proves the skipped/unreached paths and every hand-built report fixture (all
  // built from newRouteStats with steps: 0) are untouched.
  const s = summarize([ps('/a'), ps('/b', { skipped: 'x' })], state(), cfg());
  assert.equal(s.findings.filter((f) => f.kind === 'no-clickable').length, 0);
  assert.equal(s.tot.noClickable, 0);
});

test('scan truncation, a config cap and a crashed census are each reported distinctly', () => {
  const base = { atEnter: 5, attempts: 1, empty: 0, max: 5, selector: 'button', shadow: null };
  const s = summarize(
    [
      ps('/a', { steps: 1, clickable: { ...base, scanTruncated: true } }),
      ps('/b', { steps: 1, clickable: { ...base, capped: true } }),
      ps('/c', { steps: 1, clickable: { ...base, atEnter: null, max: 0, probeFailed: true } }),
    ],
    state(),
    cfg(),
  );
  const kinds = Object.fromEntries(s.findings.map((f) => [f.kind, f]));
  assert.equal(kinds['scan-truncated'].severity, 'medium');
  assert.match(kinds['scan-truncated'].message, /guardrails\.maxScanNodes \(20000\)/);
  assert.equal(kinds['candidates-capped'].severity, 'low');
  assert.equal(kinds['clickable-probe-failed'].severity, 'medium');
  // A crashed census must NOT read as "nothing to click" — that is the defect inverted.
  assert.equal(s.tot.noClickable, 0);
});

// ------------------------------------------------- dead watched origin (env, not app)

// A real run against a Vite dev server whose backend was not started reported 4
// CRITICAL and exit 2 — one per proxied endpoint — blaming the app for the
// environment. Zero successes from a watched origin is the signal.
const withOrigins = (originStats) => Object.assign(state(), { originStats });
const live = [ps('/a', { steps: 40, clickable: clicked() })];

test('a watched origin that never answered is unverified, not critical', () => {
  const st = withOrigins({ 'http://localhost:8000/api': { ok: 0, fail: 4 } });
  const reasons = unverifiedReasons(live, summarize(live, st, cfg()), cfg(), st);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /localhost:8000/);
  assert.match(reasons[0], /down rather than buggy/);
  assert.match(reasons[0], /deadOriginMinFailures/);
});

test('one broken endpoint among working ones stays CRITICAL — the over-fire guard', () => {
  // The outcome that must not be lost: an origin that IS answering, with a
  // genuinely 500ing endpoint, is an app defect and has to keep its exit 2.
  const st = withOrigins({ 'http://localhost:8000/api': { ok: 37, fail: 4 } });
  assert.deepEqual(unverifiedReasons(live, summarize(live, st, cfg()), cfg(), st), []);
});

test('too few failures to conclude, and never-contacted origins, stay quiet', () => {
  const one = withOrigins({ 'http://localhost:8000/api': { ok: 0, fail: 1 } });
  assert.deepEqual(unverifiedReasons(live, summarize(live, one, cfg()), cfg(), one), []);
  const untouched = withOrigins({ 'http://localhost:8000/api': { ok: 0, fail: 0 } });
  assert.deepEqual(unverifiedReasons(live, summarize(live, untouched, cfg()), cfg(), untouched), []);
});

test('deadOriginMinFailures: 0 disables the rule', () => {
  const st = withOrigins({ 'http://localhost:8000/api': { ok: 0, fail: 99 } });
  const c = cfg({ network: { deadOriginMinFailures: 0 } });
  assert.deepEqual(unverifiedReasons(live, summarize(live, st, c), c, st), []);
});

test('unverifiedReasons tolerates a caller that passes no state', () => {
  // run.mjs passes state, but the export is public and the old arity must not throw.
  assert.deepEqual(unverifiedReasons(live, summarize(live, state(), cfg()), cfg()), []);
});

// ------------------------------------------------------------ unverifiedReasons

test('a run where NO route offered a click is unverified, and names the remedy', () => {
  const empty = (p, shadow) => ps(p, { steps: 40, clickable: { atEnter: 0, attempts: 12, empty: 12, max: 0, scanTruncated: false, capped: false, probeFailed: false, selector: 'button', shadow } });
  const list = [empty('/a', { openRoots: 3, closedSuspects: 2, undefinedEls: 0, hosts: ['ion-button'] }), empty('/b', null)];
  const reasons = unverifiedReasons(list, summarize(list, state(), cfg()), cfg());
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /no route offered a single clickable candidate/);
  assert.match(reasons[0], /forceOpenShadowRoots/);
  assert.match(reasons[0], /guardrails\.requireClickable: false/);
});

test('ONE click-free route among real ones stays a per-route finding', () => {
  // A legal or docs page with nothing to click must not fail every run — that is
  // how a check gets switched off.
  const list = [
    ps('/a', { steps: 40, clickable: { atEnter: 0, attempts: 12, empty: 12, max: 0, scanTruncated: false, capped: false, probeFailed: false, selector: 'button', shadow: null } }),
    ps('/b', { steps: 40, clickable: clicked() }),
  ];
  const summary = summarize(list, state(), cfg());
  assert.equal(unverifiedReasons(list, summary, cfg()).length, 0);
  assert.equal(summary.findings.filter((f) => f.kind === 'no-clickable').length, 1);
});

test('requireClickable: false silences the escalation, never the report', () => {
  const list = [ps('/a', { steps: 40, clickable: { atEnter: 0, attempts: 12, empty: 12, max: 0, scanTruncated: false, capped: false, probeFailed: false, selector: 'button', shadow: null } })];
  const c = cfg({ guardrails: { requireClickable: false } });
  const summary = summarize(list, state(), c);
  assert.equal(unverifiedReasons(list, summary, c).length, 0);
  assert.equal(summary.findings.filter((f) => f.kind === 'no-clickable').length, 1);
});

test('a census that FAILED everywhere is unverified, not a clean pass', () => {
  // atEnter stays null when the census throws, and `null !== 0`, so the
  // requireClickable test used to evaluate false and the run exited 0 CLEAN while
  // its own report said "candidate coverage is UNKNOWN" — worse-known coverage
  // escaping a check that better-known coverage trips.
  const crashed = (p) => ps(p, { steps: 40, clickable: { atEnter: null, attempts: 12, empty: 12, max: 0, scanTruncated: false, capped: false, probeFailed: true, selector: null, shadow: null } });
  const list = [crashed('/a'), crashed('/b')];
  const reasons = unverifiedReasons(list, summarize(list, state(), cfg()), cfg());
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /UNKNOWN rather than zero/);
  assert.match(reasons[0], /\/a, \/b/);
});

test('one failed census among routes that DID see candidates is not a run-level verdict', () => {
  const list = [
    ps('/a', { steps: 40, clickable: clicked() }),
    ps('/b', { steps: 40, clickable: { atEnter: null, attempts: 1, empty: 1, max: 0, scanTruncated: false, capped: false, probeFailed: true, selector: null, shadow: null } }),
  ];
  assert.equal(unverifiedReasons(list, summarize(list, state(), cfg()), cfg()).length, 0);
});

test('a run whose every step was a NO-OP is unverified, and names the ratio', () => {
  // `--mutators invalidInput` against a page with no inputs: 40 steps, 0 failures,
  // 0 findings, exit 0 CLEAN. Mutators report "nothing to act on" as success.
  const list = [ps('/a', { steps: 40, noopSteps: 40, clickable: clicked() }), ps('/b', { steps: 40, noopSteps: 40, clickable: clicked() })];
  const reasons = unverifiedReasons(list, summarize(list, state(), cfg()), cfg());
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /every step that completed on every route was a NO-OP/);
  assert.match(reasons[0], /\/a: 40\/40/);
  assert.match(reasons[0], /requireEffectiveSteps: false/);
});

test('one real step anywhere clears the no-op verdict, and the opt-out works', () => {
  // The boundary that keeps this from firing on a merely quiet app.
  const list = [ps('/a', { steps: 40, noopSteps: 40, clickable: clicked() }), ps('/b', { steps: 40, noopSteps: 39, clickable: clicked() })];
  assert.equal(unverifiedReasons(list, summarize(list, state(), cfg()), cfg()).length, 0);

  const allNoop = [ps('/a', { steps: 10, noopSteps: 10, clickable: clicked() })];
  const off = cfg({ guardrails: { requireEffectiveSteps: false } });
  assert.equal(unverifiedReasons(allNoop, summarize(allNoop, state(), off), off).length, 0);
});

test('a partially-unreached run stays unverified, as it always was', () => {
  const list = [ps('/a', { steps: 12, clickable: clicked() }), ps('/b', { unreached: 'waitFor never matched' })];
  const reasons = unverifiedReasons(list, summarize(list, state(), cfg()), cfg());
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /1 route\(s\) were never reached: \/b/);
});

// --------------------------------------------------------------- normalizeRoute

test('a per-route steps of 0 fails at LOAD instead of producing an unverifiable run', () => {
  assert.throws(() => normalizeRoute({ path: '/a', steps: 0 }), /positive integer/);
  assert.throws(() => normalizeRoute({ path: '/a', steps: 2.5 }), /positive integer/);
  assert.throws(() => normalizeRoute({ path: '/a', steps: -1 }), /positive integer/);
  assert.equal(normalizeRoute({ path: '/a', steps: 3 }).steps, 3);
  assert.equal(normalizeRoute('/a').steps, null);
  assert.equal(normalizeRoute({ path: '/a', steps: null }).steps, null); // the replay shape
});

// ----------------------------------------------------------------- integration

test('runMonkey: every route skipped exits 3, not 0', async (t) => {
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  await browser.close();

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-verdict-'));
  try {
    // The exact case verified before the fix: 0 steps tested, 2 skipped, 0
    // findings, EXIT CODE 0.
    const config = resolveConfig({
      baseUrl: 'http://localhost:3000',
      routes: [
        { path: '/a', requiresAuth: true },
        { path: '/b', requiresAuth: true },
      ],
      steps: 1,
      seed: 1,
      allowAnonymous: true,
      quiet: true,
      report: { outDir, formats: ['markdown'], pageScreenshots: false },
    });
    const result = await runMonkey(config, { onLog: () => {} });
    assert.equal(result.summary.tot.steps, 0);
    assert.equal(result.verified, false);
    assert.equal(result.exitCode, EXIT.UNVERIFIED);
    assert.match(result.unverifiedReason, /NOTHING WAS TESTED/);
    const md = fs.readFileSync(result.reportPaths.find((p) => p.endsWith('.md')), 'utf8');
    assert.match(md, /NOT VERIFIED/);
    assert.match(md, /0\/2 routes exercised/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runMonkey: a component app is monkeyed, and a closed-root one fails loudly', async (t) => {
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  await browser.close();

  const app = (mode) => `<!doctype html><meta charset=utf-8><body style="margin:0">
    <qa-app></qa-app>
    <script>
      customElements.define('qa-app', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: '${mode}' }).innerHTML =
            '<button style="width:200px;height:40px">the only control</button>';
        }
      });
    </script></body>`;
  const serve = (mode) =>
    http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(app(mode)));

  const run = async (mode, guardrails = {}) => {
    const server = serve(mode);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-shadow-'));
    try {
      return await runMonkey(
        resolveConfig({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          routes: ['/'],
          steps: 2,
          seed: 1,
          quiet: true,
          mutators: { enabled: ['randomClick'] },
          probes: { a11y: false, brokenImages: false, overflow: false, perf: false },
          timing: { settleMs: 50, stepPauseMinMs: 0, stepPauseJitterMs: 0 },
          guardrails,
          report: { outDir, formats: [], pageScreenshots: false },
        }),
        { onLog: () => {} },
      );
    } finally {
      server.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  };

  // An OPEN root: the whole app is inside a custom element, and it used to yield
  // zero candidates, "no candidate" on every step, and exit 0 CLEAN.
  const open = await run('open');
  assert.equal(open.statsList[0].clickable.atEnter, 1);
  assert.equal(open.statsList[0].clickable.shadow.openRoots, 1);
  assert.equal(open.verified, true);
  assert.ok(open.state.actionLog.some((a) => a.target.includes('the only control')), 'it must actually have clicked it');

  // A CLOSED root is genuinely unreachable — so the run must refuse to pass, and
  // must name the one flag that would help.
  const shut = await run('closed');
  assert.equal(shut.statsList[0].clickable.atEnter, 0);
  assert.equal(shut.exitCode, EXIT.UNVERIFIED);
  assert.match(shut.unverifiedReason, /no route offered a single clickable candidate/);
  assert.match(shut.unverifiedReason, /forceOpenShadowRoots/);
  assert.match(shut.unverifiedReason, /qa-app/);

  const forced = await run('closed', { forceOpenShadowRoots: true });
  assert.equal(forced.statsList[0].clickable.atEnter, 1, 'the escape hatch must work end to end');
  assert.equal(forced.verified, true);
});

test('runMonkey: a baseUrl with nothing listening is exit 3, never a green report', async (t) => {
  // The likeliest false green of all, because "the app failed to boot" is the
  // common CI case. Before the fix: goto rejected with ERR_CONNECTION_REFUSED into
  // a 'medium' note, every step ran on about:blank, one mutator in four threw so
  // `steps > stepFailures` called both routes exercised, and the report said
  // "coverage: 2/2 routes exercised · 0 critical · 0 high" and EXIT 0.
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  await browser.close();

  // Bind a port, then release it, so nothing can be listening there.
  const probe = http.createServer(() => {});
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-dead-'));
  try {
    const result = await runMonkey(
      resolveConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        routes: ['/', '/gated'],
        steps: 4,
        seed: 1,
        quiet: true,
        timing: { settleMs: 50, gotoTimeoutMs: 3000, stepPauseMinMs: 0, stepPauseJitterMs: 0 },
        report: { outDir, formats: ['markdown'], pageScreenshots: false },
      }),
      { onLog: () => {} },
    );
    assert.equal(result.exitCode, EXIT.UNVERIFIED);
    assert.equal(result.verified, false);
    assert.equal(result.summary.tot.steps, 0, 'not one step may be credited to a route never navigated to');
    assert.equal(result.summary.tot.unreached, 2);
    for (const p of result.statsList) assert.match(p.unreached, /never navigated to/);
    const md = fs.readFileSync(result.reportPaths.find((p) => p.endsWith('.md')), 'utf8');
    assert.match(md, /NOT VERIFIED/);
    assert.match(md, /0\/2 routes exercised/);
    assert.ok(!md.includes('2/2 routes exercised'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runMonkey: a probe still finds a leak the page renders AFTER the settle', async (t) => {
  // Collateral of the domcontentloaded default: the enter-phase probes lost their
  // render window, shrinking from up to 30s of JS execution to settleMs. Text hits
  // default to severity 'high', so a late-hydrating SPA silently lost the
  // highest-value probe class. Fixed by a `load` wait plus running the text, a11y
  // and image probes at BOTH phases.
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  await browser.close();

  const body = `<!doctype html><meta charset=utf-8><body style="margin:0">
    <button style="width:120px;height:24px">ok</button><div id="app"></div>
    <script>setTimeout(() => {
      document.getElementById('app').innerHTML = '<p>LEAKEDMARKER in the table</p>';
    }, 900);</script></body>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-late-'));
  try {
    const result = await runMonkey(
      resolveConfig({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        routes: ['/'],
        steps: 6,
        seed: 3,
        quiet: true,
        mutators: { enabled: ['keyboardSpam'] },
        probes: { a11y: false, brokenImages: false, overflow: false, perf: false, textPatterns: [{ name: 'marker', re: /LEAKEDMARKER/ }] },
        // Deliberately far shorter than the 900ms render: the enter scan alone
        // cannot see this, so only the exit pass can.
        timing: { settleMs: 20, stepPauseMinMs: 0, stepPauseJitterMs: 0 },
        report: { outDir, formats: [], pageScreenshots: false },
      }),
      { onLog: () => {} },
    );
    assert.equal(result.summary.tot.text, 1, 'the leak renders 900ms in — an enter-only scan reports zero');
    assert.equal(result.summary.highCount, 1);
    assert.equal(result.exitCode, EXIT.HIGH);
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runMonkey: a pre-flight config error returns exit 3 and leaves no orphan run dir', async () => {
  // resolveRoutes/resolveMutators/resolveReporters used to throw out of runMonkey —
  // breaking its documented "never throws" contract — and did it AFTER mkdirSync,
  // so every bad config left an empty reports/<runId>/shots behind.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-preflight-'));
  try {
    const config = resolveConfig({
      baseUrl: 'http://localhost:3000',
      routes: [{ path: '/a', steps: 0 }],
      quiet: true,
      report: { outDir, formats: ['markdown'] },
    });
    const result = await runMonkey(config, { onLog: () => {} });
    assert.equal(result.exitCode, EXIT.UNVERIFIED);
    assert.equal(result.verified, false);
    assert.match(result.unverifiedReason, /positive integer/);
    assert.deepEqual(result.reportPaths, []);
    assert.deepEqual(fs.readdirSync(outDir), [], 'a config typo must not litter a run directory');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runMonkey: a trailing-slash redirect is not drift, a locale prefix is', async (t) => {
  const browser = await browserOrNull();
  if (!browser) return t.skip('no Chrome/Edge available — playwright-core ships no browsers');
  await browser.close();

  const body = '<!doctype html><meta charset=utf-8><body style="margin:0"><button style="width:120px;height:24px">ok</button></body>';
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    // What Next.js trailingSlash and most static hosts do on every navigation.
    if (u === '/slashy') return void res.writeHead(308, { location: '/slashy/' }).end();
    // Genuine route-list drift, which must KEEP being reported.
    if (u === '/moved') return void res.writeHead(302, { location: '/elsewhere' }).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-slash-'));
  try {
    const config = resolveConfig({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      routes: ['/slashy', '/moved'],
      steps: 1,
      seed: 1,
      quiet: true,
      mutators: { enabled: ['keyboardSpam'] },
      probes: { a11y: false, brokenImages: false, overflow: false, perf: false },
      timing: { settleMs: 50, stepPauseMinMs: 0, stepPauseJitterMs: 0 },
      report: { outDir, formats: [], pageScreenshots: false },
    });
    const result = await runMonkey(config, { onLog: () => {} });
    assert.equal(result.statsList[0].redirectedTo, null, '/slashy -> /slashy/ is normalization, not drift');
    assert.equal(result.statsList[1].redirectedTo, '/elsewhere');
    assert.equal(result.summary.tot.redirected, 1);
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// ------------------------------------------- self-inflicted perf (harness, not app)

// A real run reported "LCP 29.4s > 4.0s" as a MEDIUM app finding on a route whose
// slow-request lines were all annotated "(during slow-3G window)". collectPerf runs
// at exit too and keeps max(), so a `refresh` inside the harness's own throttle sets
// the worst sample and it survives to the report unlabelled.
test('a perf sample taken under the harness throttle is demoted and labelled', () => {
  const degraded = ps('/a', { steps: 10, clickable: clicked(), perf: { lcp: 29400, cls: 0.5, dcl: 0, load: 0 }, netDegraded: true });
  const f = Object.fromEntries(summarize([degraded], state(), cfg()).findings.map((x) => [x.kind, x]));
  assert.equal(f.lcp.severity, 'low');
  assert.equal(f.cls.severity, 'low');
  assert.match(f.lcp.message, /harness was throttling/);
});

test('an honest perf sample keeps its MEDIUM and says nothing about throttling', () => {
  const clean = ps('/a', { steps: 10, clickable: clicked(), perf: { lcp: 29400, cls: 0.5, dcl: 0, load: 0 }, netDegraded: false });
  const f = Object.fromEntries(summarize([clean], state(), cfg()).findings.map((x) => [x.kind, x]));
  assert.equal(f.lcp.severity, 'medium');
  assert.equal(f.cls.severity, 'medium');
  assert.doesNotMatch(f.lcp.message, /throttling/);
});

// ------------------------------------------------------------ rate limiting

test('a 429 is the harness outrunning the backend, not a HIGH app bug', () => {
  // defaultClassifyResponse used to fall through to 'high' for 429, so a small
  // backend that rate-limited the monkey's own 150-400ms step pace answered with
  // http-4xx findings and exit 1 — the harness filing its own load as the app's
  // bug, on a run whose coverage the throttling had already degraded.
  const c = cfg();
  assert.equal(defaultClassifyResponse({ status: 429, url: 'http://localhost:3000/rest/v1/t', watched: true }, c), 'throttled');

  const list = [
    ps('/a', {
      steps: 40,
      clickable: clicked(),
      rateLimited: [{ method: 'GET', url: '/rest/v1/t', status: 429, action: 'click button' }],
    }),
  ];
  const { findings, tot, critCount, highCount } = summarize(list, state(), c);

  assert.equal(tot.rateLimited, 1);
  assert.equal(highCount, 0, 'a rate limit must not fail the run');
  assert.equal(exitCodeFor({ verified: true, fatal: false, critCount, highCount }), EXIT.CLEAN);

  const f = findings.find((x) => x.kind === 'rate-limited');
  assert.equal(f.severity, 'medium');
  assert.match(f.message, /outran the backend/);
  assert.equal(findings.some((x) => x.kind === 'http-4xx'), false, '429 must never be reported as a 4xx');
});

test('backOff escalates, honours Retry-After, and stops at the ceiling', () => {
  const c = cfg();
  const s = { rateLimitPauseMs: 0 };

  backOff(s, undefined, c);
  assert.equal(s.rateLimitPauseMs, c.timing.rateLimitBackoffMs);
  backOff(s, undefined, c);
  assert.equal(s.rateLimitPauseMs, c.timing.rateLimitBackoffMs * 2, 'each further 429 doubles the pause');

  backOff(s, '30', c);
  assert.equal(s.rateLimitPauseMs, 30000, 'Retry-After seconds override the exponential step');

  backOff(s, '9999', c);
  assert.equal(s.rateLimitPauseMs, c.timing.rateLimitMaxPauseMs, 'a hostile Retry-After cannot stall the run');

  // Never decays: a later 429 with no hint must not walk the pause back down.
  backOff(s, undefined, c);
  assert.equal(s.rateLimitPauseMs, c.timing.rateLimitMaxPauseMs);
});
