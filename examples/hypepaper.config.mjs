// Example: HypePaper (Vue 3 + vue-i18n + Supabase auth, research-papers product).
//
// This is the app the package was extracted from, so it is also the honest
// inventory of what "app-specific" means in practice: everything below is a
// coupling point that used to be a hardcoded constant in the harness.
//
// Drop this in as `qa/webapp-qa.config.mjs` and reduce qa/package.json to
//   { "dependencies": { "webapp-qa-kit": "^0.1.0" },
//     "scripts": { "monkey": "webapp-qa" } }
//
// NO SECRETS LIVE HERE. `auth.from` is a path to a gitignored file you create
// yourself; the token never enters this config or the report.

import { defineConfig, presets } from 'webapp-qa-kit';

// The dev frontend and the API are separate origins. The old harness derived the
// API base with base.replace('://', '://api.'), which turns the dev origin
// https://burningxoul.mooo.com:5173 into api.burningxoul.mooo.com:5173 — a host
// that is not the documented local backend (uvicorn on :8000). Make it explicit.
const API_BASE = process.env.HYPEPAPER_API_BASE || 'http://localhost:8000';

export default defineConfig({
  baseUrl: process.env.QA_BASE || 'https://burningxoul.mooo.com:5173',

  // Fail-closed allowlist, replacing the old /hypepaper\.app/ denylist. The dev
  // host MUST be listed or every local run refuses to start;
  // `webapp-qa --base https://hypepaper.app --allow-prod` still works.
  allowedHosts: ['burningxoul.mooo.com', 'localhost', '127.0.0.1'],

  browser: {
    // The Vite dev server is HTTPS-only with a self-signed cert, and the point
    // of attach mode here is the already-signed-in Chrome on :9222.
    mode: 'attach',
    cdpUrl: 'http://127.0.0.1:9222',
    ignoreHTTPSErrors: true,
  },

  auth: {
    // frontend/src/core/auth/supabase.ts sets a CUSTOM Supabase storageKey.
    // The router guard reads localStorage['hypepaper-auth'] directly
    // (frontend/src/core/router/index.ts:874, gate at :880), so seeding that one
    // key is sufficient and no cookie is involved.
    strategy: 'localStorage',
    key: 'hypepaper-auth',
    from: process.env.QA_SESSION || '.auth/hypepaper-session.json',
    // The default landed-path check is already the right signal here: an
    // anonymous session is bounced to /landing, so the path changes. Supply a
    // selector-based verify only if the app ever starts rendering gated shells.
  },

  // 4 of the 11 routes the old hardcoded list used are now REDIRECTS, so the
  // harness was spending 4/11 of its budget re-testing 2 destinations:
  //   /discovery -> /explore?tab=feed   (router/index.ts:279)
  //   /search    -> /explore            (:335)
  //   /topics    -> /library?tab=topics (:239)
  //   /clusters  -> /library?tab=clusters (:235)
  // requiresAuth below is copied from each route's `meta`, verified by reading
  // router/index.ts, not guessed.
  routes: [
    { path: '/', requiresAuth: true }, // FeedPage — meta.requiresAuth at :132
    { path: '/trending', requiresAuth: true }, // :711
    { path: '/sota-arena', requiresAuth: true }, // :717 — also requiredFeature: results_arena
    { path: '/explore?tab=feed' }, // PUBLIC (:271) — was /discovery
    { path: '/explore' }, // PUBLIC — was /search
    { path: '/library', requiresAuth: true }, // :223
    { path: '/library?tab=topics', requiresAuth: true }, // was /topics
    { path: '/library?tab=clusters', requiresAuth: true }, // was /clusters
    { path: '/pricing' }, // PUBLIC by design (:346) — cold visitors compare plans
    { path: '/paper-sources', requiresAuth: true }, // :309
    {
      // The arena table, the experimental-result comparison and every
      // LaTeX-bearing field live on a paper detail page; the list pages never
      // reach one. Hardcoding an id would rot, and visiting a 404 would
      // manufacture findings — so resolve it, and drop the route loudly if the
      // API is down.
      path: '/papers/:id',
      requiresAuth: true, // :208
      resolve: async () => {
        const res = await fetch(`${API_BASE}/api/v1/papers?limit=1`);
        const body = await res.json();
        const rows = Array.isArray(body) ? body : body.papers || body.items || [];
        const id = rows[0] && (rows[0].id || rows[0].paper_id);
        return id ? `/papers/${id}` : null;
      },
    },
  ],

  steps: 40,

  guardrails: {
    // Verbatim from the original harness (qa/monkey.mjs:41-42). Kept as one
    // literal rather than presets.danger.en + .ko so that a seeded replay
    // against the pre-extraction harness matches exactly.
    dangerPattern:
      /(삭제|지우기|탈퇴|해지|로그아웃|logout|sign\s?out|delete|remove|revoke|구독|결제|checkout|subscribe|pay|purchase|cancel\s+subscription|초기화|reset|비우기|clear\s+all)/i,
    ignoreAttribute: 'data-qa-ignore',
  },

  probes: {
    a11y: true,
    brokenImages: true,
    overflow: true,
    perf: true,
    // Raw LaTeX in 22.8% of SOTA-arena rows passed every automated run until a
    // text probe existed; a human found it first. KaTeX's own source annotation
    // is math, not a leak, hence the skip selector.
    textPatterns: [presets.textPatterns.latexMath, presets.textPatterns.latexCmd, presets.textPatterns.i18nKey],
    textSkipSelector: presets.KATEX_SKIP_SELECTOR,
  },

  network: {
    consoleIgnore: [...presets.consoleIgnore.vueI18n, ...presets.consoleIgnore.vue],
    slowRequestMs: 10000,
    // Plan tiers FREE < PRO < ULTRA < TEAM < ADMIN mean 402/403 are the product
    // working, not breaking. This matches the package default; it is spelled out
    // because it is a business rule, and the day the plan model changes this is
    // the line to edit.
    classifyResponse: ({ status, url }) => {
      if (status >= 500) return 'critical';
      if (status === 402 || status === 403) return 'gate';
      if (status === 401 && /login|signin|sign-in|auth|session|oauth/i.test(url)) return 'gate';
      if (status >= 400) return 'high';
      return 'ignore';
    },
  },

  // 390px is the viewport where this app's mobile-only breakage keeps showing up.
  viewports: {
    mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  },

  report: { outDir: './reports', formats: ['markdown', 'json'] },
  thresholds: { cls: 0.1, lcpMs: 4000 },
});
