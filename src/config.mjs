import path from 'node:path';
import { DEFAULT_CONFIG } from './defaults.mjs';
import { ConfigError, hostAllowed } from './util.mjs';

export { ConfigError };

/**
 * Identity function that exists purely so editors can infer the config shape
 * and so a typo in a key is caught at load time rather than silently ignored 40
 * steps into a run.
 *
 * Checks TWO levels, not one. Every safety feature in this package is nested —
 * `guardrails.forceOpenShadowRoots`, `auth.detectLoginScreen`,
 * `guardrails.requireClickable`, `timing.gotoWaitUntil` — and a one-level check
 * meant a typo in any of them reverted the feature to its default in silence.
 * Worse: two report messages instruct the user to set nested keys as the
 * documented escape from a false exit 3, so `forceOpenShadowRoot` (singular)
 * produced a byte-identical report and no error, and the user concluded the
 * remedy did not work.
 *
 * Exactly two levels. Level 3 is where user-defined names legitimately live
 * (`mutators.weights.myMutator`, the CDP fields inside `viewports.mobile`), so
 * recursing further would reject valid configs.
 */
export function defineConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('defineConfig() needs an object');
  reject(Object.keys(cfg).filter((k) => !(k in DEFAULT_CONFIG)), DEFAULT_CONFIG, '');
  for (const [k, v] of Object.entries(cfg)) {
    const def = DEFAULT_CONFIG[k];
    if (!isPlainObject(def) || !isPlainObject(v)) continue;
    // `mutators.weights` is a free-form map of mutator name -> weight, so its own
    // keys cannot be checked against anything.
    if (k === 'mutators' && 'weights' in v) {
      reject(Object.keys(v).filter((s) => s !== 'weights' && !(s in def)), def, `${k}.`);
      continue;
    }
    reject(Object.keys(v).filter((s) => !(s in def)), def, `${k}.`);
  }
  return cfg;
}

function reject(unknown, valid, prefix) {
  if (!unknown.length) return;
  throw new ConfigError(
    `Unknown config key(s): ${unknown.map((k) => prefix + k).join(', ')}\n` +
      `Valid keys under ${prefix || '(top level)'}: ${Object.keys(valid).join(', ')}`,
  );
}

// Objects that are VALUES, not namespaces to merge into: replacing them wholesale
// is what the user means. A RegExp merged key-by-key would become garbage.
const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) && typeof v !== 'function';

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * defaults < config file < CLI overrides. Returns a frozen, validated config.
 * `cwd` anchors relative paths (outDir, auth.from) to where the user ran the
 * command, not to wherever the package happens to live.
 */
