import { Locator, Page, expect } from '@playwright/test';
import path from 'path';
import { acknowledgeWarnings, clickSave, expectToast, waitForIdle } from '../../pages/advantagego/entity';
import { selectDropdown } from '../../pages/advantagego/kendo';
import { QuoteSectionsPage, quoteId } from '../../pages/advantagego/QuoteSectionsPage';

/** Types `value` into a cell of the open ag-grid row; the editor occasionally doesn't open on the first double-click, so it is retried. */
export async function setGridCell(page: Page, row: Locator, colId: string, value: string): Promise<void> {
  const cell = row.locator(`.ag-cell[col-id="${colId}"]`);
  await expect(async () => {
    await cell.scrollIntoViewIfNeeded();
    await cell.dblclick();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
    await expect(cell).toContainText(value, { timeout: 4_000 });
  }).toPass({ timeout: 30_000 });
}

/** Quote → SECTIONS for Fleet. */
export class FleetSectionsPage extends QuoteSectionsPage {
  /**
   * A quote converted from a submission has no offering yet. Choosing it creates the FLEET risk section with its covers; its
   * Risk Details are then answered and the quote is saved (a "Run-off required…" warning is acknowledged). Checks the offering
   * and the section are still there after a reload.
   */
  async addFleetSections(
    quoteUrl: string,
    data: { offering: string; riskSection: string; riskDetails: Record<string, string>; selectedExcess: string },
  ): Promise<void> {
    const { page } = this;
    await expect(async () => {
      await page.goto(`/ui/Quote/Section/${quoteId(quoteUrl)}`);
      await expect(page.getByText('Offering:')).toBeVisible({ timeout: 30_000 });
    }).toPass({ timeout: 150_000, intervals: [2_000] });
    await this.selectOffering(data.offering);
    await expect(page.getByText(data.riskSection, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await waitForIdle(page);
    for (const [label, value] of Object.entries(data.riskDetails)) await selectDropdown(page, label, value);
    await this.setSelectedExcess(data.selectedExcess);
    await clickSave(page);
    await acknowledgeWarnings(page, 8_000);
    await waitForIdle(page);
    await this.open(quoteUrl);
    await expect(page.getByText(data.riskSection, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('input[placeholder="Offering:"], input[placeholder="Select"]').first()).toHaveValue(data.offering);
  }

  /** EXCESS tab: "Sel Excess" of every excess row (AD, Fire, Theft, Windscreen). Returns to the RISK DETAILS tab. */
  private async setSelectedExcess(value: string): Promise<void> {
    const { page } = this;
    await page.getByText('EXCESS', { exact: true }).first().click();
    const header = page.locator('.ag-header-cell').filter({ hasText: 'Sel Excess' }).first();
    await expect(header).toBeVisible({ timeout: 30_000 });
    const colId = (await header.getAttribute('col-id'))!;
    const rows = page.locator('.ag-center-cols-container .ag-row').filter({ has: page.locator(`.ag-cell[col-id="${colId}"]`) });
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      if (!(await row.isVisible())) continue;
      if ((await row.locator(`.ag-cell[col-id="${colId}"]`).innerText()).trim() === value) continue;
      await setGridCell(page, row, colId, value);
    }
    await page.getByText('RISK DETAILS', { exact: true }).first().click();
  }

  /** Quote → Fleet → SCHEDULE: the schedule grid header (titled "FleetV2") (Import/Delete/⋮ buttons live here). */
  private async openFleetSchedule() {
    const { page } = this;
    await page.locator('li[role=treeitem] span.k-treeview-leaf').filter({ has: page.getByText('FLEET', { exact: true }) }).first().click();
    await page.getByText('SCHEDULE', { exact: true }).first().click();
    const header = page.locator('header').filter({ has: page.locator('button[data-bs-title="Import"]') }).first();
    await expect(header).toBeVisible({ timeout: 60_000 });
    const count = page.getByText(/SHOWING ALL SCHEDULES: \d+/);
    await expect(count).toBeVisible({ timeout: 60_000 });
    // The grid briefly shows 0 before the schedule loads, so wait for the load and a stable count
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    const read = async () => Number((await count.innerText()).match(/\d+/)![0]);
    let scheduleCount = await read();
    await expect(async () => {
      await page.waitForTimeout(3_000);
      const now = await read();
      const stable = now === scheduleCount;
      scheduleCount = now;
      expect(stable, 'schedule count settled').toBeTruthy();
    }).toPass({ timeout: 60_000 });
    return { header, scheduleCount };
  }

  /**
   * SCHEDULE → Import (Schedule Import, With Vehicle Lookup) → Auto Mapping → submit → vehicle lookup (CDL call) →
   * Confirm Import. Unique Schedule Id is unmapped so the row is inserted as a new schedule item
   * (the file's id belongs to the reference quote). Checks the grid gains one row.
   */
  async importFleetSchedule(filePath: string): Promise<void> {
    const { page } = this;
    const { header, scheduleCount } = await this.openFleetSchedule();
    await header.locator('button[data-bs-title="Import"]').click({ force: true });
    const popupPromise = page.context().waitForEvent('page', { timeout: 30_000 });
    await header.locator('.dropdown-menu:visible').getByText('Import', { exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();

    // A previously abandoned import for this user resumes on the tasks page; discard it and start afresh
    const fileInput = popup.locator('input[type=file]');
    const staleTask = popup.locator('.schedules-content-action button.btn-transparent').first();
    await expect(fileInput.or(staleTask).first()).toBeAttached({ timeout: 60_000 });
    while (await staleTask.isVisible()) {
      await staleTask.click();
      await popup.locator('.modal.show, [role=dialog]').getByRole('button', { name: 'Yes' }).click();
      await popup.waitForTimeout(2_000);
    }
    await popup.waitForURL('**/ui/schedule/import/main', { timeout: 60_000 });
    await fileInput.setInputFiles(path.resolve(filePath));

    const rows = popup.locator('.ag-row:visible');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await rows.first().click(); // header row

    await popup.locator('input[type=radio][value="Import"]').check(); // Schedule Import (not Schedule Update)
    await popup.locator('input[type=radio][value="Vehicle Lookup"]').check(); // With Vehicle Lookup: the CDL call enriches each registration

    await popup.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(popup.getByText('Define Spreadsheet Mappings', { exact: true })).toBeVisible({ timeout: 60_000 });
    await popup.getByRole('button', { name: 'Auto Mapping', exact: true }).click();
    // Unique Schedule Id is unmapped so the row is inserted as a new vehicle (the file's id belongs to the reference quote)
    const mapped = popup.locator('[col-id=displayName]');
    await expect(mapped.filter({ hasText: /Unique Schedule Id\s*-->/ })).toBeVisible({ timeout: 30_000 }); // Auto Mapping done
    await mapped.filter({ hasText: /Unique Schedule Id\s*-->/ }).click();
    await popup.locator('button[title="Remove Mapping"]:not([disabled])').first().click();
    await expect(mapped.filter({ hasText: /Unique Schedule Id\s*-->/ })).toHaveCount(0);

    const submitted = popup.waitForResponse((r) => /ScheduleImportApi\/api\/dataImport$/i.test(r.url()), { timeout: 120_000 });
    await popup.getByRole('button', { name: 'Submit', exact: true }).click();
    expect((await submitted).ok(), 'schedule dataImport API succeeded').toBeTruthy();

    const status = (text: RegExp) => expect(popup.locator('.data-import-list').getByText(text)).toBeVisible({ timeout: 180_000 });
    // Continue stays disabled while a background step (validation, vehicle lookup, import) is still running
    const resume = async () => {
      const next = popup.getByRole('button', { name: 'Continue', exact: true });
      await expect(next).toBeEnabled({ timeout: 300_000 });
      await next.click();
    };

    await status(/Spreadsheet mappings have been validated/);
    await resume();
    await status(/Vehicle lookup is in progress/); // the vehicle lookup (CDL call) runs in the background
    await resume();
    await expect(popup.getByText('Vehicle Lookup Results', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(popup.getByText(/Vehicle lookup is complete/)).toBeVisible({ timeout: 240_000 });
    await expect(popup.getByText(/Vehicles not enriched during lookup\s*0\//)).toBeVisible();
    await popup.getByRole('button', { name: 'Next', exact: true }).click();

    await expect(popup.getByText('Confirm Import', { exact: true })).toBeVisible({ timeout: 60_000 });
    await popup.getByRole('button', { name: 'Import', exact: true }).click();
    await status(/(Import completed|record\(s\) imported) successfully/);
    await resume(); // back to Confirm Import, now offering Finish
    const closed = popup.waitForEvent('close', { timeout: 60_000 }).then(() => true, () => false);
    await popup.getByRole('button', { name: 'Finish', exact: true }).click();
    await closed;

    await page.reload();
    await expect(page.getByText('Risk Sections', { exact: true })).toBeVisible();
    await expect(async () => {
      const { scheduleCount: after } = await this.openFleetSchedule();
      expect(after, 'schedule items after import').toBe(scheduleCount + 1);
    }).toPass({ timeout: 90_000 });
  }
}
