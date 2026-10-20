import { chromium, test as base, expect } from '@playwright/test';
import { ProductConfig, getProduct } from '../products';
import { authProfileDir, restoreSessionStorage } from '../config/auth';

export interface Diagnostics {
  consoleErrors: string[];
  serverErrors: string[];
}

export const test = base.extend<{ product: ProductConfig; diagnostics: Diagnostics }>({
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
