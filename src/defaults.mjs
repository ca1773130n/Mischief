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

/** URLs where a 401 means "you are not signed in", not "this endpoint is broken". */
export const LOGIN_ADJACENT = /login|signin|sign-in|auth|session|oauth/i;

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
  },

  routes: ['/'],
  steps: 40,
  seed: null, // null = pick one and print it

  mutators: { enabled: null, weights: {}, custom: [] },

  guardrails: {
    dangerPattern: presets.danger.en,
    ignoreAttribute: 'data-qa-ignore',
    stayOnOrigin: true,
    closePopups: true,
    blockWindowOpen: true,
    maxCandidates: 400,
  },

  probes: {
    a11y: true,
    brokenImages: true,
    overflow: true,
    perf: true,
    textPatterns: [], // opt-in; see presets.textPatterns
    textSkipSelector: '',
    custom: [],
  },

  network: {
    consoleIgnore: [],
    slowRequestMs: 10000,
    loginAdjacent: LOGIN_ADJACENT,
    classifyResponse: null, // ({ status, url, method }) => 'critical'|'high'|'gate'|'ignore'
    slow3g: SLOW_3G,
    normal: NET_NORMAL,
    offline: NET_OFFLINE,
  },

  viewports: { mobile: VIEW_MOBILE, desktop: VIEW_DESKTOP },

  input: { invalidValues: INVALID_VALUES, keyPool: KEY_POOL },

  timing: {
    gotoTimeoutMs: 30000,
    gotoWaitUntil: 'networkidle',
    settleMs: 1500,
    waitForTimeoutMs: 8000,
    stepPauseMinMs: 150,
    stepPauseJitterMs: 250,
  },

  report: {
    outDir: './reports',
    formats: ['markdown', 'json'],
    maxErrorScreenshots: 25, // bound disk usage on exception storms
    consoleCap: 200, // per route, per level; the rest is counted, not stored
    pageScreenshots: true,
    reporters: [],
  },

  thresholds: { cls: 0.1, lcpMs: 4000 },

  allowProd: false,
  allowAnonymous: false,
  quiet: false,
};
