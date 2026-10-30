import { expect } from '@playwright/test';
import path from 'path';
import { acknowledgeWarnings, clickSave, expectToast, waitForIdle } from '../../pages/advantagego/entity';
import { QuotePage } from '../../pages/advantagego/QuotePage';
import { QuoteSectionsPage, quoteId } from '../../pages/advantagego/QuoteSectionsPage';

/** Quote → SECTIONS for PPP (UK Property Investors Protection Plan). */
export class PppSectionsPage extends QuoteSectionsPage {
  /** Chooses an offering; changing it asks "retain common data between the old and new offerings?" (Do not Retain). */
  private async chooseOffering(name: string): Promise<void> {
    const { page } = this;
    const input = page.locator('input[placeholder="Offering:"], input[placeholder="Select"]').first();
    await input.locator('xpath=ancestor::kendo-combobox[1]').locator('.k-input-button').click();
    await page.getByRole('option', { name, exact: true }).click();
    const retain = page.getByRole('dialog').filter({ hasText: 'retain common data' });
    if (await retain.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false)) {
      await retain.getByRole('button', { name: /Do not Retain/i }).click();
    }
    await expect(input).toHaveValue(name);
    await waitForIdle(page);
    await page.waitForTimeout(3_000);
  }

  /**
   * A quote converted from a submission shows the offering "Standard PPP" already but has no risk sections: they default only when the
   * offering is changed, so another offering is chosen and then "Standard PPP" again (PPP with Risk Details, Property Damage, Rental
   * Income, Public Liability and Additional Covers appear). The Broker Commission row's Override % is then set on the Details tab
   * (switching tabs inside the app keeps the unsaved sections) and the quote is saved; the sections are proven by reopening it.
   * Returns the offering and the validation text the first Save listed.
   */
  async addPppSections(
    quoteUrl: string,
    data: { riskSection: string; offering: string; otherOffering: string },
    brokerPercent: string,
  ): Promise<{ offering: string; validation: string }> {
    const { page } = this;
    await expect(async () => {
      await page.goto(`/ui/Quote/Section/${quoteId(quoteUrl)}`);
      await expect(page.getByText('Offering:')).toBeVisible({ timeout: 30_000 });
    }).toPass({ timeout: 150_000, intervals: [2_000] });
    const input = page.locator('input[placeholder="Offering:"], input[placeholder="Select"]').first();
    const node = page.locator('span.k-treeview-leaf').filter({ has: page.getByText(data.riskSection, { exact: true }) }).first();

    if (!(await node.isVisible())) {
      if ((await input.inputValue()).trim() === data.offering) await this.chooseOffering(data.otherOffering);
      await this.chooseOffering(data.offering);
    }
    if (!(await node.isVisible())) await this.addRiskSection(data.riskSection, { verifyTree: true }); // not defaulted: add it
    await expect(node).toBeVisible({ timeout: 60_000 });
    const offering = await input.inputValue();

    await this.saveExpectingValidation();
    const validation = (await page.locator('text=/Please enter|is required|Please select|Error\\(s\\)/').allInnerTexts()).join(' | ');

    await page.getByRole('button', { name: 'Details', exact: true }).first().click();
    await new QuotePage(page).addBrokerCommission(brokerPercent);
    await page.getByRole('button', { name: 'Sections', exact: true }).first().click();
    await clickSave(page);
    await acknowledgeWarnings(page, 8_000);
    await waitForIdle(page);
    const afterSave = (await page.locator('text=/Please enter|is required|Please select|Error\\(s\\)/').allInnerTexts()).join(' | ');
    await this.open(quoteUrl);
    await expect(node, `risk sections were not saved; the Save listed: ${afterSave || 'nothing'}`).toBeVisible({ timeout: 30_000 });
    return { offering, validation };
  }

  /** Quote → PPP → SCHEDULE: the schedule grid header (titled "PPPV2") (Import/Delete/⋮ buttons live here). */
  private async openPppSchedule() {
    const { page } = this;
    await page.locator('li[role=treeitem] span.k-treeview-leaf').filter({ has: page.getByText('PPP', { exact: true }) }).first().click();
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
   * SCHEDULE → Import (Geocode Mode + Peril Score) → Auto Mapping → geocoding results → peril score →
   * Confirm Import. Unique Schedule Id is unmapped so the row is inserted as a new schedule item
   * (the file's id belongs to the reference quote). Checks the grid gains one row.
   */
  async importPppSchedule(filePath: string): Promise<void> {
    const { page } = this;
    const { header, scheduleCount } = await this.openPppSchedule();
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

    await popup.locator('input[type=radio][value="Import"]').check();
    await popup.locator('input[type=radio][value="Geocode Mode"]').check();
    const perilScore = popup
      .getByText('Peril Score', { exact: true })
      .locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]')
      .locator('input[type=checkbox]')
      .first();
    await perilScore.check();

    await popup.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(popup.getByText('Define Spreadsheet Mappings', { exact: true })).toBeVisible({ timeout: 60_000 });
    await popup.getByRole('button', { name: 'Auto Mapping', exact: true }).click();
    // PPP answers with a "Define Mapping" notice (Original Full Address and address components detected) that blocks the page
    const notice = popup.getByRole('dialog').filter({ hasText: 'Define Mapping' });
    if (await notice.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await notice.getByRole('button', { name: 'Ok', exact: true }).click();
    const mapped = popup.locator('[col-id=displayName]');
    await expect(mapped.filter({ hasText: /Original Full Address\s*-->/ })).toBeVisible();
    await mapped.filter({ hasText: /Unique Schedule Id\s*-->/ }).click();
    await popup.locator('button[title="Remove Mapping"]:not([disabled])').first().click();
    await expect(mapped.filter({ hasText: /Unique Schedule Id\s*-->/ })).toHaveCount(0);

    const submitted = popup.waitForResponse((r) => /ScheduleImportApi\/api\/dataImport$/i.test(r.url()), { timeout: 120_000 });
    await popup.getByRole('button', { name: 'Submit', exact: true }).click();
    expect((await submitted).ok(), 'schedule dataImport API succeeded').toBeTruthy();

    const status = (text: RegExp) => expect(popup.locator('.data-import-list').getByText(text)).toBeVisible({ timeout: 180_000 });
    const resume = () => popup.getByRole('button', { name: 'Continue', exact: true }).click();

    await status(/Spreadsheet mappings have been validated/);
    await resume();
    await status(/Geocoding is complete/);
    await resume();
    await expect(popup.getByText('Geocoding Results', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(popup.getByText(/Locations Rejected\s*0\//)).toBeVisible();
    await popup.getByRole('button', { name: 'Next', exact: true }).click();

    await status(/Peril score look up is complete/);
    await resume();
    await expect(popup.getByText('Confirm Import', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(popup.locator('.ag-row').filter({ hasText: 'Accepted' })).toHaveCount(1);
    const finalImport = popup.waitForResponse((r) => /api\/Import\/importFinalScheduleData/i.test(r.url()), { timeout: 120_000 });
    await popup.getByRole('button', { name: 'Import', exact: true }).click();
    expect((await finalImport).ok(), 'final schedule import succeeded').toBeTruthy();
    await status(/Import completed successfully/);
    await popup.close();

    await page.reload();
    await expect(page.getByText('Risk Sections', { exact: true })).toBeVisible();
    await expect(async () => {
      const { scheduleCount: after } = await this.openPppSchedule();
      expect(after, 'schedule items after import').toBe(scheduleCount + 1);
    }).toPass({ timeout: 90_000 });
  }

  /**
   * Quote → PPP → SCHEDULE → ⋮ → "Geocode and Get Peril Score". The app starts a background job and opens the Data Import
   * wizard in a new tab; its Pending Tasks page is worked through: Continue (geocoding complete) → Geocoding Results → Next →
   * Continue (peril score complete) → Confirm Import → Finish. A renewal quote's copied schedule items are not geocoded, and
   * Get Price refuses them ("The Geocoding for all schedule items have not been done"), so this runs before pricing.
   * The newest task is always the first row, so earlier unfinished tasks are left alone.
   */
  async geocodeAndGetPerilScore(): Promise<void> {
    const { page } = this;
    const { header } = await this.openPppSchedule();
    const action = header.locator('a', { hasText: 'Geocode and Get Peril Score' }).first();
    // The action works on the selected schedule items and is greyed out until some are: tick the select-all box
    // (or the row boxes when the grid has none)
    // (ag-grid's checkbox is a styled wrapper around a hidden input, so the wrapper is what gets clicked)
    const ticked = (box: import('@playwright/test').Locator) => box.evaluate((e) => e.classList.contains('ag-checked'));
    const selectAll = page.locator('.ag-header-select-all .ag-checkbox-input-wrapper').locator('visible=true').first();
    if (await selectAll.count()) {
      if (!(await ticked(selectAll))) await selectAll.click();
    } else {
      for (const box of await page.locator('.ag-row .ag-selection-checkbox .ag-checkbox-input-wrapper').all()) {
        if (!(await ticked(box))) await box.click();
      }
    }
    // The action sits in one of the header's untitled ⋮ menus: open them in turn until it shows
    const menus = header.locator('button:not([data-bs-title])');
    for (let i = 0, n = await menus.count(); i < n && !(await action.isVisible()); i++) {
      await menus.nth(i).click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      if (!(await action.isVisible())) await page.keyboard.press('Escape');
    }
    await expect(action, 'Geocode and Get Peril Score is offered in the schedule menu').toBeVisible();
    await expect(action, 'Geocode and Get Peril Score is enabled once schedule items are selected').not.toHaveClass(/disabled/);
    const popupPromise = page.context().waitForEvent('page', { timeout: 30_000 });
    await action.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();

    const newestTask = popup.locator('.data-import-list').first();
    const continueNewest = async (status: RegExp) => {
      await expect(newestTask).toContainText(status, { timeout: 240_000 });
      await newestTask.getByRole('button', { name: 'Continue', exact: true }).click();
    };

    await continueNewest(/Geocoding is complete/);
    await expect(popup.getByText('Geocoding Results', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(popup.getByText(/Locations Rejected\s*0\//)).toBeVisible();
    await popup.getByRole('button', { name: 'Next', exact: true }).click();

    await continueNewest(/Peril score look up is complete/);
    await expect(popup.getByText('Confirm Import', { exact: true })).toBeVisible({ timeout: 60_000 });
    // Finish closes the wizard at once (register the wait first) and hands the geocoded data to this tab in memory
    const closed = popup.waitForEvent('close', { timeout: 60_000 }).then(() => true, () => false);
    await popup.getByRole('button', { name: 'Finish', exact: true }).click();
    await closed;

    // Give the data a few seconds to land on the schedule, then Save writes it to the database ("Schedule Saved Successfully").
    // Reload afterwards: the quote's ⋮ menu is not offered on this tab until the page is refreshed.
    await waitForIdle(page);
    await page.waitForTimeout(8_000);
    await clickSave(page);
    await expectToast(page, /Schedule Saved Successfully/, 'any', 60_000);
    await page.reload();
    await expect(page.getByText('Risk Sections', { exact: true })).toBeVisible({ timeout: 60_000 });
  }
}
