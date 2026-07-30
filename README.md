# webapp-qa-kit

A monkey that clicks your app at random, in a real browser, and writes down what
broke. Two things make it different from the other monkeys: **every run is
driven by one integer seed**, so any finding replays exactly; and **a run that
cannot prove it reached the pages it asked for fails instead of passing**.

That second one is the whole reason this exists. Its predecessor spent months
reporting clean passes while an expired session bounced it to the landing page
ten times in a row. A green report from a harness that never saw the feature is
worse than no report at all.

```
npx webapp-qa-kit init      # scaffold webapp-qa.config.mjs
# edit baseUrl + routes
npx webapp-qa               # go
```

---

## Quick start

`webapp-qa init` writes a config and adds `reports/` to `.gitignore`. Point
`baseUrl` at your dev server, list your routes, and run.

```js
// webapp-qa.config.mjs
import { defineConfig, presets } from 'webapp-qa-kit';

export default defineConfig({
  baseUrl: 'http://localhost:3000',
  allowedHosts: ['localhost', '127.0.0.1'],
  browser: { mode: 'launch', channel: 'chrome' },
  routes: [
    '/',
    '/pricing',
    { path: '/dashboard', requiresAuth: true, waitFor: '[data-testid=dashboard]' },
  ],
  steps: 40,
});
```

The output is a markdown report per run, sectioned by severity:

```markdown
# QA monkey report — 20260727-074043

- base: https://example.app
- seed: **1** (repro: `webapp-qa --seed 1`)
- pages: /pricing
- session: **ANONYMOUS** — 1 of 3 routes declare requiresAuth. …
- totals: 6 steps · 0 JS exceptions · 2 5xx · 0 4xx · 0 console errors …

## Summary

| page | steps | JS exc | net 4xx/5xx | console err | CLS | LCP | a11y flags | broken imgs | overflow? |
|---|---|---|---|---|---|---|---|---|---|
| /pricing | 6 | 0 | 0/2 | 0 | 0.000 | 1.4s | 1 | 0 | no |

### CRITICAL (2)

- **5xx** GET https://example.app/ → 503 ×1 on /pricing (after: randomClick a "Home")
```

Alongside it, `reports/<runId>/log.json` holds the full action log, every
finding as structured data, and the config needed to replay.

---

## Why seeded

All randomness comes from one 32-bit `mulberry32` stream. `--seed 4242` twice in
a row walks the same path, clicks the same elements, types the same junk.

There is a subtlety worth knowing about. Each **step** runs on its own PRNG
derived from `(seed, routeIndex, stepNumber)`, not on the master stream. A
mutator's number of random draws depends on the live DOM — an empty candidate
list means zero draws, a refused destructive click means two. If mutators drew
from the shared stream, one extra draw on step 3 would shift every later mutator
choice and "same seed" would stop meaning anything. Isolating each step makes
the master stream immune to whatever the page did.

```bash
webapp-qa replay 20260727-074043      # same seed, routes and steps as that run
```

---

## Why it fails closed

A monkey harness once ran nightly against an app where 7 of its 10 routes were
behind a router guard. With no session, the guard bounced every one of them to
the marketing page. The harness dutifully clicked around that marketing page ten
times and reported: no exceptions, no 5xx, clean pass. It had never once loaded
the feature it was supposed to be testing — which is how raw LaTeX in a
comparison table survived every automated run and was eventually found by a user.

Three mechanisms, all app-independent, make that outcome impossible here:

**1. `auth.verify` — and it runs before any claims are made.** After the first
`requiresAuth` route loads, the session is checked. Failure aborts the run with
exit code 3 and a report titled **NOT VERIFIED**, never a green one. Supply your
own predicate, or rely on the default: *did the browser stay on the path we
asked for?* A router bounce changes the path, so no app-specific selector is
needed.

**2. `waitFor` per route.** A selector only that page renders. If it never
appears, the route is recorded as **unreached** and excluded from the pass
claim, rather than being monkeyed as whatever it redirected to. (The check
re-queries the current document after waiting, because a client-side guard can
replace the page a tick after its markup matched.)

**3. Landed-URL comparison.** If the path after settling differs from the path
requested, the report says so — in the summary table and in a Coverage gaps
section. This is what catches a route list that has quietly drifted into
redirects, which happens to every route list eventually.

If any route was never reached, the run is **not verified**, whatever else it
found.

---

## Configuration

