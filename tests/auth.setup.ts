import fs from 'fs';
import path from 'path';
import { chromium } from '@playwright/test';
import { test } from '../src/fixtures';
import { LoginPage } from '../src/pages/LoginPage';
import { authFiles, authProfileDir, restoreSessionStorage, saveSession } from '../src/config/auth';

// Runs before each product's tests: reuses the saved session if it still works (refreshing it),
// otherwise re-exports it from the Edge profile that `npm run login:cdp` signed in to,
// otherwise logs in with configured credentials, otherwise asks for a login.
test('authenticate', async ({ browser, product }) => {
  test.setTimeout(120_000);
  const files = authFiles(product);

  if (!product.baseUrl) {
    fs.mkdirSync(path.dirname(files.storageState), { recursive: true });
    fs.writeFileSync(files.storageState, JSON.stringify({ cookies: [], origins: [] }));
    test.skip(true, `${product.key.toUpperCase()}_URL is not set`);
  }

  const hasSaved = fs.existsSync(files.storageState);
  const context = await browser.newContext({
    baseURL: product.baseUrl,
    storageState: hasSaved ? files.storageState : undefined,
    ignoreHTTPSErrors: true,
  });
  await restoreSessionStorage(context, product);
  const page = await context.newPage();
  const loginPage = new LoginPage(page, product);

  await page.goto(product.homePath);
  if (!product.login || (hasSaved && (await loginPage.isLoggedIn(20_000)))) {
    await saveSession(page, product);
    await context.close();
    return;
  }
  await context.close();

  // The Edge profile keeps the full SSO login (a plain storageState copy of it isn't enough)
  const profileDir = authProfileDir();
  if (fs.existsSync(profileDir)) {
    const profileContext = await chromium.launchPersistentContext(profileDir, {
      channel: process.env.BROWSER_CHANNEL || undefined,
      baseURL: product.baseUrl,
      ignoreHTTPSErrors: true,
    });
    try {
      const profilePage = profileContext.pages()[0] ?? (await profileContext.newPage());
      await profilePage.goto(new URL(product.homePath, product.baseUrl).href);
      if (await new LoginPage(profilePage, product).isLoggedIn(30_000)) {
        await saveSession(profilePage, product);
        return;
      }
    } finally {
      await profileContext.close();
    }
  }

  const credContext = await browser.newContext({ baseURL: product.baseUrl, ignoreHTTPSErrors: true });
  const credPage = await credContext.newPage();
  const credLogin = new LoginPage(credPage, product);
  if (!credLogin.canAutoLogin) {
    await credContext.close();
    throw new Error(
      `${product.name}: no valid saved session. Run "npm run login:cdp" and sign in, ` +
        `or set ${product.key.toUpperCase()}_USER/_PASSWORD for an account without MFA.`,
    );
  }
  await credPage.goto(product.homePath);
  await credLogin.login();
  await credLogin.expectLoggedIn();
  await saveSession(credPage, product);
  await credContext.close();
});
