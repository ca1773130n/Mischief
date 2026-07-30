/**
 * Route entries accept a bare string or an object:
 *
 *   '/pricing'
 *   { path: '/sota-arena', requiresAuth: true, waitFor: '[data-testid=arena]',
 *     steps: 60, mutators: ['randomClick'], skip: ({ authed }) => !authed }
 *   { path: '/papers/:id', resolve: async ({ baseUrl }) => '/papers/' + id }
 *
 * `resolve` returns a concrete path (or null / [] to drop the entry, or an array
 * to fan out). It runs in NODE, before the browser opens, so it can call your
 * API. Hardcoding an id would rot; visiting a 404 would manufacture findings.
 */
export function normalizeRoute(entry) {
  const r = typeof entry === 'string' ? { path: entry } : { ...entry };
  if (!r.path || typeof r.path !== 'string') throw new Error(`Route needs a path: ${JSON.stringify(entry)}`);
  if (!r.path.startsWith('/')) r.path = '/' + r.path;
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
  if (!out.length) throw new Error('No routes left after resolution — nothing to test.');
  return out;
}

export function newRouteStats(route) {
  return {
    page: route.path,
    requiresAuth: route.requiresAuth,
    steps: 0,
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
    requestFailures: [],
    slowRequests: [],
    perf: { lcp: 0, cls: 0, dcl: 0, load: 0 },
    a11y: null,
    textHits: [],
    custom: [],
    brokenImages: new Set(),
    overflow: [],
    shot: null,
  };
}
