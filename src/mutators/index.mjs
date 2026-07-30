import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickFrom } from '../rng.mjs';
import { ConfigError, sleep, stripQuery } from '../util.mjs';
import { chooseClickPoint, ensureOnOrigin, restoreNetwork } from '../browser/guardrails.mjs';
import { activationDangerInPage, overflowInPage } from '../probes/inpage.mjs';
import { NAMED_WEIGHTS, REMAINDER_WEIGHT } from '../defaults.mjs';

/**
 * Register a custom mutator.
 *
 *   defineMutator({ name: 'openCommandPalette', weight: 5,
 *                   run: async (ctx) => { await ctx.page.keyboard.press('Control+k');
 *                                         ctx.log('openCommandPalette', '-', ''); } })
 *
 * ctx = { page, cdp, rng, log, state, baseOrigin, config }. Draw ALL randomness
 * from ctx.rng — Math.random() breaks seeded replay.
 */
export function defineMutator(spec) {
  if (!spec || typeof spec.name !== 'string') throw new Error('defineMutator needs a name');
  if (typeof spec.run !== 'function') throw new Error(`mutator "${spec.name}" needs run(ctx)`);
  return { weight: undefined, ...spec };
}

/**
 * Is `el` inside a subtree carrying the ignore attribute? Serialized into the
 * page, so it must stay self-contained.
 *
 * el.closest() terminates at a ShadowRoot — it is not an Element — so
 * `data-qa-ignore` on a custom element never protected the real <input> inside
 * its shadow root. Playwright's CSS engine pierces, so page.$$() has always
 * RETURNED those inputs and the monkey has always typed into them: this is a
 * safety fix, not a coverage one.
 */
const insideIgnored = (el, a) => {
  let n = el;
  while (n) {
    if (n.nodeType === 1 && n.hasAttribute(a)) return true;
    n = n.parentNode;
    if (n && n.nodeType === 11 && n.host) n = n.host;
  }
  return false;
};

/**
 * Would pressing an activation key right now trigger a destructive control? If
 * so, refuse it exactly the way chooseClickPoint refuses a click: recorded in
 * state.skippedDanger so the report can show what the monkey declined.
 *
 * Fails CLOSED on an evaluate error (treats it as danger and skips the key): the
 * cost is one unpressed key, and the alternative cost is a deleted account.
 */
async function activationRefused(ctx, mutatorName) {
  const g = ctx.config.guardrails;
  let failed = false;
  const hit = await ctx.page
    .evaluate(activationDangerInPage, { dangerSource: g.dangerPattern.source, dangerFlags: g.dangerPattern.flags || 'i' })
    .catch(() => {
      failed = true;
      return null;
    });
  // A probe that could not run means we do not know what has focus, so the key is
  // not pressed. It is NOT recorded in skippedDanger, which is the report's list of
  // destructive controls the monkey was actually offered — filing an unknown there
  // would invent evidence.
  if (failed) {
    ctx.log(mutatorName, '-', 'activation skipped: could not read focus');
    return true;
  }
  if (!hit) return false;
  if (ctx.state && ctx.state.skippedDanger) {
    ctx.state.skippedDanger.push({ page: ctx.state.currentRoutePath, text: hit.text, via: hit.via });
  }
  ctx.log(mutatorName, `${hit.tag} "${hit.text}"`, 'skipped-danger');
  return true;
}

async function randomClick(ctx) {
  const t = await chooseClickPoint(ctx, 'randomClick');
  if (!t) return void ctx.log('randomClick', '-', 'no candidate', { noop: true });
  await ctx.page.mouse.click(t.x, t.y);
  ctx.log('randomClick', `${t.tag} "${t.text}"`, '');
}

async function randomBack(ctx) {
  const t = ctx.config.timing;
  const o = ctx.config.mutators.options;
  await ctx.page.goBack({ waitUntil: t.gotoWaitUntil, timeout: t.historyTimeoutMs }).catch(() => {});
  await sleep(o.backSettleMs);
  await ensureOnOrigin(ctx);
  let fwd = false;
  if (ctx.rng() < 0.5) {
    fwd = true;
    await ctx.page.goForward({ waitUntil: t.gotoWaitUntil, timeout: t.historyTimeoutMs }).catch(() => {});
    await ensureOnOrigin(ctx);
  }
  ctx.log('randomBack', '-', fwd ? 'back+forward' : 'back');
}

