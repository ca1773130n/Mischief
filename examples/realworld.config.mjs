// A worked real-world config, from the app this package was extracted from.
//
// Every value is a placeholder, but every *decision* is real: each block below
// was a hardcoded constant in the single-app harness, and moving it here is what
// "app-specific" turned out to mean in practice. Read it as an inventory of the
// coupling points you will hit, not as something to copy verbatim.
//
// Drop it in as `qa/mischief.config.mjs` and reduce qa/package.json to
//   { "dependencies": { "mischief": "^0.1.0" },
//     "scripts": { "monkey": "mischief" } }
//
// NO SECRETS LIVE HERE. `auth.from` is a path to a gitignored file you create
// yourself; the token never enters this config or the report.

import { defineConfig, presets } from 'mischief';

// The dev frontend and the API are separate origins. Deriving one from the other
// (`base.replace('://', '://api.')`) produced a host that did not exist, because
// the real backend was a local uvicorn on another port. Make it explicit.
const API_BASE = process.env.QA_API_BASE || 'http://localhost:8000';

export default defineConfig({
  baseUrl: process.env.QA_BASE || 'https://dev.example.com:5173',

  // Fail-closed allowlist, replacing a denylist of production hostnames. Your dev
  // host MUST be listed or every local run refuses to start;
  // `mischief --base https://app.example.com --allow-prod` still works.
  allowedHosts: ['dev.example.com', 'localhost', '127.0.0.1'],

  browser: {
    // This dev server is HTTPS-only with a self-signed cert, and the point of
    // attach mode is an already-signed-in Chrome on :9222.
    //
    // NOTE: ignoreHTTPSErrors is a newContext() option and attach adopts an
    // existing context, so it does NOT apply here — the config warns about the
    // combination. Start Chrome with --ignore-certificate-errors, accept the
    // cert once in that profile, or use mode: 'launch'.
    mode: 'attach',
    cdpUrl: 'http://127.0.0.1:9222',
  },

  auth: {
    // This app's Supabase client sets a CUSTOM storageKey, and the router guard
    // reads that localStorage key directly, so seeding the one key is sufficient
    // and no cookie is involved. Check your own client's storageKey.
    strategy: 'localStorage',
    key: 'my-app-auth',
    from: process.env.QA_SESSION || '.auth/session.json',
    // The default check is already right here: an anonymous session is bounced to
    // a landing page, so the path changes, and the sign-in-surface probe catches
    // same-URL gating. Supply a selector-based verify only if neither fits.
  },

  // 4 of the 11 routes the original hardcoded list used had become REDIRECTS, so
  // the harness spent 4/11 of its budget re-testing 2 destinations. This is the
  // drift the landed-URL check exists to surface — it will happen to your list too.
  //   /discovery -> /explore?tab=feed
  //   /search    -> /explore
  //   /topics    -> /library?tab=topics
  //   /clusters  -> /library?tab=clusters
  // requiresAuth is copied from each route's `meta`, verified by READING the
  // router, not guessed.
  routes: [
    { path: '/', requiresAuth: true, waitFor: '[data-testid=feed]' },
    { path: '/explore' }, // PUBLIC
    { path: '/explore?tab=feed' }, // PUBLIC — was /discovery
    { path: '/library', requiresAuth: true, waitFor: '[data-testid=library]' },
    { path: '/library?tab=topics', requiresAuth: true, waitFor: '[data-testid=library]' },
    { path: '/pricing' }, // PUBLIC by design — cold visitors compare plans
    { path: '/settings', requiresAuth: true, waitFor: '[data-testid=settings]' },
    {
      // The richest content — comparison tables, experimental results, every
      // markup-bearing field — lives on a detail page that list pages never reach.
      // Hardcoding an id would rot, and visiting a 404 would manufacture findings,
      // so resolve it, and drop the route loudly if the API is down.
      path: '/items/:id',
      requiresAuth: true,
      waitFor: '[data-testid=item-detail]',
      resolve: async () => {
        const res = await fetch(`${API_BASE}/api/v1/items?limit=1`);
        const body = await res.json();
        const rows = Array.isArray(body) ? body : body.items || [];
        const id = rows[0] && (rows[0].id || rows[0].item_id);
        return id ? `/items/${id}` : null;
      },
    },
  ],

  steps: 40,

  guardrails: {
    // A bilingual app needs a bilingual danger pattern. The English-only default
    // would refuse to click "Delete" and happily click 삭제 — presets.danger.all
    // is the shipped default for exactly that reason; combine explicitly when you
    // want a narrower set.
    dangerPattern: presets.combinePatterns(presets.danger.en, presets.danger.ko),
    ignoreAttribute: 'data-qa-ignore',
  },

  probes: {
    a11y: true,
    brokenImages: true,
    overflow: true,
    perf: true,
    // Raw LaTeX in 22.8% of one comparison table's rows passed every automated
    // run until a text probe existed; a human found it first. KaTeX's own source
    // annotation is math, not a leak, hence the skip selector. i18nKey catches an
    // untranslated `common.buttons.save` reaching the screen.
    textPatterns: [presets.textPatterns.latexMath, presets.textPatterns.latexCmd, presets.textPatterns.i18nKey],
    textSkipSelector: presets.KATEX_SKIP_SELECTOR,
  },

  network: {
    consoleIgnore: [...presets.consoleIgnore.vueI18n, ...presets.consoleIgnore.vue],
    slowRequestMs: 10000,
    // The API is on another origin. Without this line every response from it is
    // third-party noise, so a 500ing backend produces zero findings and the
    // classifyResponse below never sees the requests it exists to judge.
    watchOrigins: [new URL(API_BASE).origin],
    // Plan tiers (FREE < PRO < TEAM < ADMIN) mean 402/403 are the product
    // working, not breaking. This matches the package default; it is spelled out
    // because it is a business rule, and the day the plan model changes this is
    // the line to edit.
    classifyResponse: ({ status, url }) => {
      // A feature that is built but deliberately not switched on yet will 5xx by
      // design. Classify it as a gate — visible in the report's Gates section,
      // not counted as a defect — because the route would otherwise be
      // permanently exit 2 and the first REAL 5xx would arrive in a report
      // already full of red. DELETE THE BRANCH the day the feature opens; a
      // silenced endpoint nobody un-silences is how a real outage hides.
      if (status >= 500 && /\/api\/v\d+\/billing\//.test(url)) return 'gate';
      if (status >= 500) return 'critical';
      if (status === 402 || status === 403) return 'gate';
      if (status === 401 && /login|signin|sign-in|auth|session|oauth/i.test(url)) return 'gate';
      if (status >= 400) return 'high';
      return 'ignore';
    },
  },

  // 390px is the viewport where this app's mobile-only breakage kept showing up.
  // CSS breaks CJK between any two syllables, so the overflow probe earns its keep.
  viewports: {
    mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  },

  report: { outDir: './reports', formats: ['markdown', 'json'] },
  thresholds: { cls: 0.1, lcpMs: 4000 },
});
