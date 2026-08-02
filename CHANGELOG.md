# Changelog

## 0.1.3

Two fixes found by pointing mischief at a code-split Vue SPA. Both are cases
where the harness reported its own behaviour as the app's fault.

- **An exception thrown while the harness held the connection offline is no
  longer `critical`.** A lazy-loaded route cannot fetch its chunk with the
  network cut, so a code-split app throws on every `offlineMode` window — and
  every one of those was landing in `critCount` and failing the run. They are now
  `low`, labelled, counted separately, and shown in the totals line rather than
  dropped. `critical` goes back to meaning "the app is broken". The `duringOffline`
  flag had been recorded since the first commit and simply never read.
- **`network.consoleIgnore` entries are validated at load.** A plain string
  reached `re.test(text)` inside a page event handler and threw from there —
  uncaught, so the run died on whatever route it hit first, wrote no report, and
  exited 1, which is indistinguishable from real HIGH findings. The mistake is
  natural because `presets.consoleIgnore` is keyed by framework name, so
  `['vue', 'vite']` looks exactly right. A non-array value (the array simply
  forgotten) is caught too, rather than throwing a raw `TypeError` past the
  `ConfigError` handler.

Both are reported in the rendered report, not only in `summarize()` — a demoted
exception under a `CRITICAL (0)` heading was the first version of this fix.

## 0.1.2

A 429 is no longer reported as a bug in your app.

- `defaultClassifyResponse` fell through to `'high'` for 429, so a backend
  slower than the monkey's 150-400ms step pace answered with `http-4xx`
  findings and exit 1 — the harness filing load it had generated itself as the
  application's defect, on a run whose coverage the throttling had already
  degraded.
- 429 now classifies as `throttled`: its own MEDIUM finding, never `http-4xx`,
  never a reason to fail a run, and called out in the report header because a
  throttled run's timing numbers were measured against a throttled server.
- Each 429 widens the step pause — `Retry-After` seconds when the server sends
  one, otherwise doubling from `timing.rateLimitBackoffMs` (2s) up to
  `timing.rateLimitMaxPauseMs` (30s). Sticky for the rest of the run, so the
  harness does not re-discover the limit on every route.
- `network.classifyResponse` may now return `'throttled'`. Existing classifiers
  are unaffected; they simply never return it.

## 0.1.1

Release-automation only; the package itself is unchanged from 0.1.0.

- Publishing moves to npm trusted publishing (GitHub OIDC). No token or other
  long-lived credential exists in the repository, and released versions carry a
  provenance attestation.
- `.github/workflows/publish.yml` runs the full suite, including the
  real-Chromium browser suites, and refuses to publish a tarball containing
  origin-app residue.

## 0.1.0

Extracted from a single-app monkey harness into a configurable package. Nothing
app-specific survives outside `examples/`, and a test sweeps every shipped file to
keep it that way.

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

- **Fail-closed verification.** `auth.verify` — whose default is two ANDed
  signals, a landed-path comparison and an inline sign-in check (see *False greens*
  below) — plus per-route `waitFor` and a landed-URL comparison. A run that cannot
  prove it reached a route reports it as `unreached` and exits 3; it can no longer
  emit a green report for pages it never saw. Routes declaring `requiresAuth` with
  no session configured are refused before a browser opens.
- **Exit code 3** for harness/verification failure, separated from exit 1. The
  original returned 1 for both, so CI could not distinguish a broken runner from
  a broken app.
- **`allowedHosts` allowlist** replacing a one-string production denylist, which
  protected nothing in a project that had not edited it.
- A `vite.config.mjs`-style config file with `defineConfig`, which validates keys
  **two levels deep**, plus `defineMutator`, `defineProbe` and `defineReporter`.
- Auth strategies: `none`, `localStorage`, `storageState`, `cookies`, `custom`.
- `mischief init` and `mischief replay <runId>`.
- `presets` for danger patterns (en/ko/ja/zh), leaked-markup patterns, and
  framework console noise.
