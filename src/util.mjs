// Small helpers with no browser and no config dependency.

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

/** Filesystem-safe slug for a route path. '/' becomes 'home'. */
export function slugOf(routePath) {
  if (routePath === '/') return 'home';
  return routePath.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'route';
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
