import { chromium } from 'playwright-core';

/**
 * Get a browser + context to work in.
 *
 * ATTACH connects to a Chrome you already started with
 * `--remote-debugging-port=9222` and uses its DEFAULT context — your real,
 * signed-in profile. That is the mode's entire value (no OAuth dance, real
 * data) and its entire risk (a mis-guarded click happens to your real account).
 *
 * LAUNCH starts a throwaway browser. playwright-core ships no browser binaries,
 * so launch mode needs either `browser.channel` ('chrome', 'msedge') or an
 * explicit `browser.executablePath`.
 */
export async function openBrowser(config) {
  if (config.browser.mode === 'attach') {
    const browser = await chromium.connectOverCDP(config.browser.cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error(`No default browser context found over CDP at ${config.browser.cdpUrl}`);
    }
    return { browser, context, mode: 'attach' };
  }

  const launchOpts = {
    headless: config.browser.headless,
    args: config.browser.launchArgs || [],
  };
  if (config.browser.channel) launchOpts.channel = config.browser.channel;
  if (config.browser.executablePath) launchOpts.executablePath = config.browser.executablePath;

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    throw new Error(
      `Could not launch a browser (${(e && e.message) || e}).\n` +
        `playwright-core ships no browser binaries. Set browser.channel to 'chrome' or 'msedge' ` +
        `if one is installed, set browser.executablePath, or use browser.mode 'attach'.`,
    );
  }
  const contextOpts = { ignoreHTTPSErrors: config.browser.ignoreHTTPSErrors };
  if (config.auth.strategy === 'storageState' && config.auth.from) contextOpts.storageState = config.auth.from;
  const context = await browser.newContext(contextOpts);
  return { browser, context, mode: 'launch' };
}

/**
 * Restore every override and close only what we opened.
 *
 * Over CDP, `browser.close()` DISCONNECTS — it never quits the user's Chrome.
 * The emulation overrides live on our tab's session and would die with it, but
 * they are cleared explicitly anyway so a half-dead session can never leave the
 * user's browser emulating a phone on a throttled link.
 */
export function makeCleanup({ browser, context, page, cdp, state, config, mode }) {
  let cleaned = false;
  return async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    state.closing = true;
    try {
      await cdp.send('Network.emulateNetworkConditions', config.network.normal);
    } catch {}
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    } catch {}
    try {
      await page.close();
    } catch {}
    // In launch mode we own the context we made; in attach mode it is the
    // user's and closing it would take their whole profile down with it.
    if (mode === 'launch') {
      try {
        await context.close();
      } catch {}
    }
    try {
      await browser.close();
    } catch {}
  };
}
