import { groupCount, trunc } from '../util.mjs';
import { routeWasTested } from '../severity.mjs';

const fmtLcp = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : '-');

const renderTail = (tail) =>
  tail.map((a) => `    - #${a.step} ${a.mutator} ${a.target}${a.note ? ` — ${a.note}` : ''}`).join('\n');

/**
 * The session line used to be a hardcoded English sentence about one app's
 * routes ("7 of the 10 default pages require auth"). It is now derived from
 * three real signals — did auth apply, did verification pass, and how many
 * routes declared requiresAuth — so it stays true when the route list changes.
 */
function sessionLine(state, statsList) {
  const authRoutes = statsList.filter((p) => p.requiresAuth).length;
  const total = statsList.length;
  if (state.authed && state.verification && state.verification.ok) {
    return `AUTHENTICATED — verified (${state.verification.how})`;
  }
  if (state.authed) {
    return `**AUTHENTICATED BUT UNVERIFIED** — ${state.verification ? state.verification.how : 'no verification ran'}`;
  }
  if (authRoutes === 0) return 'anonymous (no route declares requiresAuth)';
  return (
    `**ANONYMOUS** — ${authRoutes} of ${total} routes declare requiresAuth. ` +
    `Any app with a router guard renders its login/landing page instead, so a pass on those routes proves nothing.`
  );
}

function pageCell(ps, verified) {
  if (ps.skipped) return `${ps.page} (SKIPPED)`;
  if (ps.unreached) return `${ps.page} (UNREACHED)`;
  // Routes after a mid-run crash used to render as a bare `| /x | 0 |`,
  // indistinguishable from a route that completed. Gated on !verified so the
  // marker cannot appear inside a report titled clean.
  const mark = !verified && !routeWasTested(ps) ? ' (NOT EXERCISED)' : '';
  return (ps.redirectedTo ? `${ps.page} → ${ps.redirectedTo}` : ps.page) + mark;
}

/** Any in-page walk hit the node budget — not just the clickable one. */
const scanCut = (ps) => !!(ps.scanTruncated || (ps.clickable && ps.clickable.scanTruncated));

/** '-' when the census never ran; a bold 0 is the finding, not a number. */
function clickableCell(ps) {
  const c = ps.clickable;
  if (!c || c.atEnter == null) return '-';
  return c.max === 0 ? '**0**' : String(c.max);
}

/**
 * Renders the report. Section order and headings are a stable contract: reports
 * from different versions of this package are meant to stay diffable against
 * each other, so headings are added, never renamed or reordered.
 */
