import { chromium, test as base, expect } from '@playwright/test';
import { ProductConfig, getProduct } from '../products';
import { authProfileDir, refreshSavedSession, restoreSessionStorage } from '../config/auth';

export interface Diagnostics {
  consoleErrors: string[];
  serverErrors: string[];
}

export const test = base.extend<{ product: ProductConfig; diagnostics: Diagnostics; sessionKeeper: void }>({
  // Playwright's own browser fixture, with the launch tried up to 3 times: Edge now and then crashes while starting
  // ("browserType.launch: Target page, context or browser has been closed"), which would fail the first test of a chain
  // and skip everything after it.
  browser: [
    async ({ playwright, browserName, headless, channel, launchOptions }, use) => {
      let browser;
      for (let attempt = 1; ; attempt++) {
        try {
          browser = await playwright[browserName].launch({ ...launchOptions, headless, channel });
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
      await use(browser);
      await browser.close();
    },
    { scope: 'worker', timeout: 0 },
  ],

  product: async ({}, use, testInfo) => {
    await use(getProduct(testInfo.project.metadata.product));
  },

  context: async ({ context, product }, use, testInfo) => {
    // Not in *-setup: auth.setup opens the profile itself when the saved session has expired
    const useProfile = product.useEdgeProfile && testInfo.project.metadata.role !== 'auth';
    if (useProfile) {
      const persistent = await chromium.launchPersistentContext(authProfileDir(), {
        channel: process.env.BROWSER_CHANNEL || 'msedge',
        headless: false,
        baseURL: product.baseUrl,
        ignoreHTTPSErrors: true,
        viewport: { width: 1600, height: 900 },
      });
      try {
        await use(persistent);
      } finally {
        await persistent.close();
      }
      return;
    }
    await restoreSessionStorage(context, product);
    await use(context);
  },

  // After every product test that ends still signed in, its session is saved back over the one auth.setup saved (see
  // refreshSavedSession): long runs outlive the app's tokens otherwise. Not with the Edge profile, which keeps its own session.
  sessionKeeper: [
    async ({ page, product }, use, testInfo) => {
      await use();
      if (testInfo.project.metadata.role === 'product' && !product.useEdgeProfile) {
        await refreshSavedSession(page, product).catch(() => {});
      }
    },
    { auto: true },
  ],

  // Collects browser console errors and 5xx responses for every test and attaches them to the report.
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const diag: Diagnostics = { consoleErrors: [], serverErrors: [] };
      page.on('console', (msg) => {
        if (msg.type() === 'error') diag.consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => diag.consoleErrors.push(err.message));
      page.on('response', (res) => {
        if (res.status() >= 500) diag.serverErrors.push(`${res.status()} ${res.url()}`);
      });

      await use(diag);

      if (diag.consoleErrors.length || diag.serverErrors.length) {
        await testInfo.attach('diagnostics', {
          body: JSON.stringify(diag, null, 2),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
