# Why this exists

A QA harness that reports a clean pass on a page it never loaded is worse than
having no harness at all. That is the whole idea. Everything else in this package
is downstream of it.

## What happened

The harness this was extracted from ran nightly against an app where 7 of its 10
routes sat behind a router guard. The session it used had expired. With no session,
the guard bounced every one of those routes to the marketing page. So the harness
clicked around the marketing page, ten times a night, and reported what it honestly
saw: no exceptions, no 5xx, clean pass.

It had never once loaded the feature it was supposed to be testing.

Nobody noticed, because the report said everything was fine. In the meantime, 22.8%
of the rows in one comparison table were rendering raw LaTeX — `\frac` and friends,
straight through to the user's screen. Every automated run scored it green. A human
found it, months later, by looking at the page.

Two failures, one cause. The harness could not tell the difference between "I tested
this and it was fine" and "I never got there." It had no way to say *I don't know*.

## What we did about it

Give the harness a way to refuse.

A run that cannot prove it reached the pages it asked for exits 3 and titles its
report NOT VERIFIED. Not a warning buried in the output — a different exit code,
so a CI job can tell a broken runner from a broken app. There are now six distinct
ways a run can be forced to admit it proved nothing: every route skipped, every
route unreachable, a `baseUrl` with nothing listening, a candidate scan that threw
so coverage is unknown rather than zero, every completed step a no-op, a session
that was seeded but never verified.

That list grew because we went looking for holes and kept finding them. Each one
was a path to a green report on a run that tested nothing.

The seeding — one integer, one replayable walk — exists so that when the thing does
find a bug, you can hand someone a command instead of a story.

## Why build it now, with agents around

You can point an agent at a browser and it will test better than this in most of
the ways that matter. It reads the screen. It knows what the page was supposed to
say. It gets through a checkout wizard. This package does none of that and never
will.

What it does is run 200 steps a night for free, in a real browser, with the network
throttled and the connection dropped, and refuse to say "pass" unless it can show
its work. An agent can't do the cheap part — a few hundred snapshot-bearing tool
calls per run is real money, every night, forever. And an agent grades its own
homework: ask it whether the session took effect and it will tell you yes.

So the two are not alternatives. This is the layer underneath: cheap, deterministic,
running unattended, gating CI on an exit code. The agent reads its report and chases
what needs judgment.

## Why it is small

Because the interesting part is the refusal, not the chaos. Random clicking is old —
Android's `monkey` had a `-s` seed flag a decade ago, and gremlins.js did this in
the browser in 2013. What nobody built is a harness that treats its own coverage as
something to be proven rather than assumed.

That idea does not need a platform, an account, or a service. It needs one npm
package, one config file, and an exit code.
