import { Locator, Page, expect } from '@playwright/test';
import { businessAction, waitForIdle } from '../../pages/advantagego/entity';

/*
 * Fleet commission helpers, kept in Fleet's own file so a change here does not touch the other products (the Fleet Get Commission
 * step itself is getCommission in flows/quote.ts).
 */

export const percentOf = async (cell: Locator) => Number((await cell.innerText()).replace(/[,%\s]/g, '')) || 0;

/**
 * Types `value` into a grid cell. The cell's editor sometimes does not open on a double-click (the cell only takes focus), so
 * each attempt opens it a different way (double-click, Enter, F2), fills the editor's input directly, and checks the cell shows
 * the value. Returns false when no attempt worked.
 */
export async function typeIntoCell(page: Page, cell: Locator, value: string): Promise<boolean> {
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
 * ⋮ → Get Commission. Only the call itself decides success or error here (the Commission grid is checked afterwards, by
 * getCommission in flows/quote.ts). What the app shows next varies:
 * - a "Confirm Commission Updates" dialog listing the sections (with a % = rated, name only = not rated, error 90063) → Accept;
 * - on Fleet now usually an empty "Confirm Commission Updates" dialog that closes by itself while the app applies the rates.
 * An error (failed call, no answer) is returned, not thrown, with any half-open dialog closed.
 */
export async function runGetCommission(page: Page): Promise<{ rated: string[]; notRated: string[]; error?: Error }> {
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
    console.log(`Fleet Get Commission: the "Confirm Commission Updates" dialog did not close with Accept (${(error as Error).message.split('\n')[0]})`);
    return { rated: [], notRated: [] };
  }
}
