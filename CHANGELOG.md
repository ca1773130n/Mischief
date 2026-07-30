# Changelog

## 0.1.0 — unreleased

First extraction of a single-app monkey harness (HypePaper's `qa/monkey.mjs`,
1064 lines, two commits, 34 recorded runs) into a configurable package.

### Carried over unchanged

The parts that were never app-specific, moved rather than rewritten so the
lessons encoded in their comments survive:

- `mulberry32` seeding and the per-step `(seed, route, step)` derivation.
  Verified byte-identical to the original implementation.
- Viewport-clipped clickable-candidate enumeration, and the DOM-settle polling
  that keeps seeded runs from diverging on render timing.
- All ten mutators and their 30/15/10/rest weighting.
- Probes: a11y counts, broken images, horizontal overflow, LCP/CLS, leaked-markup
  text scan.
- Collectors: console with per-level cap and drop counting, `pageerror` with
  bounded screenshots and a 10-action tail, request timing, `requestfailed`
  tagged with whether the harness caused it, response-status bucketing.
- Guardrails: danger-label refusal with re-draw, popup auto-close, `window.open`
  no-op, off-origin watchdog, `[data-qa-ignore]` opt-out, emulation restore,
  own-tab-only cleanup.
- The markdown report's section structure, golden-filed against a real
  pre-extraction report.

### New

- **Fail-closed verification.** `auth.verify` (with a landed-path default),
  per-route `waitFor`, and a landed-URL comparison. A run that cannot prove it
  reached a route reports it as `unreached` and exits 3 — it can no longer emit
  a green report for pages it never saw. Routes declaring `requiresAuth` with no
  session configured are refused before a browser opens.
- **Exit code 3** for harness/verification failure, separated from exit 1. The
  original returned 1 for both, so CI could not distinguish a broken runner from
  a broken app.
- **`allowedHosts` allowlist** replacing a one-string production denylist, which
  protected nothing in a project that had not edited it.
- `ruckus.config.mjs`-style config with `defineConfig`, plus `defineMutator`,
  `defineProbe` and `defineReporter`.
- Auth strategies: `none`, `localStorage`, `storageState`, `cookies`, `custom`.
- `webapp-qa init` and `webapp-qa replay <runId>`.
- `presets` for danger patterns (en/ko/ja/zh), leaked-markup patterns, and
  framework console noise.
- Structured `findings[]` in `log.json` and behind `--json`, so a CI job does not
  have to parse markdown.
- `browser.mode: 'launch'` is the default. Attaching to the user's real
  signed-in Chrome remains available and now prints a banner.

### Behaviour changes worth knowing

- Text-pattern hits now count toward the HIGH total (and therefore the exit
  code). The original rendered them under HIGH but excluded them from the count.
- `--routes` is a filter over the configured routes and preserves each route's
  `requiresAuth`/`waitFor`, rather than replacing the list with bare paths.