| key | default | what it does |
|---|---|---|
| `baseUrl` | `http://localhost:3000` | origin under test |
| `allowedHosts` | `['localhost','127.0.0.1','[::1]','0.0.0.0']` | fail-closed allowlist; anything else needs `--allow-prod` |
| `browser.mode` | `'launch'` | `'launch'` throwaway browser, `'attach'` your running Chrome |
| `browser.cdpUrl` | `http://127.0.0.1:9222` | attach endpoint |
| `browser.channel` | – | `'chrome'`/`'msedge'`; playwright-core ships no browsers |
| `browser.headless` | `true` | launch mode only |
| `auth.strategy` | `'none'` | `none` · `localStorage` · `storageState` · `cookies` · `custom` |
| `auth.key` | – | localStorage key your app reads |
| `auth.from` | – | path to the session file — **never commit it** |
| `auth.verify` | – | `async (page) => boolean`; defaults to the landed-path check |
| `routes` | `['/']` | strings or `{ path, requiresAuth, waitFor, steps, mutators, skip, resolve }` |
| `steps` | `40` | steps per route |
| `seed` | random | set it, or read it off the report to replay |
| `mutators.enabled` | all | subset by name |
| `mutators.weights` | see below | per-name override |
| `guardrails.dangerPattern` | `presets.danger.en` | labels that are never clicked |
| `guardrails.ignoreAttribute` | `data-qa-ignore` | subtree opt-out |
| `guardrails.stayOnOrigin` | `true` | off-origin watchdog |
| `probes.a11y` / `.brokenImages` / `.overflow` / `.perf` | `true` | built-in probes |
| `probes.textPatterns` | `[]` | leaked-markup patterns; see presets |
| `network.consoleIgnore` | `[]` | regexes for known framework noise |
| `network.slowRequestMs` | `10000` | slow-request threshold |
| `network.classifyResponse` | – | `({status,url,method}) => 'critical'\|'high'\|'gate'\|'ignore'` |
| `viewports.mobile` / `.desktop` | 390×844 / 1440×900 | what `mobileResize` toggles between |
| `report.outDir` | `./reports` | where runs land |
| `report.formats` | `['markdown','json']` | built-in reporters |
| `thresholds.cls` / `.lcpMs` | `0.1` / `4000` | perf finding thresholds |

CLI flags override the file; the file overrides the defaults.

```
webapp-qa [--config f] [--base u] [--routes csv] [--steps n] [--seed n]
          [--mutators csv] [--auth f] [--out d] [--attach] [--cdp url] [--headed]
          [--allow-prod] [--allow-anonymous] [--json]
webapp-qa init
webapp-qa replay <runId>
```

`--routes` is a **filter**, not a redefinition: a named path that exists in your
config keeps its `requiresAuth` and `waitFor`.

---

## Auth strategies

| strategy | how | works in attach mode |
|---|---|---|
| `none` | anonymous | yes |
| `localStorage` | `addInitScript` writes `auth.key` on every document | yes |
| `cookies` | `context.addCookies()` from a JSON array | yes |
| `storageState` | Playwright storage state at context creation | **no** — the context already exists |
| `custom` | your `auth.apply({ context, config })` | yes |

`localStorage` covers Supabase-style clients that use a custom `storageKey`, and
anything else that keeps its session in web storage rather than a cookie.

Capturing a session: open a signed-in tab, copy the value out of devtools, save
it to a gitignored path, point `auth.from` at it. **Never commit that file.** It
is a live credential; treat it exactly like one. Nothing in this package writes
the session into a report or a log.

---

## Mutators

| name | what it does |
|---|---|
| `randomClick` | clicks a random in-viewport candidate |
| `randomBack` | history back, sometimes forward |
| `invalidInput` | fills an input with empty / 3000 chars / emoji+CJK / injection-ish / huge numbers |
| `rapidDoubleClick` | two clicks 50 ms apart — the double-submit finder |
| `refresh` | reloads mid-interaction |
| `mobileResize` | toggles 390×844 ↔ 1440×900 and checks horizontal overflow |
| `offlineMode` | goes offline for 2.5 s and clicks once |
| `slowNetwork` | Slow-3G for the next 3 steps |
| `uploadRandomFile` | feeds a random blob to a visible file input |
| `keyboardSpam` | 15 unmodified keys (never Meta/Ctrl/Alt) |

Default weights: `randomClick` 30, `invalidInput` 15, `keyboardSpam` 10, and
every other enabled mutator splits the remaining 45. Clicking is what finds bugs;
the rest are stressors that need far fewer repetitions to earn their runtime.

```js
import { defineMutator } from 'webapp-qa-kit';

defineMutator({
  name: 'openCommandPalette',
  weight: 5,
  async run(ctx) {                       // ctx = { page, cdp, rng, log, state, baseOrigin, config }
    await ctx.page.keyboard.press('Control+k');
    ctx.log('openCommandPalette', '-', '');
  },
});
```

Draw every random decision from `ctx.rng`. `Math.random()` breaks replay.

---

## Probes

