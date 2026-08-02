import { groupCount, trunc } from './util.mjs';

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
 * Did the harness actually EXERCISE this route? Three conditions, each of which
 * has produced a false green:
 *  - not skipped   (route.skip()/the anonymous filter excluded it on purpose)
 *  - not unreached (waitFor never matched — we tested something else)
 *  - at least one step completed WITHOUT throwing. ps.steps is incremented
 *    BEFORE the mutator runs, so steps > 0 alone only proves the loop spun; a
 *    route where all 40 steps threw is 40 'medium' findings and exit 0.
 *
 * Strictly 100%: "most steps threw" is a ratio judgement that would need a
 * tunable and would misfire on a flaky app. `steps > stepFailures` means "at
 * least one step ran to completion", which needs no threshold and cannot
 * false-positive.
 */
export function routeWasTested(ps) {
  if (ps.skipped || ps.unreached) return false;
  return ps.steps > 0 && ps.steps > (ps.stepFailures || []).length;
}

/**
 * Why this run's coverage proves nothing, or null when at least one route was
 * exercised. Pure — it never touches state, so summarize() and the report
 * fixtures stay unaffected and finish() owns the mutation.
 */
export function unverifiedCoverageReason(statsList) {
  const total = statsList.length;
  // [].some() is false, which would fall through to an empty parts list and a
  // nonsensical message. Answer the empty case by name.
  if (!total) return 'no route survived resolution — this run tested nothing.';
  if (statsList.some(routeWasTested)) return null;

  const paths = (l) => l.map((p) => p.page).slice(0, 8).join(', ') + (l.length > 8 ? ', …' : '');
  const skipped = statsList.filter((p) => p.skipped);
  const unreached = statsList.filter((p) => p.unreached);
  const allFailed = statsList.filter((p) => !p.skipped && !p.unreached && p.steps > 0);
  const noSteps = statsList.filter((p) => !p.skipped && !p.unreached && p.steps === 0);
  const parts = [];
  if (skipped.length) parts.push(`${skipped.length} SKIPPED (${paths(skipped)})`);
  if (unreached.length) parts.push(`${unreached.length} never reached (${paths(unreached)})`);
  if (allFailed.length) parts.push(`${allFailed.length} where EVERY step failed (${paths(allFailed)})`);
  if (noSteps.length) parts.push(`${noSteps.length} that ran 0 steps (${paths(noSteps)})`);
  return (
    `NOTHING WAS TESTED: not one of ${total} route(s) was exercised — ${parts.join('; ')}. ` +
    `An empty findings list here means no coverage, not a clean app.`
  );
}

/**
 * Actionable diagnosis for a run that found nothing to click, from the shadow
 * census taken AT ROUTE ENTRY — the same moment `atEnter` describes. `shadow` is
 * overwritten by every click attempt, so quoting it here would mix evidence from
 * two different moments in one sentence.
 *
 * Worded as a suspicion, not a diagnosis: closedSuspects is a heuristic, and
 * forceOpenShadowRoots changes the app under test, so telling a user to switch it
 * on as fact is a claim this code cannot make.
 */
function shadowHint(statsList) {
  const seen = statsList.map((p) => (p.clickable && (p.clickable.shadowAtEnter || p.clickable.shadow)) || null).filter(Boolean);
  const closed = seen.reduce((n, s) => n + s.closedSuspects, 0);
  const open = seen.reduce((n, s) => n + s.openRoots, 0);
  const hosts = [...new Set(seen.flatMap((s) => s.hosts || []))].slice(0, 5);
  if (closed) {
    return (
      `${closed} defined custom element(s) exposed neither an open shadow root nor light-DOM content` +
      `${hosts.length ? ` (${hosts.join(', ')})` : ''}. A CLOSED root is unreachable from page script, so if your design ` +
      `system uses closed roots, guardrails.forceOpenShadowRoots: true will reveal them.`
    );
  }
  if (open) {
    return (
      `${open} open shadow root(s) were traversed and still matched nothing, so the selector is the suspect: ` +
      `component design systems ship clickable custom tags with no role="button". Widen guardrails.clickableSelector.`
    );
  }
  return 'No shadow roots were involved, so guardrails.clickableSelector matched nothing in the light DOM either.';
}

/**
 * Every reason this run cannot claim to have verified what it tested, most
 * damning first; [] when it stands on its own.
 *
 * One helper rather than three ifs at the call site: the rules compose (a run can
 * be both partly unreached and wholly unclickable), and a run-level verdict
 * spread across several call sites is how the zero-step false green survived.
 */
