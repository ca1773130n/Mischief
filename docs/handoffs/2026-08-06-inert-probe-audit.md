# The inert-control probe: what the first real measurement actually said

Written 2026-08-06, after re-adjudicating the measurement recorded in
`HypePaper/docs/handoffs/2026-08-02-mischief-migration-and-inert-control-measurement.md`
and auditing `src/inert.mjs` against it. Shipped in 0.2.1: one fix. Everything
else here is a lead, not a conclusion, and is labelled as such.

## The measurement was misread, in both directions

That handoff records **precision 0/1**: one accusation, adjudicated a false
positive. Two corrections.

**The accusation came from a contaminated run.** HypePaper walked its 13 routes
twice on 2026-08-02:

| run | mutators | accusations | routes entering at 0 clickable candidates |
| --- | --- | --- | --- |
| `20260802-190208` | incl. `slowNetwork`, `invalidInput` | 1 (false positive) | 8 of 13 |
| `20260802-202245` | stressors off | **0** | 0 of 13 — every route 26-62 |

The second run is the only valid measurement, and it accused **nothing**. So the
honest figure is **n = 0**, not 0/1: there is no precision number yet, and none of
the promotion gates (≥80% default-on · 50-80% opt-in forever · <50% delete) can be
applied. `/wiki/ask`, the accusing route, entered at **0** candidates in the
tainted run and **62** in the clean one.

**The stated mechanism was wrong.** The handoff attributes the false positive to
the clickable census admitting a `v-show` element hidden at `display:none`. It
cannot be that. A `display:none` element fails two independent gates: its
`getBoundingClientRect()` is 0×0 and is rejected at `src/probes/inpage.mjs:143`,
and `hitOk` requires `elementFromPoint` to resolve to the census element itself
(`src/probes/inpage.mjs:700-712`, enforced at `src/inert.mjs:206`). The accused
link was visible and was genuinely hit. **The real cause is still unproven** — see
the leads below.

A fix aimed at that stated mechanism was built, measured, and thrown away; the
record of why is worth more than the diff.

## Shipped in 0.2.1

**`closeRoute` discarded a disabled route's evidence along with its licence to
accuse.** `scoreRun` clears a control identity run-wide on one alive observation,
a guarantee stated without qualification, but it reads `o.inert === false`, and
`o.inert` was assigned only by the final resolution loop, which every gate
returned before reaching. A control proven alive on a shadow-blind, capped, or
one-novel-signature-short route carried no proof and stayed accusable from a
quieter route. Confirmed against `20260802-190208`: **three** controls had alive
proof thrown away. Gates now decide only whether a route may accuse. The change
can only add identities to the cleared set, so it moves verdicts toward ALIVE
only.

## Rejected: a gate on `atEnter === 0 && checks > 0`

The idea: a route whose entry census found nothing to click, yet judged clicks
anyway, has an idle baseline describing a page that had not rendered. Replayed
over both runs it looked ideal, killing the false positive and changing nothing on
the clean run. **It is wrong.** Four end-to-end fixtures (real Chromium, default
config) say so:

| fixture | `atEnter` | judged | currently | gate |
| --- | --- | --- | --- | --- |
| disabled-until-valid form + dead submit | 0 | 43 | names it, correctly | **deletes the finding** |
| controls at y=1600 + dead CTA | 0 | 17 | names it, correctly | **deletes the finding** |
| collapsed `<details>` + dead option | 3 | 30 | names it | unaffected |
| plain page + dead button | 2 | 40 | names it | unaffected |

`atEnter === 0` has benign causes that have nothing to do with render timing. The
default `clickableSelector` does not match a bare `<input>`; `disabled` controls
are rejected at `inpage.mjs:141`; and the census is viewport-clipped, so a
below-fold control counts as absent until `keyboardSpam`'s PageDown reveals it.
"Save disabled until dirty" is the dominant real-world shape of exactly the screen
where a dead submit is the highest-value bug. The gate was anti-correlated with
the probe's value.

The causal story behind it was also backwards: an **empty** churn baseline biases
toward ALIVE, not dead, because `novel = after.sigs − churn` (`inert.mjs:213`)
makes every mutation novel when there is nothing to subtract. An under-learned
baseline is the safe direction; the file says so at `inert.mjs:84-85`.

## Leads, unverified — do not treat as findings

Each is one agent's reading of the source, with a plausible mechanism and no
measurement behind it. The `everAlive` defect above came from the same sweep and
did survive checking against run data, so the batch is worth working; that is the
strongest claim available for any of them.

1. **`inert.mjs:299-316`: debounced requests may be attributed to the wrong
   click.** Attribution is to the nearest *preceding* click, but
   `deadControlGraceMs` (400ms) exceeds the gap between consecutive clicks, so a
   request fired 300ms after click *N* can land when *N+1* has already opened. The
   true issuer would be accused while an innocent later control is cleared
   run-wide. Highest-value lead: it fits `/wiki/ask` (a nav link whose route chunk
   resolves late).
2. **`inert.mjs:213`: the DOM channel gets no grace, and records it misses are
   destroyed rather than marked unknown.** `novel` reads `after.sigs` only; the
   next step's pre-click read resets the in-page bag at `inpage.mjs:736-740`, and
   `judgeStep` never reads `pend.before.sigs`. An effect landing after the 150-400ms
   step pause is drained and never compared, leaving `quiet = true`. Deterministic,
   so the unanimity rule offers no protection. Note the asymmetry the source itself
   documents at `inert.mjs:236-238`: the network channel gets grace *because*
   handlers debounce, and the DOM channel gets none.
3. **`inert.mjs:267`: the shadow suppressor reads the frozen enter-time census.**
   `shadowAtEnter || shadow` short-circuits on the enter object, which is truthy
   once `collectClickable` succeeded, so the fresher per-click reading that
   `guardrails.mjs:41` maintains is dead code for this gate. Custom elements that
   upgrade after route entry never disable the route.
4. **`inert.mjs:104,121`: ambient over-learning.** `reqFrom` is taken at baseline
   start, so every URL requested during the baseline windows becomes ambient. On a
   route still loading during the baseline — precisely the `atEnter === 0` routes —
   the page's own in-flight data fetches are the endpoints its controls hit, and
   the network veto is permanently disabled for them. This is the other lead that
   fits `/wiki/ask`.
5. **`inert.mjs:232`: `obsDropped` is written and never read.** Past `obsCap`,
   `judgeStep` still increments `checks`/`liveClicks`, then returns without
   pushing. The route keeps its licence to accuse on evidence it discarded, and a
   dropped ALIVE observation cannot clear an identity.
6. **`inpage.mjs:867-878`: signature collision across renderings.** `sigOf` keys
   on three levels of tag + `#id` + child index, so a skeleton writing text at the
   same structural position as a real post-render effect baselines it away.

## What would actually produce a precision number

Nothing here changes the fact that the number does not exist. The prerequisites
are unchanged from the 2026-08-02 handoff (HypePaper's `qa/` is wired, and the
`:8001` backend workaround gives it a healthy API), with one addition learned
since: **run with `slowNetwork` and `invalidInput` off.** Both were shown to
manufacture artefacts that were then read as app findings, and the tainted run is
the only one that has ever produced an accusation to adjudicate.

A run that accuses nothing is not a pass. If the clean configuration keeps
returning zero across more apps, the honest conclusion is that the probe is too
conservative to earn its wall clock, and the `< 50%` delete gate was never the
binding one.
