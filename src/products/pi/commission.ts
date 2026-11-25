import { Locator, Page, expect } from '@playwright/test';
import { acknowledgeWarnings, clickSave, waitForIdle } from '../../pages/advantagego/entity';

/*
 * PI commission, kept in PI's own file so a change here does not touch the other products.
 * PI is not eligible for ⋮ → Get Commission: the Broker Commission is put on by hand on DETAILS → Commission.
 */

/** DETAILS → Commission grid, expanded (the Details tab is switched to inside the app, so unsaved sections stay in memory). */
async function commissionsGrid(page: Page): Promise<Locator> {
  const section = page.getByRole('button', { name: /^Commissions?$/ });
  if (!(await section.first().isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Details', exact: true }).first().click().catch(() => {});
  }
  // The Details tab re-renders for a moment after it opens, so the section element can detach under the call: retry
  await expect(async () => {
    await section.scrollIntoViewIfNeeded({ timeout: 8_000 });
  }).toPass({ timeout: 40_000, intervals: [1_000] });
  const grid = section.locator('xpath=following::div[contains(@class,"ag-root-wrapper")][1]');
  if (!(await grid.isVisible())) await section.click();
  await expect(grid).toBeVisible();
  return grid;
}

const percentOf = async (cell: Locator) => Number((await cell.innerText()).replace(/[,%\s]/g, '')) || 0;

/**
 * Types `value` into a grid cell. The cell's editor sometimes does not open on a double-click (the cell only takes focus), so
 * each attempt opens it a different way (double-click, Enter, F2), fills the editor's input directly, and checks the cell shows
 * the value. Returns false when no attempt worked.
 */
async function typeIntoCell(page: Page, cell: Locator, value: string): Promise<boolean> {
  const editor = cell.locator('input').first();
  const openers = [
    () => cell.dblclick(),
    async () => { await cell.click(); await page.keyboard.press('Enter'); },
    async () => { await cell.click(); await page.keyboard.press('F2'); },
  ];
  for (let attempt = 0; attempt < 6; attempt++) {
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    await openers[attempt % openers.length]().catch(() => {});
    if (await editor.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
      await editor.fill(value);
      await editor.press('Enter');
    } else {
      await page.keyboard.type(value); // a focused cell also starts editing when a digit is typed
      await page.keyboard.press('Enter');
    }
    if (await expect(cell).toContainText(value, { timeout: 4_000 }).then(() => true, () => false)) return true;
    await page.keyboard.press('Escape').catch(() => {});
  }
  return false;
}

/** Saves from the Details tab (it shows no "Quote Saved" toast, so the save call itself is waited for). */
async function saveDetails(page: Page): Promise<void> {
  const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
  await clickSave(page);
  expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
  await acknowledgeWarnings(page);
  // A "…may impact the premium, please press Get Price" banner is expected now; pricing follows in a later step.
}

const brokerRows = (page: Page, grid: Locator) =>
  grid.locator('.ag-center-cols-container .ag-row').filter({ has: page.locator('.ag-cell[col-id="DeductionTypeId"]', { hasText: 'Broker Commission' }) });

/** "+" → a new commission row, Deduction Type "Broker Commission". Returns the new row. */
async function addBrokerRow(page: Page, grid: Locator): Promise<Locator> {
  const rows = grid.locator('.ag-center-cols-container .ag-row');
  const before = await rows.count();
  await page.locator('button[title^="Add Commission"]').click();
  await expect(rows).toHaveCount(before + 1);
  const row = rows.nth(before);
  const type = row.locator('.ag-cell[col-id="DeductionTypeId"]');
  await expect(async () => {
    await type.dblclick();
    await page.getByRole('option').filter({ hasText: 'Broker Commission' }).first().click({ timeout: 5_000 });
    // As a user does it: picking the option fills the row (Broker Commission / Broker Commission / No) with no Tab. Tab only
    // as a fallback when the choice has not shown in the cell.
    const shown = await expect(type).toHaveText('Broker Commission', { timeout: 3_000 }).then(() => true, () => false);
    if (!shown) await page.keyboard.press('Tab');
    await expect(type).toHaveText('Broker Commission', { timeout: 4_000 });
  }).toPass({ timeout: 30_000 });
  return row;
}

/**
 * Lets a row settle before its Selected % is edited: any open editor is closed, the app is given a moment to finish what the
 * Deduction Type choice started, and the row is brought well into view (a new row sits at the very bottom of the page).
 */
async function settleRow(page: Page, row: Locator): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await waitForIdle(page);
  await page.waitForTimeout(1_500);
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.wheel(0, 250);
  await page.waitForTimeout(500);
}

/**
 * DETAILS → Commission → the Broker Commission row's Selected %. The two % columns:
 * - Standard % (col-id PlanRatePercentage): filled by the app (Get Commission); read-only, never typed into;
 * - Selected % (col-id RatePercentage): the user's value, which overrides Standard %. This is the one set to `percent`.
 * PI is not eligible for Get Commission, so:
 * - a Broker Commission row defaulted on the quote → its Selected % is set to `percent` (left alone when it already is `percent`);
 * - no row defaulted → one is added with "+" (Deduction Type "Broker Commission") and its Selected % set to `percent`.
 * Then the quote is saved - or, with `save: false`, left unsaved on the page so the caller saves it together with other changes
 * (the sections). The Selected % editor sometimes does not open on a row (the grid ignores the clicks): the page is then reloaded,
 * which drops the unsaved row, and the whole step is tried again (3 tries). A row is never saved without a % (the app silently
 * drops such a row). Returns what was done.
 */
export async function addPiBrokerCommission(page: Page, percent: string, { save = true }: { save?: boolean } = {}): Promise<'added' | 'set' | 'kept'> {
  for (let attempt = 1; ; attempt++) {
    const grid = await commissionsGrid(page);
    await waitForIdle(page);
    // A defaulted row draws a moment after the grid itself: give it up to 5 s before deciding there is none
    const existing = brokerRows(page, grid).first();
    const defaulted = await existing.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const row = defaulted ? existing : await addBrokerRow(page, grid);
    const selected = row.locator('.ag-cell[col-id="RatePercentage"]');
    if (defaulted && (await percentOf(selected)) === Number(percent)) return 'kept';

    await settleRow(page, row);
    if (await typeIntoCell(page, selected, percent)) {
      if (save) await saveDetails(page);
      console.log(`PI Broker Commission: ${defaulted ? 'defaulted row' : 'row added with +'}, Selected % = ${percent}${save ? '' : ' (not saved yet)'}`);
      return defaulted ? 'set' : 'added';
    }
    const where = defaulted ? 'the defaulted' : 'the added';
    if (attempt >= 3) throw new Error(`Selected % of ${where} Broker Commission row would not open for editing (3 tries, each after a reload)`);
    console.log(`PI Broker Commission: Selected % of ${where} row would not open for editing (try ${attempt}); reloading and trying again`);
    await page.reload();
    await waitForIdle(page);
  }
}

/**
 * After a reload, DETAILS → Commission lists a "Broker Commission" deduction with Selected % `percent` (proves it was saved). The grid
 * sometimes draws its rows before the deduction types have loaded (Type and Description blank), so it is reloaded and read again.
 */
export async function expectPiBrokerCommission(page: Page, percent: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await waitForIdle(page);
    const grid = await commissionsGrid(page);
    const row = brokerRows(page, grid).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.ag-cell[col-id="RatePercentage"]')).toContainText(percent, { timeout: 5_000 });
  }).toPass({ timeout: 150_000, intervals: [2_000] });
}
