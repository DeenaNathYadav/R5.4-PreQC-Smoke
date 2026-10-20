import { Page, expect } from '@playwright/test';

// Toolbar actions shared by Submission / Quote / Policy screens.

/** The app covers the page with a processing overlay while it works; clicks wait until it is gone (slow environments). */
export async function waitForIdle(page: Page): Promise<void> {
  await page.locator('.processing-overlay').first().waitFor({ state: 'hidden', timeout: 90_000 }).catch(() => {});
}

export async function clickSave(page: Page): Promise<void> {
  await waitForIdle(page);
  await page.locator('button[title="Save"]').first().click();
}

/** Runs an action from the ⋮ "More" menu, e.g. "Convert to Quote". */
export async function businessAction(page: Page, action: string): Promise<void> {
  await waitForIdle(page);
  await page.locator('button[title="More"]').first().click();
  // Scope to the open menu: some actions share their text with page labels (e.g. "Taken Up" is also a stage name)
  const inMenu = page.locator('.dropdown-menu:visible').getByText(action, { exact: true });
  // The menu fills in a moment after it opens, so give the entry a chance to appear before falling back
  await inMenu.first().waitFor({ timeout: 5_000 }).catch(() => {});
  if (await inMenu.count()) await inMenu.first().click();
  else await page.getByText(action, { exact: true }).click();
}

/** Every entry in the ⋮ "More" menu for the entity's current stage (some may be greyed out). */
export async function listActions(page: Page): Promise<string[]> {
  await waitForIdle(page);
  await page.locator('button[title="More"]').first().click();
  // The menu fills in a moment after it opens
  await page.locator('.dropdown-menu:visible li').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const texts = (await page.locator('.dropdown-menu:visible li').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  // Closing the menu with Escape leaves the ⋮ button without its "More" title, so reload to a clean state
  await page.reload();
  await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
  return [...new Set(texts)];
}

/**
 * Bottom-right ngx-toastr notification, e.g. "Price is returned back from the rating engine".
 * Toasts disappear after a few seconds, so call this right after the triggering action.
 */
export async function expectToast(
  page: Page,
  text: string | RegExp,
  type: 'success' | 'error' | 'info' | 'warning' | 'any' = 'success',
  timeout = 120_000,
): Promise<void> {
  const selector = type === 'any' ? '.toast' : `.toast.toast-${type}`;
  await expect(page.locator(selector).filter({ hasText: text }).first()).toBeVisible({ timeout });
}

/**
 * Waits for the page title to match. On a slow environment a page sometimes stays blank (title just "Underwriting"),
 * so reload and look again a couple of times before giving up.
 */
export async function expectTitleWithReload(page: Page, pattern: RegExp, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await expect(page).toHaveTitle(pattern, { timeout: 25_000 });
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      await page.reload();
    }
  }
}

/** Entity pages are titled "Underwriting - <reference>". */
export async function referenceFromTitle(page: Page, pattern: RegExp): Promise<string> {
  await expectTitleWithReload(page, pattern);
  return (await page.title()).match(pattern)![0];
}
