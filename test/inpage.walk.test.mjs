// The drift guard that makes duplication safe.
//
// qaWalk cannot be a shared module helper: every function in probes/inpage.mjs is
// serialized into the page by page.evaluate() and would lose a module-scope
// reference. So it is copy-pasted into four probes, and this test is the only
// thing standing between that and four subtly different traversals — which would
// mean the a11y probe and the click probe disagreeing about what is on the page,
// with no test failing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  a11yPassInPage,
  brokenImagesInPage,
  gatherCandidatesInPage,
  textPatternsInPage,
} from '../src/probes/inpage.mjs';

const START = '/* @qa-walk */';
const END = '/* @qa-walk-end */';

const COPIES = {
  gatherCandidatesInPage,
  textPatternsInPage,
  a11yPassInPage,
  brokenImagesInPage,
};

function extract(fn) {
  const src = fn.toString();
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  assert.ok(a >= 0 && b > a, `${fn.name} has no ${START} … ${END} block`);
  return src.slice(a + START.length, b);
}

test('every copy of qaWalk is byte-identical', () => {
  const [first, ...rest] = Object.entries(COPIES);
  const reference = extract(first[1]);
  assert.ok(reference.includes('function qaWalk('), 'the marked block must be the walk itself');
  for (const [name, fn] of rest) {
    assert.equal(extract(fn), reference, `qaWalk in ${name} has drifted from ${first[0]}`);
  }
});

test('the walk is self-contained — one definition, no module references', () => {
  for (const [name, fn] of Object.entries(COPIES)) {
    const src = fn.toString();
    assert.equal(src.split('function qaWalk(').length - 1, 1, `${name} must define qaWalk exactly once`);
    // A serialized function cannot import; if this ever appears the probe throws
    // in-page and safeEval swallows it into a silent "found nothing".
    assert.ok(!/\bimport\b/.test(src), `${name} must not reference import`);
  }
});

test('the traversal order rule is present, not accidentally inverted', () => {
  // Push order IS the replay key: children pushed in reverse so they pop in DOM
  // order, shadow children pushed last so they pop first. Swapping either line
  // silently changes every seeded pick, so pin the two lines that encode it.
  const src = extract(gatherCandidatesInPage);
  const kids = src.indexOf('for (let i = kids.length - 1; i >= 0; i--)');
  const shadow = src.indexOf('const sk = sr.children;');
  assert.ok(kids > 0, 'light children must be pushed in reverse');
  assert.ok(shadow > kids, 'the shadow tree must be pushed AFTER the light children, so it pops FIRST');
});
