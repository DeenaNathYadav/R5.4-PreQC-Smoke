import { test, expect } from '../fixtures';
import { getProduct } from '../products';
import { env } from '../config/env';

/** Standard smoke checks every product gets, driven by its entry in products.ts. */
export function registerSmokeSuite(key: string): void {
  const product = getProduct(key);

  test.describe(`${product.name} smoke`, { tag: '@smoke' }, () => {
    test.skip(!product.baseUrl, `${key.toUpperCase()}_URL is not set`);

    test('app loads with a logged-in session', async ({ page }) => {
      await page.goto(product.homePath);
      await expect(page.locator(product.loggedInIndicator).first()).toBeVisible();
    });

    test('deployed build matches EXPECTED_BUILD', async ({ page }) => {
      const expected = env('EXPECTED_BUILD');
      test.skip(!expected || !product.buildVersion, 'EXPECTED_BUILD or buildVersion selector not set');
      await page.goto(product.homePath);
      await expect(page.locator(product.buildVersion!).first()).toContainText(expected);
    });

    for (const p of product.pages) {
      test(`page renders: ${p.name}`, async ({ page, diagnostics }) => {
        const response = await page.goto(p.path);
        expect(response?.status() ?? 0, `HTTP status for ${p.path}`).toBeLessThan(400);
        if (p.title) await expect(page).toHaveTitle(p.title);
        if (p.expect) await expect(page.locator(p.expect).first()).toBeVisible();
        await expect(page, 'redirected to login').not.toHaveURL(/login\.microsoftonline\.com/);
        expect.soft(diagnostics.serverErrors, 'backend 5xx responses').toEqual([]);
      });
    }
  });
}
