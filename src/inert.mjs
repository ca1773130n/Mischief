// Dead-control detection — "after that click, did ANYTHING change?"
//
// Mischief has no assertion layer and cannot grow one: knowing that "Save" saved
// requires app semantics this harness does not have. A control wired to nothing
// therefore raises no exception, answers 200, logs nothing and leaves every other
// field of the route stats empty — it passes clean. That is a common real bug and
// it is invisible here by construction. Absence of effect is the only signal
// available without semantics, which is the whole reason this file exists.
//
// It is also the easiest signal in this package to get wrong in BOTH directions,
// and both were measured rather than reasoned about. On an adversarial page (a
// 100ms text clock, a 500ms innerHTML re-render, a CSS animation and an 800ms
// poll) carrying eight controls of known ground truth, three reps each:
//
//   channel                    false accusations, of 6 healthy controls
//   DOM-mutation novelty       3
//   DOM/text/scroll signature  5
//   network + URL              5
//
// Every one of them, shipped alone, is unusable. Each is also blind exactly where
// another sees: the network channel is the only thing that rescues a fetch-only
// control, and the DOM channel is the only thing that rescues a client-only one.
// The UNION — alive if ANY channel fires — brings that to a single false
// accusation, on a control whose only effect writes the same node the clock
// writes, and it still accused the genuinely dead button on all three reps
// through all that churn.
//
// So: every channel here is a VETO, never a vote. Every ambiguity resolves to
// ALIVE. Three gates must all pass before a route may accuse anything at all, and
// the finding is 'low' and opt-in. Read the exit-code containment note in
// severity.mjs before changing any of that.

import { readInert } from './probes/index.mjs';
import { samePath, sleep, stripQuery } from './util.mjs';

/** Is the probe on for this run? */
export const inertOn = (config) => !!(config.probes && config.probes.deadControls);

/**
 * Only these two mutators dispatch one discrete click at a target this harness
 * can name.
 *
 * Everything else is excluded for a structural reason, not for tuning:
 * refresh/randomBack ARE navigation, so the observable always fires;
 * mobileResize and slowNetwork touch no DOM and have their own signals;
 * offlineMode deliberately cuts the network (and calls randomClick internally,
 * which is why the offlineWindow suppressor below is not redundant);
 * keyboardSpam presses keys into whatever happens to have focus; and
 * invalidInput's fill() writes the value PROPERTY, which raises no mutation
 * record at all, so a perfectly working field would read as dead every step.
 */
const ELIGIBLE_MUTATORS = new Set(['randomClick', 'rapidDoubleClick']);

/**
 * Tags that are controls. `select` and `[tabindex]` are both in the default
 * guardrails.clickableSelector, and both are guaranteed false positives:
 * clicking a <select> opens native browser chrome, which produces zero DOM
 * mutations, zero requests and no URL change on every rep, and any focusable
 * non-interactive div is legitimately inert. Without this one check the loudest
 * finding on a healthy app is a working dropdown.
 */
const ELIGIBLE_TAGS = new Set(['a', 'button', 'input', 'summary']);
const eligibleTarget = (t) => ELIGIBLE_TAGS.has(t.tag) || t.role === 'button';

/** Query strings and id-like digit runs collapse, so /poll?t=1 and /poll/17 are one endpoint. */
export const normalizeReqUrl = (u) => stripQuery(u).replace(/\d+/g, '#');

/** Identity a finding can be reported under, stable across a re-render. */
export const controlKey = (t) => (t.id ? `#${t.id}` : `${t.tag}${t.role ? `[role=${t.role}]` : ''} "${t.text || ''}"`);

const controlLabel = (t) => `${t.tag}${t.id ? `#${t.id}` : ''}${t.text ? ` "${t.text}"` : ''}`;

// Bounded like every other list in the stats bag. A default 40-step route cannot
// reach this; a per-route steps override could.
const obsCap = (config) => Math.max(1, config.steps * 4);

/**
 * Spend the per-route settle window MEASURING idle churn instead of sleeping
 * through it.
 *
 * Costs no extra wall clock — it is the same timing.settleMs, sampled. Split
 * into windows rather than unioned into one because a signature seen in exactly
 * one window is a one-shot hydration artifact, and baselining those away is how a
 * real effect that happens to land on the same subtree becomes permanently
 * invisible. A bigger baseline means MORE dead verdicts, so churn must RECUR.
 */
