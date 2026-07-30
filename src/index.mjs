// Public API.

export { runMonkey } from './run.mjs';
export { defineConfig, resolveConfig, ConfigError } from './config.mjs';
export { defineMutator, builtinMutators, resolveMutators } from './mutators/index.mjs';
export { defineProbe } from './probes/index.mjs';
export { defineReporter, builtinReporters, buildMarkdown } from './report/index.mjs';
export { authStrategies, applyAuth, verifyAuth, AuthError } from './auth/index.mjs';
export { defaultClassifyResponse } from './collect.mjs';
export { mulberry32, deriveStepRng, pickFrom, pickWeighted } from './rng.mjs';
// Deliberately NOT exported, though they are the natural neighbours of these
// three: judgeLoginSignals (its only input is produced by an in-page probe that
// the exports map blocks, so a consumer cannot call it at all), routeWasTested and
// unverifiedCoverageReason (both freeze the internal per-route stats shape, and an
// English prose sentence, into the 0.1.0 compatibility surface — and
// unverifiedReasons already composes the latter). Adding an export later is cheap;
// removing one is a breaking change.
export { summarize, exitCodeFor, unverifiedReasons, EXIT } from './severity.mjs';
export { DEFAULT_CONFIG } from './defaults.mjs';
export * as presets from './presets.mjs';
