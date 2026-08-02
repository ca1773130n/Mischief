import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMarkdown } from '../src/report/markdown.mjs';
import { jsonReporter } from '../src/report/index.mjs';
import { summarize, exitCodeFor, EXIT } from '../src/severity.mjs';
import { resolveConfig } from '../src/config.mjs';
import { newRouteStats, normalizeRoute } from '../src/routes.mjs';

/**
 * The structural contract, lifted verbatim from a real pre-extraction report.
 * Reports written months apart must stay diffable, so headings may be ADDED but
 * never renamed or reordered.
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
  const config = resolveConfig({ baseUrl: 'http://localhost:3000', seed: 1, steps: 6, routes: ['/one'] });
  const routes = [normalizeRoute('/one')];
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
  const { md, summary } = fixture({ ps: { unreached: 'waitFor "#marker" never appeared' } });
  assert.ok(md.includes('| /one (UNREACHED) |'));
  assert.ok(md.includes('## Coverage gaps'));
  assert.ok(md.includes('**NOT TESTED** /one'));
  assert.equal(summary.tot.unreached, 1);
  assert.ok(summary.findings.some((f) => f.kind === 'unreached'));
});

test('a redirected route shows its real destination — the stale-route-list detector', () => {
  const { md, summary } = fixture({ ps: { redirectedTo: '/explore' } });
  assert.ok(md.includes('| /one → /explore |'));
  assert.ok(md.includes('redirected to /explore'));
  assert.equal(summary.tot.redirected, 1);
});

test('a skipped route is labelled, so an anonymous run cannot look like coverage', () => {
  const { md } = fixture({ ps: { skipped: 'requiresAuth and this run has no session' } });
  assert.ok(md.includes('| /one (SKIPPED) |'));
  assert.ok(md.includes('skipped /one —'));
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

/** A report over an arbitrary list of route stats, for the multi-route cases. */
function multi(statsList, stateOver = {}) {
  const config = resolveConfig({ baseUrl: 'http://localhost:3000', seed: 1, steps: 6, routes: ['/'] });
  const routes = statsList.map((p) => normalizeRoute(p.page));
  const state = {
    gates: [], skippedDanger: [], actionLog: [], authed: false, verified: true, verification: null,
    unverifiedReason: null, ...stateOver,
  };
  const summary = summarize(statsList, state, config);
  return {
    md: buildMarkdown({ config, state, statsList, summary, startDate: new Date(), durationMs: 1, runId: 'r', routes }),
    summary,
  };
}

const stats = (page, over = {}) => Object.assign(newRouteStats(normalizeRoute(page)), over);
const NO_CLICK = {
  atEnter: 0, attempts: 12, empty: 12, max: 0, scanTruncated: false, capped: false, probeFailed: false,
  selector: 'a, button', shadow: { openRoots: 4, closedSuspects: 2, undefinedEls: 0, hosts: ['my-btn'] },
};

test('the clickable column is APPENDED, leaving the golden header and separator intact', () => {
  // The golden strings are matched as substrings, so appending keeps them as
  // prefixes. Inserting a column anywhere else breaks the report contract.
  const { md } = fixture();
  const header = md.split('\n').find((l) => l.startsWith('| page |'));
  const sep = md.split('\n').find((l) => l.startsWith('|---|'));
  assert.ok(header.startsWith(GOLDEN_SPINE[1]), 'the old header must remain a PREFIX');
  assert.ok(header.endsWith('| clickable |'));
  assert.ok(sep.includes(GOLDEN_SPINE[2]));
  assert.equal(sep.split('|').length - 2, 11, 'the separator must gain exactly one column');
});

test('a route with nothing to click says so in the table, the gaps and the header', () => {
  const { md, summary } = multi([stats('/a', { steps: 40, clickable: NO_CLICK })]);
  assert.ok(md.split('\n').some((l) => l.startsWith('| /a |') && l.endsWith('| **0** |')), 'a zero must be bold, not just another number');
  assert.ok(md.includes('## Coverage gaps'));
  assert.ok(md.includes('- **NOTHING TO CLICK** /a — 0 candidates matched a, button; 4 open shadow root(s), 2 with no open root'));
  assert.ok(md.includes('1 with nothing to click'));
  assert.ok(md.includes('- dom: 4 open shadow root(s) traversed'), 'positive evidence that piercing ran');
  assert.equal(summary.tot.noClickable, 1);
});

