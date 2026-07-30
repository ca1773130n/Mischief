import path from 'node:path';
import { DEFAULT_CONFIG } from './defaults.mjs';
import { hostAllowed } from './util.mjs';

/**
 * Identity function that exists purely so editors can infer the config shape
 * and so a typo in a top-level key is caught at load time rather than silently
 * ignored 40 steps into a run.
 */
export function defineConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('defineConfig() needs an object');
  const unknown = Object.keys(cfg).filter((k) => !(k in DEFAULT_CONFIG));
  if (unknown.length) {
    throw new ConfigError(
      `Unknown config key(s): ${unknown.join(', ')}\nValid keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`,
    );
  }
  return cfg;
}

export class ConfigError extends Error {}

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

  return cfg;
}
