import {
  a11yPassInPage,
  brokenImagesInPage,
  gatherCandidatesInPage,
  inertProbeInPage,
  perfInPage,
  textPatternsInPage,
} from './inpage.mjs';
import { reWire, sleep } from '../util.mjs';

/**
 * Register a custom probe.
 *
 * `evaluate` is SERIALIZED INTO THE PAGE — it must not close over anything from
 * your config file. Give it what it needs via `arg` (JSON-serializable only).
 *
 *   defineProbe({
 *     name: 'no-lorem',
 *     phase: 'enter',
 *     evaluate: () => document.body.innerText.includes('Lorem ipsum'),
 *     severity: 'medium',
 *   })
 *
 * Results land in the route's `custom[name]` and are reported under their
 * severity as `probe <name>` when the value is truthy / a non-empty array.
 */
export function defineProbe(spec) {
  if (!spec || typeof spec.name !== 'string') throw new Error('defineProbe needs a name');
  if (typeof spec.evaluate !== 'function') throw new Error(`probe "${spec.name}" needs evaluate()`);
  return { phase: 'enter', severity: 'medium', arg: undefined, ...spec };
}

/** Best-effort: a probe that throws must never take the run down. */
async function safeEval(page, fn, arg, fallback) {
  try {
    return arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
  } catch {
    return fallback;
  }
}

/**
 * Perf is accumulated across the route with max(), because SPA nav resets nothing.
 *
 * max() means the WORST sample survives to the report, and the worst sample is
 * very often one the harness caused: a `refresh` inside a slow-3G window reloads
 * the page over a 500kbit pipe and hands back an LCP of half a minute. Whether
 * that happened is tracked per ROUTE (ps.netDegraded), not per sample — the
 * PerformanceObserver records the value during the throttled load, but this
 * function reads it at exit, by which point the run loop has already restored
 * the network. A read-time flag is therefore always false exactly when it
 * matters.
 */
export async function collectPerf(page, ps) {
  const p = await safeEval(page, perfInPage, undefined, null);
  if (!p) return;
  ps.perf.lcp = Math.max(ps.perf.lcp, p.lcp);
  ps.perf.cls = Math.max(ps.perf.cls, p.cls);
  ps.perf.dcl = ps.perf.dcl || p.dcl;
  ps.perf.load = ps.perf.load || p.load;
}

export async function collectBrokenImages(page, ps, config) {
  const res = await safeEval(page, brokenImagesInPage, { maxScanNodes: config.guardrails.maxScanNodes }, null);
  if (!res) return;
  for (const src of res.images) ps.brokenImages.add(src);
  if (res.truncated) ps.scanTruncated = true;
}

/**
 * Read (and RESET) the dead-control observables. `xy` is the click point on the
 * pre-click read, null otherwise.
 *
 * Returns null and sets probeFailed on ANY failure to observe — an evaluate that
 * threw, or an init script that never ran. Same rule as collectClickable, and
 * for a sharper reason: safeEval swallows in-page throws, and this probe's whole
 * output is "nothing changed", so a silently-zeroed read would fabricate exactly
 * the deadness it exists to detect.
 */
export async function readInert(page, ps, xy) {
  // ci identifies WHICH candidate the click aimed at, so the probe can confirm by
  // identity that the click landed on it rather than on whatever happened to be
  // at those coordinates.
  const r = await safeEval(
    page,
    inertProbeInPage,
    { x: xy ? xy.x : null, y: xy ? xy.y : null, ci: xy && xy.ci != null ? xy.ci : null },
    null,
  );
  if (!r || !r.installed) {
    if (ps && ps.inert) ps.inert.probeFailed = true;
    return null;
  }
  return r;
}

/**
 * Run at BOTH phases, keeping whichever pass saw more.
 *
 * Enter-only was a silent undercount: the goto now resolves at
 * domcontentloaded, so on a slow-hydrating app the enter pass can scan a
 * skeleton. The exit pass looks at a page that has definitely rendered.
 */
export async function collectA11y(page, ps, config) {
  const a = await safeEval(page, a11yPassInPage, { maxScanNodes: config.guardrails.maxScanNodes }, null);
  if (!a) return;
  if (a.truncated) ps.scanTruncated = true;
  const total = (x) => (x ? x.imgsNoAlt.count + x.unlabeledButtons.count + x.unlabeledInputs.count : -1);
  // Whole object, not per-counter maxima: the samples have to belong to the counts
  // they are printed under.
  if (total(a) > total(ps.a11y)) ps.a11y = a;
}

/**
 * The single source of truth for the candidate-gathering argument.
 *
 * chooseClickPoint and this census MUST pass the same thing: a census that
 * counted candidates the click mutators could not see would be worse than no
 * census, because it would read as coverage.
 */
