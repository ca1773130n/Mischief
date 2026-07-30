import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, deriveStepRng, pickWeighted } from '../src/rng.mjs';

test('mulberry32 is deterministic for a given seed', () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('mulberry32 seed 1 matches the pre-extraction harness byte for byte', () => {
  // Frozen so a "harmless" refactor of the PRNG cannot silently invalidate
  // every seed recorded in an existing report. These five values were produced
  // by running the original qa/monkey.mjs implementation side by side with this
  // one; they are measured, not chosen.
  const r = mulberry32(1);
  const got = Array.from({ length: 5 }, () => r());
  assert.deepEqual(got, [
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849,
  ]);
});

test('different seeds diverge', () => {
  const a = Array.from({ length: 10 }, mulberry32(1));
  const b = Array.from({ length: 10 }, mulberry32(2));
  assert.notDeepEqual(a, b);
});

test('deriveStepRng isolates a step from its neighbours', () => {
  // The point of per-step derivation: consuming extra draws inside step 2 must
  // not change what step 3 sees.
  const s2 = deriveStepRng(42, 0, 2);
  const s3before = Array.from({ length: 5 }, deriveStepRng(42, 0, 3));
  for (let i = 0; i < 100; i++) s2();
  const s3after = Array.from({ length: 5 }, deriveStepRng(42, 0, 3));
  assert.deepEqual(s3before, s3after);
});

test('deriveStepRng distinguishes (route, step) pairs', () => {
  const seen = new Set();
  for (let r = 0; r < 6; r++) for (let s = 1; s <= 6; s++) seen.add(deriveStepRng(7, r, s)());
  assert.equal(seen.size, 36);
});

test('pickWeighted respects weights', () => {
  const entries = [['a', 90], ['b', 10]];
  const rng = mulberry32(3);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i++) counts[pickWeighted(rng, entries)]++;
  assert.ok(counts.a > counts.b * 5, `expected a >> b, got ${JSON.stringify(counts)}`);
  assert.ok(counts.b > 0, 'b must still be reachable');
});
