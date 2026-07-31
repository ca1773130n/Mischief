import fs from 'node:fs';
import path from 'node:path';
import { deriveStepRng, mulberry32, pickWeighted } from './rng.mjs';
import { makeRunId, pathOf, samePath, sleep, trunc, uniqueSlugs } from './util.mjs';
import { openBrowser, makeCleanup } from './browser/attach.mjs';
import { wireGuardrails, restoreNetwork } from './browser/guardrails.mjs';
import { wireCollectors } from './collect.mjs';
import { applyAuth, verifyAuth, AuthError } from './auth/index.mjs';
import { resolveMutators } from './mutators/index.mjs';
import { runProbes } from './probes/index.mjs';
import { initScriptInPage } from './probes/inpage.mjs';
import { resolveRoutes, newRouteStats } from './routes.mjs';
import { summarize, exitCodeFor, unverifiedReasons, EXIT } from './severity.mjs';
import { resolveReporters } from './report/index.mjs';

/**
 * Run one seeded chaos pass.
 *
 * `config` must already be through resolveConfig() (the CLI does that).
 * Never calls process.exit — returns an exitCode for the caller to use, so the
 * function is usable from a test or another script.
 */
export async function runMonkey(config, { onLog } = {}) {
  const say = onLog || ((m) => !config.quiet && console.log(m));
  const startDate = new Date();
  const runId = makeRunId(startDate);
  const outDir = config.report.outDir;
  const runDir = path.join(outDir, runId);
  const shotsDir = path.join(runDir, 'shots');

  // Pre-flight resolution runs BEFORE the run directory exists and inside a try,
  // so that a config typo neither breaks this function's "never throws, returns an
  // exitCode" contract nor leaves an orphan reports/<runId>/shots behind. All three
  // resolvers can throw: `steps: 0`, an all-dropped route resolver, `--mutators
  // randomClik`, an unknown report format.
  const dropped = [];
  let routes, registry, mutatorEntries, reporters;
  try {
    routes = await resolveRoutes(config.routes, config, (r, why) => {
      dropped.push({ path: r.path, why });
      say(`mischief: dropping ${r.path} — ${why}`);
    });
    ({ registry, entries: mutatorEntries } = resolveMutators(config));
    reporters = resolveReporters(config);
  } catch (e) {
    const why = `the run could not be set up: ${(e && e.message) || e}`;
    say(`mischief: ABANDONED — ${why}`);
    return preflightFailure({ runId, config, startDate, error: e, why });
  }

  fs.mkdirSync(shotsDir, { recursive: true });

  const statsList = routes.map(newRouteStats);
  // Injective per-route screenshot names. slugOf alone collapsed two non-Latin
  // paths onto one filename, so the second overwrote the first and both report
  // rows pointed at the wrong page.
  const routeSlugs = uniqueSlugs(routes.map((r) => r.path));
  const state = {
    currentRoutePath: routes[0].path,
    stepIndex: 0,
    ps: statsList[0],
    offlineWindow: false,
    slowStepsRemaining: 0,
    rateLimitPauseMs: 0, // grows on 429, never decays — see backOff() in collect.mjs
    mobileEmulated: false,
    closing: false,
    errShots: 0,
    stepDidWork: false, // see log() and the no-op accounting in the step loop
    actionLog: [],
    skippedDanger: [],
    gates: [],
    originStats: {}, // watched origin -> { ok, fail }; see the dead-origin rule in severity.mjs
    authed: false,
    verified: true,
    verification: null,
    unverifiedReason: null,
    configWarnings: config.warnings || [],
    droppedRoutes: dropped,
    outDir,
    shotsDir,
  };
  /**
   * `opts.noop: true` means the mutator ran to completion having done nothing —
   * "no candidate", "no editable input". Mutators report those as SUCCESS, so
   * without this flag a route where all 40 steps found nothing counted as
   * exercised. One non-noop log entry in a step is enough to make the step real.
   */
  const log = (mutator, target, note, opts) => {
    if (!opts || !opts.noop) state.stepDidWork = true;
    state.actionLog.push({
      page: state.currentRoutePath,
      step: state.stepIndex,
      mutator,
      target,
      note,
      ...(opts && opts.noop ? { noop: true } : {}),
    });
  };

  // Declared before the pre-flight check below, which calls abandon() -> finish()
  // and would otherwise hit `t0` in its temporal dead zone.
  const t0 = Date.now();

  // ---- fail closed BEFORE opening a browser, when we already know enough ----
  const authRoutes = routes.filter((r) => r.requiresAuth);
  if (authRoutes.length && config.auth.strategy === 'none' && !config.allowAnonymous) {
    return abandon(
      `${authRoutes.length} of ${routes.length} routes declare requiresAuth but auth.strategy is 'none'. ` +
        `Configure auth, or pass --allow-anonymous to skip those routes on purpose.`,
    );
  }

  let browser, context, page, cdp, cleanup, mode;
  let fatal = null;

  try {
    say(`mischief: ${config.browser.mode === 'attach' ? `attaching to ${config.browser.cdpUrl}` : 'launching browser'} …`);
    ({ browser, context, mode } = await openBrowser(config));

    // Session goes in BEFORE the first navigation. addInitScript-based
    // strategies have no effect on a document that already loaded.
    try {
      const applied = await applyAuth({ context, config });
      state.authed = applied.authed;
      if (applied.authed) say(`mischief: ${applied.note}`);
    } catch (e) {
      if (e instanceof AuthError && !config.allowAnonymous) {
        await hardClose(browser, context, mode);
        return abandon(`auth could not be applied — ${e.message}`);
      }
      say(`mischief: WARNING — ${e.message}; continuing ANONYMOUS`);
    }

    page = await context.newPage(); // a fresh tab — never hijack a tab the user is using
    page.setDefaultTimeout(config.browser.defaultTimeoutMs);
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable').catch(() => {});
    cleanup = makeCleanup({ browser, context, page, cdp, state, config, mode });
    const onSignal = async (code) => {
      await cleanup();
      process.exit(code);
    };
    process.on('SIGINT', () => onSignal(130));
    process.on('SIGTERM', () => onSignal(143));

    await page.addInitScript(initScriptInPage, {
      blockWindowOpen: config.guardrails.blockWindowOpen,
      forceOpenShadowRoots: config.guardrails.forceOpenShadowRoots,
    });
    wireGuardrails(page, state, config.baseOrigin, config);
    wireCollectors(page, state, config.baseOrigin, config);

    const ctx = { page, cdp, rng: mulberry32(config.seed), log, state, baseOrigin: config.baseOrigin, config };
    const master = mulberry32(config.seed);
    let verifiedOnce = false;

    for (let ri = 0; ri < routes.length; ri++) {
      const route = routes[ri];
      const ps = statsList[ri];
      state.currentRoutePath = route.path;
      state.ps = ps;
      state.stepIndex = 0;
      const rt0 = Date.now();

      const skipReason = routeSkipReason(route, state, config);
      if (skipReason) {
        ps.skipped = skipReason;
        say(`mischief: route ${ri + 1}/${routes.length} ${route.path} — SKIPPED (${skipReason})`);
        continue;
      }

      say(`mischief: route ${ri + 1}/${routes.length} ${route.path}`);
      try {
        await page.goto(config.baseOrigin + route.path, {
          waitUntil: config.timing.gotoWaitUntil,
          timeout: config.timing.gotoTimeoutMs,
        });
      } catch (e) {
        // A goto cap is routine — the page is usually perfectly usable. Record
        // it, do not abort. (It used to be routine on EVERY route, because the
        // default waitUntil was 'networkidle' and no app with an open socket ever
        // reaches that; see timing.gotoWaitUntil.)
        ps.gotoNote = `goto: ${trunc(String((e && e.message) || e), 140)}`;
      }
      await sleep(config.timing.settleMs);

      // (a0) Are we even ON the app? A goto TIMEOUT leaves a loaded, usable
      // document — that is the routine case above. ERR_CONNECTION_REFUSED,
      // ERR_NAME_NOT_RESOLVED and a bad gotoWaitUntil enum do not: the tab is
      // still on about:blank. Without this check the monkey spent every step
      // mutating about:blank, one mutator in four threw, `steps > stepFailures`
      // called the route exercised, and a default-config run against a dead
      // baseUrl reported "coverage: 2/2 routes exercised" and EXIT 0 — the
      // single likeliest real-world false green, since an app that failed to boot
      // is the common CI case. Routed through `unreached` so the machinery that
      // already exists names it, renders it under Coverage gaps and returns 3.
      if (!page.url().startsWith(config.baseOrigin)) {
        ps.unreached =
          `never navigated to ${route.path} — the browser is still on ${page.url()}, not on ${config.baseOrigin}` +
          (ps.gotoNote ? ` (${ps.gotoNote})` : '');
        say(`mischief:   NOT REACHED — ${ps.unreached}`);
        ps.durationMs = Date.now() - rt0;
        continue;
      }

      // The enter-phase probes need the app RENDERED, and goto now resolves at
      // domcontentloaded rather than networkidle — which shortened their window
      // from up to 30s of JS execution to settleMs. 'load' fires once the bundle
      // has run, which restores it without restoring networkidle's guaranteed
      // timeout. Best-effort: a page that never fires load is not a finding.
      await page.waitForLoadState('load', { timeout: config.timing.loadStateTimeoutMs }).catch(() => {});

      // (b) waitFor — a selector only THIS page renders. Without it a router
      // bounce is indistinguishable from a slow render, and the monkey happily
      // hammers whatever it landed on while the report credits this route.
      if (route.waitFor) {
        let present = false;
        try {
          await page.waitForSelector(route.waitFor, { timeout: config.timing.waitForTimeoutMs, state: 'attached' });
          // waitForSelector can resolve against a document that a client-side
          // guard is ABOUT to replace: the gated markup really was in the HTML,
          // then location.replace('/login') swapped it out a tick later.
          // Re-querying the current document is what turns that near-miss into
          // an honest "not reached".
          await page.waitForLoadState('domcontentloaded', { timeout: config.timing.loadStateTimeoutMs }).catch(() => {});
          present = !!(await page.$(route.waitFor));
        } catch {
          present = false;
        }
        if (!present) {
          ps.unreached = `waitFor "${route.waitFor}" is not present (landed on ${pathOf(page.url())})`;
          say(`mischief:   NOT REACHED — ${ps.unreached}`);
          ps.durationMs = Date.now() - rt0;
          continue;
        }
      }

      // (c) landed-URL check — cheap, needs no per-app selector, and catches the
      // single most common drift: a route that quietly became a redirect.
      // samePath, not pathOf: trailing-slash normalization is not drift, and
      // flagging it on every route buried the redirects that are.
      const landed = samePath(page.url());
      if (landed !== samePath(config.baseOrigin + route.path)) {
        ps.redirectedTo = landed;
        say(`mischief:   redirected → ${landed}`);
      }

      // (a) verification, once, on the first requiresAuth route we actually load.
      if (!verifiedOnce && route.requiresAuth) {
        verifiedOnce = true;
        const v = await verifyAuth({ page, config, route, baseOrigin: config.baseOrigin });
        state.verification = v;
        if (!v.ok) {
          await cleanup();
          // "whatever the app rendered instead", not "redirected to": with inline
          // gating there is no redirect at all — the login form is at this url.
          return abandon(
            `session verification FAILED on ${route.path} — ${v.how}.${v.detail ? ` ${v.detail}` : ''} ` +
              `The run would have tested whatever the app rendered instead and called it a pass.`,
          );
        }
        say(`mischief: session verified (${v.how})`);
      }

      await runProbes(page, ps, config, 'enter');

      const stepCount = route.steps ?? config.steps;
      const routeEntries = route.mutators
        ? mutatorEntries.filter(([n]) => route.mutators.includes(n))
        : mutatorEntries;
      if (!routeEntries.length) throw new Error(`Route ${route.path} enabled no known mutator`);

      for (let stepN = 1; stepN <= stepCount; stepN++) {
        state.stepIndex = stepN;
        ps.steps++;
        await page.waitForLoadState('domcontentloaded', { timeout: config.timing.loadStateTimeoutMs }).catch(() => {});
        const name = pickWeighted(master, routeEntries);
        ctx.rng = deriveStepRng(config.seed, ri, stepN); // see rng.mjs for why
        state.stepDidWork = false;
        try {
          await registry[name](ctx);
          // Counted only for steps that COMPLETED: a step that threw is already a
          // finding, and counting it twice would let stepFailures alone trip the
          // no-op verdict.
          if (!state.stepDidWork) ps.noopSteps++;
        } catch (e) {
          // A step failure is a finding, never a crash. One unclickable element
          // must not cost you the other 39 steps.
          ps.stepFailures.push({ step: stepN, mutator: name, error: trunc(String((e && e.message) || e), 300) });
          log(name, '-', 'step-failed');
        }
        // The slowNetwork throttle covers the 3 steps AFTER it fires.
        if (name !== 'slowNetwork' && state.slowStepsRemaining > 0 && --state.slowStepsRemaining === 0) {
          await restoreNetwork(ctx);
        }
        await sleep(
          config.timing.stepPauseMinMs +
            Math.floor(master() * config.timing.stepPauseJitterMs) +
            state.rateLimitPauseMs,
        );
      }

      // Leave the next route a clean slate: unthrottled, default metrics.
      if (state.slowStepsRemaining > 0) {
        state.slowStepsRemaining = 0;
        await restoreNetwork(ctx);
      }
      if (state.mobileEmulated) {
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
        state.mobileEmulated = false;
      }
      // Reset alongside the others: offlineMode sets this flag before the CDP call
      // that can throw, and a stuck `true` tags every later request failure as
      // self-inflicted and suppresses the findings.
      state.offlineWindow = false;

      await runProbes(page, ps, config, 'exit');
      if (config.report.pageScreenshots) {
        const shotPath = path.join(shotsDir, `page-${routeSlugs[ri]}.jpeg`);
        try {
          await page.screenshot({
            path: shotPath,
            type: 'jpeg',
            quality: config.report.screenshotQuality,
            fullPage: true,
            timeout: config.timing.gotoTimeoutMs,
          });
          ps.shot = path.relative(outDir, shotPath);
        } catch {}
      }
      ps.durationMs = Date.now() - rt0;
    }
  } catch (e) {
    fatal = e;
  }

  if (cleanup) await cleanup();
  else await hardClose(browser, context, mode);

  if (fatal) {
    state.verified = false;
    state.unverifiedReason = `the harness crashed mid-run: ${trunc(String((fatal && fatal.message) || fatal), 300)}`;
  }

  return finish({ fatal, durationMs: Date.now() - t0 });

  // ---------------------------------------------------------------- helpers

  function abandon(reason) {
    state.verified = false;
    state.unverifiedReason = reason;
    say(`mischief: ABANDONED — ${reason}`);
    return finish({ fatal: null, durationMs: Date.now() - t0 });
  }

  function finish({ fatal: f, durationMs }) {
    const summary = summarize(statsList, state, config);
    // Guarded on `!== false`: abandon() and the crash handler have already set a
    // far more actionable reason, and both leave an all-zero statsList — so an
    // unguarded coverage verdict would overwrite "session verification FAILED on
    // /x" with the generic "NOTHING WAS TESTED".
    if (state.verified !== false) {
      const reasons = unverifiedReasons(statsList, summary, config, state);
      if (reasons.length) {
        state.verified = false;
        state.unverifiedReason = reasons.join(' ');
      }
    }
    const result = {
      runId,
      seed: config.seed,
      config,
      routes,
      state,
      statsList,
      summary,
      findings: summary.findings,
      // The --json projection. `clickable` is here because log.json's own `pages[]`
      // carries it and a CI job reading --json found nothing about the census.
      pages: statsList.map((ps) => ({
        path: ps.page,
        steps: ps.steps,
        noopSteps: ps.noopSteps,
        unreached: ps.unreached,
        skipped: ps.skipped,
        redirectedTo: ps.redirectedTo,
        durationMs: ps.durationMs,
        clickable: ps.clickable,
      })),
      verified: state.verified !== false,
      unverifiedReason: state.unverifiedReason,
      startDate,
      durationMs,
      fatal: f,
      reportPaths: [],
      logPath: null,
    };
    for (const r of reporters) {
      try {
        const p = r.write(result, { outDir, runId, runDir });
        if (p) {
          result.reportPaths.push(p);
          if (r.name === 'json') result.logPath = p;
        }
      } catch (e) {
        say(`mischief: reporter "${r.name}" failed — ${(e && e.message) || e}`);
      }
    }
    result.exitCode = exitCodeFor({
      verified: result.verified,
      fatal: f,
      critCount: summary.critCount,
      highCount: summary.highCount,
    });
    return result;
  }
}