async function invalidInput(ctx) {
  const sel =
    'input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=range]):not([type=color]), textarea';
  const ignore = ctx.config.guardrails.ignoreAttribute;
  const handles = await ctx.page.$$(sel);
  const usable = [];
  for (const h of handles) {
    if (!(await h.isVisible().catch(() => false))) continue;
    if (!(await h.isEditable().catch(() => false))) continue;
    if (ignore && (await h.evaluate(insideIgnored, ignore).catch(() => true))) continue;
    usable.push(h);
  }
  if (!usable.length) return void ctx.log('invalidInput', '-', 'skipped: no editable input', { noop: true });
  const h = pickFrom(ctx.rng, usable);
  const type = await h.evaluate((el) => el.type || 'text').catch(() => 'text');
  // number/date inputs reject free text at the DRIVER level, so fill() would
  // throw before the app ever saw the value — that tests Playwright, not the app.
  // The per-type pools are config keys: substituting a hardcoded list silently
  // discarded a user's own input.invalidValues on exactly those fields.
  const byType = ctx.config.input.invalidValuesByType || {};
  const pool = byType[type] || ctx.config.input.invalidValues;
  const value = pickFrom(ctx.rng, pool);
  await h.fill(value, { timeout: ctx.config.browser.defaultTimeoutMs });
  // Enter submits the form, so it goes through the same danger gate as a click:
  // "type DELETE to confirm" + Enter is a destructive activation with no click.
  const enter = ctx.rng() < ctx.config.mutators.options.enterProbability;
  let refused = false;
  if (enter) {
    refused = await activationRefused(ctx, 'invalidInput');
    if (!refused) await h.press('Enter').catch(() => {});
  }
  ctx.log(
    'invalidInput',
    `${type} field`,
    `${value.length} chars${byType[type] ? ' (type-restricted pool)' : ''}${enter ? (refused ? ' +Enter REFUSED' : ' +Enter') : ''}`,
  );
}

async function rapidDoubleClick(ctx) {
  const t = await chooseClickPoint(ctx, 'rapidDoubleClick');
  if (!t) return void ctx.log('rapidDoubleClick', '-', 'no candidate', { noop: true });
  const gap = ctx.config.mutators.options.doubleClickGapMs;
  await ctx.page.mouse.click(t.x, t.y);
  await sleep(gap);
  await ctx.page.mouse.click(t.x, t.y).catch(() => {});
  ctx.log('rapidDoubleClick', `${t.tag} "${t.text}"`, `2 clicks / ${gap}ms`);
}

async function refresh(ctx) {
  await ctx.page.reload({ waitUntil: ctx.config.timing.gotoWaitUntil, timeout: ctx.config.timing.reloadTimeoutMs });
  ctx.log('refresh', '-', '');
}

async function mobileResize(ctx) {
  const toMobile = !ctx.state.mobileEmulated;
  const vp = toMobile ? ctx.config.viewports.mobile : ctx.config.viewports.desktop;
  await ctx.cdp.send('Emulation.setDeviceMetricsOverride', vp);
  ctx.state.mobileEmulated = toMobile;
  await sleep(ctx.config.mutators.options.resizeSettleMs);
  const label = `${vp.width}x${vp.height}`;
  const m = ctx.config.probes.overflow ? await ctx.page.evaluate(overflowInPage).catch(() => null) : null;
  if (m && m.sw > m.cw + 1) {
    ctx.state.ps.overflow.push({ viewport: label, scrollWidth: m.sw, clientWidth: m.cw, url: stripQuery(ctx.page.url()) });
    ctx.log('mobileResize', label, `HORIZONTAL OVERFLOW ${m.sw}>${m.cw}`);
  } else {
    ctx.log('mobileResize', label, m ? 'no overflow' : '');
  }
}

async function offlineMode(ctx) {
  const before = ctx.state.ps.jsExceptions.length;
  const ms = ctx.config.mutators.options.offlineMs;
  // try/finally, because the flag is set BEFORE the CDP call that can throw. A
  // failed emulation used to leave the whole rest of the run tagged as
  // self-inflicted, which suppresses every later request-failure finding.
  ctx.state.offlineWindow = true; // the requestfailed collector tags failures inside this window as self-inflicted
  try {
    await ctx.cdp.send('Network.emulateNetworkConditions', ctx.config.network.offline);
    ctx.log('offlineMode', '-', `offline ${(ms / 1000).toFixed(1)}s + one click`);
    await randomClick(ctx).catch(() => {});
    await sleep(ms);
  } finally {
    await restoreNetwork(ctx).catch(() => {});
    ctx.state.offlineWindow = false;
  }
  const broke = ctx.state.ps.jsExceptions.length - before;
  if (broke > 0) ctx.log('offlineMode', '-', `${broke} JS exception(s) while offline`);
}

