// Every constant that used to be a top-level `const` in a single-app harness.
// Anything an app might reasonably want different is a config key, not a literal.

import * as presets from './presets.mjs';

export const SLOW_3G = {
  offline: false,
  latency: 400,
  downloadThroughput: (500 * 1024) / 8,
  uploadThroughput: (400 * 1024) / 8,
};
export const NET_NORMAL = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
export const NET_OFFLINE = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

export const VIEW_MOBILE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
export const VIEW_DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false };

export const INVALID_VALUES = ['', 'A'.repeat(3000), '👾💥🔥한글🈚︎', '"><s>x</s>%00%%$$', '-999999999', '0.0.0.1e308'];

// Plain keys only — never Meta/Ctrl/Alt. A monkey with modifier keys closes the
// user's window, opens devtools, or triggers OS shortcuts.
export const KEY_POOL = [
  'Tab', 'Enter', 'Escape', 'Space', 'ArrowDown', 'ArrowUp', 'PageDown', 'Home',
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
];

/**
 * Keys that ACTIVATE whatever currently has focus, rather than just moving
 * through the page.
 *
 * Split out of KEY_POOL because the danger guardrail used to cover mouse clicks
 * only: 'Tab' then 'Enter' reaches a focused "Delete account" without
 * dangerPattern ever being consulted — in attach mode, against a real profile,
 * under a banner advertising the guardrail. keyboardSpam and invalidInput now
 * check the focused control's label before pressing any key in this list.
 */
export const ACTIVATION_KEYS = ['Enter', 'Space'];

/**
 * URLs where a 401 means "you are not signed in", not "this endpoint is broken".
 *
 * Matched against the URL, never against copy, so localized auth paths need
 * their own stems: '/ko/로그인' and '/anmelden' are as much a sign-in endpoint as
 * '/login', and without them every gated request on a localized app is filed as
 * a HIGH finding and drives exit code 1.
 */
export const LOGIN_ADJACENT =
  /login|signin|sign-in|logon|log-in|auth|session|oauth|sso|saml|token|refresh|credential|passwor|passkey|로그인|인증|세션|ログイン|認証|登录|登入|鉴权|anmelden|abmelden|einloggen|connexion|authentifi|iniciar-?sesion|entrar|accedi|inloggen|вход|войти/i;

// randomClick 30%, invalidInput 15%, keyboardSpam 10%; every other enabled
// mutator splits the remaining 45%. Clicking is what finds bugs; the rest are
// stressors that need far fewer repetitions to be worth their runtime.
export const NAMED_WEIGHTS = { randomClick: 30, invalidInput: 15, keyboardSpam: 10 };
export const REMAINDER_WEIGHT = 45;

