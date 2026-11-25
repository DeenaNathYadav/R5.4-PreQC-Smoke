import { Locator, Page, expect } from '@playwright/test';
import { acknowledgeWarnings, businessAction, clickSave, waitForIdle } from '../../pages/advantagego/entity';

/*
 * MTP commission, kept in MTP's own file so a change here does not touch the other products.
 * MTP is eligible for ⋮ → Get Commission, which should fill the Standard % of every commission row. When it does not (or it errors),
 * the Get Commission test fails, but first 12 is put in the Selected % of every row and saved, so the rest of the scenario carries on.
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
}

/** The commission rows of the grid (blank placeholder rows, with no Deduction Type, are left out). */
async function deductionRows(page: Page, grid: Locator): Promise<Locator[]> {
  const rows = grid.locator('.ag-center-cols-container .ag-row').filter({ has: page.locator('.ag-cell[col-id="DeductionTypeId"]') });
  const out: Locator[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    if ((await row.locator('.ag-cell[col-id="DeductionTypeId"]').innerText()).trim()) out.push(row);
  }
  return out;
}

const rowName = async (row: Locator) =>
  [
    (await row.locator('.ag-cell[col-id="DeductionTypeId"]').innerText()).trim(),
  ]
    .filter(Boolean)
    .join(' / '); // the MTP grid shows Section (col-id DeductionTypeId), Standard % and Selected %

/** "+" → Deduction Type "Broker Commission" (used only when Get Commission left the grid with no commission rows at all). */
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
 * ⋮ → Get Commission. Only the call itself decides success or error here (the Commission grid is checked afterwards, by
 * getMtpCommission). What the app shows next varies:
 * - a "Confirm Commission Updates" dialog listing the sections (with a % = rated, name only = not rated, error 90063) → Accept;
 * - on some quotes an empty "Confirm Commission Updates" dialog that closes by itself while the app applies the rates.
 * An error (failed call, no answer) is returned, not thrown, with any half-open dialog closed.
 */
async function runGetCommission(page: Page): Promise<{ rated: string[]; notRated: string[]; error?: Error }> {
  const dialog = page.getByRole('dialog').filter({ hasText: 'Confirm Commission Updates' }).first();
  try {
    const response = page.waitForResponse(
      (r) => /CommissionConnector\/GetCommissionRates/i.test(r.url()) && r.request().method() === 'POST',
      { timeout: 120_000 },
    );
    await businessAction(page, 'Get Commission');
    expect((await response).ok(), 'GetCommissionRates succeeded').toBeTruthy();
  } catch (error) {
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: /^(cancel|close)$/i }).first().click({ timeout: 5_000 }).catch(() => page.keyboard.press('Escape'));
    }
    await waitForIdle(page);
    return { rated: [], notRated: [], error: error as Error };
  }
  // Wait (up to 60 s) for the dialog to list its rows, or to be gone (it closes by itself when the app applies the rates itself)
  const dialogRows = dialog.locator('.ag-row').first();
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (await dialogRows.isVisible().catch(() => false)) break;
    if (Date.now() - started > 5_000 && !(await dialog.isVisible().catch(() => false))) {
      await waitForIdle(page);
      return { rated: [], notRated: [] };
    }
    await page.waitForTimeout(500);
  }
  try {
    await waitForIdle(page);
    const rated = new Set<string>();
    const notRated = new Set<string>();
    for (const text of await dialog.locator('.ag-row').allInnerTexts()) {
      const parts = text.replace(/^Contract\s*/, '').trim().split(/\s*\n\s*/).filter(Boolean);
      if (!parts.length) continue;
      const rates = [...new Set(parts.filter((p) => /^-?[\d.,]+%?$/.test(p)).map((p) => p.replace(/%$/, '')))];
      const section = parts.filter((p) => !/^-?[\d.,]+%?$/.test(p)).join(' ');
      if (rates.length) rated.add(`${section} ${rates.map((r) => `${r}%`).join(' / ')}`);
      else notRated.add(section);
    }
    // The dialog re-renders while its grid loads; retry until the Accept click closes it
    await expect(async () => {
      await waitForIdle(page);
      if (await dialog.isVisible()) await dialog.getByRole('button', { name: /^accept$/i }).click({ timeout: 10_000 });
      await expect(dialog).toBeHidden({ timeout: 15_000 });
    }).toPass({ timeout: 120_000 });
    return { rated: [...rated], notRated: [...notRated] };
  } catch (error) {
    // The rates call itself succeeded: a dialog that would not accept is closed, and the grid check that follows decides the outcome
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: /^(cancel|close)$/i }).first().click({ timeout: 5_000 }).catch(() => page.keyboard.press('Escape'));
    }
    await waitForIdle(page);
    console.log(`MTP Get Commission: the "Confirm Commission Updates" dialog did not close with Accept (${(error as Error).message.split('\n')[0]})`);
    return { rated: [], notRated: [] };
  }
}

