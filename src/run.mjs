import fs from 'node:fs';
import path from 'node:path';
import { deriveStepRng, mulberry32, pickWeighted } from './rng.mjs';
import { makeRunId, pathOf, slugOf, sleep, trunc } from './util.mjs';
import { openBrowser, makeCleanup } from './browser/attach.mjs';
import { wireGuardrails, restoreNetwork } from './browser/guardrails.mjs';
import { wireCollectors } from './collect.mjs';
import { applyAuth, verifyAuth, AuthError } from './auth/index.mjs';
import { resolveMutators } from './mutators/index.mjs';
import { runProbes } from './probes/index.mjs';
import { initScriptInPage } from './probes/inpage.mjs';
import { resolveRoutes, newRouteStats } from './routes.mjs';
import { summarize, exitCodeFor, EXIT } from './severity.mjs';
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
  fs.mkdirSync(shotsDir, { recursive: true });

  const dropped = [];
  const routes = await resolveRoutes(config.routes, config, (r, why) => {
    dropped.push({ path: r.path, why });
    say(`webapp-qa: dropping ${r.path} — ${why}`);
  });
  const { registry, entries: mutatorEntries } = resolveMutators(config);
  const reporters = resolveReporters(config);

  const statsList = routes.map(newRouteStats);
  const state = {
    currentRoutePath: routes[0].path,
    stepIndex: 0,
    ps: statsList[0],
    offlineWindow: false,
    slowStepsRemaining: 0,
    mobileEmulated: false,
    closing: false,
    errShots: 0,
    actionLog: [],
    skippedDanger: [],
    gates: [],
    authed: false,
    verified: true,
    verification: null,
    unverifiedReason: null,
    droppedRoutes: dropped,
    outDir,
    shotsDir,
  };
  const log = (mutator, target, note) =>
    state.actionLog.push({ page: state.currentRoutePath, step: state.stepIndex, mutator, target, note });

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
    say(`webapp-qa: ${config.browser.mode === 'attach' ? `attaching to ${config.browser.cdpUrl}` : 'launching browser'} …`);
    ({ browser, context, mode } = await openBrowser(config));

    // Session goes in BEFORE the first navigation. addInitScript-based
    // strategies have no effect on a document that already loaded.
    try {
      const applied = await applyAuth({ context, config });
      state.authed = applied.authed;
      if (applied.authed) say(`webapp-qa: ${applied.note}`);
    } catch (e) {
      if (e instanceof AuthError && !config.allowAnonymous) {
        await hardClose(browser, context, mode);
        return abandon(`auth could not be applied — ${e.message}`);
      }
      say(`webapp-qa: WARNING — ${e.message}; continuing ANONYMOUS`);
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

    await page.addInitScript(initScriptInPage, { blockWindowOpen: config.guardrails.blockWindowOpen });
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
        say(`webapp-qa: route ${ri + 1}/${routes.length} ${route.path} — SKIPPED (${skipReason})`);
        continue;
      }

      say(`webapp-qa: route ${ri + 1}/${routes.length} ${route.path}`);
      try {
        await page.goto(config.baseOrigin + route.path, {
          waitUntil: config.timing.gotoWaitUntil,
          timeout: config.timing.gotoTimeoutMs,
        });
      } catch (e) {
        // A networkidle cap is routine on apps with SSE or an HMR socket — the
        // page is usually perfectly usable. Record it, do not abort.
        ps.gotoNote = `goto: ${trunc(String((e && e.message) || e), 140)}`;
      }
      await sleep(config.timing.settleMs);

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
          await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          present = !!(await page.$(route.waitFor));
        } catch {
          present = false;
        }
        if (!present) {
          ps.unreached = `waitFor "${route.waitFor}" is not present (landed on ${pathOf(page.url())})`;
          say(`webapp-qa:   NOT REACHED — ${ps.unreached}`);
          ps.durationMs = Date.now() - rt0;
          continue;
        }
      }

      // (c) landed-URL check — cheap, needs no per-app selector, and catches the
      // single most common drift: a route that quietly became a redirect.
      const landed = pathOf(page.url());
      if (landed !== pathOf(config.baseOrigin + route.path)) {
        ps.redirectedTo = landed;
        say(`webapp-qa:   redirected → ${landed}`);
      }

      // (a) verification, once, on the first requiresAuth route we actually load.
      if (!verifiedOnce && route.requiresAuth) {
        verifiedOnce = true;
        const v = await verifyAuth({ page, config, route, baseOrigin: config.baseOrigin });
        state.verification = v;
        if (!v.ok) {
          await cleanup();
          return abandon(
            `session verification FAILED on ${route.path} — ${v.how}. ` +
              `The run would have tested whatever the app redirected to and called it a pass.`,
            { partial: true },
          );
        }
        say(`webapp-qa: session verified (${v.how})`);
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
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        const name = pickWeighted(master, routeEntries);
        ctx.rng = deriveStepRng(config.seed, ri, stepN); // see rng.mjs for why
        try {
          await registry[name](ctx);
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
        await sleep(config.timing.stepPauseMinMs + Math.floor(master() * config.timing.stepPauseJitterMs));
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

      await runProbes(page, ps, config, 'exit');
      if (config.report.pageScreenshots) {
        const shotPath = path.join(shotsDir, `page-${slugOf(route.path)}.jpeg`);
        try {
          await page.screenshot({ path: shotPath, type: 'jpeg', quality: 50, fullPage: true, timeout: 15000 });
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

  function abandon(reason, { partial = false } = {}) {
    state.verified = false;
    state.unverifiedReason = reason;
    say(`webapp-qa: ABANDONED — ${reason}`);
    return finish({ fatal: null, durationMs: Date.now() - t0, partial });
  }

  function finish({ fatal: f, durationMs }) {
    const summary = summarize(statsList, state, config);
    // A route the harness never reached cannot contribute to a pass. Without
    // this, a route list that has drifted into 404s exits 0 and reports "None."
    // under every severity — the exact false green this package exists to stop.
    if (state.verified !== false && summary.tot.unreached > 0) {
      const names = statsList.filter((p) => p.unreached).map((p) => p.page);
      state.verified = false;
      state.unverifiedReason = `${summary.tot.unreached} route(s) were never reached: ${names.join(', ')}. Findings cover only the routes that loaded.`;
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
      pages: statsList.map((ps) => ({
        path: ps.page,
        steps: ps.steps,
        unreached: ps.unreached,
        skipped: ps.skipped,
        redirectedTo: ps.redirectedTo,
        durationMs: ps.durationMs,
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
        say(`webapp-qa: reporter "${r.name}" failed — ${(e && e.message) || e}`);
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
