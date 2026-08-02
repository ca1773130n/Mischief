import path from 'node:path';
import { normalizeReqUrl } from './inert.mjs';
import { pathOf, stripQuery, trunc } from './util.mjs';

/**
 * Default response classification.
 *
 * 5xx is the server's fault and always critical. 402/403 mean "you are not
 * entitled to this" and 401 on a login-adjacent URL means "you are not signed
 * in" — those are GATES, expected behaviour that would otherwise drown the 4xx
 * section in noise on any app with plans or permissions. Everything else 4xx is
 * a high finding.
 *
 * `watched` is false for a response from an origin outside
 * [baseOrigin, ...network.watchOrigins] — third-party analytics and CDN noise is
 * not this app's bug, so the default ignores it. Add your API's origin to
 * network.watchOrigins to have it judged; override this whole function via
 * `network.classifyResponse` if your app disagrees.
 */
export function defaultClassifyResponse({ status, url, watched = true }, config) {
  if (status < 400) return 'ignore';
  if (!watched) return 'ignore';
  if (status >= 500) return 'critical';
  if (status === 402 || status === 403) return 'gate';
  if (status === 401 && config.network.loginAdjacent.test(url)) return 'gate';
  // 429 is not an app bug. It is this harness clicking faster than the backend
  // will answer, and reporting it as 'high' both blamed the app for load the
  // monkey generated and — because HIGH is exit 1 — failed the run for it.
  if (status === 429) return 'throttled';
  return 'high';
}

/**
 * Widen the step pause after a 429 so the monkey stops outrunning the backend.
 *
 * Sticky and session-wide at the highest value seen — it never decays. One
 * throttled route therefore slows every route after it, which is deliberate: the
 * alternative re-discovers the limit on each new route by generating fresh 429s
 * against a backend that has already said no.
 *
 * ponytail: no decay, and Retry-After is honoured only in its seconds form. If a
 * long run ends up over-paced by one early burst, decay per route before making
 * the escalation cleverer.
 */
export function backOff(state, retryAfter, config) {
  const t = config.timing;
  const hinted = Number(retryAfter);
  const next =
    Number.isFinite(hinted) && hinted > 0
      ? hinted * 1000
      : state.rateLimitPauseMs
        ? state.rateLimitPauseMs * 2
        : t.rateLimitBackoffMs;
  state.rateLimitPauseMs = Math.min(Math.max(state.rateLimitPauseMs || 0, next), t.rateLimitMaxPauseMs);
}

function lastActionDesc(state) {
  const a = state.actionLog[state.actionLog.length - 1];
  return a ? `${a.mutator} ${a.target}`.trim() : 'page-load';
}

/**
 * Wire every passive collector. Must run BEFORE the first navigation, otherwise
 * the first page's console output and requests are lost.
 */
