import fs from 'node:fs';
import { pathOf, samePath, sleep } from '../util.mjs';
import { loginSignalsInPage } from '../probes/inpage.mjs';

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
 * Is this scope a SIGN-IN screen, or just an authenticated page that happens to
 * hold a password field? Pure, so the whole policy is testable with no browser.
 *
 * The shape rules are load-bearing, not polish. "Any visible password field"
 * would abort a healthy run on every settings page with a change-password form —
 * and a false exit 3 is exactly as bad as the false green being fixed. Sign-in
 * has ONE credential field; change-password has current+new+confirm and sign-up
 * has new+confirm, so a count other than 1 means we are inside the app. A
 * `new-password` token means the same thing by spec.
 *
 * Returns `confidence`, because one masked field on its own is genuinely
 * AMBIGUOUS: it is also the shape of "re-enter your password to confirm", the
 * sudo-mode prompt GitHub, Stripe and AWS all ship on destructive actions. What
 * separates them is that a sign-in form asks WHO you are as well — an email,
 * username or tel field beside the password — or posts to a login-adjacent
 * action. With neither, the caller reports a NOTE and keeps running rather than
 * aborting a healthy run; see verifyAuth. (A "welcome back, alice@x.com" screen
 * with a remembered user and no form action lands in the ambiguous bucket and is
 * therefore missed. That is the fail-open side of the trade.)
 *
 * A login-adjacent `action` never PROMOTES past the shape rules — that would
 * abort on a change-password form posting to /api/auth/password.
 *
 * `otp` is judged far more narrowly than a password: a one-time-code prompt on an
 * authenticated page is normal (2FA step-up, email confirmation), so it only
 * counts as sign-in when the form action says so.
 */
export function judgeLoginSignals(signals, { loginAdjacent } = {}) {
  if (!signals || !signals.total) return null;
  for (const s of signals.scopes) {
    if (s.count !== 1) continue;
    if (s.fresh) continue;
    const adjacent = !!(s.action && loginAdjacent && loginAdjacent.test(s.action));
    const otpOnly = !s.masked && s.current !== 1 && s.otp === 1;
    if (otpOnly && !adjacent) continue;
    if (!otpOnly && !s.masked && s.current !== 1) continue;
    const why = [
      otpOnly ? '1 visible one-time-code field' : '1 visible password field',
      s.current ? 'autocomplete=current-password' : null,
      s.identifiers ? `${s.identifiers} identifier field(s) beside it` : null,
      adjacent ? `form action ${s.action}` : null,
      signals.inShadow ? 'inside a shadow root' : null,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      why,
      sample: s.sample,
      confidence: s.identifiers > 0 || adjacent ? 'sign-in' : 'ambiguous',
    };
  }
  return null;
}

/**
 * Fail-open by construction: only the PRESENCE of a field may ever fail
 * verification. A probe that cannot run (CSP, navigation mid-evaluate, detached
 * frame, a closed shadow root) costs a detection — back to the old behaviour —
 * and can never manufacture a false abort.
 *
 * THREE states, not two. A bare `null` meant "looked, found nothing" and "could
 * not look" were the same answer, and the caller rendered both as the positive
 * claim "no sign-in field visible" — a verified-sounding assertion about a check
 * that never executed, which is precisely the category of claim this package
 * exists to refuse.
 *
 * `pierced` is threaded out for the same reason: without the init script the
 * fallback query does not enter shadow roots, so a component app's login screen
 * is invisible and the report must not imply otherwise.
 */
async function sniffLogin(page, config) {
  const arg = { skipSelector: config.auth.loginSkipSelector || '' };
  const judgeArg = { loginAdjacent: config.network.loginAdjacent };
  try {
    let facts = await page.evaluate(loginSignalsInPage, arg);
    let hit = judgeLoginSignals(facts, judgeArg);
    if (!hit) {
      // One re-look, because a login modal can render a beat after settle.
      // settleMs is already the app's own "how long until quiet" number.
      await sleep(Math.min(config.timing.settleMs, 1000));
      facts = await page.evaluate(loginSignalsInPage, arg);
      hit = judgeLoginSignals(facts, judgeArg);
    }
    const pierced = !!(facts && facts.pierced);
    return hit ? { ...hit, pierced } : { clean: true, pierced };
  } catch {
    return { failed: true, pierced: false };
  }
}

/** The one-line `how` fragment for a probe outcome, honest about each state. */
function loginNote(r) {
  if (r.failed) return 'sign-in check did not run';
  if (!r.pierced) return 'no sign-in field visible (shadow roots NOT pierced)';
  return 'no sign-in field visible';
}