export async function sampleBaseline(page, ps, config) {
  const p = config.probes;
  const n = Math.max(1, p.deadControlBaselineWindows);
  // Decoupled from timing.settleMs. Sharing it gave 4 windows of 375ms, which can
  // only ever learn a timer faster than ~375ms — so the ordinary 0.5-3s poll was
  // never baselined, fired inside judged windows instead, and rescued dead
  // controls as "something changed". The probe went quiet on exactly the apps it
  // was built for. This costs real wall clock per route, which an opt-in
  // diagnostic can afford and a default-on one could not.
  // Never shorter than the settle this replaces: other probes read the page after
  // it and a shortened settle would degrade them to buy this one nothing.
  const total = Math.max(p.deadControlBaselineMs, config.timing.settleMs);
  const each = Math.max(1, Math.round(total / n));
  const seen = new Map();
  // Only traffic from HERE ON is ambient. Previously the whole of ps.reqLog was,
  // which meant every URL the page load touched disabled the network veto for
  // itself — a control calling its own app's API was judged on DOM alone.
  const reqFrom = ps.reqLog.length;
  await readInert(page, ps, null); // drain whatever the load itself produced
  for (let i = 0; i < n; i++) {
    await sleep(each);
    const r = await readInert(page, ps, null);
    if (!r) return; // probeFailed is set; this route is UNKNOWN, never "dead"
    ps.inert.baselineWindows++;
    ps.inert.roots = r.roots;
    if (r.capped) ps.inert.capped = true;
    for (const s of new Set(r.sigs)) seen.set(s, (seen.get(s) || 0) + 1);
  }
  // ONE sighting is enough. Nothing was clicked during these windows, so anything
  // that moved is ambient by construction; requiring two was a confidence test the
  // situation does not call for, and it is what let slow timers through.
  ps.inert.churn = [...seen.keys()];
  // Anything the page asked for while nobody was touching it is ambient by
  // definition: polling, analytics, HMR heartbeats, route prefetch.
  for (const r of ps.reqLog.slice(reqFrom)) if (!ps.inert.ambient.includes(r.u)) ps.inert.ambient.push(r.u);
}

/**
 * Record what is about to be clicked, and take the "before" reading.
 *
 * Called from chooseClickPoint — the single funnel every click in this package
 * passes through — and BEFORE mouse.click, never from log(), which runs after the
 * click has resolved and a synchronous handler's fetch has already fired.
 *
 * Draws no ctx.rng(), so every recorded seed still replays identically. See the
 * same warning at guardrails.mjs and in rng.mjs.
 */
export async function markClick(ctx, pick) {
  const st = ctx.state;
  st.pendingClick = null;
  const ps = st.ps;
  if (!ps || !ps.inert) return;
  // Short-circuit before the round trip: a <select> or a [tabindex] div is never
  // judged, so reading the page for it is a CDP call per click for nothing.
  if (!eligibleTarget(pick)) return;
  const before = await readInert(ctx.page, ps, { x: pick.x, y: pick.y, ci: pick.ci });
  if (!before) return;
  st.pendingClick = {
    t: Date.now(),
    key: controlKey(pick),
    label: controlLabel(pick),
    tag: pick.tag,
    role: pick.role || '',
    url: samePath(ctx.page.url()),
    dialogs: ps.inert.dialogs,
    popups: ps.inert.popups,
    // Sampled HERE, not in judgeStep. The step loop decrements
    // slowStepsRemaining BEFORE the pause the verdict is read after, so on the
    // LAST throttled step of a slowNetwork window the flag has already gone back
    // to 0 by the time judgeStep looks — and that step is precisely the one where
    // a slow backend has not answered yet.
    degraded: st.offlineWindow || st.slowStepsRemaining > 0 || st.rateLimitPauseMs > 0,
    before,
  };
}

/**
 * Judge one completed step. Called from the step loop AFTER the existing step
 * pause, which is a 150-400ms settle window the run already pays for — reading
 * before it would give a zero-length window and report async work as absent.
 */
