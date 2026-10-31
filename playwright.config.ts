import path from 'path';
import { defineConfig, devices, Project } from '@playwright/test';
import { products } from './src/products';
import { authFiles, authProject, groupByAuth } from './src/config/auth';

const isCI = !!process.env.CI;
// `npm run login` sets this to add the interactive "<key>-login" projects.
const manualLogin = !!process.env.MANUAL_LOGIN;
// The runner (scripts/run-smoke.mjs) gives each product its own report folder; unset = the classic shared locations.
const runDir = process.env.SMOKE_REPORT_DIR ? path.resolve(process.env.SMOKE_REPORT_DIR) : '';
const resultsDir = runDir || path.resolve('results');

export default defineConfig({
  testDir: './tests',
  outputDir: runDir ? path.join(runDir, 'artifacts') : 'test-results',
  timeout: 180_000, // the AdvantageGo environments can be slow
  expect: { timeout: 30_000 },
  fullyParallel: true,
  retries: isCI ? 1 : 0,
  workers: isCI ? 4 : undefined,
  reporter: [
    process.env.SMOKE_REPORTER === 'list' ? ['list'] : ['./reporters/console-reporter.ts', { outputDir: resultsDir }],
    ['./reporters/contracts-reporter.ts', { outputDir: resultsDir }],
    ['html', { open: 'never', outputFolder: runDir ? path.join(runDir, 'html') : 'playwright-report' }],
    ['junit', { outputFile: path.join(resultsDir, 'junit.xml') }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 900 },
    // Set BROWSER_CHANNEL=msedge or chrome to use an installed browser instead of Playwright's Chromium.
    channel: process.env.BROWSER_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video needs ffmpeg (`npx playwright install ffmpeg`); traces already include screenshots of every step.
    video: process.env.VIDEO ? 'retain-on-failure' : 'off',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    ignoreHTTPSErrors: true,
  },
  // One "auth:<host>" project per login (products on the same host share it) and one project per product.
  // Product projects carry metadata the runner reads: which product, its auth project, its worker cap, whether it is configured.
  projects: groupByAuth(products).flatMap(({ key: authKey, products: members }): Project[] => {
    const lead = members[0];
    const { storageState } = authFiles(lead);
    const shared = (p: typeof lead) => ({ baseURL: p.baseUrl || undefined });

    if (manualLogin) {
      return [{ name: `${lead.key}-login`, testMatch: /login\.manual\.ts/, metadata: { product: lead.key }, use: { ...shared(lead), headless: false } }];
    }
    return [
      {
        name: authProject(lead),
        testMatch: /auth\.setup\.ts/,
        metadata: { product: lead.key, role: 'auth', authKey, serves: members.map((m) => m.key) },
        use: shared(lead),
      },
      ...members.map(
        (p): Project => ({
          name: p.key,
          testMatch: `${p.key}/**/*.spec.ts`,
          dependencies: [authProject(lead)],
          metadata: {
            product: p.key,
            role: 'product',
            title: p.name,
            authProject: authProject(lead),
            configured: !!p.baseUrl,
            maxWorkers: p.maxWorkers ?? null,
          },
          use: { ...shared(p), storageState },
        }),
      ),
    ];
  }),
});
