// Small helpers with no browser and no config dependency.

/**
 * The package's one "your config is wrong" error type.
 *
 * It lives here rather than in config.mjs so that routes.mjs, mutators/index.mjs
 * and report/index.mjs can throw it without importing the config module. Before
 * that, route and mutator validation threw a bare Error, missed bin's
 * `instanceof ConfigError` branch, and reported a one-character typo as
 * "FATAL before the run loop" with a full stack trace.
 */
export class ConfigError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const stripQuery = (u) => String(u).split('?')[0].split('#')[0];

export const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/** Group items by a derived key, most frequent first. Used all over the report. */
export function groupCount(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    const g = m.get(k) || { key: k, count: 0, sample: it };
    g.count++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** Local-time run id, e.g. 20260727-074043. Sorts lexicographically. */
export function makeRunId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Pathname of a URL, tolerant of about:blank and garbage. Used for the
 * landed-URL check, which must never throw mid-run.
 */
export function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

/**
 * Path for COMPARISON, tolerant of one trailing slash.
 *
 * Next.js `trailingSlash` and most static hosts normalize '/x' to '/x/' (or back)
 * on every navigation. Compared literally, that made the landed-URL check report
 * 'redirected' on every route of such an app — noise in the one section built to
 * catch real route drift, which trains you to ignore it. Only a single slash is
 * stripped, and never from '/' itself: collapsing that to '' would make the root
 * compare equal to anything else that normalized away.
 *
 * A locale redirect ('/' -> '/en') still differs, and must — that is genuine drift.
 */
export function samePath(url) {
  const p = pathOf(url);
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Filesystem-safe slug for a route path. '/' becomes 'home'.
 *
 * Unicode letters and digits are KEPT. `[^a-z0-9]` stripped them, so every
 * non-Latin path collapsed to the literal slug 'route' — two such routes wrote to
 * the same page-route.jpeg and the second silently overwrote the first, leaving
 * both report rows pointing at the wrong screenshot.
 */
export function slugOf(routePath) {
  if (routePath === '/') return 'home';
  return String(routePath).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'route';
}

/**
 * Make a list of slugs injective by suffixing the collisions.
 *
 * Even with Unicode kept, '/a/b' and '/a-b' still slug the same, and a run whose
 * per-route evidence points at another route's page is a quiet lie. Deterministic
 * (index-based), so replaying a seed reproduces the same filenames.
 */
export function uniqueSlugs(paths) {
  const seen = new Map();
  return paths.map((p, i) => {
    const base = slugOf(p);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${i}`;
  });
}

/**
 * Host allowlist check. Exact match, or a leading dot for subdomains
 * ('.example.com' matches 'api.example.com' but not 'example.com').
 */
export function hostAllowed(hostname, allowed) {
  const h = String(hostname).toLowerCase();
  return (allowed || []).some((entry) => {
    const e = String(entry).toLowerCase();
    return e.startsWith('.') ? h.endsWith(e) : h === e;
  });
}

/** Serializable form of a RegExp — evaluate() cannot marshal a RegExp itself. */
export function reWire(re) {
  return { source: re.source, flags: re.flags };
}
