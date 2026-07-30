# Mischief

A monkey that clicks your app at random, in a real browser, and writes down what
broke. Two things make it different from the other monkeys: **every run is
driven by one integer seed**, so any finding replays exactly; and **a run that
cannot prove it reached the pages it asked for fails instead of passing**.

That second one is the whole reason this exists. Its predecessor spent months
reporting clean passes while an expired session bounced it to the landing page
ten times in a row. A green report from a harness that never saw the feature is
worse than no report at all.

```
npm i -D mischief      # `npx mischief` resolves a PACKAGE name, not the bin
npx mischief init      # scaffold mischief.config.mjs
# edit baseUrl + routes
npx mischief               # go
```

---

## Quick start

`mischief init` writes a config and adds `reports/` to `.gitignore`. Point
`baseUrl` at your dev server, list your routes, and run. What `init` scaffolds
has exactly one live route — `'/'`, the only path every app has — because a route
asserted here that your app does not serve manufactures a finding on the first
run:

```js
// mischief.config.mjs
import { defineConfig, presets } from 'mischief';

export default defineConfig({
  baseUrl: 'http://localhost:3000',
  routes: [
    '/',
    // { path: '/some/public/page' },
    // { path: '/some/gated/page', requiresAuth: true, waitFor: '[data-testid=your-marker]' },
  ],
  steps: 40,
});
```

The output is a markdown report per run, sectioned by severity:

```markdown
# QA monkey report — 20260727-074043

- base: https://example.app
- seed: **1** (repro: `mischief --seed 1`)
- pages: /some/public/page
- session: **ANONYMOUS** — 1 of 3 routes declare requiresAuth. …
- totals: 6 steps · 0 JS exceptions · 2 5xx · 0 4xx · 0 console errors …

## Summary

| page | steps | JS exc | net 4xx/5xx | console err | CLS | LCP | a11y flags | broken imgs | overflow? | clickable |
|---|---|---|---|---|---|---|---|---|---|---|
| /some/public/page | 6 | 0 | 0/2 | 0 | 0.000 | 1.4s | 1 | 0 | no | 34 |

### CRITICAL (2)

- **5xx** GET https://example.app/api/x → 503 ×1 (after: randomClick a "Home")
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
mischief replay 20260727-074043      # same seed, routes and steps as that run
```

---

## Why it fails closed

A monkey harness once ran nightly against an app where 7 of its 10 routes were
behind a router guard. With no session, the guard bounced every one of them to
the marketing page. The harness dutifully clicked around that marketing page ten
times and reported: no exceptions, no 5xx, clean pass. It had never once loaded
the feature it was supposed to be testing — which is how raw LaTeX in a
comparison table survived every automated run and was eventually found by a user.

Five mechanisms, all app-independent, make that outcome impossible here:

**1. `auth.verify` — and it runs before any claims are made.** After the first
`requiresAuth` route loads, the session is checked. Failure aborts the run with
exit code 3 and a report titled **NOT VERIFIED**, never a green one. Supply your
own predicate — it is authoritative — or rely on two default signals, both of
which must pass:

- *Did the browser stay on the path we asked for?* A router bounce changes the
  path, so no app-specific selector is needed. This catches **redirect** gating.
- *Is a sign-in surface still on screen?* A landed-path check is structurally
  blind to an app that renders a login modal or a `<Login/>` component at the
  **same url**, and that is a very common pattern — the monkey hammers the login
  form for 40 steps under the report line "session verified". The signal is a
  single visible password field, which is app- and locale-independent. Two or
  three fields, or an `autocomplete=new-password` token, means a change-password
  or sign-up form on a page you are already signed in to, so it does **not**
  fire. Nor does a lone password field with **nothing beside it** — no identifier
  field, no login-adjacent form `action` — because that is equally the shape of
  "re-enter your password to confirm", the sudo-mode prompt GitHub, Stripe and AWS
  all ship. That case is reported as a note and the run continues; aborting a
  healthy run is exactly as bad as the false green. If a gated route of yours does
  render a full sign-in form to a signed-in user, set
  `auth.detectLoginScreen: false` or `auth.loginSkipSelector`. The probe fails
  **open**: if it cannot run the report says *"sign-in check did not run"* rather
  than claiming it passed. Two blind spots it names rather than papers over: a
  **passwordless** sign-in screen (magic link, OAuth-only, passkey) has no
  credential input to find, and without the init script the fallback query does not
  pierce shadow roots — the report says so in both cases.

