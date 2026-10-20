import { Page, expect } from '@playwright/test';
import type { ProductConfig } from '../products/types';

export class LoginPage {
  constructor(private readonly page: Page, private readonly product: ProductConfig) {}

  get canAutoLogin(): boolean {
    return !!(this.product.username && this.product.password);
  }

  async login(): Promise<void> {
    const { login, name, key } = this.product;
    if (!login) return;
    if (!this.canAutoLogin) {
      throw new Error(`No credentials for ${name}: set ${key.toUpperCase()}_USER/_PASSWORD or SMOKE_USER/SMOKE_PASSWORD`);
    }
    if (login.type === 'azure-ad') return this.azureAdLogin();

    await this.page.locator(login.username).first().fill(this.product.username);
    if (login.next) await this.page.locator(login.next).first().click();
    await this.page.locator(login.password).first().fill(this.product.password);
    await this.page.locator(login.submit).first().click();
  }

  /** Standard login.microsoftonline.com pages. Fails if the account is challenged for MFA. */
  private async azureAdLogin(): Promise<void> {
    const page = this.page;
    await page.locator('input[name="loginfmt"]').fill(this.product.username);
    await page.locator('#idSIButton9').click();
    await page.locator('input[name="passwd"]').fill(this.product.password);
    await page.locator('#idSIButton9').click();
    // "Stay signed in?" prompt, when shown
    const staySignedIn = page.locator('#idBtn_Back');
    await staySignedIn.waitFor({ timeout: 10_000 }).then(() => staySignedIn.click(), () => {});
  }

  async isLoggedIn(timeout = 30_000): Promise<boolean> {
    return this.page
      .locator(this.product.loggedInIndicator)
      .first()
      .waitFor({ timeout })
      .then(() => true, () => false);
  }

  async expectLoggedIn(): Promise<void> {
    await expect(this.page.locator(this.product.loggedInIndicator).first()).toBeVisible({ timeout: 30_000 });
  }
}
