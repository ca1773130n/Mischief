#!/usr/bin/env node
// mischief — seeded, guard-railed browser chaos QA.
// Exit codes: 0 clean · 1 HIGH · 2 CRITICAL · 3 harness/verification failure.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runMonkey } from '../src/run.mjs';
import { resolveConfig, ConfigError } from '../src/config.mjs';
import { EXIT } from '../src/severity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_NAMES = ['mischief.config.mjs', 'mischief.config.js', 'qa.config.mjs'];

const USAGE = `mischief — seeded monkey testing in a real browser

  mischief [options]              run
  mischief init                   scaffold mischief.config.mjs here
  mischief replay <runId>         re-run a previous run's exact seed/routes/steps

Options
  --config <file>     config file (default: ${CONFIG_NAMES.join(' | ')} in cwd)
  --base <url>        base URL under test
  --routes <csv>      FILTER the configured routes to these paths — each one keeps
                      its requiresAuth/waitFor; unknown paths are added as-is
  --steps <n>         steps per route
  --seed <n>          replay a specific walk
  --mutators <csv>    restrict to these mutators
  --auth <file>       session file (overrides auth.from)
  --out <dir>         report directory
  --attach            drive an already-running Chrome over CDP (your real profile)
  --cdp <url>         CDP endpoint for --attach (default http://127.0.0.1:9222)
  --headed            launch mode: show the browser
  --allow-prod        permit a base URL outside allowedHosts
  --allow-anonymous   run without a session; every requiresAuth route is SKIPPED
  --quiet             suppress per-step progress output
  --json              print the machine-readable result to stdout
  -h, --help

Exit codes: 0 clean · 1 HIGH · 2 CRITICAL · 3 harness or verification failure`;

function die(msg, code = EXIT.UNVERIFIED) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { overrides: {}, configPath: null, json: false, command: null, commandArg: null };
  const set = (obj, dotted, value) => {
    const parts = dotted.split('.');
    let cur = obj;
    for (const p of parts.slice(0, -1)) cur = cur[p] = cur[p] || {};
    cur[parts[parts.length - 1]] = value;
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === 'init' || a === 'replay') {
      o.command = a;
      if (a === 'replay') o.commandArg = next();
    } else if (a === '--config') o.configPath = path.resolve(next());
    else if (a === '--base') set(o.overrides, 'baseUrl', next());
    else if (a === '--routes') o.routesCsv = next();
    else if (a === '--steps') set(o.overrides, 'steps', parseInt(next(), 10));
    else if (a === '--seed') set(o.overrides, 'seed', parseInt(next(), 10));
    else if (a === '--mutators') set(o.overrides, 'mutators.enabled', next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--auth') set(o.overrides, 'auth.from', next());
    else if (a === '--out') set(o.overrides, 'report.outDir', next());
    else if (a === '--attach') set(o.overrides, 'browser.mode', 'attach');
    else if (a === '--cdp') {
      set(o.overrides, 'browser.cdpUrl', next());
      set(o.overrides, 'browser.mode', 'attach');
    } else if (a === '--headed') set(o.overrides, 'browser.headless', false);
    else if (a === '--allow-prod') set(o.overrides, 'allowProd', true);
    else if (a === '--allow-anonymous') set(o.overrides, 'allowAnonymous', true);
    else if (a === '--quiet') set(o.overrides, 'quiet', true);
    else if (a === '--json') o.json = true;
    else die(`Unknown flag: ${a}\n\n${USAGE}`);
  }
  return o;
}

async function loadConfigFile(explicit) {
  const candidates = explicit ? [explicit] : CONFIG_NAMES.map((n) => path.resolve(process.cwd(), n));
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    const cfg = mod.default || mod.config;
    if (!cfg) die(`${p} has no default export. Use \`export default defineConfig({ … })\`.`);
    return { cfg, path: p };
  }
  if (explicit) die(`Config not found: ${explicit}`);
  return { cfg: {}, path: null };
}

function cmdInit() {
  const target = path.resolve(process.cwd(), 'mischief.config.mjs');
  if (fs.existsSync(target)) die(`${target} already exists — not overwriting.`, 1);
  fs.copyFileSync(path.join(__dirname, '..', 'templates', 'mischief.config.mjs'), target);
  console.log(`created ${target}`);

  // Reports are runtime artifacts. Without this, the first run leaves dozens of
  // screenshots in the consumer's `git status`.
  const gi = path.resolve(process.cwd(), '.gitignore');
  const line = 'reports/';
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!existing.split('\n').some((l) => l.trim() === line)) {
    fs.writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + `${line}\n`);
    console.log(`added "${line}" to ${gi}`);
  }
  console.log('\nNext: edit baseUrl + routes, then run `mischief`.');
}

/**
 * Replay reads the seed, routes and steps back out of a previous run's log.json.
 * The argument is a runId inside the configured outDir, or a path to the run
 * directory or the log itself — because runs written with `--out` do not live
 * where the config says they do.
 */