test('an all-skipped run is titled NOT VERIFIED and shows 0 of N exercised', () => {
  const list = [stats('/a', { skipped: 'requiresAuth and this run has no session' }), stats('/b', { skipped: 'route.skip() returned true' })];
  const { md } = multi(list, { verified: false, unverifiedReason: 'NOTHING WAS TESTED: not one of 2 route(s) was exercised' });
  assert.match(md, /^# QA monkey report — r — NOT VERIFIED$/m);
  assert.ok(md.includes('THIS RUN PROVED NOTHING'));
  assert.ok(md.includes('NOTHING WAS TESTED: not one of 2 route(s) was exercised'));
  assert.ok(md.includes('0/2 routes exercised'));
  assert.equal(md.split('\n').filter((l) => l.startsWith('| /') && l.includes('(SKIPPED)')).length, 2);

  // The new branches must not reorder or drop a heading.
  let cursor = 0;
  for (const marker of GOLDEN_SPINE) {
    const at = md.indexOf(marker, cursor);
    assert.ok(at >= 0, `missing section: ${marker}`);
    cursor = at + marker.length;
  }
});

test('routes that never ran because of a crash are marked, and only those', () => {
  const { md } = multi([stats('/a', { steps: 20 }), stats('/b')], {
    verified: false,
    unverifiedReason: 'the harness crashed mid-run',
  });
  assert.ok(!md.includes('| /a (NOT EXERCISED)'), 'a route that completed must not be marked');
  assert.ok(md.includes('| /b (NOT EXERCISED)'), 'a bare `| /b | 0 |` was indistinguishable from a route that finished');
});

test('the marker never appears in a report titled clean', () => {
  // The synthetic 0-step fixture must stay unbranded, or every clean report lies.
  const { md } = fixture();
  assert.ok(!md.includes('(NOT EXERCISED)'));
});

test('resolver-dropped routes are rendered, since they appear in no table row', () => {
  const { md } = multi([stats('/a', { steps: 5 })], {
    droppedRoutes: [{ path: '/things/:id', why: 'resolve() returned nothing' }],
  });
  assert.ok(md.includes('## Coverage gaps'));
  assert.ok(md.includes('- **NOT TESTED** /things/:id — dropped before the run: resolve() returned nothing'));
});

test('the reporter survives a state fixture that predates its newest fields', () => {
  // Every hand-built fixture in this file omits droppedRoutes and configWarnings.
  assert.doesNotThrow(() => multi([stats('/a', { steps: 5 })]));
});

test('every clickable finding summarize() files is also rendered under its severity', () => {
  // A MEDIUM section reading "None." while findings[] holds a medium is its own
  // small false green.
  const base = { atEnter: 5, attempts: 1, empty: 0, max: 5, selector: 'button', shadow: null };
  const { md, summary } = multi([
    stats('/a', { steps: 1, clickable: { ...base, scanTruncated: true } }),
    stats('/b', { steps: 1, clickable: { ...base, capped: true } }),
    stats('/c', { steps: 1, clickable: { ...base, probeFailed: true } }),
  ]);
  assert.ok(summary.findings.some((f) => f.kind === 'scan-truncated'));
  const medium = md.slice(md.indexOf('### MEDIUM'), md.indexOf('### LOW'));
  assert.ok(!medium.includes('None.'));
  assert.ok(medium.includes('the DOM scan stopped at guardrails.maxScanNodes (20000)'));
  assert.ok(medium.includes('the clickable census threw in-page'));
  const low = md.slice(md.indexOf('### LOW'), md.indexOf('## Gates hit'));
  assert.ok(!low.includes('None.'));
  assert.ok(low.includes('at least guardrails.maxCandidates (400)'));
});

test('an inert control renders under LOW, and LOW stops claiming "None."', () => {
  // markdown.mjs already had this bug once for throttled perf lines: a section
  // that prints a finding and then says "None." underneath it. The renderer and
  // the "None." guard must read the SAME predicate.
  const p = stats('/a', { steps: 40 });
  Object.assign(p.inert, { checks: 12, liveClicks: 9, liveSignatures: 9 });
  p.inert.hits.push({ key: '#save', label: 'button#save "Save"', count: 4 });
  const { md, summary } = multi([p]);
  assert.ok(summary.findings.some((f) => f.kind === 'inert-control' && f.severity === 'low'));
  const low = md.slice(md.indexOf('### LOW'), md.indexOf('## Gates hit'));
  assert.ok(low.includes('4 clicks on button#save "Save" produced no DOM change'), low);
  assert.ok(low.includes('9 other click(s) on this route did'), 'the evidence that the instrument works must travel with the claim');
  assert.ok(!low.includes('None.'));

  // Nothing about a LOW finding may reach the exit code, and no heading moved.
  assert.equal(summary.critCount, 0);
  assert.equal(summary.highCount, 0);
  let cursor = 0;
  for (const marker of GOLDEN_SPINE) {
    const at = md.indexOf(marker, cursor);
    assert.ok(at >= 0, `missing section: ${marker}`);
    cursor = at + marker.length;
  }
});

test('a route the dead-control probe skipped says so rather than reading as cleared', () => {
  const p = stats('/a', { steps: 40 });
  p.inert.disabled = 'open shadow root(s) are present and the observer cannot see inside them';
  const { md, summary } = multi([p]);
  const low = md.slice(md.indexOf('### LOW'), md.indexOf('## Gates hit'));
  assert.ok(low.includes('dead-control detection did not run — open shadow root(s) are present'), low);
  assert.ok(!low.includes('None.'));
  assert.equal(summary.tot.inert, 0, 'a route that was never judged accuses nothing');
});

test('log.json records the four keys the candidate list is a function of', () => {
  // A log that omitted them could not explain its own picks.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wqk-json-'));
  try {
    fs.mkdirSync(path.join(outDir, 'r'));
    const config = resolveConfig({ baseUrl: 'http://localhost:3000', seed: 1, steps: 6, routes: ['/'] });
    const routes = [normalizeRoute('/')];
    const statsList = [Object.assign(newRouteStats(routes[0]), { steps: 4, clickable: { ...NO_CLICK } })];
    const state = {
      gates: [], skippedDanger: [], actionLog: [], authed: false, verified: true, verification: null,
      unverifiedReason: null, configWarnings: ['w'],
    };
    const summary = summarize(statsList, state, config);
    const p = jsonReporter.write({ config, state, statsList, summary, routes, durationMs: 1, fatal: null }, { outDir, runId: 'r' });
    const log = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(log.config.guardrails.clickableSelector, config.guardrails.clickableSelector);
    assert.equal(log.config.guardrails.maxScanNodes, 20000);
    assert.equal(log.config.guardrails.requireClickable, true);
    assert.equal(log.config.guardrails.forceOpenShadowRoots, false);
    // Same rule one probe over: an inert-control verdict is a function of its
    // baseline rule and its grace window, so a log omitting them cannot explain
    // its own verdict.
    assert.equal(log.config.probes.deadControls, false);
    assert.equal(log.config.probes.deadControlBaselineWindows, 6);
    // The DURATION, not just the window count. Sharing timing.settleMs gave 375ms
    // windows, which can only learn a sub-375ms timer — an ordinary 0.5-3s poll
    // was never baselined and rescued dead controls for the rest of the walk. A
    // log omitting this cannot explain why a control was or was not accused.
    assert.equal(log.config.probes.deadControlBaselineMs, 4000);
    assert.equal(log.config.probes.deadControlGraceMs, 400);
    assert.equal(log.config.timing.settleMs, 1500, 'settleMs is the FLOOR on the baseline, not its length');
    assert.deepEqual(log.configWarnings, ['w']);
    assert.equal(log.pages[0].clickable.atEnter, 0, 'the census must round-trip, with no Set or undefined leakage');
    assert.deepEqual(log.pages[0].clickable.shadow.hosts, ['my-btn']);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('a config warning lands in a trailing Notes section', () => {
  const { md } = multi([stats('/a', { steps: 5 })], {
    configWarnings: ['route /dash declares requiresAuth but has no waitFor.'],
  });
  assert.ok(md.includes('## Notes'));
  assert.ok(md.includes('- route /dash declares requiresAuth but has no waitFor.'));
  assert.ok(md.indexOf('## Notes') > md.indexOf('## Skipped danger'), 'headings are only ever added at the end');
});

test('a throttled perf sample renders under LOW with its reason, never MEDIUM', () => {
  // The markdown section re-derived the LCP/CLS threshold from ps.perf instead of
  // reading summarize()'s verdict, so a sample summarize had already demoted to
  // 'low' still printed under MEDIUM. Two sources of truth, and the one a human
  // reads was the wrong one.
  const perf = { lcp: 29400, cls: 0.9, dcl: 0, load: 0 };
  const cut = (md) => ({
    medium: md.slice(md.indexOf('### MEDIUM'), md.indexOf('### LOW')),
    low: md.slice(md.indexOf('### LOW')),
  });

  const { md } = fixture({ ps: { steps: 5, perf, netDegraded: true } });
  assert.match(cut(md).low, /LCP 29\.4s.*harness was throttling/);
  assert.doesNotMatch(cut(md).medium, /LCP 29\.4s/);

  const honest = fixture({ ps: { steps: 5, perf, netDegraded: false } });
  assert.match(cut(honest.md).medium, /LCP 29\.4s/);
  assert.doesNotMatch(cut(honest.md).low, /LCP 29\.4s/);
});

test('an offline-caused exception is rendered under LOW, never under a CRITICAL (0) heading', () => {
  // summarize() demoted these and dropped them from critCount, but the renderer
  // looped every jsExceptions entry unconditionally. The result was a report
  // whose CRITICAL heading said 0, whose next line said "None.", and whose line
  // after that was a full exception write-up. The headline and the body
  // contradicting each other on one page is exactly the false verdict this
  // package exists to refuse.
  const { md, summary } = fixture({
    ps: {
      steps: 6,
      jsExceptions: [
        {
          message: 'Failed to fetch dynamically imported module: /src/views/Help.vue',
          stack: 'Error: chunk\n    at x (/a.js:1:1)',
          action: 'offlineMode -',
          tail: [],
          shot: null,
          duringOffline: true,
        },
      ],
    },
  });
  assert.equal(summary.critCount, 0, 'precondition: it is not a critical any more');

  const crit = md.split('### CRITICAL')[1].split('### HIGH')[0];
  assert.match(crit, /None\./);
  assert.ok(!crit.includes('#### JS exception'), `a demoted exception must not render under CRITICAL:\n${crit}`);
  assert.ok(!crit.includes('Help.vue'), 'nor its message');

  const low = md.split('### LOW')[1];
  assert.match(low, /Help\.vue/, 'it must still be reported, under LOW');
  assert.match(low, /held the connection offline/);
});

test('a real exception still renders in full under CRITICAL', () => {
  // The other half of the guard above: the skip must key on duringOffline, not
  // quietly swallow every exception.
  const { md, summary } = fixture({
    ps: {
      steps: 6,
      jsExceptions: [
        { message: 'TypeError: undefined is not a function', stack: 'Error\n    at y (/b.js:2:2)', action: 'randomClick Save', tail: [], shot: null, duringOffline: false },
      ],
    },
  });
  assert.equal(summary.critCount, 1);
  const crit = md.split('### CRITICAL')[1].split('### HIGH')[0];
  assert.match(crit, /#### JS exception 1/);
  assert.match(crit, /undefined is not a function/);
});