export async function judgeStep(ctx, mutatorName, threw) {
  const st = ctx.state;
  const pend = st.pendingClick;
  st.pendingClick = null;
  const ps = st.ps;
  if (!ps || !ps.inert || !pend) return;

  // Suppressors. Every one of these is a window the HARNESS opened, in which a
  // click legitimately changes nothing — the same distinction collect.mjs already
  // draws for console errors, request failures and slow requests.
  if (threw) return; // a step that threw is already a finding; it is not evidence of deadness
  if (!ELIGIBLE_MUTATORS.has(mutatorName)) return;
  if (!eligibleTarget(pend)) return;
  // offline: nothing can change with the network cut — and offlineMode fires a
  // randomClick inside exactly that window. Slow-3G: the app may simply not have
  // answered yet. Rate limited: silence is the backend throttling this harness,
  // not a dead control. Checked at BOTH ends of the step, because a window can
  // open after the click was marked and close before the verdict is read.
  if (pend.degraded) return;
  if (st.offlineWindow || st.slowStepsRemaining > 0 || st.rateLimitPauseMs > 0) return;
  // mouse.click performs no actionability check and aims at the centre of the
  // VIEWPORT-CLIPPED rect, so a sticky header or overlay absorbs the click and the
  // element actually hit is not the one this finding would name.
  // IDENTITY, and it must be a positive confirmation.
  //
  // Two earlier versions of this guard were both wrong. Tag EQUALITY against the
  // innermost hit element dropped every `<button><span>Save</span></button>` —
  // the markup of every component library — so the probe was blind on real apps.
  // Tag CONTAINMENT over the ancestor chain fixed that and broke the other way:
  // any ancestor <a> satisfied it, so a click that landed on a DIFFERENT link
  // counted as a hit on the intended one, and a control the monkey never touched
  // was accused of being dead. That produced the only false positive the first
  // real-app run found.
  //
  // hitOk compares the exact node the census chose. Anything other than a
  // confirmed true — a miss, a stale census, a probe that could not tell — means
  // we do not know what was clicked, and a signal whose entire value is
  // trustworthiness must not accuse on a maybe.
  if (pend.before.hitOk !== true) return;
  if (pend.before.hit === 'canvas' || pend.before.hit === 'iframe') return;

  const after = await readInert(ctx.page, ps, null);
  if (!after) return; // probeFailed; the route is UNKNOWN and closeRoute will say so

  const churn = new Set(ps.inert.churn);
  const novel = after.sigs.filter((s) => !churn.has(s));
  // A window in which more distinct subtrees changed than the observer will track
  // is UNKNOWN, not quiet.
  const unknown = after.capped || pend.before.capped;
  if (unknown) ps.inert.capped = true;
  const changed =
    novel.length > 0 ||
    after.docId !== pend.before.docId || // a navigation IS the change
    after.frm !== pend.before.frm || // .value / .checked, which no observer sees
    after.opened !== pend.before.opened || // window.open, which this harness stubs
    after.scr !== pend.before.scr || // scrollTo and #anchor links raise no mutation
    ps.inert.dialogs !== pend.dialogs ||
    ps.inert.popups !== pend.popups ||
    samePath(ctx.page.url()) !== pend.url;

  ps.inert.checks++;
  if (novel.length > 0) ps.inert.liveSignatures++;
  if (changed || unknown) ps.inert.liveClicks++;

  if (ps.inert.obs.length >= obsCap(ctx.config)) {
    ps.inert.obsDropped++;
    return;
  }
  // The network channel is NOT resolved here: a debounced handler fires 300-500ms
  // after the click, i.e. after this pause ended. The window is stored and
  // resolved against ps.reqLog at route end.
  ps.inert.obs.push({
    key: pend.key,
    label: pend.label,
    t0: pend.t,
    tEnd: Date.now(),
    quiet: !changed && !unknown,
    inert: null,
  });
}

/**
 * Close the route: decide whether it may accuse ANYTHING, then resolve the
 * network veto over each recorded click window.
 *
 * Three gates, all required. Each one exists because without it the detector
 * accuses a control it structurally cannot see.
 */
