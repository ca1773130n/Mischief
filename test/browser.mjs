// Not a *.test.mjs file on purpose: `npm test` globs test/*.test.mjs, so importing
// this from three suites costs nothing, while importing it from one of them would
// re-run that suite in every importer's process.

import { chromium } from 'playwright-core';

/**
 * A Chromium, or null. playwright-core ships no browsers, so the browser suites
 * skip when none is installed — never for convenience: if you have a browser,
 * they must pass.
 */
export async function browserOrNull() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch {}
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return null;
  }
}