export function buildMarkdown({ config, state, statsList, summary, startDate, durationMs, runId, routes }) {
  const { tot, critCount, highCount } = summary;
  const L = [];
  const verified = state.verified !== false;

  // 1 — header
  L.push(`# QA monkey report — ${runId}${verified ? '' : ' — NOT VERIFIED'}`);
  L.push('');
  if (!verified) {
    L.push('> **THIS RUN PROVED NOTHING.**');
    L.push(`> ${state.unverifiedReason || 'verification failed'}`);
    L.push('>');
    L.push('> Findings below are whatever was collected before the run was abandoned. Do not read the absence of');
    L.push('> findings as a pass — fix the session or the route list and run again.');
    L.push('');
  }
  L.push(`- base: ${config.baseUrl}`);
  L.push(`- seed: **${config.seed}** (repro: \`mischief --seed ${config.seed}\`)`);
  L.push(`- pages: ${routes.map((r) => r.path).join(', ')}`);
  L.push(`- session: ${sessionLine(state, statsList)}`);
  L.push(`- steps/page: ${config.steps}`);
  L.push(`- started: ${startDate.toISOString()} · duration: ${(durationMs / 1000).toFixed(1)}s`);
  L.push(
    // The offline count is shown rather than dropped: those exceptions are real
    // events, they just say something about the harness instead of the app.
    `- totals: ${tot.steps} steps · ${tot.jsExc} JS exceptions` +
      `${tot.jsExcOffline ? ` (+${tot.jsExcOffline} while offline, not counted)` : ''} · ` +
      `${tot.n5} 5xx · ${tot.n4} 4xx · ` +
      `${tot.cerr} console errors · ${tot.text} text-pattern hits · ${state.gates.length} gates · ${state.skippedDanger.length} danger-skips`,
  );
  // Header-level, not buried under MEDIUM: once the backend starts refusing load
  // the walk is no longer the walk that was configured, and every timing number
  // below it was measured against a throttled server.
  if (tot.rateLimited) {
    L.push(
      `- **rate limited: ${tot.rateLimited} × 429** — the harness outran the backend and backed off to ` +
        `+${state.rateLimitPauseMs}ms per step. Raise \`timing.stepPauseMinMs\` to pace the whole run instead.`,
    );
  }
  if (tot.unreached || tot.redirected || tot.skipped || tot.noClickable) {
    const exercised = statsList.filter(routeWasTested).length;
    L.push(
      `- coverage: ${exercised}/${statsList.length} routes exercised · ${tot.unreached} unreached · ` +
        `${tot.redirected} redirected · ${tot.skipped} skipped` +
        (tot.noClickable ? ` · ${tot.noClickable} with nothing to click` : ''),
    );
  }
  // Positive evidence that shadow-root piercing ran, so a component app can tell
  // "found nothing" from "never looked".
  const openRoots = statsList.reduce((n, p) => n + ((p.clickable && p.clickable.shadow && p.clickable.shadow.openRoots) || 0), 0);
  if (openRoots) L.push(`- dom: ${openRoots} open shadow root(s) traversed`);
  // Which origins were judged, so "no 5xx" is distinguishable from "your API was
  // never looked at". Printed only when it is not just baseOrigin, i.e. only when
  // it is not already implied by `- base:` two lines up.
  const watched = config.watchedOrigins || [];
  if (watched.length > 1) L.push(`- network: responses classified from ${watched.join(', ')}`);
  L.push('');

  // 2 — summary table. The `clickable` column is APPENDED: the golden-spine test
  // matches the header and separator rows as substrings, so inserting a column
  // anywhere else silently breaks the report contract.
  L.push('## Summary');
  L.push('');
  L.push('| page | steps | JS exc | net 4xx/5xx | console err | CLS | LCP | a11y flags | broken imgs | overflow? | clickable |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const ps of statsList) {
    const a11yN = ps.a11y ? ps.a11y.imgsNoAlt.count + ps.a11y.unlabeledButtons.count + ps.a11y.unlabeledInputs.count : '-';
    const over = ps.overflow.length ? `yes (${[...new Set(ps.overflow.map((o) => o.viewport))].join(', ')})` : 'no';
    L.push(
      `| ${pageCell(ps, verified)} | ${ps.steps} | ${ps.jsExceptions.length} | ${ps.net4xx.length}/${ps.net5xx.length} | ` +
        `${ps.consoleErrors.length + ps.consoleDropped.error} | ${ps.perf.cls.toFixed(3)} | ${fmtLcp(ps.perf.lcp)} | ` +
        `${a11yN} | ${ps.brokenImages.size} | ${over} | ${clickableCell(ps)} |`,
    );
  }
  L.push('');

  // 2b — coverage, only when something was not tested. Resolver-dropped routes
  // land here too: they appear in no statsList row, so without this the run
  // silently reports on nine routes when you asked for ten.
  const noClick = (p) => p.steps > 0 && p.clickable && p.clickable.atEnter === 0 && p.clickable.max === 0;
  const notTested = statsList.filter((p) => p.unreached || p.skipped || p.redirectedTo || noClick(p));
  const dropped = state.droppedRoutes || [];
  if (notTested.length || dropped.length) {
    L.push('## Coverage gaps');
    L.push('');
    for (const ps of notTested) {
      if (ps.unreached) L.push(`- **NOT TESTED** ${ps.page} — ${ps.unreached}`);
      else if (ps.skipped) L.push(`- skipped ${ps.page} — ${ps.skipped}`);
      else if (ps.redirectedTo)
        L.push(`- ${ps.page} redirected to ${ps.redirectedTo} — the steps below hammered the destination, not ${ps.page}`);
      // Not `else`: a route can be both redirected and click-free, and the two
      // gaps have different remedies.
      if (noClick(ps) && !ps.unreached && !ps.skipped) {
        const s = ps.clickable.shadowAtEnter || ps.clickable.shadow;
        L.push(
          `- **NOTHING TO CLICK** ${ps.page} — 0 candidates matched ${ps.clickable.selector}` +
            (s ? `; ${s.openRoots} open shadow root(s), ${s.closedSuspects} with no open root` : ''),
        );
      }
    }
    for (const d of dropped) L.push(`- **NOT TESTED** ${d.path} — dropped before the run: ${d.why}`);
    L.push('');
  }

  // 3 — findings by severity
  L.push('## Findings');
  L.push('');
  L.push(`### CRITICAL (${critCount})`);
  L.push('');
  if (critCount === 0) L.push('None.');
  for (const ps of statsList) {
    for (const [i, e] of ps.jsExceptions.entries()) {
      L.push(`#### JS exception ${i + 1} on ${ps.page}${e.duringOffline ? ' (during offline window)' : ''}`);
      L.push('');
      L.push(`> ${e.message}`);
      L.push('');
      const frames = e.stack.split('\n').slice(1, 4).map((s) => s.trim()).filter(Boolean);
      if (frames.length) L.push(...frames.map((f) => `- \`${trunc(f, 160)}\``));
      L.push(`- after action: ${e.action}`);
      if (e.shot) L.push(`- screenshot: ${e.shot}`);
      if (e.tail.length) {
        L.push('- action-log tail:');
        L.push(renderTail(e.tail));
      }
      L.push('');
    }
    for (const g of groupCount(ps.net5xx, (r) => `${r.method} ${r.url} → ${r.status}`)) {
      L.push(`- **5xx** ${g.key} ×${g.count} on ${ps.page} (after: ${g.sample.action})`);
    }
  }
  L.push('');

  L.push(`### HIGH (${highCount})`);
  L.push('');
  if (highCount === 0) L.push('None.');
  for (const ps of statsList) {
    for (const g of groupCount(ps.net4xx, (r) => `${r.method} ${r.url} → ${r.status}`)) {
      L.push(`- **4xx** ${g.key} ×${g.count} on ${ps.page} (after: ${g.sample.action})`);
    }
    for (const o of ps.overflow) {
      L.push(`- **overflow** ${ps.page} at ${o.viewport}: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth} (${o.url})`);
    }
    if (ps.brokenImages.size) {
      L.push(`- **broken images** on ${ps.page} (${ps.brokenImages.size}):`);
      for (const src of [...ps.brokenImages].slice(0, 10)) L.push(`    - ${src}`);
    }
  }
  L.push('');

  const allText = statsList.flatMap((ps) => (ps.textHits || []).map((h) => ({ page: ps.page, ...h })));
  if (allText.length) {
    L.push(`- unrendered markup in visible text (${allText.length} node(s)):`);
    for (const g of groupCount(allText, (h) => `${h.kind} <${h.where}> ${trunc(h.text, 90)}`).slice(0, 12)) {
      L.push(`    - ×${g.count} [${g.sample.page}] ${g.key}`);
    }
    L.push('');
  }

  L.push('### MEDIUM');
  L.push('');
  const allConsoleErrs = statsList.flatMap((ps) => ps.consoleErrors.map((t) => ({ page: ps.page, text: t })));
  if (allConsoleErrs.length) {
    L.push(`- console errors (${tot.cerr} total, top ${Math.min(15, allConsoleErrs.length)} distinct):`);
    for (const g of groupCount(allConsoleErrs, (e) => trunc(e.text, 160)).slice(0, 15)) {
      L.push(`    - ×${g.count} [${g.sample.page}] ${g.key}`);
    }
  }
  for (const ps of statsList) {
    // Perf lines are rendered ONLY when the sample is trustworthy. A route where
    // the harness throttled or went offline produces a max() LCP that measures
    // the stressor, and summarize() already demotes those to 'low' with a label —
    // this section used to re-derive the threshold from ps.perf directly and so
    // printed the self-inflicted number under MEDIUM regardless. Two sources of
    // truth for one verdict, and the human-readable one was the wrong one.
    if (!ps.netDegraded) {
      if (ps.perf.cls > config.thresholds.cls) L.push(`- CLS ${ps.perf.cls.toFixed(3)} > ${config.thresholds.cls} on ${ps.page}`);
      if (ps.perf.lcp > config.thresholds.lcpMs) L.push(`- LCP ${fmtLcp(ps.perf.lcp)} > ${fmtLcp(config.thresholds.lcpMs)} on ${ps.page}`);
    }
    for (const s of ps.slowRequests.slice(0, 10)) {
      L.push(`- slow request ${(s.ms / 1000).toFixed(1)}s on ${ps.page}: ${s.url}${s.throttled ? ' (during slow-3G window)' : ''}`);
    }
    for (const g of groupCount(ps.stepFailures, (f) => `${f.mutator}: ${trunc(f.error, 120)}`).slice(0, 10)) {
      L.push(`- step failure ×${g.count} on ${ps.page} — ${g.key}`);
    }
    for (const c of ps.custom || []) {
      if ((c.severity || 'medium') === 'medium') L.push(`- probe \`${c.name}\` on ${ps.page}: ${trunc(JSON.stringify(c.value), 200)}`);
    }
    if (ps.gotoNote) L.push(`- ${ps.page}: ${ps.gotoNote}`);
    if (ps.redirectedTo) L.push(`- ${ps.page} redirected to ${ps.redirectedTo}`);
    // All statements about how much of the run's own evidence is missing. Rendered
    // here because summarize() files them as 'medium', and a MEDIUM section that
    // says "None." while findings[] holds a medium is its own small lie.
    if (scanCut(ps))
      L.push(`- ${ps.page}: the DOM scan stopped at guardrails.maxScanNodes (${config.guardrails.maxScanNodes}) — deeper subtrees were never offered a click`);
    if (ps.textHitsCapped)
      L.push(`- ${ps.page}: the text scan stopped at probes.maxTextHits (${config.probes.maxTextHits}) — there may be more leaked markup than is listed`);
    if (ps.clickable && ps.clickable.probeFailed)
      L.push(`- ${ps.page}: the clickable census threw in-page — candidate coverage here is UNKNOWN`);
  }
  if (
    tot.cerr === 0 && tot.slow === 0 && tot.stepFail === 0 && tot.redirected === 0 &&
    !statsList.some(
      (p) =>
        p.perf.cls > config.thresholds.cls ||
        p.perf.lcp > config.thresholds.lcpMs ||
        p.gotoNote ||
        (p.custom || []).length ||
        p.textHitsCapped ||
        scanCut(p) ||
        (p.clickable && p.clickable.probeFailed),
    )
  ) {
    L.push('None.');
  }
  L.push('');

  L.push('### LOW');
  L.push('');
  for (const ps of statsList) {
    // The throttled counterparts of the MEDIUM perf lines above. Kept, not
    // dropped: the measurement is real and worth seeing, it just describes the
    // harness's own slow-3G window rather than the page.
    if (ps.netDegraded) {
      const why = ' — measured while the harness was throttling; not an app finding';
      if (ps.perf.cls > config.thresholds.cls) L.push(`- CLS ${ps.perf.cls.toFixed(3)} > ${config.thresholds.cls} on ${ps.page}${why}`);
      if (ps.perf.lcp > config.thresholds.lcpMs) L.push(`- LCP ${fmtLcp(ps.perf.lcp)} > ${fmtLcp(config.thresholds.lcpMs)} on ${ps.page}${why}`);
    }
    if (ps.clickable && ps.clickable.capped) {
      L.push(
        `- ${ps.page}: at least guardrails.maxCandidates (${config.guardrails.maxCandidates}) controls matched; ` +
          `only the first ${config.guardrails.maxCandidates} in DOM order could ever be clicked`,
      );
    }
    if (!ps.a11y) continue;
    const a = ps.a11y;
    if (a.imgsNoAlt.count + a.unlabeledButtons.count + a.unlabeledInputs.count === 0) continue;
    L.push(
      `- a11y ${ps.page}: ${a.imgsNoAlt.count} imgs w/o alt · ${a.unlabeledButtons.count} unlabeled buttons/links · ${a.unlabeledInputs.count} unlabeled inputs`,
    );
    for (const s of a.imgsNoAlt.samples.slice(0, 3)) L.push(`    - img: ${s}`);
    for (const s of a.unlabeledButtons.samples.slice(0, 3)) L.push(`    - btn: \`${s.replace(/`/g, "'")}\``);
  }
  if (tot.cwarn > 0) {
    const allWarns = statsList.flatMap((ps) => ps.consoleWarnings);
    L.push(`- console warnings: ${tot.cwarn} total; top distinct:`);
    for (const g of groupCount(allWarns, (t) => trunc(t, 140)).slice(0, 5)) L.push(`    - ×${g.count} ${g.key}`);
  }
  if (tot.a11y === 0 && tot.cwarn === 0 && !statsList.some((p) => p.clickable && p.clickable.capped)) L.push('None.');
  L.push('');

  // 4 — gates
  L.push(`## Gates hit (${state.gates.length})`);
  L.push('');
  if (!state.gates.length) L.push('None.');
  for (const g of groupCount(state.gates, (r) => `${r.status} ${r.method} ${r.url}`)) {
    L.push(`- ${g.key} ×${g.count} on ${g.sample.page} (after: ${g.sample.action})`);
  }
  L.push('');

  // 5 — refused clicks. Worth printing even when empty: it tells you whether the
  // danger pattern is doing anything at all on your app.
  L.push(`## Skipped danger (${state.skippedDanger.length})`);
  L.push('');
  if (!state.skippedDanger.length) L.push('Nothing dangerous was offered a click.');
  for (const g of groupCount(state.skippedDanger, (s) => s.text)) {
    L.push(`- "${g.key}" ×${g.count}`);
  }
  L.push('');

  // 6 — config warnings. Trailing, because headings are only ever ADDED. The
  // `|| []` is required: report fixtures build `state` by hand and omit this.
  const warnings = state.configWarnings || [];
  if (warnings.length) {
    L.push('## Notes');
    L.push('');
    for (const w of warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push(`_Full raw data: ${runId}/log.json · screenshots: ${runId}/shots/_`);
  L.push('');

  return L.join('\n');
}