**2. `waitFor` per route.** A selector only that page renders. If it never
appears, the route is recorded as **unreached** and excluded from the pass
claim, rather than being monkeyed as whatever it redirected to. (The check
re-queries the current document after waiting, because a client-side guard can
replace the page a tick after its markup matched.) A `requiresAuth` route with
no `waitFor` prints a warning, because arrival is what `waitFor` proves — it is
a warning and not an error, since some apps have no stable selector to offer.

**3. Landed-URL comparison.** If the path after settling differs from the path
requested, the report says so — in the summary table and in a Coverage gaps
section. This is what catches a route list that has quietly drifted into
redirects, which happens to every route list eventually. One trailing slash is
tolerated: `trailingSlash` normalization is not drift, and flagging it on every
route buried the redirects that are. A locale prefix (`/` → `/en`) still counts.

**4. A run must have EXERCISED something.** At least one route has to be neither
skipped nor unreached, with at least one step that completed without throwing —
and that step has to have *done* something. Every route skipped (the normal outcome
of `--allow-anonymous` over a fully gated route list), every route running zero
steps, every step throwing, and every step a no-op (`--mutators invalidInput`
against a page with no inputs: 40 steps, 0 failures, 0 findings) all used to exit 0
with an empty findings list. They are exit 3 now, with a report that names which
routes and why. So is a route the browser **never navigated to** — a dead
`baseUrl`, the common CI case when the app failed to boot, used to report "2/2
routes exercised" after spending every step on `about:blank`. A **partly** skipped
run still tested something and is a real run — the skip is reported, and the exit
code comes from the findings. `guardrails.requireEffectiveSteps: false` opts out of
the no-op rule.

**5. There has to be something to click.** Each route's clickable-candidate count
is recorded on entry and shown in the summary table. If no route offered a single
candidate, the click mutators never clicked anything, so an empty findings list
says nothing about the app — that is exit 3 too, and the report names the likely
cause (see shadow DOM below). Set `guardrails.requireClickable: false` for a
genuinely static site. One click-free page among real routes is a per-route
finding, not a failed run.

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
| `auth.verify` | – | `async (page) => boolean`; authoritative. Without it, the two default signals below |
| `browser.channel` / `.executablePath` | – | name or path a launch uses |
| `browser.ignoreHTTPSErrors` | `true` | dev servers are routinely self-signed |
| `browser.defaultTimeoutMs` | `10000` | Playwright default per-action timeout |
| `browser.launchArgs` | `[]` | extra Chromium flags |
| `auth.detectLoginScreen` | `true` | also fail verification when a sign-in field is visible at the same url |
| `auth.loginSkipSelector` | `''` | subtree whose credential fields are not a sign-in screen |
| `routes` | `['/']` | strings or `{ path, requiresAuth, waitFor, steps, mutators, skip, resolve }` |
| `steps` | `40` | steps per route |
| `seed` | random | set it, or read it off the report to replay |
| `mutators.enabled` | all | subset by name |
| `mutators.weights` | see below | per-name override |
| `mutators.custom` | `[]` | `[defineMutator({…})]` — the helper returns a spec, it does not self-register |
| `mutators.options` | see below | per-mutator behaviour constants |
| `guardrails.dangerPattern` | `presets.danger.all` | labels never clicked **and never activated by Enter/Space** |
| `guardrails.ignoreAttribute` | `data-qa-ignore` | subtree opt-out; prunes through a shadow host |
| `guardrails.stayOnOrigin` | `true` | off-origin watchdog |
| `guardrails.closePopups` / `.blockWindowOpen` | `true` | never accumulate tabs |
| `guardrails.clickableSelector` | `a, button, [role="button"], input[type="submit"], select, [tabindex]` | what counts as clickable |
| `guardrails.maxCandidates` | `400` | cap on candidates offered per step |
| `guardrails.maxScanNodes` | `20000` | bound on **all four** in-page walks; exhausting it is reported, never silent |
| `guardrails.requireClickable` | `true` | a run where no route offered a click is not verified |
| `guardrails.requireEffectiveSteps` | `true` | a run where every step was a no-op is not verified |
| `guardrails.forceOpenShadowRoots` | `false` | patch `attachShadow` to open closed roots — see below |
| `probes.a11y` / `.brokenImages` / `.overflow` / `.perf` | `true` | built-in probes |
| `probes.textPatterns` | `[]` | leaked-markup patterns; see presets |
| `probes.textSkipSelector` | `''` | subtree the text scan ignores; prunes through a shadow host |
| `probes.maxTextHits` | `25` | per-route hit cap; exhausting it is reported |
| `probes.custom` | `[]` | `[defineProbe({…})]` |
| `timing.gotoWaitUntil` | `'domcontentloaded'` | **not** `networkidle` — see below; validated against Playwright's enum |
| `timing.gotoTimeoutMs` / `.settleMs` / `.waitForTimeoutMs` | `30000` / `1500` / `8000` | navigation budget |
| `timing.loadStateTimeoutMs` | `5000` | wait for `load` before the enter probes, so they do not scan a skeleton |
| `timing.settlePollAttempts` / `.settlePollMs` | `8` / `250` | candidate-settle poll, shared by the census and every click |
| `timing.historyTimeoutMs` / `.reloadTimeoutMs` | `8000` / `30000` | `randomBack` / `refresh` budgets |
| `timing.stepPauseMinMs` / `.stepPauseJitterMs` | `150` / `250` | pause between steps |
| `network.consoleIgnore` | `[]` | regexes for known framework noise; see `presets.consoleIgnore` |
| `network.slowRequestMs` | `10000` | slow-request threshold |
| `network.watchOrigins` | `[]` | extra origins to classify beside `baseUrl` — **set this if your API is on another port** |
| `network.loginAdjacent` | see source | URLs where a 401 is a gate, not a defect; matched against URLs, so localized paths need extending |
| `network.classifyResponse` | – | `({status,url,method,watched}) => 'critical'\|'high'\|'gate'\|'ignore'` |
| `network.slow3g` / `.normal` / `.offline` | CDP profiles | what `slowNetwork` / `offlineMode` emulate |
| `viewports.mobile` / `.desktop` | 390×844 / 1440×900 | what `mobileResize` toggles between |
| `input.invalidValues` | 6 values | what `invalidInput` types |
| `input.invalidValuesByType` | see source | per-type pools for number/date fields, which reject free text at the driver level |
| `input.keyPool` | plain keys | what `keyboardSpam` presses; never Meta/Ctrl/Alt |
| `input.activationKeys` | `['Enter','Space']` | keys checked against `dangerPattern` before being pressed |
| `report.outDir` | `./reports` | where runs land |
| `report.formats` | `['markdown','json']` | built-in reporters |
| `report.reporters` | `[]` | `[defineReporter({…})]` |
| `report.pageScreenshots` / `.screenshotQuality` | `true` / `50` | one JPEG per route |
| `report.maxErrorScreenshots` | `25` | bound disk usage on exception storms |
| `report.consoleCap` / `.slowRequestCap` / `.requestFailureCap` | `200` / `100` / `300` | per route; the rest is **counted**, not dropped |
| `thresholds.cls` / `.lcpMs` | `0.1` / `4000` | perf finding thresholds |
| `allowProd` / `allowAnonymous` / `quiet` | `false` | the three run-level switches, all also CLI flags |