- **a11y** — images without `alt`, buttons/links with no accessible name, inputs
  with no label. Three unambiguous checks, no ruleset. They also correlate with
  the monkey's own blind spot: an unlabeled button is invisible to the danger
  guardrail too.
- **brokenImages** — `complete && naturalWidth === 0`, i.e. 404s.
- **overflow** — `scrollWidth > clientWidth` at each viewport.
- **perf** — LCP and CLS via `PerformanceObserver`, plus DCL and load.
- **textPatterns** — markup that leaked into rendered text. Off by default,
  because "is `\frac` a defect" has no app-independent answer.
  `presets.textPatterns` ships `latexMath`, `latexCmd` and `i18nKey`.

```js
import { defineProbe } from 'webapp-qa-kit';

defineProbe({
  name: 'no-lorem',
  phase: 'enter',                        // 'enter' | 'exit' | 'both'
  severity: 'medium',
  evaluate: () => document.body.innerText.includes('Lorem ipsum'),
});
```

`evaluate` is serialized into the page — it cannot close over your config. Pass
JSON-serializable data via `arg`.

---

## Guardrails and safety

- **Danger pattern.** Controls whose visible label matches are never clicked;
  they are logged under *Skipped danger* instead. `presets.danger` ships `en`,
  `ko`, `ja`, `zh` — combine with `presets.combinePatterns()`.
- **This has a known hole.** The pattern matches on `innerText` + `aria-label` +
  `title`. **An icon-only delete button with no accessible name is invisible to
  it.** Put `data-qa-ignore` on destructive controls; do not rely on the regex
  alone. (The a11y probe counts exactly these elements, so the report tells you
  how big your blind spot is.)
- **`allowedHosts` is an allowlist, not a denylist.** A denylist of production
  hostnames protects nothing in a fresh project, because you have to remember to
  add your own domain first. Everything unlisted is refused until `--allow-prod`.
- **Own tab only.** One fresh tab; popups auto-close; `window.open` is a no-op;
  an off-origin navigation is walked back. Network and device-metric overrides
  are cleared on exit, including on SIGINT/SIGTERM.
- **`mode: 'attach'` drives your real browser.** It connects to a Chrome you
  started with `--remote-debugging-port=9222` and uses its default context — your
  actual profile, your actual session. That is the mode's entire value (no OAuth
  dance, real data) and its entire risk (a mis-guarded click happens to your real
  account). It prints a banner every time. Over CDP, `browser.close()` only
  disconnects; your Chrome is never quit.

---

## Reports and exit codes

`reports/<runId>.md` plus `reports/<runId>/` with `log.json` and screenshots
(one per route, plus up to 25 at the moment of each JS exception, each carrying
the last 10 actions that led there).

| code | meaning |
|---|---|
| `0` | clean |
| `1` | HIGH findings |
| `2` | any CRITICAL |
| `3` | the harness failed, or could not verify what it tested |

3 is deliberately distinct from 1: a CI job must be able to tell a broken runner
from a broken app.

```yaml
- run: npx webapp-qa --allow-anonymous --steps 20
# exit 3 => fix the harness. 1 or 2 => fix the app.
```

---

## Recipes

```bash
webapp-qa --steps 10 --routes /,/pricing          # CI smoke, public routes only
webapp-qa --steps 200 --seed $RANDOM              # nightly deep run
webapp-qa --routes /checkout --steps 60 --headed  # single-route triage, watch it
webapp-qa replay 20260727-074043                  # reproduce yesterday's finding
webapp-qa --mutators randomClick,refresh          # narrow the search
```

For CJK apps, set a bilingual danger pattern — CSS will break Korean and Japanese
between any two syllables, so the `mobileResize` overflow probe earns its keep:

```js
guardrails: { dangerPattern: presets.combinePatterns(presets.danger.en, presets.danger.ko) }
```

---

## Non-goals

- **Not a replacement for Playwright test.** Scripted assertions about known
  behaviour are a different job, and a better one where you can afford it. This
  is for the space between the tests you wrote.
- **No visual baseline in v0.1.** Screenshot diffing needs a baseline store,
  tolerance tuning, and masking of dynamic regions; done badly it produces noise
  that trains you to ignore the report. Deferred rather than half-built.
- **Not a load tester.** One tab, one user, deliberately slow.
- **No route discovery.** The route list is explicit. Deriving it from a router
  file means AST-parsing TypeScript with dynamic `import()` factories; until
  that exists, the landed-URL check is what catches drift.

## Prior art

**gremlins.js** runs in the page, which is lighter to set up but cannot see
network status, cannot throttle, and has no report. **Playwright test** is the
right tool for deterministic assertions about behaviour you can already name.
This sits between them: seeded chaos, real CDP control, and a report you can
hand to someone.

## License

MIT.
