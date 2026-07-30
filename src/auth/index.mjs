import fs from 'node:fs';
import { pathOf } from '../util.mjs';

export class AuthError extends Error {}

/**
 * Seed a session into the context BEFORE the first navigation.
 *
 * Returns { authed, note }. Throws AuthError when a session was configured but
 * could not be applied — see the fail-closed rationale in verifyAuth().
 */
export async function applyAuth({ context, config }) {
  const { strategy, key, from } = config.auth;
  if (strategy === 'none') return { authed: false, note: 'no session configured' };

  if (strategy === 'storageState') {
    // Already applied at newContext() time in openBrowser(); nothing to do here.
    return { authed: true, note: `storageState from ${from}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(from, 'utf8').trim();
  } catch (e) {
    throw new AuthError(`auth.from "${from}" is unreadable (${(e && e.message) || e})`);
  }

  if (strategy === 'localStorage') {
    // Parse to fail loudly HERE rather than silently seeding garbage that the
    // app will discard, leaving an anonymous run that looks authenticated.
    try {
      JSON.parse(raw);
    } catch (e) {
      throw new AuthError(`auth.from "${from}" is not valid JSON (${(e && e.message) || e})`);
    }
    // addInitScript, not evaluate: it re-runs on EVERY document. This harness
    // navigates constantly and a one-shot evaluate would be lost on the next load.
    await context.addInitScript(
      ([k, v]) => {
        try {
          window.localStorage.setItem(k, v);
        } catch {}
      },
      [key, raw],
    );
    return { authed: true, note: `localStorage["${key}"] seeded from ${from}` };
  }

  if (strategy === 'cookies') {
    let cookies;
    try {
      const parsed = JSON.parse(raw);
      cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
    } catch (e) {
      throw new AuthError(`auth.from "${from}" is not valid JSON (${(e && e.message) || e})`);
    }
    if (!Array.isArray(cookies) || !cookies.length) {
      throw new AuthError(`auth.from "${from}" holds no cookies (expected an array, or { cookies: [...] })`);
    }
    await context.addCookies(cookies);
    return { authed: true, note: `${cookies.length} cookie(s) from ${from}` };
  }

  if (strategy === 'custom') {
    await config.auth.apply({ context, config });
    return { authed: true, note: 'custom auth.apply()' };
  }

  return { authed: false, note: `unhandled strategy ${strategy}` };
}

/**
 * Prove the session actually took effect. THIS IS THE POINT OF THE PACKAGE.
 *
 * A harness that seeds a session and then navigates without checking will, on
 * any app with a router guard, quietly test the LOGIN PAGE N times and report a
 * clean pass. That failure mode is not an edge case: it is the default outcome
 * of an expired token, and a green report from it is worse than no report.
 *
 * Default check when no `auth.verify` is supplied: navigate to the first
 * `requiresAuth` route and confirm the browser is still ON that path. A router
 * bounce to /login or /landing changes the path, so the redirect IS the signal —
 * no app-specific selector required.
 *
 * Returns { ok, how, landedPath }.
 */
export async function verifyAuth({ page, config, route, baseOrigin }) {
  if (typeof config.auth.verify === 'function') {
    let ok = false;
    try {
      ok = !!(await config.auth.verify(page));
    } catch (e) {
      return { ok: false, how: `auth.verify() threw: ${(e && e.message) || e}`, landedPath: pathOf(page.url()) };
    }
    return { ok, how: 'auth.verify()', landedPath: pathOf(page.url()) };
  }

  const want = pathOf(baseOrigin + route.path);
  const got = pathOf(page.url());
  return {
    ok: got === want,
    how: `landed-path check (wanted ${want}, got ${got})`,
    landedPath: got,
  };
}

export const authStrategies = ['none', 'localStorage', 'storageState', 'cookies', 'custom'];