`mutators.options` holds the per-mutator constants: `offlineMs` 2500, `slowSteps` 3,
`doubleClickGapMs` 50, `keyboardSpamKeys` 15, `keyPauseMinMs` 30,
`keyPauseJitterMs` 50, `enterProbability` 0.3, `resizeSettleMs` 400,
`backSettleMs` 500, `uploadExtensions` `['.txt','.png','.pdf','.zip']`,
`uploadMinBytes` 1024, `uploadJitterBytes` 50176.

Keys are validated **two levels deep**, so `guardrails.forceOpenShadowRoot`
(singular) is an error rather than a silently ignored no-op. CLI flags override
the file; the file overrides the defaults.

```
mischief [--config f] [--base u] [--routes csv] [--steps n] [--seed n]
         [--mutators csv] [--auth f] [--out d] [--attach] [--cdp url] [--headed]
         [--allow-prod] [--allow-anonymous] [--quiet] [--json]
mischief init
mischief replay <runId>
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

`defineMutator` returns a spec; it does **not** register anything. Put the result
in `mutators.custom`:

```js
import { defineConfig, defineMutator } from 'mischief';

export default defineConfig({
  mutators: {
    custom: [
      defineMutator({
        name: 'openCommandPalette',
        weight: 5,
        async run(ctx) {                 // ctx = { page, cdp, rng, log, state, baseOrigin, config }
          await ctx.page.keyboard.press('Control+k');
          ctx.log('openCommandPalette', '-', '');
        },
      }),
    ],
  },
});
```

Draw every random decision from `ctx.rng`. `Math.random()` breaks replay. If your
mutator can find nothing to act on, say so with
`ctx.log(name, '-', 'nothing to do', { noop: true })` — a run in which every step
on every route was a no-op is exit 3, and an unflagged no-op reads as coverage.

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

Only the clickable census is enter-only. Everything else runs at **both** phases
and accumulates, because a scan `settleMs` after a `domcontentloaded` goto can be
a scan of an unrendered skeleton.

Like `defineMutator`, `defineProbe` returns a spec — put it in `probes.custom`:

```js
import { defineConfig, defineProbe } from 'mischief';