export const DEFAULT_CONFIG = {
  baseUrl: 'http://localhost:3000',

  // FAIL-CLOSED. A denylist of production hostnames protects nothing in a fresh
  // project — you have to remember to add your own domain before it helps. An
  // allowlist refuses everything you did not name, so day one is safe.
  allowedHosts: ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'],

  browser: {
    // 'launch' = throwaway browser, safe default.
    // 'attach' = drive a Chrome you already have open, in YOUR real signed-in
    // profile. Enormously convenient, and it means a mis-guarded click happens
    // to your actual account. Opt in deliberately.
    mode: 'launch',
    cdpUrl: 'http://127.0.0.1:9222',
    channel: undefined, // e.g. 'chrome' — launch mode only; playwright-core ships no browsers
    executablePath: undefined,
    headless: true,
    ignoreHTTPSErrors: true, // dev servers are routinely self-signed
    defaultTimeoutMs: 10000,
    launchArgs: [],
  },

  auth: {
    strategy: 'none', // none | localStorage | storageState | cookies | custom
    key: null, // localStorage key
    from: null, // path to the session file
    apply: null, // custom: async ({ context, page, config }) => void
    verify: null, // async (page) => boolean; see src/auth/index.mjs for the default
    // The default verification refuses to believe a page that still shows a
    // sign-in field, because inline gating (a login modal at the SAME url) is
    // invisible to a landed-path check. Set false if a gated route of yours
    // legitimately renders a lone password input.
    // A KNOWN false-positive shape: the "re-enter your password to confirm"
    // (sudo-mode) form that GitHub, Stripe and AWS all ship. One masked field, no
    // identifier beside it — the same shape as sign-in. It is reported as an
    // ambiguous note rather than a verification failure; see judgeLoginSignals.
    // A passwordless sign-in screen (magic link, OAuth-only, passkey) is NOT
    // covered at all: the probe keys on credential inputs.
    detectLoginScreen: true,
    loginSkipSelector: '', // subtree whose credential fields are not a sign-in screen
  },

  routes: ['/'],
  steps: 40,
  seed: null, // null = pick one and print it

  mutators: {
    enabled: null,
    weights: {},
    custom: [],
    // Behaviour constants the mutators used to hold as literals, in breach of the
    // rule at the top of this file. An app that only accepts .csv uploads, or that
    // needs longer than 400ms to reflow after a resize, had no key to say so.
    options: {
      offlineMs: 2500,
      slowSteps: 3, // slowNetwork throttles this many steps AFTER it fires
      doubleClickGapMs: 50,
      keyboardSpamKeys: 15,
      keyPauseMinMs: 30,
      keyPauseJitterMs: 50,
      enterProbability: 0.3, // invalidInput submits this often
      resizeSettleMs: 400,
      backSettleMs: 500,
      uploadExtensions: ['.txt', '.png', '.pdf', '.zip'],
      uploadMinBytes: 1024,
      uploadJitterBytes: 49 * 1024,
    },
  },

  guardrails: {
    dangerPattern: presets.danger.all,
    ignoreAttribute: 'data-qa-ignore',
    stayOnOrigin: true,
    closePopups: true,
    blockWindowOpen: true,
    maxCandidates: 400,
    // What counts as clickable. A key because component design systems ship
    // clickable custom tags carrying no role="button" — piercing shadow roots
    // only half-solves those. Matched per element, so no :scope and no leading
    // combinator.
    clickableSelector: 'a, button, [role="button"], input[type="submit"], select, [tabindex]',
    // Traversal bound for the in-page DOM walk. Real SPAs run 5k–15k nodes;
    // Chrome's own DOM-size audit warns at ~1500. Exhausting it is REPORTED, not
    // silent — silent truncation is the same false green one level down.
    maxScanNodes: 20000,
    // A run where no route offered a single clickable candidate is not verified.
    // Turn off for a genuinely static site.
    requireClickable: true,
    // A run in which EVERY step on EVERY route was a no-op is not verified either.
    // Mutators report "nothing to type into" / "no candidate" as success, so
    // `mischief --mutators invalidInput` against a page with no inputs used to run
    // 40 steps, record 0 failures, emit no finding of any kind and exit 0 CLEAN.
    // Generalises requireClickable past clicking. Turn off if you deliberately run
    // a mutator set that mostly finds nothing on your app.
    requireEffectiveSteps: true,
    // Rewrites attachShadow to open every closed root. Off by default: it makes
    // the app under test no longer the shipped app. The zero-candidate finding
    // names this flag, so a component app is told the remedy rather than left
    // with a green report.
    forceOpenShadowRoots: false,
  },

  probes: {
    a11y: true,
    brokenImages: true,
    overflow: true,
    perf: true,
    textPatterns: [], // opt-in; see presets.textPatterns
    textSkipSelector: '',
    // Bound on text-pattern hits per route. A key, and REPORTED when exhausted:
    // it used to be a hardcoded 25 that abandoned the walk with no flag, which is
    // the same silent-truncation false negative maxScanNodes exists to refuse.
    maxTextHits: 25,
    // Dead-control detection: after a click, did ANYTHING change?
    //
    // A control wired to nothing raises no exception, returns 200 and logs
    // nothing, so every other detector in this package passes it clean — a
    // common real bug that is invisible here by construction. Absence of effect
    // is the only signal available without app semantics.
    //
    // OPT-IN, following the probes.textPatterns precedent, because it is the
    // easiest signal here to get wrong in both directions and both were
    // measured: on an adversarial page (100ms text clock + 500ms innerHTML
    // re-render + CSS animation + 800ms poll) each single observable accused 3-5
    // of 6 HEALTHY controls, while a naive record count could not separate a
    // real click from an idle tick at all. Only the union of every observable,
    // with an idle baseline subtracted, got that down to one. See src/inert.mjs.
    deadControls: false,
    // A control must be clicked this many times and be inert EVERY time. One
    // alive observation clears it permanently, run-wide.
    deadControlMinObservations: 2,
    // The per-route settle window is split into this many samples to learn which
    // DOM subtrees change on their own. A signature must recur in >= 2 windows to
    // count as churn: a BIGGER baseline means MORE dead verdicts, so the rule is
    // deliberately biased toward a small one.
    deadControlBaselineWindows: 4,
    deadControlMaxSignatures: 200,
    // Debounced and animated handlers routinely fire their request 300-500ms
    // after the click, i.e. after the step pause has already ended. Without the
    // grace the request is credited to the NEXT step, which is two wrong answers
    // from one click.
    deadControlGraceMs: 400,
    // A URL requested under this many DISTINCT click targets is the app's own
    // background traffic (polling, analytics, prefetch), not any one control's
    // effect, so it stops rescuing controls from an inert verdict.
    deadControlAmbientTargets: 3,
    // Bound on the per-route request log the network channel reads. Cap, then
    // COUNT — a route past the cap is UNKNOWN and reports nothing, because a
    // request that was never recorded cannot prove a control live.
    deadControlMaxRequests: 2000,
    // Observe inside shadow roots by wrapping attachShadow. Off by default like
    // guardrails.forceOpenShadowRoots, but milder: it never alters init.mode, so
    // the app under test keeps the roots it shipped. Without it, a route with any
    // shadow root is skipped entirely rather than judged blind.
    deadControlObserveShadowRoots: false,
    custom: [],
  },

  network: {
    consoleIgnore: [],
    slowRequestMs: 10000,
    loginAdjacent: LOGIN_ADJACENT,
    // Extra origins whose responses are classified alongside baseOrigin. Needed
    // whenever the API is not on the app's origin — the most common dev layout —
    // because everything off baseOrigin used to be dropped BEFORE classification,
    // so an app with a 500ing API on another port read as CLEAN with no report
    // line saying the API was never looked at. The watched set is printed in the
    // report header. classifyResponse (below) sees every response either way.
    watchOrigins: [],
    // A watched origin that never answered once and failed at least this many
    // times is treated as DOWN — the run is unverified rather than critical.
    // Not 1: a single 5xx from an origin contacted exactly once is as likely to
    // be one broken endpoint as a dead host, and demoting a real CRITICAL to
    // "could not test" on that evidence would hide the bug this package exists
    // to surface. Set to 0 to disable the rule.
    deadOriginMinFailures: 3,
    classifyResponse: null, // ({ status, url, method, watched }) => 'critical'|'high'|'gate'|'throttled'|'ignore'
    slow3g: SLOW_3G,
    normal: NET_NORMAL,
    offline: NET_OFFLINE,
  },

  viewports: { mobile: VIEW_MOBILE, desktop: VIEW_DESKTOP },

  input: {
    invalidValues: INVALID_VALUES,
    // number/date inputs reject free text at the DRIVER level, so the general
    // pool would make fill() throw before the app ever saw a value. Per-type
    // pools are keys so a user's own invalidValues are not silently discarded on
    // those fields, which is what a hardcoded substitution did.
    invalidValuesByType: {
      number: ['', '-999999999'],
      date: [''],
      time: [''],
      month: [''],
      week: [''],
      'datetime-local': [''],
    },
    keyPool: KEY_POOL,
    activationKeys: ACTIVATION_KEYS,
  },

  timing: {
    gotoTimeoutMs: 30000,
    // NOT 'networkidle'. Any persistent connection never reaches it — an HMR
    // websocket, SSE, a realtime database client, an analytics heartbeat,
    // long-polling — so every route burned the full gotoTimeoutMs and recorded a
    // 'goto' finding. That is the DEFAULT case for a dev server, and a dev server
    // is the default baseUrl.
    gotoWaitUntil: 'domcontentloaded',
    settleMs: 1500,
    // Budget for waitForLoadState. Used once per route to wait for 'load' BEFORE
    // the enter-phase probes: shortening the goto wait to domcontentloaded also
    // shortened the window those probes get, so the text and a11y scans were
    // looking at an SPA skeleton and finding nothing. 'load' fires once the
    // bundle has executed, which restores the old effective window without
    // restoring networkidle's guaranteed 30s timeout.
    loadStateTimeoutMs: 5000,
    waitForTimeoutMs: 8000,
    // The candidate-settle poll, shared by the per-route census and every click.
    // Right after a reload or route change the app may not have rendered, and an
    // empty candidate list at that instant is timing noise — which, now that a
    // click-free run is exit 3, would be a FALSE exit 3 on a healthy slow app.
    settlePollAttempts: 8,
    settlePollMs: 250,
    historyTimeoutMs: 8000, // goBack / goForward
    reloadTimeoutMs: 30000,
    stepPauseMinMs: 150,
    stepPauseJitterMs: 250,
    // Added to the step pause once the app answers 429, then doubled per 429 up
    // to the ceiling. A `Retry-After` in seconds overrides both. The monkey's
    // default 150-400ms gap is faster than a small backend can serve, so without
    // this a rate-limited run just keeps hammering and reports the limit as bugs.
    rateLimitBackoffMs: 2000,
    rateLimitMaxPauseMs: 30000,
  },

  report: {
    outDir: './reports',
    formats: ['markdown', 'json'],
    maxErrorScreenshots: 25, // bound disk usage on exception storms
    consoleCap: 200, // per route, per level; the rest is counted, not stored
    // Same rule as consoleCap: cap, then COUNT what was dropped. These used to be
    // hardcoded caps that discarded silently.
    slowRequestCap: 100,
    requestFailureCap: 300,
    pageScreenshots: true,
    screenshotQuality: 50,
    reporters: [],
  },

  thresholds: { cls: 0.1, lcpMs: 4000 },

  allowProd: false,
  allowAnonymous: false,
  quiet: false,
};
