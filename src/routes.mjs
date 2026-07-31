import { ConfigError } from './util.mjs';

/**
 * Route entries accept a bare string or an object:
 *
 *   '/'
 *   { path: '/some/gated/page', requiresAuth: true, waitFor: '[data-testid=x]',
 *     steps: 60, mutators: ['randomClick'], skip: ({ authed }) => !authed }
 *   { path: '/things/:id', resolve: async ({ baseUrl }) => '/things/' + id }
 *
 * `resolve` returns a concrete path (or null / [] to drop the entry, or an array
 * to fan out). It runs in NODE, before the browser opens, so it can call your
 * API. Hardcoding an id would rot; visiting a 404 would manufacture findings.
 */
export function normalizeRoute(entry) {
  const r = typeof entry === 'string' ? { path: entry } : { ...entry };
  if (!r.path || typeof r.path !== 'string') throw new ConfigError(`Route needs a path: ${JSON.stringify(entry)}`);
  if (!r.path.startsWith('/')) r.path = '/' + r.path;
  // `!= null`, not truthiness: steps: 0 is exactly the value that must throw. A
  // route with 0 steps completes without testing anything, and the run exited 0
  // CLEAN. Replay reconstructs steps: null for routes with no override.
  if (r.steps != null && (!Number.isInteger(r.steps) || r.steps < 1)) {
    throw new ConfigError(`Route ${r.path}: steps must be a positive integer (got ${r.steps})`);
  }
  return {
    path: r.path,
    requiresAuth: !!r.requiresAuth,
    waitFor: r.waitFor || null,
    steps: r.steps ?? null,
    mutators: r.mutators || null,
    skip: r.skip || null,
    resolve: r.resolve || null,
    meta: r.meta || {},
  };
}

/**
 * Normalize + run resolvers. `onDrop(route, reason)` is called for entries a
 * resolver could not fill in, so the run says so out loud instead of silently
 * testing nine routes when you asked for ten.
 */
export async function resolveRoutes(rawRoutes, config, onDrop = () => {}) {
  const out = [];
  for (const entry of rawRoutes) {
    const route = normalizeRoute(entry);
    if (!route.resolve) {
      out.push(route);
      continue;
    }
    let resolved;
    try {
      resolved = await route.resolve({ baseUrl: config.baseUrl, baseOrigin: config.baseOrigin, config, route });
    } catch (e) {
      onDrop(route, `resolve() threw: ${(e && e.message) || e}`);
      continue;
    }
    const list = resolved == null ? [] : Array.isArray(resolved) ? resolved : [resolved];
    if (!list.length) {
      onDrop(route, 'resolve() returned nothing');
      continue;
    }
    for (const p of list) out.push({ ...route, resolve: null, path: String(p).startsWith('/') ? String(p) : '/' + p });
  }
  if (!out.length) throw new ConfigError('No routes left after resolution — nothing to test.');
  return out;
}

export function newRouteStats(route) {
  return {
    page: route.path,
    requiresAuth: route.requiresAuth,
    steps: 0,
    // Steps whose mutator completed while doing nothing at all. Mutators report
    // "no candidate" / "no editable input" as SUCCESS, so `steps > stepFailures`
    // called a route exercised when every step had been a no-op — 40 steps, 0
    // failures, 0 findings, exit 0 CLEAN. See guardrails.requireEffectiveSteps.
    noopSteps: 0,
    // OR of every in-page walk's budget exhaustion, not just the clickable one:
    // the a11y and text scans have their own, independent of whether the census
    // even ran, and silent truncation is the same false green one level down.
    scanTruncated: false,
    textHitsCapped: false,
    gotoNote: '',
    redirectedTo: null, // set when the landed path differs from the requested one
    unreached: null, // set when waitFor timed out — this route was NOT tested
    skipped: null, // set when route.skip() or the anonymous filter excluded it
    durationMs: 0,
    jsExceptions: [],
    stepFailures: [],
    consoleErrors: [],
    consoleWarnings: [],
    consoleDropped: { error: 0, warning: 0 },
    net4xx: [],
    net5xx: [],
    // 429s. Kept out of net4xx on purpose: a rate limit is the harness outrunning
    // the backend, not a bug in the page. See defaultClassifyResponse.
    rateLimited: [],
    requestFailures: [],
    requestFailuresDropped: 0,
    slowRequests: [],
    slowRequestsDropped: 0,
    perf: { lcp: 0, cls: 0, dcl: 0, load: 0 },
    // Sticky: the harness throttled or disconnected at some point on this route,
    // so its max() perf samples measure the stressor rather than the page.
    netDegraded: false,
    // What the monkey was actually offered to click. `atEnter: null` means the
    // census never ran; `probeFailed` means it threw. Neither is the same as 0,
    // and conflating them is how a broken probe would manufacture the very
    // "nothing to click" verdict this data exists to report.
    clickable: {
      atEnter: null,
      attempts: 0,
      empty: 0,
      max: 0,
      scanTruncated: false,
      capped: false,
      probeFailed: false,
      selector: null,
      shadow: null, // { openRoots, closedSuspects, undefinedEls, hosts } — LAST attempt
      shadowAtEnter: null, // the same census at route entry, which atEnter belongs to
    },
    a11y: null,
    textHits: [],
    custom: [],
    brokenImages: new Set(),
    overflow: [],
    shot: null,
  };
}
