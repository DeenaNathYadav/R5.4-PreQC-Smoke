import { Locator, Page, expect } from '@playwright/test';

/**
 * "Define Spreadsheet Mappings" → Auto Mapping, until the Import Mapping list shows `expected` (e.g. /Original Full Address\s*-->/).
 * The page draws before its field lists have loaded, and Auto Mapping pressed in that moment does nothing (Import Mapping stays
 * "No Rows To Show"), so it waits for the page to settle first and presses again (up to 3 times) if nothing was mapped.
 * PPP answers with a "Define Mapping" notice (address components detected) that blocks the page: it is closed with Ok.
 */
export async function autoMap(popup: Page, expected: RegExp): Promise<void> {
  const target = popup.locator('[col-id=displayName]').filter({ hasText: expected });
  const notice = popup.getByRole('dialog').filter({ hasText: 'Define Mapping' });
  for (let attempt = 1; ; attempt++) {
    await popup.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    await expect(popup.getByRole('gridcell').first()).toBeVisible({ timeout: 30_000 }); // field lists loaded
    await popup.waitForTimeout(1_000);
    await popup.getByRole('button', { name: 'Auto Mapping', exact: true }).click();
    await expect(target.or(notice).first()).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Ok', exact: true }).click();
    if (await target.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) return;
    if (attempt === 3) await expect(target.first(), 'Auto Mapping filled the Import Mapping list').toBeVisible();
    console.log(`Auto Mapping mapped nothing (attempt ${attempt}); pressing it again`);
  }
}

/**
 * Waits on the schedule Data Import wizard's Pending Tasks list (the tab a schedule import or "Geocode and Get Peril Score" opens).
 * The list doesn't update by itself when a background step (validation, geocoding, vehicle lookup, peril score, import) finishes:
 * it stays on the status it first drew, Continue disabled, until it is refreshed with the ↻ button next to Import Data, as a user
 * does by hand. So every wait here presses ↻ every few seconds until the step is done (up to 5 minutes a step).
 */
export function dataImportTasks(popup: Page) {
  const refresh = async () => {
    const button = popup.locator('xpath=//button[normalize-space()="Import Data"]/preceding::button[1]');
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
    else await popup.reload().catch(() => undefined);
  };
  const untilRefreshed = async (check: () => Promise<void>, timeout = 300_000) => {
    await expect(async () => {
      try {
        await check();
      } catch (e) {
        await refresh();
        throw e;
      }
    }).toPass({ timeout, intervals: [5_000, 10_000] });
  };
  const list = popup.locator('.data-import-list');
  const continueIn = async (scope: Page | Locator) => {
    const next = scope.getByRole('button', { name: 'Continue', exact: true }).first();
    await untilRefreshed(() => expect(next).toBeEnabled({ timeout: 15_000 }));
    await next.click();
  };

  return {
    refresh,
    /** A task in the list shows this status. */
    status: (text: RegExp) => untilRefreshed(() => expect(list.getByText(text).first()).toBeVisible({ timeout: 15_000 })),
    /** Continue, once a background step has finished and enabled it. */
    resume: () => continueIn(popup),
    /** The newest task (always the first row) reaches this status, then its Continue. Earlier unfinished tasks are left alone. */
    continueNewest: async (text: RegExp) => {
      const newest = list.first();
      await untilRefreshed(() => expect(newest).toContainText(text, { timeout: 15_000 }));
      await continueIn(newest);
    },
  };
}
