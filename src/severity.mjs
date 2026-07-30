import { trunc } from './util.mjs';

export const EXIT = {
  CLEAN: 0,
  HIGH: 1,
  CRITICAL: 2,
  /**
   * The harness itself failed, or it could not prove it tested what it claimed.
   *
   * This code exists because the harness this was extracted from returned 1 for
   * "crashed before finishing" AND 1 for "found high-severity findings" — a CI
   * job could not tell a broken runner from a broken app.
   */
  UNVERIFIED: 3,
};

/**
 * Fold per-route stats into totals + a flat, machine-readable finding list.
 * The markdown reporter renders from this; a CI job can consume it directly.
 */
export function summarize(statsList, state, config) {
  const tot = {
    steps: 0, jsExc: 0, n4: 0, n5: 0, cerr: 0, cwarn: 0, a11y: 0, broken: 0,
    overflow: 0, text: 0, slow: 0, stepFail: 0, unreached: 0, redirected: 0, skipped: 0,
  };
  const findings = [];
  const add = (severity, kind, page, message, extra) => findings.push({ severity, kind, page, message, ...extra });

  for (const ps of statsList) {
    tot.steps += ps.steps;
    tot.jsExc += ps.jsExceptions.length;
    tot.n4 += ps.net4xx.length;
    tot.n5 += ps.net5xx.length;
    tot.cerr += ps.consoleErrors.length + ps.consoleDropped.error;
    tot.cwarn += ps.consoleWarnings.length + ps.consoleDropped.warning;
    tot.broken += ps.brokenImages.size;
    tot.overflow += ps.overflow.length;
    tot.slow += ps.slowRequests.length;
    tot.stepFail += ps.stepFailures.length;
    tot.text += (ps.textHits || []).length;
    if (ps.unreached) tot.unreached++;
    if (ps.redirectedTo) tot.redirected++;
    if (ps.skipped) tot.skipped++;
    if (ps.a11y) tot.a11y += ps.a11y.imgsNoAlt.count + ps.a11y.unlabeledButtons.count + ps.a11y.unlabeledInputs.count;

    for (const e of ps.jsExceptions) add('critical', 'js-exception', ps.page, e.message, { action: e.action, shot: e.shot });
    for (const r of ps.net5xx) add('critical', 'http-5xx', ps.page, `${r.method} ${r.url} → ${r.status}`, { action: r.action });
    for (const r of ps.net4xx) add('high', 'http-4xx', ps.page, `${r.method} ${r.url} → ${r.status}`, { action: r.action });
    for (const o of ps.overflow)
      add('high', 'overflow', ps.page, `${o.viewport}: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}`);
    for (const src of ps.brokenImages) add('high', 'broken-image', ps.page, src);
    for (const h of ps.textHits || []) add(h.severity || 'high', `text:${h.kind}`, ps.page, trunc(h.text, 120), { where: h.where });
    for (const c of ps.custom || []) add(c.severity || 'medium', `probe:${c.name}`, ps.page, JSON.stringify(c.value).slice(0, 200));

    // A route the harness could not reach is a finding about the RUN, not about
    // the app — but it must never be counted as a clean pass either.
    if (ps.unreached) add('unverified', 'unreached', ps.page, ps.unreached);
    if (ps.redirectedTo) add('medium', 'redirected', ps.page, `requested ${ps.page}, landed on ${ps.redirectedTo}`);

    for (const t of ps.consoleErrors) add('medium', 'console-error', ps.page, trunc(t, 160));
    if (ps.perf.cls > config.thresholds.cls) add('medium', 'cls', ps.page, `CLS ${ps.perf.cls.toFixed(3)} > ${config.thresholds.cls}`);
    if (ps.perf.lcp > config.thresholds.lcpMs)
      add('medium', 'lcp', ps.page, `LCP ${(ps.perf.lcp / 1000).toFixed(1)}s > ${(config.thresholds.lcpMs / 1000).toFixed(1)}s`);
    for (const s of ps.slowRequests) if (!s.throttled) add('medium', 'slow-request', ps.page, `${(s.ms / 1000).toFixed(1)}s ${s.url}`);
    for (const f of ps.stepFailures) add('medium', 'step-failure', ps.page, `${f.mutator}: ${trunc(f.error, 120)}`);
    if (ps.gotoNote) add('medium', 'goto', ps.page, ps.gotoNote);
    if (ps.a11y) {
      const a = ps.a11y;
      const n = a.imgsNoAlt.count + a.unlabeledButtons.count + a.unlabeledInputs.count;
      if (n) add('low', 'a11y', ps.page, `${a.imgsNoAlt.count} imgs w/o alt · ${a.unlabeledButtons.count} unlabeled buttons/links · ${a.unlabeledInputs.count} unlabeled inputs`);
    }
  }

  const critCount = tot.jsExc + tot.n5 + findings.filter((f) => f.severity === 'critical' && !['js-exception', 'http-5xx'].includes(f.kind)).length;
  const highCount = tot.n4 + tot.overflow + tot.broken + findings.filter((f) => f.severity === 'high' && !['http-4xx', 'overflow', 'broken-image'].includes(f.kind)).length;

  return { tot, findings, critCount, highCount, gates: state.gates.length };
}

/** Exit code. Verification failure outranks findings — a run you cannot trust has no findings. */
export function exitCodeFor({ verified, fatal, critCount, highCount }) {
  if (!verified || fatal) return EXIT.UNVERIFIED;
  if (critCount > 0) return EXIT.CRITICAL;
  if (highCount > 0) return EXIT.HIGH;
  return EXIT.CLEAN;
}