/**
 * Prove the session actually took effect. THIS IS THE POINT OF THE PACKAGE.
 *
 * A harness that seeds a session and then navigates without checking will, on
 * any app with a router guard, quietly test the LOGIN PAGE N times and report a
 * clean pass. That failure mode is not an edge case: it is the default outcome
 * of an expired token, and a green report from it is worse than no report.
 *
 * Default check when no `auth.verify` is supplied, TWO signals, both must pass:
 *  1. the browser is still on the path we asked for. Catches REDIRECT gating; a
 *     bounce to /login changes the path, so no app-specific selector is needed.
 *  2. no sign-in credential surface is rendered. Catches INLINE gating — an app
 *     that shows a login modal or a <Login/> component at the SAME url, which
 *     signal 1 is structurally blind to. Very common, and it let the monkey
 *     hammer a login form for 40 steps under the report line "session verified".
 *     Keys on credential INPUTS, so a passwordless sign-in screen (magic link,
 *     OAuth-only, passkey) is not covered — the absence of a hit is not proof of
 *     arrival, which is why signal 1 is ANDed with it rather than replaced by it.
 *
 * Returns { ok, how, landedPath, detail?, signals? }. `how` stays short enough
 * for the report's one-line `- session:` row; prose goes in `detail`.
 */
export async function verifyAuth({ page, config, route, baseOrigin }) {
  // A user-supplied verify() stays AUTHORITATIVE. ANDing a heuristic onto it
  // would break every working config on upgrade. The probe still runs, demoted
  // to a note, so a verify() that is too weak is at least visible.
  if (typeof config.auth.verify === 'function') {
    let ok = false;
    try {
      ok = !!(await config.auth.verify(page));
    } catch (e) {
      return { ok: false, how: `auth.verify() threw: ${(e && e.message) || e}`, landedPath: pathOf(page.url()) };
    }
    const probe = ok ? await sniffLogin(page, config) : null;
    const hint = probe && probe.why ? probe : null;
    return {
      ok,
      how:
        'auth.verify()' +
        (hint
          ? ` — note: a sign-in field is also visible (${hint.why}); auth.verify() says authenticated, so the run continues`
          : ''),
      landedPath: pathOf(page.url()),
      signals: hint || undefined,
    };
  }

  const want = samePath(baseOrigin + route.path);
  const got = samePath(page.url());
  // Returned before the probe runs: a redirect is the more informative message,
  // and it saves an evaluate.
  if (got !== want) {
    return { ok: false, how: `landed-path check (wanted ${want}, got ${got})`, landedPath: got };
  }
  if (!config.auth.detectLoginScreen) return { ok: true, how: `landed on ${got}`, landedPath: got };

  const probe = await sniffLogin(page, config);
  if (probe.why && probe.confidence === 'sign-in') {
    return {
      ok: false,
      how: `inline-login check on ${got} — ${probe.why}`,
      detail:
        `The URL never changed, so the landed-path check alone could not see this: the app rendered its sign-in ` +
        `surface in place. Element: ${probe.sample}. If ${route.path} legitimately shows a single password field to a ` +
        `signed-in user, set auth.detectLoginScreen: false (or auth.loginSkipSelector) and re-run.`,
      landedPath: got,
      signals: probe,
    };
  }
  if (probe.why) {
    // AMBIGUOUS: one password field, no identifier beside it, no login-adjacent
    // action — indistinguishable from a "re-enter your password to confirm" prompt.
    // Reported, not fatal: aborting here fails a healthy run, and staying silent
    // hides a real login screen. Naming it does neither.
    return {
      ok: true,
      how: `landed on ${got} + 1 ambiguous password field (see note)`,
      detail:
        `A lone password field is visible (${probe.why}) but nothing beside it says sign-in — no identifier field and ` +
        `no login-adjacent form action — so it reads as a re-authentication prompt rather than a sign-in screen and the ` +
        `run continues. Element: ${probe.sample}. If this route IS gated inline, give the run an auth.verify() so the ` +
        `check is authoritative; if it is a confirm prompt, auth.loginSkipSelector silences this note.`,
      landedPath: got,
      signals: probe,
    };
  }
  return { ok: true, how: `landed on ${got} + ${loginNote(probe)}`, landedPath: got };
}

export const authStrategies = ['none', 'localStorage', 'storageState', 'cookies', 'custom'];