/**
 * The result shape for a failure BEFORE anything exists to report on.
 *
 * runMonkey documents itself as never throwing and always returning an exitCode,
 * which the three pre-flight resolvers used to break — and they did it after
 * mkdirSync, leaving an empty run directory behind on every bad config. There is
 * no statsList and no reporter to write with, so this returns exit 3 with the
 * fields every caller reads, and writes nothing at all.
 */
function preflightFailure({ runId, config, startDate, error, why }) {
  const summary = {
    tot: { steps: 0, unreached: 0, redirected: 0, skipped: 0, noClickable: 0 },
    findings: [{ severity: 'unverified', kind: 'preflight', page: '-', message: why }],
    critCount: 0,
    highCount: 0,
    gates: 0,
  };
  return {
    runId,
    seed: config.seed,
    config,
    routes: [],
    state: { verified: false, unverifiedReason: why },
    statsList: [],
    summary,
    findings: summary.findings,
    pages: [],
    verified: false,
    unverifiedReason: why,
    startDate,
    durationMs: 0,
    fatal: error,
    reportPaths: [],
    logPath: null,
    exitCode: EXIT.UNVERIFIED,
  };
}

/**
 * Anonymous runs must not pretend to cover gated routes. Skipping loudly is the
 * honest outcome; testing the redirect target under the gated route's name is not.
 */
function routeSkipReason(route, state, config) {
  if (route.skip && route.skip({ authed: state.authed, config, route })) return 'route.skip() returned true';
  if (route.requiresAuth && !state.authed) return 'requiresAuth and this run has no session';
  return null;
}

async function hardClose(browser, context, mode) {
  if (mode === 'launch' && context) {
    try {
      await context.close();
    } catch {}
  }
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
}

export { EXIT };