export interface MtpCommissionResult {
  /** sections the Get Commission dialog showed with a % */
  rated: string[];
  /** sections the dialog showed without a % */
  notRated: string[];
  /** commission rows whose Standard % is still empty after Get Commission */
  missingStandard: string[];
  /** set when Get Commission errored or left a Standard % empty: the reason the Get Commission test fails */
  failure?: string;
}

/**
 * ⋮ → Get Commission, then DETAILS → Commission is checked: every commission row should now have a Standard %.
 * - All filled: rows with an empty Selected % get `percent`; nothing fails.
 * - Get Commission errored, or a Standard % is empty: every row's Selected % is set to `percent` (a "Broker Commission" row is
 *   added with "+" if there are no rows at all) and saved, so the scenario can move on, and `failure` says why the test should fail.
 * Works from the Sections tab too (the Details tab is switched to inside the app).
 */
export async function getMtpCommission(page: Page, percent: string): Promise<MtpCommissionResult> {
  const connector = await runGetCommission(page);
  let grid = await commissionsGrid(page);
  await waitForIdle(page);
  const readGrid = async () => {
    const rows = await deductionRows(page, grid);
    const missing: string[] = [];
    for (const row of rows) {
      if ((await percentOf(row.locator('.ag-cell[col-id="PlanRatePercentage"]'))) <= 0) missing.push(await rowName(row));
    }
    return { rows, missing };
  };
  let state = await readGrid();
  // The rates arrive a moment after "Updated for Quote": give the grid up to 30 s to show every Standard % before calling them
  // missing (checked each second; every 10 s the tab is switched to Sections and back, inside the app, so the grid redraws)
  if (!connector.error) {
    const started = Date.now();
    let redrawn = started;
    while ((!state.rows.length || state.missing.length) && Date.now() - started < 30_000) {
      await page.waitForTimeout(1_000);
      if (Date.now() - redrawn >= 10_000) {
        await page.getByRole('button', { name: 'Sections', exact: true }).first().click().catch(() => {});
        await waitForIdle(page);
        grid = await commissionsGrid(page);
        redrawn = Date.now();
      }
      state = await readGrid();
    }
  }
  let rows = state.rows;
  const missingStandard = state.missing;
  const problems: string[] = [];
  if (connector.error) problems.push(`Get Commission errored: ${connector.error.message.split('\n')[0]}`);
  if (!rows.length) problems.push('Get Commission created no commission rows');
  if (missingStandard.length) problems.push(`Standard % not populated for: ${missingStandard.join(', ')}`);
  if (!rows.length) rows = [await addBrokerRow(page, grid)];

  let changed = 0;
  for (const row of rows) {
    const selected = row.locator('.ag-cell[col-id="RatePercentage"]');
    const value = await percentOf(selected);
    if (problems.length ? value === Number(percent) : value > 0) continue;
    expect(await typeIntoCell(page, selected, percent), `Selected % of "${await rowName(row)}" took ${percent}`).toBe(true);
    changed++;
  }
  if (changed) await saveDetails(page);
  const failure = problems.length
    ? `${problems.join('; ')}. ${percent}% was put in Selected % of every commission row and saved, so the scenario carries on.`
    : undefined;
  return { rated: connector.rated, notRated: connector.notRated, missingStandard, failure };
}