async function slowNetwork(ctx) {
  // The throttle covers the NEXT N steps; the step loop decrements and restores.
  // Throttling a single step would only ever slow down this mutator itself.
  const n = ctx.config.mutators.options.slowSteps;
  ctx.state.slowStepsRemaining = n;
  await ctx.cdp.send('Network.emulateNetworkConditions', ctx.config.network.slow3g);
  ctx.log('slowNetwork', '-', `Slow-3G for next ${n} steps`);
}

async function uploadRandomFile(ctx) {
  const ignore = ctx.config.guardrails.ignoreAttribute;
  const o = ctx.config.mutators.options;
  const inputs = await ctx.page.$$('input[type=file]');
  let target = null;
  for (const h of inputs) {
    if (!(await h.isVisible().catch(() => false))) continue;
    if (ignore && (await h.evaluate(insideIgnored, ignore).catch(() => true))) continue;
    target = h;
    break;
  }
  if (!target) return void ctx.log('uploadRandomFile', '-', 'skipped: no visible file input', { noop: true });
  const ext = pickFrom(ctx.rng, o.uploadExtensions);
  const size = o.uploadMinBytes + Math.floor(ctx.rng() * o.uploadJitterBytes);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(ctx.rng() * 256);
  const tmp = path.join(os.tmpdir(), `mischief-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    await target.setInputFiles(tmp, { timeout: ctx.config.browser.defaultTimeoutMs });
    ctx.log('uploadRandomFile', ext, `${size} bytes`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

async function keyboardSpam(ctx) {
  const o = ctx.config.mutators.options;
  // Enter and Space ACTIVATE whatever has focus, so they go through the danger
  // guardrail like a click does. Without this, Tab-then-Enter reached a focused
  // "Delete account" while the report claimed the guardrail covered it.
  const activation = ctx.config.input.activationKeys || [];
  const pressed = [];
  let refused = 0;
  for (let i = 0; i < o.keyboardSpamKeys; i++) {
    const k = pickFrom(ctx.rng, ctx.config.input.keyPool);
    // Both draws happen before the refusal branch, so the number of rng draws per
    // iteration is CONSTANT. A draw count that depended on what had focus would
    // make the same seed press a different key sequence on two runs.
    const pause = o.keyPauseMinMs + Math.floor(ctx.rng() * o.keyPauseJitterMs);
    if (activation.includes(k) && (await activationRefused(ctx, 'keyboardSpam'))) {
      refused++;
      pressed.push(`${k}(refused)`);
      continue;
    }
    pressed.push(k);
    await ctx.page.keyboard.press(k).catch(() => {});
    await sleep(pause);
  }
  ctx.log('keyboardSpam', pressed.slice(0, 8).join(' '), `${o.keyboardSpamKeys} keys${refused ? `, ${refused} refused` : ''}`);
}

export const builtinMutators = {
  randomClick,
  randomBack,
  invalidInput,
  rapidDoubleClick,
  refresh,
  mobileResize,
  offlineMode,
  slowNetwork,
  uploadRandomFile,
  keyboardSpam,
};

/** name -> run(ctx), built-ins plus anything the config registered. */
export function buildRegistry(config) {
  const reg = { ...builtinMutators };
  for (const m of config.mutators.custom || []) reg[m.name] = m.run;
  return reg;
}

/**
 * Resolve the enabled set into [[name, weight], …].
 *
 * Weighting rule: the three named weights are absolute; every OTHER enabled
 * mutator gets an equal share of the remaining 45. That keeps the ratio sane
 * whether you enable three mutators or thirteen.
 */
export function resolveMutators(config) {
  const reg = buildRegistry(config);
  const names = config.mutators.enabled && config.mutators.enabled.length ? config.mutators.enabled : Object.keys(reg);
  const unknown = names.filter((n) => !reg[n]);
  if (unknown.length) {
    throw new ConfigError(`Unknown mutator(s): ${unknown.join(', ')}. Valid: ${Object.keys(reg).join(', ')}`);
  }
  const explicit = { ...NAMED_WEIGHTS, ...(config.mutators.weights || {}) };
  const customWeights = Object.fromEntries((config.mutators.custom || []).filter((m) => m.weight != null).map((m) => [m.name, m.weight]));
  Object.assign(explicit, customWeights, config.mutators.weights || {});
  const unweighted = names.filter((n) => explicit[n] == null);
  const share = unweighted.length ? REMAINDER_WEIGHT / unweighted.length : 0;
  return { registry: reg, entries: names.map((n) => [n, explicit[n] ?? share]) };
}