export function closeRoute(ps, config) {
  const i = ps && ps.inert;
  if (!i) return;
  const p = config.probes;

  // (a) SHADOW. A document-level MutationObserver does not cross a shadow
  // boundary — measured: zero records for a shadow-internal textContent change.
  // On a Lit/Stencil/Ionic app that means EVERY click reads as dead. A hard
  // suppressor rather than something the liveness gate absorbs, because a route
  // holding both a light-DOM control and a shadow control passes the liveness
  // gate on the former and then falsely accuses the latter.
  const sh = (ps.clickable && (ps.clickable.shadowAtEnter || ps.clickable.shadow)) || null;
  if (!p.deadControlObserveShadowRoots && sh && (sh.openRoots > 0 || sh.closedSuspects > 0)) {
    i.disabled =
      `${sh.openRoots} open and ${sh.closedSuspects} suspected-closed shadow root(s) are present, and the mutation ` +
      `observer cannot see inside them — a control that works inside one would read as dead ` +
      `(probes.deadControlObserveShadowRoots: true observes them without changing the app's shadow modes)`;
    return;
  }
  if (i.probeFailed) {
    i.disabled = 'the in-page observer could not be read on this route, so absence of change is UNKNOWN rather than observed';
    return;
  }
  if (i.capped) {
    i.disabled = `more distinct DOM subtrees changed than probes.deadControlMaxSignatures (${p.deadControlMaxSignatures}) tracks, so the idle baseline cannot be trusted`;
    return;
  }
  if (i.unknown) {
    i.disabled = `the request log hit probes.deadControlMaxRequests (${p.deadControlMaxRequests}), so a request that would have proved a control live may never have been recorded`;
    return;
  }
  if (!i.checks) return; // nothing eligible was clicked here; that is not a failure
  // (b) LIVENESS. Proof the instrument can see THIS app before any accusation
  // from it is admissible. Novel signatures specifically, not any channel: a
  // route where only navigation and form state ever fired says nothing about
  // whether the DOM channel works here.
  if (!i.liveSignatures) {
    i.disabled =
      `no click on this route produced a DOM change the observer had not already seen while idle, so it cannot be ` +
      `shown to see this app at all (${i.checks} click(s) judged, ${i.churn.length} idle churn signature(s))`;
    return;
  }

  // Each request belongs to exactly ONE click: the most recent one whose window
  // still covers it. Click windows OVERLAP by construction — the grace is longer
  // than the step pause — and an inclusive attribution was measured to make two
  // errors from a single request. On the fixture in test/verdict.test.mjs one
  // POST /save, issued by the one control that issues it, fell inside three
  // consecutive windows: that alone met the "requested under 3 distinct targets"
  // test, so the endpoint was declared background traffic and stopped rescuing
  // the control it belonged to — while simultaneously being able to rescue the
  // genuinely dead button clicked two steps EARLIER. Attribution to the nearest
  // preceding click is also simply the causal answer.
  const grace = p.deadControlGraceMs;
  const owned = i.obs.map(() => []);
  for (const r of ps.reqLog) {
    let k = -1;
    for (let n = 0; n < i.obs.length; n++) if (i.obs[n].t0 <= r.t) k = n; // obs is chronological
    if (k < 0 || r.t > i.obs[k].tEnd + grace) continue;
    owned[k].push(r.u);
  }

  // A URL requested under many DISTINCT targets is background traffic, not any
  // one control's effect. Without this, an 800ms poll rescues every dead button.
  const byUrl = new Map();
  i.obs.forEach((o, n) => {
    for (const u of new Set(owned[n])) {
      const keys = byUrl.get(u) || new Set();
      keys.add(o.key);
      byUrl.set(u, keys);
    }
  });
  for (const [u, keys] of byUrl) {
    if (keys.size >= p.deadControlAmbientTargets && !i.ambient.includes(u)) i.ambient.push(u);
  }
  const ambient = new Set(i.ambient);
  i.obs.forEach((o, n) => {
    o.inert = o.quiet && !owned[n].some((u) => !ambient.has(u));
  });
}

/**
 * Score the whole run, once, after every route has closed.
 *
 * Run-level rather than per-route because shared chrome is clicked on every
 * route, and a header button proved live on /a is not dead on /b. Doing this at
 * the end also makes the verdict independent of route ORDER, which a
 * clear-as-you-go rule would not be.
 */
export function scoreRun(statsList, config) {
  const min = Math.max(1, config.probes.deadControlMinObservations);
  // One alive observation ANYWHERE clears an identity for the whole run.
  // Identity collisions merge, and because any alive observation clears, a
  // collision can only ever suppress a finding — the safe direction.
  const everAlive = new Set();
  for (const ps of statsList) {
    for (const o of (ps.inert && ps.inert.obs) || []) if (o.inert === false) everAlive.add(o.key);
  }
  for (const ps of statsList) {
    const i = ps && ps.inert;
    if (!i || i.disabled) continue;
    const g = new Map();
    for (const o of i.obs) {
      if (o.inert !== true || everAlive.has(o.key)) continue;
      const e = g.get(o.key) || { key: o.key, label: o.label, count: 0 };
      e.count++;
      g.set(o.key, e);
    }
    // UNANIMITY. One observation is a coincidence — a click absorbed by an
    // overlay, a handler that raced the settle. The finding says "every time",
    // so it has to have looked more than once.
    for (const e of g.values()) if (e.count >= min) i.hits.push(e);
  }
}
