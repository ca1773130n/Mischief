import { gatherCandidatesInPage } from '../probes/inpage.mjs';
import { pickFrom } from '../rng.mjs';
import { sleep } from '../util.mjs';

/**
 * Pick a click target, refusing anything whose visible label matches the danger
 * pattern.
 *
 * The polling loop is not paranoia: right after a reload or route change the app
 * may not have rendered yet, and an empty candidate list at that instant is
 * timing noise that makes two runs of the same seed diverge. Two seconds of
 * patience buys reproducibility.
 */
export async function chooseClickPoint(ctx, mutatorName) {
  const g = ctx.config.guardrails;
  const arg = {
    dangerSource: g.dangerPattern.source,
    dangerFlags: g.dangerPattern.flags || 'i',
    ignoreAttribute: g.ignoreAttribute,
    maxCandidates: g.maxCandidates,
  };
  let cands = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    cands = await ctx.page.evaluate(gatherCandidatesInPage, arg).catch(() => null);
    if (cands && cands.length) break;
    await sleep(250);
  }
  if (!cands || !cands.length) return null;
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
  return pick;
}

/** If a mutator walked us off-origin, come back to the route under test. */
export async function ensureOnOrigin(ctx) {
  if (!ctx.config.guardrails.stayOnOrigin) return;
  if (ctx.page.url().startsWith(ctx.baseOrigin)) return;
  await ctx.page
    .goto(ctx.baseOrigin + ctx.state.currentRoutePath, { waitUntil: 'domcontentloaded', timeout: 15000 })
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
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      if (!page.url().startsWith(baseOrigin)) {
        await page
          .goto(baseOrigin + state.currentRoutePath, { waitUntil: 'domcontentloaded', timeout: 15000 })
          .catch(() => {});
      }
    } finally {
      recovering = false;
    }
  });
}
