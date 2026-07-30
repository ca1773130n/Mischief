import path from 'node:path';
import { stripQuery, trunc } from './util.mjs';

/**
 * Default response classification.
 *
 * 5xx is the server's fault and always critical. 402/403 mean "you are not
 * entitled to this" and 401 on a login-adjacent URL means "you are not signed
 * in" — those are GATES, expected behaviour that would otherwise drown the 4xx
 * section in noise on any app with plans or permissions. Everything else 4xx is
 * a high finding.
 *
 * Override via `network.classifyResponse` if your app disagrees.
 */
export function defaultClassifyResponse({ status, url }, config) {
  if (status < 400) return 'ignore';
  if (status >= 500) return 'critical';
  if (status === 402 || status === 403) return 'gate';
  if (status === 401 && config.network.loginAdjacent.test(url)) return 'gate';
  return 'high';
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

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (ignore.some((re) => re.test(text))) return;
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
  page.on('request', (r) => reqStart.set(r, Date.now()));
  page.on('requestfinished', (r) => {
    const t0 = reqStart.get(r);
    reqStart.delete(r);
    if (!t0) return;
    const ms = Date.now() - t0;
    if (ms > config.network.slowRequestMs && state.ps.slowRequests.length < 100) {
      // `throttled` matters: a 12s request during a deliberate Slow-3G window is
      // the harness's own doing, not a finding.
      state.ps.slowRequests.push({ url: trunc(stripQuery(r.url()), 200), ms, throttled: state.slowStepsRemaining > 0 });
    }
  });
  page.on('requestfailed', (r) => {
    reqStart.delete(r);
    if (state.ps.requestFailures.length >= 300) return;
    state.ps.requestFailures.push({
      url: trunc(stripQuery(r.url()), 200),
      failure: (r.failure() && r.failure().errorText) || 'unknown',
      offline: state.offlineWindow, // failures we caused by going offline are tagged, not reported
    });
  });

  page.on('response', (res) => {
    try {
      const url = res.url();
      // Third-party analytics and CDN noise is not this app's bug.
      if (!url.startsWith(baseOrigin)) return;
      const status = res.status();
      if (status < 400) return;
      const rec = { method: res.request().method(), url: trunc(stripQuery(url), 200), status, action: lastActionDesc(state) };
      const verdict = classify({ status, url, method: rec.method });
      if (verdict === 'critical') state.ps.net5xx.push(rec);
      else if (verdict === 'gate') state.gates.push({ ...rec, page: state.currentRoutePath });
      else if (verdict === 'high') state.ps.net4xx.push(rec);
    } catch {}
  });
}
