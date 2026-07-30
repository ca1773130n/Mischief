import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickFrom } from '../rng.mjs';
import { sleep, stripQuery } from '../util.mjs';
import { chooseClickPoint, ensureOnOrigin, restoreNetwork } from '../browser/guardrails.mjs';
import { overflowInPage } from '../probes/inpage.mjs';
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

async function randomClick(ctx) {
  const t = await chooseClickPoint(ctx, 'randomClick');
  if (!t) return void ctx.log('randomClick', '-', 'no candidate');
  await ctx.page.mouse.click(t.x, t.y);
  ctx.log('randomClick', `${t.tag} "${t.text}"`, '');
}

async function randomBack(ctx) {
  await ctx.page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  await sleep(500);
  await ensureOnOrigin(ctx);
  let fwd = false;
  if (ctx.rng() < 0.5) {
    fwd = true;
    await ctx.page.goForward({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
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
    if (ignore && (await h.evaluate((el, a) => !!el.closest(`[${a}]`), ignore).catch(() => true))) continue;
    usable.push(h);
  }
  if (!usable.length) return void ctx.log('invalidInput', '-', 'skipped: no editable input');
  const h = pickFrom(ctx.rng, usable);
  const type = await h.evaluate((el) => el.type || 'text').catch(() => 'text');
  // number/date inputs reject free text at the DRIVER level, so fill() would
  // throw before the app ever saw the value — that tests Playwright, not the app.
  let pool = ctx.config.input.invalidValues;
  if (type === 'number') pool = ['', '-999999999'];
  else if (['date', 'time', 'month', 'week', 'datetime-local'].includes(type)) pool = [''];
  const value = pickFrom(ctx.rng, pool);
  await h.fill(value, { timeout: 5000 });
  const enter = ctx.rng() < 0.3;
  if (enter) await h.press('Enter').catch(() => {});
  ctx.log('invalidInput', `${type} field`, `${value.length} chars${enter ? ' +Enter' : ''}`);
}

async function rapidDoubleClick(ctx) {
  const t = await chooseClickPoint(ctx, 'rapidDoubleClick');
  if (!t) return void ctx.log('rapidDoubleClick', '-', 'no candidate');
  await ctx.page.mouse.click(t.x, t.y);
  await sleep(50);
  await ctx.page.mouse.click(t.x, t.y).catch(() => {});
  ctx.log('rapidDoubleClick', `${t.tag} "${t.text}"`, '2 clicks / 50ms');
}

async function refresh(ctx) {
  await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  ctx.log('refresh', '-', '');
}

async function mobileResize(ctx) {
  const toMobile = !ctx.state.mobileEmulated;
  const vp = toMobile ? ctx.config.viewports.mobile : ctx.config.viewports.desktop;
  await ctx.cdp.send('Emulation.setDeviceMetricsOverride', vp);
  ctx.state.mobileEmulated = toMobile;
  await sleep(400);
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
  ctx.state.offlineWindow = true; // the requestfailed collector tags failures inside this window as self-inflicted
  await ctx.cdp.send('Network.emulateNetworkConditions', ctx.config.network.offline);
  ctx.log('offlineMode', '-', 'offline 2.5s + one click');
  await randomClick(ctx).catch(() => {});
  await sleep(2500);
  await restoreNetwork(ctx);
  ctx.state.offlineWindow = false;
  const broke = ctx.state.ps.jsExceptions.length - before;
  if (broke > 0) ctx.log('offlineMode', '-', `${broke} JS exception(s) while offline`);
}

async function slowNetwork(ctx) {
  // The throttle covers the NEXT 3 steps; the step loop decrements and restores.
  // Throttling a single step would only ever slow down this mutator itself.
  ctx.state.slowStepsRemaining = 3;
  await ctx.cdp.send('Network.emulateNetworkConditions', ctx.config.network.slow3g);
  ctx.log('slowNetwork', '-', 'Slow-3G for next 3 steps');
}

async function uploadRandomFile(ctx) {
  const ignore = ctx.config.guardrails.ignoreAttribute;
  const inputs = await ctx.page.$$('input[type=file]');
  let target = null;
  for (const h of inputs) {
    if (!(await h.isVisible().catch(() => false))) continue;
    if (ignore && (await h.evaluate((el, a) => !!el.closest(`[${a}]`), ignore).catch(() => true))) continue;
    target = h;
    break;
  }
  if (!target) return void ctx.log('uploadRandomFile', '-', 'skipped: no visible file input');
  const ext = pickFrom(ctx.rng, ['.txt', '.png', '.pdf', '.zip']);
  const size = 1024 + Math.floor(ctx.rng() * 49 * 1024);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(ctx.rng() * 256);
  const tmp = path.join(os.tmpdir(), `webapp-qa-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    await target.setInputFiles(tmp, { timeout: 5000 });
    ctx.log('uploadRandomFile', ext, `${size} bytes`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

async function keyboardSpam(ctx) {
  const pressed = [];
  for (let i = 0; i < 15; i++) {
    const k = pickFrom(ctx.rng, ctx.config.input.keyPool);
    pressed.push(k);
    await ctx.page.keyboard.press(k).catch(() => {});
    await sleep(30 + Math.floor(ctx.rng() * 50));
  }
  ctx.log('keyboardSpam', pressed.slice(0, 8).join(' '), '15 keys');
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
    throw new Error(`Unknown mutator(s): ${unknown.join(', ')}. Valid: ${Object.keys(reg).join(', ')}`);
  }
  const explicit = { ...NAMED_WEIGHTS, ...(config.mutators.weights || {}) };
  const customWeights = Object.fromEntries((config.mutators.custom || []).filter((m) => m.weight != null).map((m) => [m.name, m.weight]));
  Object.assign(explicit, customWeights, config.mutators.weights || {});
  const unweighted = names.filter((n) => explicit[n] == null);
  const share = unweighted.length ? REMAINDER_WEIGHT / unweighted.length : 0;
  return { registry: reg, entries: names.map((n) => [n, explicit[n] ?? share]) };
}