async function replayOverrides(runId, cfg, cwd, outOverride) {
  const roots = [outOverride, cfg.report && cfg.report.outDir, './reports'].filter(Boolean);
  const candidates = [
    path.resolve(cwd, runId),
    path.resolve(cwd, runId, 'log.json'),
    ...roots.flatMap((r) => [path.resolve(cwd, r, runId, 'log.json'), path.resolve(cwd, r, runId)]),
  ];
  const logPath = candidates.find((p) => fs.existsSync(p) && p.endsWith('log.json'));
  if (!logPath) die(`No log for run "${runId}". Looked in:\n  ${candidates.filter((p) => p.endsWith('log.json')).join('\n  ')}`);
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const c = log.config || {};
  console.log(`mischief: replaying ${runId} — seed ${c.seed}, ${(c.routes || []).length} route(s), ${c.steps} steps`);
  return {
    seed: c.seed,
    steps: c.steps,
    baseUrl: c.baseUrl,
    routes: (c.routes || []).map((r) => ({ path: r.path, requiresAuth: r.requiresAuth, waitFor: r.waitFor, steps: r.steps })),
  };
}

async function main() {
  const o = parseArgs(process.argv);
  if (o.command === 'init') return cmdInit();

  const { cfg: fileCfg, path: cfgPath } = await loadConfigFile(o.configPath);
  if (cfgPath) console.log(`mischief: config ${cfgPath}`);

  let overrides = o.overrides;
  if (o.command === 'replay') {
    const outOverride = overrides.report && overrides.report.outDir;
    overrides = { ...(await replayOverrides(o.commandArg, fileCfg, process.cwd(), outOverride)), ...overrides };
  }
  // --routes is a FILTER, not a redefinition. Matching entries keep their
  // config metadata — dropping requiresAuth/waitFor here would silently disable
  // the verification that makes a gated route's result trustworthy, which is
  // exactly the failure this tool exists to prevent.
  if (o.routesCsv) {
    const want = o.routesCsv.split(',').map((s) => s.trim()).filter(Boolean);
    const declared = new Map(
      (overrides.routes || fileCfg.routes || []).map((r) => [typeof r === 'string' ? r : r.path, r]),
    );
    overrides.routes = want.map((p) => declared.get(p) ?? declared.get('/' + p.replace(/^\//, '')) ?? p);
  }

  let config;
  try {
    config = resolveConfig(fileCfg, overrides, process.cwd());
  } catch (e) {
    die(e instanceof ConfigError ? e.message : (e && e.stack) || String(e));
  }

  if (config.browser.mode === 'attach') {
    console.error(
      `mischief: ATTACH MODE — driving the browser at ${config.browser.cdpUrl}, in whatever profile it is signed into.\n` +
        `           Clicks are real. Mouse clicks AND Enter/Space activations are checked against\n` +
        `           guardrails.dangerPattern, which matches a control's VISIBLE LABEL only — an\n` +
        `           icon-only destructive button with no accessible name is invisible to it.\n` +
        `           Guardrail: ${config.guardrails.dangerPattern}`,
    );
  }
  if (config.allowAnonymous && config.auth.strategy === 'none') {
    console.error('mischief: ANONYMOUS RUN — every route declaring requiresAuth will be SKIPPED, not tested.');
  }
  if (config.allowProd) {
    console.error(`mischief: --allow-prod — ${config.baseUrl} is outside allowedHosts and is being monkeyed anyway.`);
  }
  // Derived by resolveConfig. Printed before the browser opens, so a route that
  // cannot prove it arrived is flagged while you still have the terminal open.
  for (const w of config.warnings || []) console.error(`mischief: WARNING — ${w}`);

  let result;
  try {
    result = await runMonkey(config);
  } catch (e) {
    die(`mischief: FATAL before the run loop — ${(e && e.stack) || e}`);
  }

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          seed: result.seed,
          exitCode: result.exitCode,
          verified: result.verified,
          unverifiedReason: result.unverifiedReason,
          summary: result.summary.tot,
          critCount: result.summary.critCount,
          highCount: result.summary.highCount,
          pages: result.pages,
          findings: result.findings,
          reportPaths: result.reportPaths,
        },
        null,
        2,
      ),
    );
  }

  const md = result.reportPaths.find((p) => p.endsWith('.md'));
  console.log(
    `mischief: done — ${result.summary.critCount} critical, ${result.summary.highCount} high` +
      `${result.verified ? '' : ' — NOT VERIFIED'} (exit ${result.exitCode})`,
  );
  if (md) console.log(`REPORT: ${md}`);
  process.exit(result.exitCode);
}

main().catch((e) => {
  console.error('mischief: fatal —', (e && e.stack) || e);
  process.exit(EXIT.UNVERIFIED);
});
