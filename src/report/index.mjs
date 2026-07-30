import fs from 'node:fs';
import path from 'node:path';
import { buildMarkdown } from './markdown.mjs';

/**
 * Register a custom reporter.
 *
 *   defineReporter({ name: 'junit', write(result, { outDir, runId }) { … return filePath } })
 *
 * `result` is the same object runMonkey() returns, plus `statsList` and `state`.
 */
export function defineReporter(spec) {
  if (!spec || typeof spec.name !== 'string') throw new Error('defineReporter needs a name');
  if (typeof spec.write !== 'function') throw new Error(`reporter "${spec.name}" needs write()`);
  return spec;
}

export const markdownReporter = defineReporter({
  name: 'markdown',
  write(result, { outDir, runId }) {
    const p = path.join(outDir, `${runId}.md`);
    fs.writeFileSync(p, buildMarkdown(result));
    return p;
  },
});

/**
 * The raw log is what makes a finding reproducible: config (including the seed),
 * the full action log, and every collected stat. `webapp-qa replay <runId>`
 * reads exactly this file.
 */
export const jsonReporter = defineReporter({
  name: 'json',
  write(result, { outDir, runId }) {
    const p = path.join(outDir, runId, 'log.json');
    const { config, state, statsList, durationMs, summary, fatal } = result;
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          runId,
          config: serializableConfig(config, result.routes),
          durationMs,
          verified: state.verified !== false,
          unverifiedReason: state.unverifiedReason || null,
          authed: !!state.authed,
          verification: state.verification || null,
          summary: { ...summary.tot, critCount: summary.critCount, highCount: summary.highCount },
          findings: summary.findings,
          actionLog: state.actionLog,
          skippedDanger: state.skippedDanger,
          gates: state.gates,
          pages: statsList.map((ps) => ({ ...ps, brokenImages: [...ps.brokenImages] })),
          fatal: fatal ? String((fatal && fatal.stack) || fatal) : null,
        },
        null,
        2,
      ),
    );
    return p;
  },
});

/**
 * Functions and RegExps do not survive JSON.stringify, and a config full of
 * `null` where the interesting parts were is worse than useless in a log. Emit
 * only what replay actually needs, with regexes as their source text.
 */
function serializableConfig(config, routes) {
  return {
    baseUrl: config.baseUrl,
    seed: config.seed,
    steps: config.steps,
    routes: routes.map((r) => ({ path: r.path, requiresAuth: r.requiresAuth, waitFor: r.waitFor, steps: r.steps })),
    mutators: config.mutators.enabled,
    browser: { mode: config.browser.mode, cdpUrl: config.browser.cdpUrl, headless: config.browser.headless },
    auth: { strategy: config.auth.strategy, key: config.auth.key, from: config.auth.from },
    guardrails: { dangerPattern: String(config.guardrails.dangerPattern), ignoreAttribute: config.guardrails.ignoreAttribute },
    thresholds: config.thresholds,
    allowProd: config.allowProd,
    allowAnonymous: config.allowAnonymous,
  };
}

export const builtinReporters = { markdown: markdownReporter, json: jsonReporter };

export function resolveReporters(config) {
  const out = [];
  for (const name of config.report.formats || []) {
    const r = builtinReporters[name];
    if (!r) throw new Error(`Unknown report format "${name}". Valid: ${Object.keys(builtinReporters).join(', ')}`);
    out.push(r);
  }
  for (const r of config.report.reporters || []) out.push(r);
  return out;
}

export { buildMarkdown };
