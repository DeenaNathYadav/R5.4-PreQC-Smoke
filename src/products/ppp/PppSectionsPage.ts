import { expect } from '@playwright/test';
import path from 'path';
import { autoMap, dataImportTasks } from '../../pages/advantagego/dataImport';
import { acknowledgeWarnings, clickSave, expectToast, waitForIdle } from '../../pages/advantagego/entity';
import { QuoteSectionsPage, quoteId } from '../../pages/advantagego/QuoteSectionsPage';

/** Quote → SECTIONS for PPP (UK Property Investors Protection Plan). */
export class PppSectionsPage extends QuoteSectionsPage {
  /** Closes the "Unsaved changes – Please save changes to continue" notice (it overlays the page and blocks Save) with Ok. */
  private async dismissUnsavedChanges(): Promise<void> {
    const notice = this.page.locator('.cdk-overlay-container').filter({ hasText: /Unsaved changes/i });
    if (await notice.isVisible().catch(() => false)) {
      await notice.getByRole('button', { name: /^Ok$/i }).first().click();
      await expect(notice.getByRole('heading', { name: /Unsaved changes/i })).toBeHidden({ timeout: 10_000 });
    }
  }

  /**
   * From the quote's Details tab (Broker Commission already set there): the SECTIONS tab is clicked inside the app, as a user does.
   * The app then defaults the offering "Standard PPP" and the PPP risk section (Risk Details, Property Damage, Rental Income, Public
   * Liability, Additional Covers) - it does NOT when the Sections page is opened by its address, so this never uses page.goto first.
   * The test never chooses the offering or adds a section: if the PPP section is not defaulted, it fails. Then Save, and the quote is
   * reopened to prove the sections were saved. Returns the offering and what the Save listed (empty when nothing).
   */
  async saveDefaultedSections(
    quoteUrl: string,
    data: { riskSection: string; offering: string },
  ): Promise<{ offering: string; afterSave: string }> {
    const { page } = this;
    const input = page.locator('input[placeholder="Offering:"], input[placeholder="Select"]').first();
    const node = page.locator('span.k-treeview-leaf').filter({ has: page.getByText(data.riskSection, { exact: true }) }).first();

    await page.getByRole('button', { name: 'Sections', exact: true }).first().click();
    await this.dismissUnsavedChanges();
    // SECTIONS tab → the offering and the PPP risk section the app defaulted (checked as soon as they show, up to 60 s) → Save
    await waitForIdle(page);
    await expect(node, `the ${data.riskSection} risk section was not defaulted on the SECTIONS tab`).toBeVisible({ timeout: 60_000 });
    await expect(input, 'the defaulted offering').toHaveValue(data.offering, { timeout: 30_000 });
    const offering = (await input.inputValue()).trim();
    console.log(`PPP sections: offering "${offering}" and the ${data.riskSection} risk section defaulted by the app`);

    await waitForIdle(page);
    await clickSave(page);
    await acknowledgeWarnings(page, 8_000);
    await waitForIdle(page);
    const afterSave = (await page.locator('text=/Please enter|is required|Please select|Error\\(s\\)/').allInnerTexts()).join(' | ');
    if (afterSave) console.log(`PPP sections Save listed: ${afterSave}`);
    await this.open(quoteUrl);
    await expect(node, `risk sections were not saved; the Save listed: ${afterSave || 'nothing'}`).toBeVisible({ timeout: 30_000 });
    return { offering, afterSave };
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
    await autoMap(popup, /Original Full Address\s*-->/); // also closes PPP's "Define Mapping" notice
    const mapped = popup.locator('[col-id=displayName]');
    await expect(mapped.filter({ hasText: /Original Full Address\s*-->/ })).toBeVisible();
    await mapped.filter({ hasText: /Unique Schedule Id\s*-->/ }).click();
    await popup.locator('button[title="Remove Mapping"]:not([disabled])').first().click();
    await expect(mapped.filter({ hasText: /Unique Schedule Id\s*-->/ })).toHaveCount(0);

    const submitted = popup.waitForResponse((r) => /ScheduleImportApi\/api\/dataImport$/i.test(r.url()), { timeout: 120_000 });
    await popup.getByRole('button', { name: 'Submit', exact: true }).click();
    expect((await submitted).ok(), 'schedule dataImport API succeeded').toBeTruthy();

    // The task list only moves on when refreshed (src/pages/advantagego/dataImport.ts)
    const { status, resume } = dataImportTasks(popup);

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
    // "Import completed successfully", or now "1 record(s) imported successfully. Please continue to Finish the job."
    await status(/(Import completed|record\(s\) imported) successfully/);
    // Continue → Finish ends the job (the wizard closes itself); until then the rows are not on the schedule
    await resume();
    const closed = popup.waitForEvent('close', { timeout: 60_000 }).then(() => true, () => false);
    await popup.getByRole('button', { name: 'Finish', exact: true }).click();
    if (!(await closed)) await popup.close();

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

    const { continueNewest } = dataImportTasks(popup);

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
