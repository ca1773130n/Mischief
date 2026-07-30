import { a11yPassInPage, brokenImagesInPage, perfInPage, textPatternsInPage } from './inpage.mjs';
import { reWire } from '../util.mjs';

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

/** Perf is accumulated across the route with max(), because SPA nav resets nothing. */
export async function collectPerf(page, ps) {
  const p = await safeEval(page, perfInPage, undefined, null);
  if (!p) return;
  ps.perf.lcp = Math.max(ps.perf.lcp, p.lcp);
  ps.perf.cls = Math.max(ps.perf.cls, p.cls);
  ps.perf.dcl = ps.perf.dcl || p.dcl;
  ps.perf.load = ps.perf.load || p.load;
}

export async function collectBrokenImages(page, ps) {
  const list = await safeEval(page, brokenImagesInPage, undefined, []);
  for (const src of list) ps.brokenImages.add(src);
}

export async function collectA11y(page, ps) {
  ps.a11y = await safeEval(page, a11yPassInPage, undefined, null);
}

export async function collectTextPatterns(page, ps, config) {
  const patterns = config.probes.textPatterns || [];
  if (!patterns.length) return;
  ps.textHits = await safeEval(
    page,
    textPatternsInPage,
    {
      patterns: patterns.map((p) => ({ name: p.name, severity: p.severity || 'high', ...reWire(p.re) })),
      skipSelector: config.probes.textSkipSelector || '',
      maxHits: 25,
    },
    [],
  );
}

export async function collectCustom(page, ps, config, phase) {
  for (const probe of config.probes.custom || []) {
    if (probe.phase !== 'both' && probe.phase !== phase) continue;
    const value = await safeEval(page, probe.evaluate, probe.arg, null);
    if (value === null || value === false || (Array.isArray(value) && !value.length)) continue;
    ps.custom.push({ name: probe.name, severity: probe.severity || 'medium', value });
  }
}

/** Run the whole built-in probe set for one phase. */
export async function runProbes(page, ps, config, phase) {
  if (config.probes.perf) await collectPerf(page, ps);
  if (config.probes.brokenImages) await collectBrokenImages(page, ps);
  if (phase === 'enter') {
    if (config.probes.a11y) await collectA11y(page, ps);
    await collectTextPatterns(page, ps, config);
  }
  await collectCustom(page, ps, config, phase);
}
