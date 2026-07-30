import { defineConfig, presets } from 'mischief';

export default defineConfig({
  baseUrl: 'http://localhost:3000',

  // Fail-closed allowlist. Nothing outside this list runs without --allow-prod.
  // The package default also allows '[::1]' and '0.0.0.0', which several dev
  // servers print — add them back if yours does.
  allowedHosts: ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'],

  browser: {
    mode: 'launch', // 'attach' drives an already-open Chrome in your real profile
    headless: true,
    // playwright-core ships no browser binaries, so a launch has to be pointed at
    // one you already have. This line names Google Chrome because it is the most
    // common; on a machine with only Edge or Chromium use 'msedge' / 'chromium', or
    // set executablePath. Removing it entirely only works if Playwright can find a
    // browser on its own — the launch error tells you either way.
    channel: 'chrome', // 'chrome' | 'msedge' | 'chromium' | 'chrome-beta' …
    // executablePath: '/path/to/your/chromium',
  },

  // Only '/' is listed, because it is the only path every app has. Add your own —
  // a route asserted here that your app does not serve manufactures a finding on
  // the first run.
  //
  // Mark every gated route with requiresAuth. Anonymous runs SKIP those instead
  // of silently testing the login page under their name, which is the whole point
  // of this package. Give each one a waitFor too: it is the selector that proves
  // the route actually arrived.
  routes: [
    '/',
    // { path: '/some/public/page' },
    // { path: '/some/gated/page', requiresAuth: true, waitFor: '[data-testid=your-marker]' },
    // { path: '/things/:id', resolve: async ({ baseUrl }) => {
    //     const r = await fetch(`${baseUrl}/api/things?limit=1`);
    //     const [first] = await r.json();
    //     return first ? `/things/${first.id}` : null;   // null drops the route, loudly
    //   } },
  ],

  steps: 40,

  // auth: {
  //   strategy: 'localStorage',   // none | localStorage | storageState | cookies | custom
  //   key: 'my-app-auth',         // the key your app reads
  //   from: '.auth/session.json', // NEVER commit this file
  //   // Optional and AUTHORITATIVE — supplying it overrides both default checks.
  //   verify: async (page) => !!(await page.$('[data-testid=user-menu]')),
  //   // Without a verify(), two default signals must BOTH pass: the browser
  //   // stayed on the path we asked for, and no sign-in field is on screen.
  //   // Turn the second one off if a gated route of yours legitimately shows a
  //   // lone password input to a signed-in user.
  //   detectLoginScreen: true,
  //   // A subtree whose credential fields are not a sign-in screen — e.g. a
  //   // "re-enter your password to confirm" form on a settings page.
  //   loginSkipSelector: '',
  // },

  guardrails: {
    // Matches the VISIBLE LABEL of a control, for both mouse clicks and Enter/Space
    // activations. An icon-only delete button with no accessible name is invisible
    // to it — put data-qa-ignore on those.
    //
    // The default is presets.danger.all (en + ko + ja + zh). Narrow it to your own
    // locale only if the extra refusals are costing you coverage: widening this
    // list costs a click, narrowing it costs your data.
    dangerPattern: presets.danger.all,
    ignoreAttribute: 'data-qa-ignore',
    // What counts as clickable. Widen it if your design system ships clickable
    // custom elements with no role="button".
    // clickableSelector: 'a, button, [role="button"], input[type="submit"], select, [tabindex]',
    // Open shadow roots are pierced. CLOSED ones are not — nothing in page script
    // can reach them. Set this to see inside them, at the cost of no longer
    // testing the app exactly as it ships.
    // forceOpenShadowRoots: false,
  },

  probes: {
    a11y: true,
    brokenImages: true,
    overflow: true,
    perf: true,
    // textPatterns: [presets.textPatterns.i18nKey],
  },

  network: {
    // Known framework noise, so it does not drown the real console errors. Pick
    // the ones that match YOUR toolchain — this list makes no assumption about it.
    // consoleIgnore: [...presets.consoleIgnore.vite],   // vite | vue | vueI18n | react
    slowRequestMs: 10000,
    // If your API is on another origin, list it here. Otherwise its 4xx/5xx are
    // ignored as third-party noise and the run reports zero network findings
    // however hard the API is failing. The report header prints what was watched.
    // watchOrigins: ['http://localhost:8000'],
  },

  report: { outDir: './reports', formats: ['markdown', 'json'] },
  thresholds: { cls: 0.1, lcpMs: 4000 },
});
