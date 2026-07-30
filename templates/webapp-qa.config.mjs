import { defineConfig, presets } from 'webapp-qa-kit';

export default defineConfig({
  baseUrl: 'http://localhost:3000',

  // Fail-closed allowlist. Nothing outside this list runs without --allow-prod.
  allowedHosts: ['localhost', '127.0.0.1'],

  browser: {
    mode: 'launch', // 'attach' drives an already-open Chrome in your real profile
    channel: 'chrome', // playwright-core ships no browsers; name one you have
    headless: true,
  },

  // Mark every gated route. Anonymous runs SKIP them instead of silently testing
  // the login page under their name — which is the whole point of this package.
  routes: [
    '/',
    { path: '/pricing' },
    // { path: '/dashboard', requiresAuth: true, waitFor: '[data-testid=dashboard]' },
    // { path: '/items/:id', resolve: async ({ baseUrl }) => {
    //     const r = await fetch(`${baseUrl}/api/items?limit=1`);
    //     const [first] = await r.json();
    //     return first ? `/items/${first.id}` : null;   // null drops the route, loudly
    //   } },
  ],

  steps: 40,

  // auth: {
  //   strategy: 'localStorage',   // none | localStorage | storageState | cookies | custom
  //   key: 'my-app-auth',         // the key your app reads
  //   from: '.auth/session.json', // NEVER commit this file
  //   // Optional. Without it, verification falls back to "did we stay on the
  //   // path we asked for" — a router bounce to /login is the failure signal.
  //   verify: async (page) => !!(await page.$('[data-testid=user-menu]')),
  // },

  guardrails: {
    // Matches the VISIBLE LABEL of a control. An icon-only delete button with no
    // accessible name is invisible to it — put data-qa-ignore on those.
    dangerPattern: presets.danger.en,
    ignoreAttribute: 'data-qa-ignore',
  },

  probes: {
    a11y: true,
    brokenImages: true,
    overflow: true,
    perf: true,
    // textPatterns: [presets.textPatterns.i18nKey],
  },

  network: {
    consoleIgnore: [...presets.consoleIgnore.vite],
    slowRequestMs: 10000,
  },

  report: { outDir: './reports', formats: ['markdown', 'json'] },
  thresholds: { cls: 0.1, lcpMs: 4000 },
});