export function wireCollectors(page, state, baseOrigin, config) {
  const ignore = config.network.consoleIgnore || [];
  const cap = config.report.consoleCap;
  const classify = config.network.classifyResponse || ((rec) => defaultClassifyResponse(rec, config));
  const watched = config.watchedOrigins || [baseOrigin];
  const deadControls = !!config.probes.deadControls;

  // Both listeners exist ONLY for the dead-control probe, and both are gated so a
  // run with the probe off behaves exactly as it did before.
  //
  // The dialog one is a deliberate behaviour change worth reviewing: with no
  // listener registered Playwright auto-dismisses every dialog, so this handler
  // dismisses too and the app under test sees the same thing it always did. It is
  // here because a control whose only effect is alert() leaves NO trace in any
  // other channel — no DOM record, no request, no URL change — and would be
  // accused every time.
  if (deadControls) {
    page.on('dialog', (d) => {
      state.ps.inert.dialogs++;
      d.dismiss().catch(() => {});
    });
    // Independent of guardrails.closePopups, which returns early when popups are
    // not being closed: a counter registered there would be dead in that config.
    page.on('popup', () => state.ps.inert.popups++);
  }

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (ignore.some((re) => re.test(text))) return;
    // A console error logged while the harness holds the connection offline is
    // the offlineMode mutator's own doing — ERR_INTERNET_DISCONNECTED is what it
    // exists to provoke. requestFailures have carried an `offline` tag from the
    // start; console output did not, so the same self-inflicted event was a
    // finding in one channel and noise in the other.
    if (state.offlineWindow) return;
    const bucket = type === 'error' ? state.ps.consoleErrors : state.ps.consoleWarnings;
    // Cap, then COUNT the rest. A storm of one repeated error must not blow up
    // memory, and must not be silently invisible either.
    if (bucket.length < cap) bucket.push(trunc(text, 500));
    else state.ps.consoleDropped[type]++;
  });

  page.on('pageerror', (err) => {
    const rec = {
      message: trunc(String((err && err.message) || err), 500),
      stack: ((err && err.stack) || '').split('\n').slice(0, 10).join('\n'),
      duringOffline: state.offlineWindow,
      action: lastActionDesc(state),
      // The last 10 actions are the only thing that makes a monkey-found
      // exception reproducible by hand.
      tail: state.actionLog.slice(-10),
      shot: null,
    };
    state.ps.jsExceptions.push(rec);
    if (state.errShots < config.report.maxErrorScreenshots) {
      const n = ++state.errShots;
      const p = path.join(state.shotsDir, `err-${n}.jpeg`);
      rec.shot = path.relative(state.outDir, p);
      page.screenshot({ path: p, type: 'jpeg', quality: 60 }).catch(() => {});
    }
  });

  const reqStart = new Map();
  page.on('request', (r) => {
    const t = Date.now();
    reqStart.set(r, t);
    // Piggy-backed on the listener that already exists — the dead-control probe
    // needs to know a request was ISSUED, which costs nothing here and would cost
    // a second listener anywhere else. Timestamped rather than counted because a
    // debounced handler fires after the step pause has already ended.
    if (!deadControls) return;
    if (state.ps.reqLog.length >= config.probes.deadControlMaxRequests) {
      state.ps.reqLogDropped++;
      // Cap, then COUNT — and mark the route UNKNOWN, because a request that was
      // never recorded cannot prove a control live, and the missing evidence
      // points one way only: toward calling a working control dead.
      state.ps.inert.unknown = true;
      return;
    }
    state.ps.reqLog.push({ t, u: normalizeReqUrl(r.url()) });
  });
  page.on('requestfinished', (r) => {
    const t0 = reqStart.get(r);
    reqStart.delete(r);
    if (!t0) return;
    const ms = Date.now() - t0;
    if (ms <= config.network.slowRequestMs) return;
    // Cap, then COUNT the drops, exactly like consoleCap above. These caps used to
    // discard silently, so a storm past the cap read as "only 100 slow requests".
    if (state.ps.slowRequests.length >= config.report.slowRequestCap) {
      state.ps.slowRequestsDropped++;
      return;
    }
    // `throttled` matters: a 12s request during a deliberate Slow-3G window is
    // the harness's own doing, not a finding.
    state.ps.slowRequests.push({ url: trunc(stripQuery(r.url()), 200), ms, throttled: state.slowStepsRemaining > 0 });
  });
  page.on('requestfailed', (r) => {
    reqStart.delete(r);
    if (state.ps.requestFailures.length >= config.report.requestFailureCap) {
      state.ps.requestFailuresDropped++;
      return;
    }
    state.ps.requestFailures.push({
      url: trunc(stripQuery(r.url()), 200),
      failure: (r.failure() && r.failure().errorText) || 'unknown',
      offline: state.offlineWindow, // failures we caused by going offline are tagged, not reported
    });
  });

  page.on('response', (res) => {
    try {
      const url = res.url();
      const status = res.status();

      // Liveness, counted BEFORE the <400 early return — successes are the whole
      // signal and nothing else records them. A subtree that answered every
      // request with 5xx and never once succeeded is a dependency that is down,
      // not an app with bugs: a dev server proxying /api to a backend nobody
      // started reports one CRITICAL per endpoint and exit 2, blaming the app
      // for the environment.
      //
      // Scoped to origin + FIRST PATH SEGMENT, not origin alone. Under a proxy
      // the dead backend never appears as its own origin — the browser only
      // ever talks to the dev server, which is serving pages perfectly well —
      // so origin-level liveness sees a healthy host with a few broken routes
      // and cannot tell the two apart. The segment is taken from observed
      // traffic, never assumed: '/api' emerges because that is what the app
      // requested, and an app that mounts its backend elsewhere gets whatever
      // it actually uses. 5xx is the only failure counted; a 404 means the
      // server is alive and answering, which is what this is establishing.
      const origin = watched.find((o) => url.startsWith(o));
      if (origin) {
        const key = origin + '/' + (pathOf(url).split('/')[1] || '');
        const s = state.originStats[key] || (state.originStats[key] = { ok: 0, fail: 0 });
        if (status >= 500) s.fail++;
        else s.ok++;
      }

      if (status < 400) return;
      // Everything reaches classify(), including cross-origin. Returning early on
      // `!url.startsWith(baseOrigin)` made network.classifyResponse — documented as
      // the override — structurally unable to see the API of any app whose API is
      // not on the app's own origin, which is the common dev layout. Such an app
      // reported zero 4xx/5xx however hard its API was failing.
      const rec = {
        method: res.request().method(),
        url: trunc(stripQuery(url), 200),
        status,
        action: lastActionDesc(state),
        watched: watched.some((o) => url.startsWith(o)),
      };
      const verdict = classify({ status, url, method: rec.method, watched: rec.watched });
      if (verdict === 'critical') state.ps.net5xx.push(rec);
      else if (verdict === 'gate') state.gates.push({ ...rec, page: state.currentRoutePath });
      else if (verdict === 'throttled') {
        state.ps.rateLimited.push(rec);
        backOff(state, res.headers()['retry-after'], config);
      } else if (verdict === 'high') state.ps.net4xx.push(rec);
    } catch {}
  });
}
