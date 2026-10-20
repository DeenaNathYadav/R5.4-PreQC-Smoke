import { test } from '../src/fixtures';
import { LoginPage } from '../src/pages/LoginPage';
import { saveSession } from '../src/config/auth';

// `npm run login`: opens a browser, waits (up to 10 min) for you to sign in incl. MFA, saves the session.
// The session is saved the moment the tab is back on the app's own /ui/ pages after Microsoft's login,
// because the sign-in window can close itself right after a successful login.
test('sign in manually and save session', async ({ page, product }) => {
  test.setTimeout(11 * 60_000);
  test.skip(!product.baseUrl, `${product.key.toUpperCase()}_URL is not set`);

  const appHost = new URL(product.baseUrl).host;
  let sawMicrosoft = false;
  let saved = false;
  let saving: Promise<void> = Promise.resolve();

  const trySave = () => {
    saving = saving.then(async () => {
      if (saved) return;
      try {
        await saveSession(page, product);
        saved = true;
        console.log(`>>> Session saved for ${product.name}.`);
      } catch (e) {
        console.log(`    save attempt failed: ${(e as Error).message.split('\n')[0]}`);
      }
    });
  };

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const u = new URL(frame.url());
    console.log(`    at ${u.origin}${u.pathname}`);
    if (u.host === 'login.microsoftonline.com') sawMicrosoft = true;
    // Back on the app after having gone through Microsoft's login = signed in
    else if (sawMicrosoft && u.host === appHost && u.pathname.startsWith('/ui/')) trySave();
  });

  await page.goto(product.homePath);
  console.log(`\n>>> Sign in to ${product.name} in the browser window that just opened (10 min)...\n`);

  // Fallback to the navigation hook above: the logged-in indicator (needs a fresh browser, so Microsoft is always seen first)
  const loginPage = new LoginPage(page, product);
  const deadline = Date.now() + 10 * 60_000;
  while (!saved && Date.now() < deadline && !page.isClosed()) {
    if (sawMicrosoft && (await loginPage.isLoggedIn(1_000))) trySave();
    await saving;
    if (!saved) await page.waitForTimeout(500).catch(() => {});
  }
  if (!saved) throw new Error(`Timed out or window closed before the session could be saved (last URL: ${page.url()})`);
});