- Structured `findings[]` in `log.json` and behind `--json`, so a CI job does not
  have to parse markdown.
- `browser.mode: 'launch'` is the default. Attaching to the user's real
  signed-in Chrome remains available and now prints a banner.

### False greens found and closed before release

Six defects, each of which produced a clean report from a run that had proved
nothing. All six were reproduced before being fixed.

- **Shadow DOM was invisible, so a component app scored zero coverage in
  silence.** `document.querySelectorAll` and `TreeWalker` do not pierce shadow
  roots, so on any app built out of custom elements (Lit, Stencil, Ionic, Vaadin,
  LWC) every in-page probe read zero — no click candidates, no text scanned, no
  a11y counts, no broken images — and the run exited 0 CLEAN with nothing in the
  report saying it had found nothing to look at. All four probes now walk open
  shadow roots, nested to any depth, including slotted light content. Traversal is
  *element → its shadow tree → its slotted light children*, which on a page with
  no shadow roots is exactly document order, so **existing seeds still replay**.
  Closed roots remain unreachable from page script; they are now counted and named
  instead of missed, with `guardrails.forceOpenShadowRoots` as an opt-in escape
  hatch (off by default — patching `attachShadow` means the app under test is no
  longer the app that ships). Iframes are still out of scope.
  - `guardrails.ignoreAttribute` and `probes.textSkipSelector` now prune *through*
    a shadow host. `el.closest()` stops at a `ShadowRoot`, so `data-qa-ignore` on a
    custom element protected nothing inside it — and since Playwright's CSS engine
    *does* pierce, `invalidInput` and `uploadRandomFile` were already typing into
    those inputs. That was a safety hole, not a coverage one.
  - The a11y probe's `label[for]` lookup is now scoped with `getRootNode()`. ids
    are per shadow root, so `document.querySelector` would have matched an
    unrelated label in the outer document.
  - A per-route clickable-candidate census is recorded on entry and shown in the
    summary table. Zero candidates on a route is a finding; zero on *every* route
    that ran is exit 3, with the shadow census in the message so the report names
    the remedy. `guardrails.requireClickable: false` opts out.
- **`timing.gotoWaitUntil` now defaults to `'domcontentloaded'`.** No app with a
  persistent connection ever reaches `networkidle` — HMR websocket, SSE, realtime
  client, analytics heartbeat, long-polling — so every route burned the full
  30 s `gotoTimeoutMs` and recorded a `goto` finding. That was the default outcome
  against a dev server, which is the default `baseUrl`.
- **A run that exercised nothing is no longer a pass.** With every route
  `requiresAuth` and `--allow-anonymous`, all routes were skipped: 0 steps tested,
  0 findings, **exit 0**. A run is verified only if at least one route was neither
  skipped nor unreached and had at least one step complete without throwing —
  which also closes `route.steps: 0` (now rejected at load) and a route where all
  40 steps threw. A *partly* skipped run still tested something and stays a real
  run. Skipped routes finally get a finding of their own, and resolver-dropped
  routes are rendered in *Coverage gaps* instead of vanishing.
