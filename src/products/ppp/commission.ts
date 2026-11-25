import { Locator, Page, expect } from '@playwright/test';
import { acknowledgeWarnings, clickSave, waitForIdle } from '../../pages/advantagego/entity';

/*
 * PPP commission, kept in PPP's own file so a change here does not touch the other products.
 * PPP is not eligible for ⋮ → Get Commission: the Broker Commission is put on by hand on DETAILS → Commission.
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

/**
 * Saves from the Details tab (it shows no "Quote Saved" toast, so the save call itself is waited for). Any message the save answers
 * with (e.g. "Please select at least one Cover to proceed.") is logged, so the report shows when the app did not keep something.
 */
async function saveDetails(page: Page): Promise<void> {
  const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
  await clickSave(page);
  const response = await saved;
  expect(response.ok(), 'UpdateQuote succeeded').toBeTruthy();
  const messages = [...new Set(((await response.text().catch(() => '')).match(/"Message":"[^"]+"/g) ?? []).map((m) => m.slice(11, -1)))];
  if (messages.length) console.log(`PPP Details save answered: ${messages.join(' | ')}`);
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
    await page.keyboard.press('Tab'); // commits the editor
    await expect(type).toHaveText('Broker Commission', { timeout: 4_000 });
  }).toPass({ timeout: 30_000 });
  return row;
}

/**
 * Lets a row settle before its Selected % is edited: any open editor is closed, the app is given a moment to finish loading, and
 * the row is brought well into view (it can sit at the very bottom of the page).
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
 * DETAILS → Commission → the Broker Commission row's Selected %, on the converted quote BEFORE its sections are touched (the app
 * defaults a Broker Commission row on the converted quote). The two % columns:
 * - Standard % (col-id PlanRatePercentage): filled by the app (Get Commission); read-only, never typed into;
 * - Selected % (col-id RatePercentage): the user's value, which overrides Standard %. This is the one set to `percent`.
 * PPP is not eligible for Get Commission, so:
 * - the defaulted Broker Commission row → its Selected % is set to `percent` (left alone when it already is `percent`);
 * - no row defaulted → one is added with "+" (Deduction Type "Broker Commission") and its Selected % set to `percent`.
 * Then the quote is saved. The Selected % editor sometimes does not open (the grid ignores the clicks): the page is then reloaded,
 * which drops anything unsaved, and the whole step is tried again (3 tries). A row is never saved without a %. Returns what was done.
 */
export async function addPppBrokerCommission(page: Page, percent: string): Promise<'added' | 'set' | 'kept'> {
  for (let attempt = 1; ; attempt++) {
    const grid = await commissionsGrid(page);
    await waitForIdle(page);
    // The defaulted row draws a moment after the grid itself: give it up to 5 s before deciding there is none
    const existing = brokerRows(page, grid).first();
    const defaulted = await existing.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const row = defaulted ? existing : await addBrokerRow(page, grid);
    const selected = row.locator('.ag-cell[col-id="RatePercentage"]');
    if (defaulted && (await percentOf(selected)) === Number(percent)) return 'kept';

    await settleRow(page, row);
    if (await typeIntoCell(page, selected, percent)) {
      await saveDetails(page);
      console.log(`PPP Broker Commission: ${defaulted ? 'defaulted row' : 'row added with +'}, Selected % = ${percent}`);
      return defaulted ? 'set' : 'added';
    }
    const where = defaulted ? 'the defaulted' : 'the added';
    if (attempt >= 3) throw new Error(`Selected % of ${where} Broker Commission row would not open for editing (3 tries, each after a reload)`);
    console.log(`PPP Broker Commission: Selected % of ${where} row would not open for editing (try ${attempt}); reloading and trying again`);
    await page.reload();
    await waitForIdle(page);
  }
}

/**
 * After a reload, DETAILS → Commission lists a "Broker Commission" deduction with Selected % `percent` (proves it was saved). The grid
 * sometimes draws its rows before the deduction types have loaded (Type and Description blank), so it is reloaded and read again.
 */
export async function expectPppBrokerCommission(page: Page, percent: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await waitForIdle(page);
    const grid = await commissionsGrid(page);
    const row = brokerRows(page, grid).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.ag-cell[col-id="RatePercentage"]')).toContainText(percent, { timeout: 5_000 });
  }).toPass({ timeout: 150_000, intervals: [2_000] });
}
