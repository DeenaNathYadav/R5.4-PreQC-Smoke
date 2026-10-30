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

/**
 * Waits until `done()` holds, clicking ACKNOWLEDGE whenever the warnings banner offers it. Some actions (a CMBC General
 * Endorsement save with its CVOT reminder, Confirm Cancellation …) come back with the banner instead of completing; its
 * ACKNOWLEDGE link makes the app carry the action out. Returns quietly on timeout so the caller's own check reports what is missing.
 */
export async function acknowledgeUntil(page: Page, done: () => Promise<boolean>, timeout = 120_000): Promise<void> {
  const acknowledge = page.getByText('ACKNOWLEDGE', { exact: true });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await done().catch(() => false)) return;
    if (await acknowledge.first().isVisible().catch(() => false)) {
      await acknowledge.first().click().catch(() => {});
      await page.waitForTimeout(3_000);
      continue;
    }
    await page.waitForTimeout(1_000);
  }
}

/**
 * Acknowledges every warnings banner that shows up within `graceMs` (and any that follow within a few seconds), whatever the
 * warning says. Every product treats a warning as "acknowledge and carry on". Returns how many were acknowledged.
 */
export async function acknowledgeWarnings(page: Page, graceMs = 4_000): Promise<number> {
  const acknowledge = page.getByText('ACKNOWLEDGE', { exact: true }).first();
  let clicked = 0;
  let wait = graceMs;
  while (await acknowledge.waitFor({ state: 'visible', timeout: wait }).then(() => true, () => false)) {
    await acknowledge.click().catch(() => {});
    clicked++;
    await page.waitForTimeout(2_000);
    wait = 3_000; // a second warning can follow the first
  }
  return clicked;
}

/** Save, then wait until `done()` holds (acknowledging a warnings banner on the way, see acknowledgeUntil). */
export async function saveAcknowledgingWarnings(page: Page, done: () => Promise<boolean>, timeout = 120_000): Promise<void> {
  await clickSave(page);
  await acknowledgeUntil(page, done, timeout);
}

/** Runs an action from the ⋮ "More" menu, e.g. "Convert to Quote". */
export async function businessAction(page: Page, action: string): Promise<void> {
  await waitForIdle(page);
  // On this host a page sometimes renders blank: reload once when the ⋮ button does not show
  const more = page.locator('button[title="More"]').first();
  if (!(await more.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
    await page.reload();
    await more.waitFor({ state: 'visible', timeout: 60_000 });
  }
  await more.click();
  // Scope to the open menu: some actions share their text with page labels (e.g. "Taken Up" is also a stage name)
  const inMenu = page.locator('.dropdown-menu:visible').getByText(action, { exact: true });
  // The menu fills in a moment after it opens, so give the entry a chance to appear before falling back
  await inMenu.first().waitFor({ timeout: 5_000 }).catch(() => {});
  if (await inMenu.count()) await inMenu.first().click();
  else await page.getByText(action, { exact: true }).click();
}

/**
 * Opens an entity URL and waits for its ⋮ menu. On this slow host a page sometimes renders blank (no ⋮ for a minute or more),
 * so the link is opened again a couple of times before giving up.
 */
export async function gotoWithMenu(page: Page, url: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto(url);
    try {
      await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 40_000 });
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
    }
  }
}

/** Reloads the current page and waits for its ⋮ menu, reloading again when the page renders blank (see gotoWithMenu). */
export async function reloadWithMenu(page: Page, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.reload();
    try {
      await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 40_000 });
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
    }
  }
}

/** Every entry in the ⋮ "More" menu for the entity's current stage (some may be greyed out). */
export async function listActions(page: Page): Promise<string[]> {
  await waitForIdle(page);
  await page.locator('button[title="More"]').first().click();
  // The menu fills in a moment after it opens
  await page.locator('.dropdown-menu:visible li').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const texts = (await page.locator('.dropdown-menu:visible li').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  // Closing the menu with Escape leaves the ⋮ button without its "More" title, so reload to a clean state
  // (a reload sometimes renders blank on a slow host: reload again, as gotoWithMenu does)
  for (let attempt = 1; ; attempt++) {
    await page.reload();
    try {
      await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 40_000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
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
 * Pass `url` when the page was opened by a deep link: the app sometimes bounces a deep link to the Dashboard, and
 * reloading would then just reload the Dashboard, so the link is opened again instead.
 */
export async function expectTitleWithReload(
  page: Page,
  pattern: RegExp,
  { attempts = 3, url }: { attempts?: number; url?: string } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await expect(page).toHaveTitle(pattern, { timeout: 25_000 });
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      if (url) await page.goto(url);
      else await page.reload();
    }
  }
}

/** Entity pages are titled "Underwriting - <reference>". */
export async function referenceFromTitle(page: Page, pattern: RegExp): Promise<string> {
  await expectTitleWithReload(page, pattern);
  return (await page.title()).match(pattern)![0];
}