- **The default `auth.verify` now catches inline gating.** A landed-path
  comparison only fires on a redirect, so an app that renders a login modal or a
  `<Login/>` at the *same* url passed verification while the monkey hammered the
  login form for 40 steps under the line "session verified". The default now also
  requires that no sign-in surface is visible. The discriminator is shape, not
  copy: exactly one visible password field, no `autocomplete=new-password` token —
  so a settings page's change-password form (current + new + confirm) does not fire
  it. A user-supplied `auth.verify` stays authoritative; the probe is demoted to a
  note on `how`. The probe fails **open**, so it can only ever cost a detection.
  `auth.detectLoginScreen: false` and `auth.loginSkipSelector` are the escapes.
  A `requiresAuth` route with no `waitFor` now warns (not errors — some apps have
  no stable selector, and refusing to run is not this package's job).
- **`mischief init` no longer scaffolds routes your app may not have.** The
  template shipped two invented product routes, so the first run after `init`
  manufactured a finding for a route that did not exist. Only `/` is live now; the
  richer forms are present, commented, and generically named. The same invented
  routes were still in the README's copy-pasteable quick start, which is where
  people actually copy from — gone, and the guard test now sweeps every shipped
  file rather than four of them.
- **Trailing-slash normalization is no longer reported as a redirect.** `/x` and
  `/x/` compared unequal, so any app with `trailingSlash` normalization (Next.js,
  most static hosts) had every route flagged as drift — noise in the one section
  built to catch real drift. A locale-prefix redirect (`/` → `/en`) still is
  reported, because it is real drift.

### False greens found in review of the above, and closed

Auditing the six fixes turned up more of the same class — several of them created
or widened by those fixes.

- **A `baseUrl` with nothing listening reported "2/2 routes exercised" and exited
  0.** `page.goto` rejects with `ERR_CONNECTION_REFUSED` into a routine `goto`
  note, so every step ran against `about:blank`; only one mutator in four throws
  there, so `steps > stepFailures` called both routes exercised. This is the
  likeliest false green of all — in CI, "the app failed to boot" is the common
  case. A route the browser never navigated to is now `unreached`: named, rendered
  under *Coverage gaps*, exit 3.
- **A run whose every step was a no-op is no longer a pass.** Mutators report
  "no candidate" / "no editable input" as success, so `--mutators invalidInput`
  against a page with no inputs ran 40 steps, recorded 0 failures, emitted no
  finding of any kind and exited 0 CLEAN. Steps are now counted as no-ops and
  `guardrails.requireEffectiveSteps` (default `true`) generalises the
  `requireClickable` rule past clicking.
- **A clickable census that threw on every route exited 0** while its own report
  said "candidate coverage is UNKNOWN": `atEnter` stays `null` on failure and
  `null !== 0`, so the `requireClickable` rule could not fire. Worse-known coverage
  was escaping a check that better-known coverage tripped. UNKNOWN coverage is now
  exit 3, and an in-page throw during a click is recorded as `probeFailed` rather
  than merely as "empty".
- **The census is now as patient as the clicks it describes.** It was a single
  unpolled shot while `chooseClickPoint` polls for two seconds, so a slow-hydrating
  app on a route with no click mutator could record `0` and — now that zero is exit
  3 — fail a healthy run. Both use `timing.settlePollAttempts`/`settlePollMs`.
- **The `domcontentloaded` default had quietly shortened every enter-phase probe's
  render window** from up to 30 s of JS execution to `settleMs`, so the text and
  a11y scans could be reading an unrendered skeleton. There is now a `load` wait
  before them (`timing.loadStateTimeoutMs`), and the text, a11y, broken-image and
  perf probes run at **both** phases and accumulate. Only the clickable census is
  enter-only, since "what did this route offer on arrival" is its definition.
- **Nested config keys are validated.** `defineConfig` checked top-level keys only,
  so every safety switch — all of which are nested — could be misspelled into a
  silent no-op. Two report messages tell the user to set a nested key as the
  documented escape from a false exit 3; `guardrails.forceOpenShadowRoot` produced
  a byte-identical report and no error. `timing.gotoWaitUntil` and
  `guardrails.maxCandidates` are now value-validated too.
- **A cross-origin API was invisible.** Every response off `baseOrigin` was dropped
  *before* classification, so the split frontend/API layout — the common dev
  layout, and the layout of this package's own example — reported zero 4xx/5xx
  however hard the API was failing, and `network.classifyResponse` (documented as
  the override) could not reach it. New `network.watchOrigins`; the classifier now
  sees everything with a `watched` flag; the watched set is printed in the report
  header, so "no 5xx" is distinguishable from "never looked".
- **Truncation is reported for all four in-page walks**, not just the clickable
  one, and the text probe's hit cap is `probes.maxTextHits` with a finding of its
  own. `report.slowRequestCap` and `.requestFailureCap` now count what they drop,
  the way `consoleCap` always did.
- **`verifyAuth` no longer claims a check it did not run.** `sniffLogin` returned
  `null` both for "looked, found nothing" and for "could not look", and the caller
  rendered both as *"no sign-in field visible"*. It is three-state now, and it also
  reports when shadow roots were not pierced.
- **Pre-flight failures return exit 3 instead of throwing**, and no longer create
  the run directory first. A bad `steps`, mutator name or report format used to
  escape `runMonkey`'s documented no-throw contract, print a stack trace, and leave
  an empty `reports/<runId>/shots` behind. Route, mutator and reporter validation
  all throw `ConfigError` now, so the CLI prints them cleanly.

### Safety

- **`guardrails.dangerPattern` defaults to `presets.danger.all`** (en + ko + ja +
  zh) instead of `presets.danger.en`. English-only meant a Korean, Japanese or
  Chinese app got **zero** destructive-click protection out of the box, and the
  only hint was a Recipes section in the README. Widening a refusal list costs a
  click; narrowing it costs the user's data. `danger.en` also now matches "Log out"
  — the space made one of the two commonest destructive labels in English invisible
  to it.
- **The danger guardrail covers the keyboard.** It lived only in
  `chooseClickPoint`, while `keyboardSpam`'s key pool contains `Enter` and `Space`
  and `invalidInput` presses `Enter` — so `Tab` then `Enter` reached a focused
  "Delete account", in attach mode, against the user's real profile, under a banner
  advertising the guardrail. A focused destructive control and a form whose submit
  is destructive are both refused and recorded. `input.activationKeys` is the key.
- **`data-qa-ignore` on a shadow host protects its shadow tree**, and the mutators'
  `el.closest()` checks were replaced with a boundary-hopping walk (Playwright's
  CSS engine pierces, so `invalidInput` had always been typing into those inputs).

### Behaviour changes worth knowing

- Text-pattern hits now count toward the HIGH total (and therefore the exit
  code). The original rendered them under HIGH but excluded them from the count.
- `--routes` is a filter over the configured routes and preserves each route's
  `requiresAuth`/`waitFor`, rather than replacing the list with bare paths.
- The Summary table gained a trailing `clickable` column and the report gained a
  trailing `## Notes` section. Headings and columns are only ever appended, so
  reports from different versions stay diffable.
- `gatherCandidatesInPage` returns `{ candidates, selector, scanned, truncated,
  capped, shadow }` instead of a bare array; `textPatternsInPage` returns
  `{ hits, truncated, capped }` and `brokenImagesInPage` returns
  `{ images, truncated }`. None is public API, but a custom reporter reading
  `pages[].clickable` out of `log.json` will now find the census — and so will
  `--json`, whose `pages[]` projection previously omitted it.
- Per-route `steps` must be a positive integer. `steps: 0` used to run a route
  that tested nothing.
- `auth.loginIgnoreSelector` is now `auth.loginSkipSelector`, so the two
  "exclude this subtree" selectors share one verb with each other
  (`probes.textSkipSelector`). `guardrails.ignoreAttribute` keeps its verb: it is
  an attribute, not a selector.
- `judgeLoginSignals`, `routeWasTested` and `unverifiedCoverageReason` are no longer
  exported. The first is uncallable through the public API (its input comes from an
  in-page probe the exports map blocks); the other two would freeze the internal
  per-route stats shape, and an English prose sentence, into the compatibility
  surface. `summarize`, `exitCodeFor`, `unverifiedReasons` and `EXIT` remain.
- ~20 behaviour constants that were literals in the mutators and guardrails are now
  config keys under `mutators.options`, `timing.*`, `input.*` and `report.*`, per the
  rule stated at the top of `src/defaults.mjs`. Four navigations that hardcoded
  `waitUntil: 'domcontentloaded'` now honour `timing.gotoWaitUntil`.
- `slugOf` keeps Unicode letters and digits, and screenshot names are made
  injective across the resolved route list. Every non-Latin path used to collapse to
  the slug `route`, so two such routes overwrote each other's screenshot and both
  report rows pointed at the wrong page.
