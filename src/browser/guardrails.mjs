import { gatherCandidatesInPage } from '../probes/inpage.mjs';
import { clickableArg } from '../probes/index.mjs';
import { inertOn, markClick } from '../inert.mjs';
import { pickFrom } from '../rng.mjs';
import { sleep } from '../util.mjs';

/**
 * Pick a click target, refusing anything whose visible label matches the danger
 * pattern.
 *
 * The polling loop is not paranoia: right after a reload or route change the app
 * may not have rendered yet, and an empty candidate list at that instant is
 * timing noise that makes two runs of the same seed diverge. Two seconds of
 * patience buys reproducibility. collectClickable polls identically — a census
 * less patient than the clicks it describes would report a slow app as click-free.
 */
export async function chooseClickPoint(ctx, mutatorName) {
  const arg = clickableArg(ctx.config);
  const t = ctx.config.timing;
  let res = null;
  let threw = false;
  for (let attempt = 0; attempt < Math.max(1, t.settlePollAttempts); attempt++) {
    threw = false;
    res = await ctx.page.evaluate(gatherCandidatesInPage, arg).catch(() => {
      threw = true;
      return null;
    });
    if (res && res.candidates.length) break;
    await sleep(t.settlePollMs);
  }
  // Pure counters — no ctx.rng() is drawn here. One extra draw before pickFrom
  // would shift every pick of every existing seed.
  const ps = ctx.state && ctx.state.ps;
  if (ps && ps.clickable) {
    ps.clickable.attempts++;
    if (res) {
      ps.clickable.max = Math.max(ps.clickable.max, res.candidates.length);
      ps.clickable.selector = ps.clickable.selector || res.selector;
      if (res.truncated) ps.clickable.scanTruncated = true;
      if (res.capped) ps.clickable.capped = true;
      if (res.shadow) ps.clickable.shadow = res.shadow;
    }
    // An in-page throw used to be recorded only as `empty++`, making a broken
    // probe indistinguishable from a genuinely empty page — the silent degradation
    // the census exists to end. `empty` still counts it: a step that found nothing
    // to click really did find nothing.
    if (threw) ps.clickable.probeFailed = true;
    if (!res || !res.candidates.length) ps.clickable.empty++;
  }
  if (!res || !res.candidates.length) return null;
  const cands = res.candidates;
  let pick = pickFrom(ctx.rng, cands);
  if (pick.danger) {
    // Logged as refused, then re-drawn from the safe pool — so the report can
    // show WHICH destructive controls the monkey was offered.
    ctx.state.skippedDanger.push({ page: ctx.state.currentRoutePath, text: pick.text || pick.tag });
    ctx.log(mutatorName, `${pick.tag} "${pick.text}"`, 'skipped-danger');
    const safe = cands.filter((c) => !c.danger);
    if (!safe.length) return null;
    pick = pickFrom(ctx.rng, safe);
  }
  // The last thing before the caller clicks. This is the ONE funnel every click
  // in this package passes through (randomClick, rapidDoubleClick, and the
  // randomClick offlineMode fires internally), so the dead-control probe's
  // "before" reading belongs here and nowhere else — log() runs after the click
  // has resolved, by which point a synchronous handler's fetch has already gone.
  // Draws no ctx.rng(), so recorded seeds still replay exactly.
  if (inertOn(ctx.config)) await markClick(ctx, pick);
  return pick;
}

/**
 * If a mutator walked us off-origin, come back to the route under test.
 * Uses timing.gotoWaitUntil like the route navigation itself: a hardcoded
 * 'domcontentloaded' here meant the key was honoured on the first goto only.
 */
export async function ensureOnOrigin(ctx) {
  if (!ctx.config.guardrails.stayOnOrigin) return;
  if (ctx.page.url().startsWith(ctx.baseOrigin)) return;
  await ctx.page
    .goto(ctx.baseOrigin + ctx.state.currentRoutePath, {
      waitUntil: ctx.config.timing.gotoWaitUntil,
      timeout: ctx.config.timing.gotoTimeoutMs,
    })
    .catch(() => {});
}

/**
 * Restore network conditions.
 *
 * Falls back to Slow-3G rather than full speed when a slowNetwork window is
 * still open: an offlineMode step ending must not silently cancel a throttle
 * window that has steps left to run.
 */
export async function restoreNetwork(ctx) {
  const target = ctx.state.slowStepsRemaining > 0 ? ctx.config.network.slow3g : ctx.config.network.normal;
  await ctx.cdp.send('Network.emulateNetworkConditions', target).catch(() => {});
}

/**
 * Popup suppression + off-origin watchdog. Wired once, before the first
 * navigation, so nothing escapes between page loads.
 */
export function wireGuardrails(page, state, baseOrigin, config) {
  if (config.guardrails.closePopups) {
    // The monkey must never accumulate tabs — in attach mode those tabs are in
    // the user's own window.
    page.on('popup', (p) => p.close().catch(() => {}));
  }

  if (!config.guardrails.stayOnOrigin) return;

  let recovering = false;
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    // about:blank is the pristine-tab state; the randomBack mutator recovers
    // from it on its own, and fighting it here causes a navigation war.
    if (state.closing || recovering || url === 'about:blank' || url.startsWith(baseOrigin)) return;
    recovering = true;
    const t = config.timing;
    try {
      await page.goBack({ waitUntil: t.gotoWaitUntil, timeout: t.historyTimeoutMs }).catch(() => {});
      if (!page.url().startsWith(baseOrigin)) {
        await page.goto(baseOrigin + state.currentRoutePath, { waitUntil: t.gotoWaitUntil, timeout: t.gotoTimeoutMs }).catch(() => {});
      }
    } finally {
      recovering = false;
    }
  });
}