export function unverifiedReasons(statsList, summary, config, state = {}) {
  const out = [];
  const nothing = unverifiedCoverageReason(statsList);
  if (nothing) out.push(nothing);

  // A watched origin that answered NOTHING and failed repeatedly is a dependency
  // that is down. Every finding it produced is one CRITICAL per endpoint blaming
  // the app for a backend nobody started — the inverse of a false green and the
  // same category error: reporting on an app the run could not actually exercise.
  // Requires zero successes, so one broken endpoint among working ones stays
  // CRITICAL, which is the outcome that must not be lost.
  const minFail = config.network.deadOriginMinFailures;
  if (minFail > 0) {
    const dead = Object.entries(state.originStats || {}).filter(([, s]) => s.ok === 0 && s.fail >= minFail);
    if (dead.length) {
      out.push(
        `${dead.map(([o, s]) => `${o}/* (${s.fail} responses, all 5xx, none OK)`).join(', ')} never answered a ` +
          `single request successfully, so it is down rather than buggy — findings against it describe the ` +
          `environment, not the app. Start the dependency it proxies to, or drop it from network.watchOrigins if ` +
          `it is not meant to be up. network.deadOriginMinFailures: 0 disables this.`,
      );
    }
  }

  // Only when NO route offered anything. A legitimately click-free page (legal,
  // docs) among real routes stays a per-route finding — failing every run on one
  // static page is how a check gets switched off.
  const ran = statsList.filter((p) => p.steps > 0 && !p.skipped && !p.unreached);
  const nothingSeen = (p) => p.clickable && p.clickable.max === 0;
  const knownEmpty = (p) => nothingSeen(p) && p.clickable.atEnter === 0;
  // atEnter stays null when the census threw, and `null !== 0`, so a run whose
  // census failed EVERYWHERE used to slip past this test and exit 0 CLEAN while
  // reporting "candidate coverage is UNKNOWN" — worse-known coverage escaping a
  // check that better-known coverage trips. UNKNOWN coverage is what exit 3 is for.
  const unknown = (p) => nothingSeen(p) && p.clickable.probeFailed;
  if (config.guardrails.requireClickable && ran.length && ran.every((p) => knownEmpty(p) || unknown(p))) {
    const failed = ran.filter(unknown);
    out.push(
      (failed.length
        ? `no route observed a single clickable candidate, and the census itself threw in-page on ` +
          `${failed.length} of ${ran.length} route(s) (${failed.map((p) => p.page).join(', ')}), so candidate coverage is ` +
          `UNKNOWN rather than zero. `
        : `no route offered a single clickable candidate (selector: ${config.guardrails.clickableSelector}). `) +
        `The click mutators never clicked anything, so an empty findings list says nothing about this app. ` +
        (failed.length === ran.length ? '' : shadowHint(statsList) + ' ') +
        `If this app genuinely has no clickable controls, set guardrails.requireClickable: false.`,
    );
  }

  // Generalises the rule above past clicking. Mutators report "no candidate" and
  // "no editable input" as SUCCESS, so `--mutators invalidInput` against a page
  // with no inputs ran every step, recorded no failure, emitted no finding of any
  // kind and exited 0 CLEAN. The evidence was in the action log and nothing read it.
  const effective = (p) => p.steps - (p.stepFailures || []).length;
  if (
    config.guardrails.requireEffectiveSteps &&
    ran.length &&
    ran.every((p) => effective(p) > 0 && (p.noopSteps || 0) >= effective(p))
  ) {
    out.push(
      `every step that completed on every route was a NO-OP — the mutators found nothing to act on ` +
        `(${ran.map((p) => `${p.page}: ${p.noopSteps}/${effective(p)}`).join(', ')}). ` +
        `The run touched the app without changing anything, so an empty findings list says nothing about it. ` +
        `Widen the mutator set, or set guardrails.requireEffectiveSteps: false.`,
    );
  }

  // A route the harness never reached cannot contribute to a pass. Without this,
  // a route list that has drifted into 404s exits 0 and reports "None." under
  // every severity — the exact false green this package exists to stop.
  if (!nothing && summary.tot.unreached > 0) {
    const names = statsList.filter((p) => p.unreached).map((p) => p.page);
    out.push(
      `${summary.tot.unreached} route(s) were never reached: ${names.join(', ')}. Findings cover only the routes that loaded.`,
    );
  }
  return out;
}

/**
 * Fold per-route stats into totals + a flat, machine-readable finding list.
 * The markdown reporter renders from this; a CI job can consume it directly.
 */
export function summarize(statsList, state, config) {
  const tot = {
    steps: 0, jsExc: 0, jsExcOffline: 0, n4: 0, n5: 0, cerr: 0, cwarn: 0, a11y: 0, broken: 0,
    overflow: 0, text: 0, slow: 0, stepFail: 0, unreached: 0, redirected: 0, skipped: 0,
    noClickable: 0, rateLimited: 0, inert: 0,
  };
  const findings = [];
  const add = (severity, kind, page, message, extra) => findings.push({ severity, kind, page, message, ...extra });

  for (const ps of statsList) {
    tot.steps += ps.steps;
    // An exception thrown while WE held the connection offline is the
    // offlineMode mutator's own doing, not the app's. A lazy-loaded route
    // cannot fetch its chunk with the network cut, so a code-split SPA throws
    // on every offline window — and every one of them was landing in critCount.
    // Counted separately so `critical` keeps meaning "the app is broken".
    // (consoleErrors and requestFailures have drawn this line all along; the
    // `duringOffline` flag was already recorded here, just never read.)
    const selfInflicted = ps.jsExceptions.filter((e) => e.duringOffline).length;
    tot.jsExc += ps.jsExceptions.length - selfInflicted;
    tot.jsExcOffline += selfInflicted;
    tot.n4 += ps.net4xx.length;
    tot.n5 += ps.net5xx.length;
    tot.rateLimited += ps.rateLimited.length;
    tot.cerr += ps.consoleErrors.length + ps.consoleDropped.error;
    tot.cwarn += ps.consoleWarnings.length + ps.consoleDropped.warning;
    tot.broken += ps.brokenImages.size;
    tot.overflow += ps.overflow.length;
    tot.slow += ps.slowRequests.length;
    tot.stepFail += ps.stepFailures.length;
    tot.text += (ps.textHits || []).length;
    tot.inert += ((ps.inert && ps.inert.hits) || []).length;
    if (ps.unreached) tot.unreached++;
    if (ps.redirectedTo) tot.redirected++;
    if (ps.skipped) tot.skipped++;
    if (ps.a11y) tot.a11y += ps.a11y.imgsNoAlt.count + ps.a11y.unlabeledButtons.count + ps.a11y.unlabeledInputs.count;

    for (const e of ps.jsExceptions)
      add(e.duringOffline ? 'low' : 'critical', 'js-exception', ps.page,
        `${e.message}${e.duringOffline ? ' — thrown while the harness held the connection offline; not an app finding' : ''}`,
        { action: e.action, shot: e.shot, duringOffline: !!e.duringOffline });
    for (const r of ps.net5xx) add('critical', 'http-5xx', ps.page, `${r.method} ${r.url} → ${r.status}`, { action: r.action });
    for (const r of ps.net4xx) add('high', 'http-4xx', ps.page, `${r.method} ${r.url} → ${r.status}`, { action: r.action });
    for (const o of ps.overflow)
      add('high', 'overflow', ps.page, `${o.viewport}: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}`);
    for (const src of ps.brokenImages) add('high', 'broken-image', ps.page, src);
    for (const h of ps.textHits || []) add(h.severity || 'high', `text:${h.kind}`, ps.page, trunc(h.text, 120), { where: h.where });
    for (const c of ps.custom || []) add(c.severity || 'medium', `probe:${c.name}`, ps.page, JSON.stringify(c.value).slice(0, 200));

    // A route the harness could not reach is a finding about the RUN, not about
    // the app — but it must never be counted as a clean pass either. Severity
    // 'unverified' is what keeps these out of critCount/highCount.
    if (ps.unreached) add('unverified', 'unreached', ps.page, ps.unreached);
    if (ps.skipped) add('unverified', 'skipped', ps.page, ps.skipped);
    if (ps.redirectedTo) add('medium', 'redirected', ps.page, `requested ${ps.page}, landed on ${ps.redirectedTo}`);

    // Nothing to click is a statement about this RUN's coverage, not about the
    // app, so it is 'unverified' rather than 'high' — it must not silently
    // become exit 1. `steps > 0` keeps skipped/unreached routes out: they
    // `continue` before the probes and carry their own finding.
    const c = ps.clickable || {};
    if (ps.steps > 0 && c.atEnter === 0 && c.max === 0) {
      tot.noClickable++;
      const s = c.shadowAtEnter || c.shadow;
      add(
        'unverified',
        'no-clickable',
        ps.page,
        `0 elements matched ${c.selector} in the viewport (${c.attempts} click attempt(s), ${c.empty} empty)` +
          (s
            ? `; ${s.openRoots} open shadow root(s) traversed` +
              (s.closedSuspects
                ? `; ${s.closedSuspects} defined custom element(s) exposed neither an open shadow root nor light-DOM ` +
                  `content (${s.hosts.join(', ')}) — a closed root is unreachable from page script ` +
                  `(see guardrails.forceOpenShadowRoots)`
                : '') +
              (s.undefinedEls ? `; ${s.undefinedEls} custom element(s) were never registered` : '')
            : ''),
      );
    }
    if (ps.scanTruncated || c.scanTruncated)
      add('medium', 'scan-truncated', ps.page, `the DOM scan stopped at guardrails.maxScanNodes (${config.guardrails.maxScanNodes}) — deeper subtrees were never offered a click`);
    if (c.capped)
      add('low', 'candidates-capped', ps.page, `at least guardrails.maxCandidates (${config.guardrails.maxCandidates}) controls matched; only the first ${config.guardrails.maxCandidates} in DOM order could ever be clicked`);
    if (c.probeFailed)
      add('medium', 'clickable-probe-failed', ps.page, 'the clickable census threw in-page; candidate coverage for this route is UNKNOWN');
    // Same class as scan-truncated: the text scan stopped looking, and its hits are
    // the only probe class that defaults to severity 'high'.
    if (ps.textHitsCapped)
      add('medium', 'text-scan-truncated', ps.page, `the text scan stopped at probes.maxTextHits (${config.probes.maxTextHits}) — there may be more leaked markup than is listed`);
    if (ps.slowRequestsDropped)
      add('low', 'slow-requests-dropped', ps.page, `${ps.slowRequestsDropped} further slow request(s) past report.slowRequestCap (${config.report.slowRequestCap}) were counted, not stored`);

    // 'low', and NEVER anything else. This is an inference from ABSENCE with a
    // measured, non-zero false-positive rate — unlike every 'medium' beside it,
    // which states something the harness observed directly. critCount/highCount
    // below select on 'critical'/'high' only, so a 'low' finding is structurally
    // incapable of moving exitCodeFor, and tot.inert is inert by construction
    // because neither expression reads it. The nearest precedents are a11y and
    // candidates-capped: real measurements, uncertain diagnosis, must not drive
    // behaviour. It must also never travel via ps.textHits (defaults to 'high')
    // or ps.custom (user-supplied severity), and never via log(…, {noop:true}),
    // which feeds requireEffectiveSteps and would turn this into exit 3.
    //
    // The wording states the OBSERVATION and the evidence that the instrument
    // works on this route — never "broken" or "dead" — so a reader can dismiss it
    // in one glance when it is a false positive.
    for (const h of (ps.inert && ps.inert.hits) || [])
      add('low', 'inert-control', ps.page, `${h.count} clicks on ${h.label} produced no DOM change, no request, no URL change and no dialog (${ps.inert.liveClicks} other click(s) on this route did)`);
    // A route that was NOT judged says so. "Clean" and "never looked" must stay
    // distinguishable — the same rule clickable.atEnter exists for.
    if (ps.inert && ps.inert.disabled)
      add('low', 'inert-not-checked', ps.page, `dead-control detection did not run on this route: ${ps.inert.disabled}`);

    for (const t of ps.consoleErrors) add('medium', 'console-error', ps.page, trunc(t, 160));
    // A perf sample taken while the harness held the network at Slow-3G or
    // offline measures the stressor, not the app. Demoted to 'low' and labelled
    // rather than dropped: the number is still real, it just cannot be read as a
    // page-speed defect. (slowRequests has carried this distinction all along.)
    if (ps.perf.cls > config.thresholds.cls)
      add(ps.netDegraded ? 'low' : 'medium', 'cls', ps.page,
        `CLS ${ps.perf.cls.toFixed(3)} > ${config.thresholds.cls}${ps.netDegraded ? ' — measured while the harness was throttling; not an app finding' : ''}`);
    if (ps.perf.lcp > config.thresholds.lcpMs)
      add(ps.netDegraded ? 'low' : 'medium', 'lcp', ps.page,
        `LCP ${(ps.perf.lcp / 1000).toFixed(1)}s > ${(config.thresholds.lcpMs / 1000).toFixed(1)}s${ps.netDegraded ? ' — measured while the harness was throttling; not an app finding' : ''}`);
    for (const s of ps.slowRequests) if (!s.throttled) add('medium', 'slow-request', ps.page, `${(s.ms / 1000).toFixed(1)}s ${s.url}`);
    for (const f of ps.stepFailures) add('medium', 'step-failure', ps.page, `${f.mutator}: ${trunc(f.error, 120)}`);
    // MEDIUM, never HIGH: the backend refused load this harness generated, so
    // failing the run on it would report the monkey's own pace as the app's bug.
    for (const g of groupCount(ps.rateLimited, (r) => `${r.method} ${r.url}`))
      add('medium', 'rate-limited', ps.page, `429 ×${g.count} on ${g.key} — the harness outran the backend`, {
        action: g.sample.action,
      });
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