export default defineConfig({
  probes: {
    custom: [
      defineProbe({
        name: 'no-lorem',
        phase: 'enter',                  // 'enter' | 'exit' | 'both'
        severity: 'medium',
        evaluate: () => document.body.innerText.includes('Lorem ipsum'),
      }),
    ],
  },
});
```

`evaluate` is serialized into the page — it cannot close over your config. Pass
JSON-serializable data via `arg`.

### Network findings and your API's origin

Responses are classified for `baseUrl`'s origin plus anything in
`network.watchOrigins`; everything else defaults to `'ignore'`, because a CDN's
500 is not your app's bug. **If your API runs on another port, add it** —
otherwise a 500ing API produces zero findings. The watched set is printed in the
report header, so "no 5xx" is distinguishable from "your API was never looked at".
`network.classifyResponse` sees every response, watched or not, with a `watched`
flag.

---

## Web components and the shadow DOM

`document.querySelectorAll` does not pierce shadow roots, and neither does a
`TreeWalker`. On an app built out of custom elements — Lit, Stencil, Ionic,
Vaadin, LWC, most design systems — that meant every in-page probe read **zero**:
no click candidates, no text scanned, no a11y counts, no broken images. The
monkey logged "no candidate" for all 40 steps and the run exited 0 clean.

**Covered.** Open shadow roots, nested to any depth, plus slotted light content,
in all four in-page probes. The danger guardrail pierces too, so a "Delete
account" button inside a component is refused and logged rather than being
invisible. `guardrails.ignoreAttribute` and `probes.textSkipSelector` now prune
*through* a host, which `el.closest()` never could — `data-qa-ignore` on a custom
element previously protected nothing inside its shadow root.

**Not covered, and the report says so:**

- **Closed shadow roots.** `el.shadowRoot` is `null` and nothing running in the
  page can reach them. They are counted instead of missed: a defined custom
  element with no open root and no light children is reported as a
  closed-root suspect, by tag name. `guardrails.forceOpenShadowRoots: true`
  patches `attachShadow` before any app code runs and opens them. It is off by
  default because `shadowRoot.mode` is observable and some libraries assert
  closed-ness — with it on, the app under test is no longer the app that ships.
- **Iframes.** `page.evaluate` is main-frame only. Per-frame scanning needs
  coordinate translation and is not implemented.

Traversal order is *element → its shadow tree → its slotted light children*,
children in DOM order. On a page with no shadow roots that is exactly document
order, so the candidate list is identical element-for-element to what
`querySelectorAll` returned and **seeds recorded before this existed still
replay**. Slot assignment is deliberately not resolved: `slot.assign()` is
imperative, so resolving it would make "the candidate at index N" depend on when
component code ran rather than on the DOM.

If a route's clickable count is `0`, the report names it under *Coverage gaps*
along with how many shadow roots were traversed and how many hosts exposed none —
which is the difference between "your selector is too narrow" and "these roots
are closed".

---

## Guardrails and safety

- **Danger pattern.** Controls whose visible label matches are never clicked, and
  never activated by `Enter`/`Space` either — a focused "Delete account" and a
  form whose submit button is destructive are both refused, because `Tab` then
  `Enter` reaches a delete button with no click anywhere in it. Refusals are logged
  under *Skipped danger*. The default is `presets.danger.all`, which is `en` + `ko`
  + `ja` + `zh` combined: an English-only default meant a Korean or Japanese app
  had **no** destructive-click protection at all. Narrow it to your own locale
  (`presets.danger.en`) if you want the coverage back.
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
- **`timing.gotoWaitUntil` is `domcontentloaded`, not `networkidle`.** An app with
  any persistent connection never reaches network idle: an HMR websocket, SSE, a
  realtime database client, an analytics heartbeat, long-polling. Under
  `networkidle` every route burned the full `gotoTimeoutMs` and recorded a finding
  about it — the default outcome against a dev server, which is the default
  `baseUrl`. Set it back if your app really does go quiet and you want that
  guarantee; a goto that caps out is recorded, not fatal.
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
from a broken app. You get 3 when the harness crashed, when the config could not be
resolved, when session verification failed, when any route was never reached
(including "the browser never left `about:blank`"), when **no** route was exercised
(all skipped, all zero-step, every step threw, or every step a no-op), when no
route offered anything to click, and when the clickable census itself threw on every
route — UNKNOWN coverage is what this code is for. Every one of those cases used to
be exit 0 with an empty findings list.

```yaml
- run: npx mischief --allow-anonymous --steps 20
# exit 3 => fix the harness. 1 or 2 => fix the app.
```

---

## Recipes

These assume `mischief` is installed in the project (see Quick start);
without it, use `npx mischief …`.

```bash
mischief --steps 10 --routes /                   # CI smoke, public routes only
mischief --steps 200 --seed $RANDOM              # nightly deep run
mischief --routes /some/page --steps 60 --headed # single-route triage, watch it
mischief replay 20260727-074043                  # reproduce yesterday's finding
mischief --mutators randomClick,refresh          # narrow the search
```

The danger pattern already covers en/ko/ja/zh. Narrow it if the extra refusals
cost you coverage:

```js
guardrails: { dangerPattern: presets.combinePatterns(presets.danger.en, presets.danger.ko) }
```

CSS will break Korean and Japanese between any two syllables, so on a CJK app the
`mobileResize` overflow probe earns its keep.

## Development

`npm test` runs the suite with Node's built-in runner. The `--test` glob it uses
needs **Node ≥ 21**; the package itself runs on Node ≥ 18. The browser suites skip
themselves when no Chrome or Edge is installed — `playwright-core` ships no
browsers — but they are not optional: if you have a browser, they must pass.

---

## Why not just point an agent at Playwright MCP?

A fair question in 2026, and for a whole class of testing the answer is that you
should. An LLM driving a browser reads the screen, understands intent, and gets
through a checkout wizard. This package cannot do any of that. Five things it does
that an agent does not:

**1. It is not suggestible.** An agent's prior is your app's happy path — it clicks
what looks meaningful, because that is what understanding a UI means. `rapidDoubleClick`
exists because two clicks 50 ms apart is *not* something a reasonable tester does,
which is exactly why it finds double-submit bugs. A monkey has no theory of your app.
That is the feature, and it is not a cost optimisation: it is a different search
distribution, and you cannot prompt your way to it.

**2. Cost, at the depth where monkeys start working.** The default is 40 steps per
route. Five routes is 200 steps, and over MCP each step is a tool call returning an
accessibility snapshot — a few thousand tokens on a real app, so roughly one to two
million tokens per run. Here a 200-step run costs nothing and takes minutes. Deep
runs are where random testing earns its keep, and they are the runs you cannot
afford to have an agent perform nightly.

**3. A CDP surface MCP does not expose.**

```
Network.emulateNetworkConditions     Slow-3G, offline
Emulation.setDeviceMetricsOverride   real mobile viewport
PerformanceObserver                  LCP, CLS
```

An agent cannot throttle the network, drop the connection, or measure layout shift.
`offlineMode`, `slowNetwork`, `mobileResize` and the perf probe are out of reach
rather than merely expensive.

**4. Findings replay.** `--seed 4242` walks the same path twice. An agent's finding
is a paragraph describing something that happened once. That is the difference
between a bug report and an anecdote.

**5. Verification has to be mechanical, not self-reported.** An agent has the
judgement to notice it was bounced to a login page. What it does not have is the
discipline to check every time, and it reports on its own work: asked whether the
session took effect, it says yes. `unverifiedReasons()` closes six paths to a false
green, including several no reviewer would think to enumerate — a `baseUrl` with
nothing listening that reported *2/2 routes exercised*, a candidate census that threw
in-page so coverage is UNKNOWN rather than zero, a run in which every completed step
was a no-op. Judgement finds those once. A gate catches them every night.

### Where the agent wins

Anything needing an oracle. Every finding this package rates critical or high is
self-evident from the browser alone:

```
critical  js-exception, http-5xx
high      http-4xx, broken-image, overflow
```

None of them requires knowing what the page was *supposed* to say. So nothing here
tells you the total is wrong, that Save didn't save, that the empty state reads
badly, or that the wrong currency symbol is rendering. An agent gets through a
multi-step form; a monkey plateaus at interaction depth two.

The bug classes are close to disjoint, which is why this is not an alternative.
Run this nightly at 200 steps for the price of the electricity, let the exit code
gate CI, and hand the report to an agent to triage and to chase what needs
judgement. This is the cheap deterministic layer underneath agent-driven testing,
not a substitute for it.

---

## Non-goals

- **Not a replacement for Playwright test.** Scripted assertions about known
  behaviour are a different job, and a better one where you can afford it. This
  is for the space between the tests you wrote.
- **Not a replacement for an agent driving a browser.** See above — no oracle, and
  it plateaus at interaction depth two.
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