export function resolveConfig(fileConfig = {}, overrides = {}, cwd = process.cwd()) {
  const cfg = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), overrides);

  cfg.baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!cfg.baseUrl) throw new ConfigError('baseUrl is required');
  let url;
  try {
    url = new URL(cfg.baseUrl);
  } catch {
    throw new ConfigError(`baseUrl is not a URL: ${cfg.baseUrl}`);
  }
  cfg.baseOrigin = url.origin;

  // Derived, like baseOrigin: the set of origins whose responses are classified.
  // Normalized to origins so a trailing path in the config cannot make
  // startsWith() silently match nothing. Read-only — watching an origin never
  // sends anything to it, so this deliberately does NOT go through allowedHosts.
  cfg.watchedOrigins = [
    cfg.baseOrigin,
    ...(cfg.network.watchOrigins || []).map((o) => {
      try {
        return new URL(String(o)).origin;
      } catch {
        throw new ConfigError(`network.watchOrigins entry is not a URL: ${o}`);
      }
    }),
  ].filter((o, i, all) => all.indexOf(o) === i);

  // consoleIgnore entries are matched with `re.test(text)` in collect.mjs, so a
  // plain string throws "re.test is not a function" from inside a page event
  // handler — an uncaught throw that kills the run on whatever route it first
  // hits, with no report written and node's exit 1 indistinguishable from real
  // HIGH findings. Every other field here fails loudly at load; this one did not.
  // The mistake is easy to make because presets.consoleIgnore is keyed by
  // framework name, so `['vue', 'vite']` looks exactly like the right thing.
  // Array.isArray first, not `|| []`. That only guards FALSY values, so the most
  // natural version of the mistake — `consoleIgnore: /\[vite\] connect/`, the
  // array simply forgotten — is truthy, not iterable, and the for...of threw a
  // raw TypeError before the instanceof check ran. bin/mischief.mjs prints
  // e.stack for anything that is not a ConfigError, so the one misconfiguration
  // this block exists to explain got a stack trace instead of the explanation.
  const ignore = cfg.network.consoleIgnore;
  if (ignore != null && !Array.isArray(ignore)) {
    throw new ConfigError(
      `network.consoleIgnore must be an array of RegExp, got ${typeof ignore} (${JSON.stringify(String(ignore))}).\n` +
        `  A single pattern still needs the array: [/\\[vite\\] connect(ed|ing)/].`,
    );
  }
  for (const re of ignore || []) {
    if (!(re instanceof RegExp)) {
      throw new ConfigError(
        `network.consoleIgnore entries must be RegExp, got ${typeof re} (${JSON.stringify(re)}).\n` +
          `  Use presets.consoleIgnore: [...presets.consoleIgnore.vue, ...presets.consoleIgnore.vite]\n` +
          `  or write your own, e.g. [/\\[vite\\] connect(ed|ing)/].`,
      );
    }
  }

  // The safety rail. Refusing by default is the point: a chaos monkey pointed at
  // production clicks real buttons in a real session.
  if (!cfg.allowProd && !hostAllowed(url.hostname, cfg.allowedHosts)) {
    throw new ConfigError(
      `REFUSED: "${url.hostname}" is not in allowedHosts [${(cfg.allowedHosts || []).join(', ')}].\n` +
        `Add it to allowedHosts in your config, or pass --allow-prod to override for one run.`,
    );
  }

  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) throw new ConfigError('routes must be a non-empty array');
  if (!Number.isFinite(cfg.steps) || cfg.steps < 1) throw new ConfigError('steps must be a positive integer');
  if (cfg.seed === null || cfg.seed === undefined) cfg.seed = Date.now() % 100000;
  if (!Number.isFinite(cfg.seed)) throw new ConfigError('seed must be an integer');
  cfg.seed = cfg.seed >>> 0;

  // A bad value here would silently truncate every DOM scan, which is the exact
  // failure class this package exists to refuse. maxCandidates has the same
  // property one level down: the walk aborts on `out.length >= maxCandidates`, so
  // 0 or null returns an empty candidate list and reports it as "nothing to click".
  for (const k of ['maxScanNodes', 'maxCandidates']) {
    if (!Number.isFinite(cfg.guardrails[k]) || cfg.guardrails[k] < 1) {
      throw new ConfigError(`guardrails.${k} must be a number >= 1 (got ${cfg.guardrails[k]})`);
    }
  }

  // Same failure mode one probe over: deadControlBaselineWindows: 0 would divide
  // the settle window into nothing and learn an EMPTY idle baseline, after which
  // every timer tick reads as a control's effect — or, with the comparison the
  // other way round, every click reads as dead. A signal whose stated risk is
  // false positives must not be silently mis-tunable.
  for (const k of [
    'deadControlMinObservations',
    'deadControlBaselineWindows',
    'deadControlMaxSignatures',
    'deadControlAmbientTargets',
    'deadControlMaxRequests',
  ]) {
    if (!Number.isFinite(cfg.probes[k]) || cfg.probes[k] < 1) {
      throw new ConfigError(`probes.${k} must be a number >= 1 (got ${cfg.probes[k]})`);
    }
  }
  if (!Number.isFinite(cfg.probes.deadControlGraceMs) || cfg.probes.deadControlGraceMs < 0) {
    throw new ConfigError(`probes.deadControlGraceMs must be a number >= 0 (got ${cfg.probes.deadControlGraceMs})`);
  }

  // Validated like browser.mode and auth.strategy, and for a sharper reason: this
  // is the most-edited timing key, it goes straight to Playwright, and a typo
  // makes EVERY page.goto reject. The run then happens entirely on about:blank and
  // diagnoses itself by naming a different config key.
  const waits = ['load', 'domcontentloaded', 'networkidle', 'commit'];
  if (!waits.includes(cfg.timing.gotoWaitUntil)) {
    throw new ConfigError(`timing.gotoWaitUntil must be one of ${waits.join(', ')} (got ${cfg.timing.gotoWaitUntil})`);
  }

  if (!['launch', 'attach'].includes(cfg.browser.mode)) {
    throw new ConfigError(`browser.mode must be 'launch' or 'attach' (got ${cfg.browser.mode})`);
  }
  const strategies = ['none', 'localStorage', 'storageState', 'cookies', 'custom'];
  if (!strategies.includes(cfg.auth.strategy)) {
    throw new ConfigError(`auth.strategy must be one of ${strategies.join(', ')} (got ${cfg.auth.strategy})`);
  }
  if (cfg.auth.strategy === 'localStorage' && !cfg.auth.key) {
    throw new ConfigError("auth.strategy 'localStorage' needs auth.key (the storage key your app reads)");
  }
  if (cfg.auth.strategy === 'custom' && typeof cfg.auth.apply !== 'function') {
    throw new ConfigError("auth.strategy 'custom' needs auth.apply(ctx)");
  }
  // storageState is applied when a context is CREATED. In attach mode we join a
  // context that already exists, so there is nothing to apply it to — say so now
  // rather than running a silently anonymous suite.
  if (cfg.auth.strategy === 'storageState' && cfg.browser.mode === 'attach') {
    throw new ConfigError(
      "auth.strategy 'storageState' cannot be applied in browser.mode 'attach' — the context already exists.\n" +
        "Use 'cookies' or 'localStorage' for attach mode, or switch to browser.mode 'launch'.",
    );
  }
  if (cfg.auth.strategy !== 'none' && !cfg.auth.from && !cfg.auth.apply) {
    throw new ConfigError(`auth.strategy '${cfg.auth.strategy}' needs auth.from (path to a session file)`);
  }

  cfg.report.outDir = path.resolve(cwd, cfg.report.outDir);
  if (cfg.auth.from) cfg.auth.from = path.resolve(cwd, cfg.auth.from);

  // Derived, like cfg.baseOrigin — deliberately NOT a DEFAULT_CONFIG key, which
  // would make it user-settable and then clobber it in the merge.
  //
  // A warning, not an error: the package cannot know a selector, some apps have
  // no stable one to offer, and its job is to refuse to CLAIM unverified
  // coverage — not to refuse to run.
  cfg.warnings = [];
  for (const e of cfg.routes) {
    if (!e || typeof e !== 'object' || !e.requiresAuth || e.waitFor) continue;
    cfg.warnings.push(
      `route ${e.path || '(resolved at run time)'} declares requiresAuth but has no waitFor. Arrival on a gated ` +
        `route is only proven by a selector this route renders and the sign-in screen does not; without one, a guard ` +
        `that swaps the page after load is indistinguishable from a slow render.`,
    );
  }

  // Context options cannot be applied to a context that already exists. In attach
  // mode we adopt the running browser's default context, so anything passed to
  // newContext() is silently dropped — the same structural limit that makes
  // auth.strategy 'storageState' unavailable there. Left unsaid, a self-signed dev
  // cert turns every route into ERR_CERT_AUTHORITY_INVALID and the run fails
  // closed with a browser error, which is honest but tells you nothing about the
  // setting that did not take.
  if (cfg.browser.mode === 'attach' && cfg.browser.ignoreHTTPSErrors) {
    cfg.warnings.push(
      `browser.ignoreHTTPSErrors has no effect in attach mode — it is a context option, and attach adopts the ` +
        `browser's existing context. A self-signed certificate will fail every navigation. Either launch Chrome ` +
        `with --ignore-certificate-errors, accept the certificate once in that profile, or use mode: 'launch'.`,
    );
  }

  return cfg;
}
