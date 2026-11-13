import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { ProductConfig, getProduct } from '../products';
import { refreshSavedSession, restoreSessionStorage } from '../config/auth';

export interface Diagnostics {
  consoleErrors: string[];
  serverErrors: string[];
}

export const test = base.extend<{ product: ProductConfig; diagnostics: Diagnostics; sessionKeeper: void }, { sharedPage: Page | null }>({
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

  // One signed-in page for all the product tests a worker runs, instead of a new browser window per test: a new window downloads and
  // starts the whole app again (8-20 s a test), the open page is already there. A failed test ends its worker, so the next test gets
  // a fresh page. Not for the auth project (it opens its own browser).
  sharedPage: [
    async ({ browser }, use, workerInfo) => {
      const { metadata, use: options } = workerInfo.project;
      // Opt-in (SHARED_PAGE=1) until it has had a clean full run: in its trials on preQC the long-lived page ended on a blank page
      // ("Refreshing Token") once the app had to renew its sign-in, which a new window per test does not run into.
      if (metadata.role !== 'product' || process.env.SHARED_PAGE !== '1') return use(null);
      const product = getProduct(metadata.product);
      // Every product signs in the same way: the saved session (auth.setup) in a new context, with or without SHARED_PAGE
      const context: BrowserContext = await browser.newContext({
        baseURL: options.baseURL,
        storageState: options.storageState,
        viewport: options.viewport,
        userAgent: options.userAgent,
        deviceScaleFactor: options.deviceScaleFactor,
        ignoreHTTPSErrors: options.ignoreHTTPSErrors,
      });
      await restoreSessionStorage(context, product);
      context.setDefaultTimeout(options.actionTimeout ?? 20_000);
      context.setDefaultNavigationTimeout(options.navigationTimeout ?? 90_000);
      const page = context.pages()[0] ?? (await context.newPage());
      try {
        await use(page);
      } finally {
        await context.close();
      }
    },
    { scope: 'worker', timeout: 0 },
  ],

  product: async ({}, use, testInfo) => {
    await use(getProduct(testInfo.project.metadata.product));
  },

  // Not built on Playwright's own per-test context, so none is opened next to the shared page (Playwright still records the trace
  // and the failure screenshot of every context, the shared one included)
  context: async ({ browser, sharedPage, product }, use, testInfo) => {
    if (sharedPage) return use(sharedPage.context());
    const options = testInfo.project.use;
    const context = await browser.newContext({
      baseURL: options.baseURL,
      storageState: options.storageState,
      viewport: options.viewport,
      userAgent: options.userAgent,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors,
    });
    await restoreSessionStorage(context, product);
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },

  // Every test still opens the record it works on (a page already showing it can be out of date: tried, and a test then read the
  // commission and task statuses from before the last change); only the app start-up of a new window is saved.
  page: async ({ context, sharedPage }, use) => {
    await use(sharedPage ?? (await context.newPage()));
  },

  // After every product test that ends still signed in, its session is saved back over the one auth.setup saved (see
  // refreshSavedSession): long runs outlive the app's tokens otherwise.
  sessionKeeper: [
    async ({ page, product }, use, testInfo) => {
      await use();
      if (testInfo.project.metadata.role === 'product') {
        await refreshSavedSession(page, product).catch(() => {});
      }
    },
    { auto: true },
  ],

  // Collects browser console errors and 5xx responses for every test and attaches them to the report.
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const diag: Diagnostics = { consoleErrors: [], serverErrors: [] };
      const onConsole = (msg: { type(): string; text(): string }) => {
        if (msg.type() === 'error') diag.consoleErrors.push(msg.text());
      };
      const onPageError = (err: Error) => diag.consoleErrors.push(err.message);
      const onResponse = (res: { status(): number; url(): string }) => {
        if (res.status() >= 500) diag.serverErrors.push(`${res.status()} ${res.url()}`);
      };
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
      page.on('response', onResponse);

      await use(diag);

      // The page outlives the test (sharedPage): stop listening for it
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
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