export function clickableArg(config) {
  const g = config.guardrails;
  return {
    selector: g.clickableSelector,
    dangerSource: g.dangerPattern.source,
    dangerFlags: g.dangerPattern.flags || 'i',
    ignoreAttribute: g.ignoreAttribute,
    maxCandidates: g.maxCandidates,
    maxScanNodes: g.maxScanNodes,
  };
}

/**
 * Count what this route offers a click, on entry.
 *
 * Per-route rather than per-click because a route whose `mutators` list excludes
 * randomClick/rapidDoubleClick would otherwise produce no data at all — and
 * "the report never said whether it found anything to click" is the defect.
 *
 * Polls with exactly the patience chooseClickPoint uses. It was a single shot,
 * which was survivable while zero candidates were merely reported — but a
 * zero-candidate run is now exit 3, so on a route with no click mutator this shot
 * is the ONLY evidence, and one glance at a slow-hydrating app under the
 * domcontentloaded default would fail a healthy run. See timing.settlePoll*.
 */
export async function collectClickable(page, ps, config) {
  const arg = clickableArg(config);
  let res = null;
  for (let attempt = 0; attempt < Math.max(1, config.timing.settlePollAttempts); attempt++) {
    res = await safeEval(page, gatherCandidatesInPage, arg, null);
    if (res && res.candidates.length) break;
    await sleep(config.timing.settlePollMs);
  }
  // safeEval swallows in-page throws, so a crash MUST NOT be recorded as zero:
  // that would fabricate the exact false signal this probe exists to detect.
  if (!res) {
    ps.clickable.probeFailed = true;
    return;
  }
  ps.clickable.atEnter = res.candidates.length;
  ps.clickable.max = Math.max(ps.clickable.max, res.candidates.length);
  ps.clickable.selector = res.selector;
  ps.clickable.shadow = res.shadow;
  // Kept separate from `shadow`, which every click attempt overwrites: the
  // no-clickable message quotes this census, and mixing an enter-time atEnter with
  // a last-step shadow count is evidence from two different moments.
  ps.clickable.shadowAtEnter = res.shadow;
  if (res.truncated) ps.clickable.scanTruncated = true;
  if (res.truncated) ps.scanTruncated = true;
  if (res.capped) ps.clickable.capped = true;
}

/**
 * Run at BOTH phases, unioned — same reason as collectA11y. Hits are the
 * highest-value probe class in the package and they default to severity 'high',
 * so an enter-only scan of an unrendered skeleton is the most expensive kind of
 * silent undercount.
 */
export async function collectTextPatterns(page, ps, config) {
  const patterns = config.probes.textPatterns || [];
  if (!patterns.length) return;
  const res = await safeEval(
    page,
    textPatternsInPage,
    {
      patterns: patterns.map((p) => ({ name: p.name, severity: p.severity || 'high', ...reWire(p.re) })),
      skipSelector: config.probes.textSkipSelector || '',
      maxHits: config.probes.maxTextHits,
      maxScanNodes: config.guardrails.maxScanNodes,
    },
    null,
  );
  if (!res) return;
  if (res.truncated) ps.scanTruncated = true;
  if (res.capped) ps.textHitsCapped = true;
  const seen = new Set((ps.textHits || []).map((h) => `${h.kind}|${h.where}|${h.text}`));
  for (const h of res.hits) {
    const k = `${h.kind}|${h.where}|${h.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ps.textHits.push(h);
  }
}

export async function collectCustom(page, ps, config, phase) {
  for (const probe of config.probes.custom || []) {
    if (probe.phase !== 'both' && probe.phase !== phase) continue;
    const value = await safeEval(page, probe.evaluate, probe.arg, null);
    if (value === null || value === false || (Array.isArray(value) && !value.length)) continue;
    ps.custom.push({ name: probe.name, severity: probe.severity || 'medium', value });
  }
}

/**
 * Run the whole built-in probe set for one phase.
 *
 * Only the clickable census is enter-only, because "what did this route offer on
 * arrival" is its definition. Everything else accumulates across both phases: an
 * enter-only scan happens settleMs after a goto that resolves at
 * domcontentloaded, which on a hydrating SPA is a scan of the skeleton.
 */
export async function runProbes(page, ps, config, phase) {
  if (config.probes.perf) await collectPerf(page, ps);
  if (config.probes.brokenImages) await collectBrokenImages(page, ps, config);
  if (phase === 'enter') await collectClickable(page, ps, config);
  if (config.probes.a11y) await collectA11y(page, ps, config);
  await collectTextPatterns(page, ps, config);
  await collectCustom(page, ps, config, phase);
}
