import { expect } from '@playwright/test';
import path from 'path';
import { EditableGrid } from '../../pages/advantagego/agGrid';
import { clickSave, expectToast, waitForIdle } from '../../pages/advantagego/entity';
import { selectDropdown } from '../../pages/advantagego/kendo';
import { QuoteSectionsPage, escapeRegExp } from '../../pages/advantagego/QuoteSectionsPage';

export interface CmbcSectionData {
  offering: string;
  riskSections: string[];
  childSections: string[];
  /** Liability → Public and Product Liability → <section> → EXPOSURE: grid cells (col-id → value) and dropdowns. */
  liabilityExposures?: CmbcExposure[];
}

export interface CmbcExposure {
  section: string;
  grid: string;
  /** Dropdown cells: col-id → option text (cells already showing the value are skipped). */
  options: Record<string, string>;
  /** Numeric/text cells: col-id → value. */
  values: Record<string, string>;
  /** Kendo dropdown questions on the same tab: label → option. */
  questions?: Record<string, string>;
}

/** Quote → SECTIONS for CMBC: PDBI / Liability structure, exposure grids and the schedule import. */
export class CmbcSectionsPage extends QuoteSectionsPage {
  async expectCmbcStructure(data: CmbcSectionData): Promise<void> {
    for (const section of data.riskSections) {
      await expect(this.page.getByText(section, { exact: true }).first()).toBeVisible();
    }
    await this.page.getByText('PDBI', { exact: true }).first().click();
    await expect(this.page.getByText('Business Interruption', { exact: true }).first()).toBeVisible();
    await expect(this.page.getByText('Property Damage', { exact: true }).first()).toBeVisible();
    await this.page.getByText('LIABILITY', { exact: true }).first().click();
    await expect(this.page.getByText('Public and Product Liability', { exact: true }).first()).toBeVisible();
  }

  async fillCmbcRequiredDetails(data?: CmbcSectionData): Promise<void> {
    await this.page.getByText('PDBI', { exact: true }).first().click();
    for (const section of ['Business Interruption', 'Property Damage']) {
      await this.page.getByText(section, { exact: true }).first().click();
      await selectDropdown(this.page, 'Form Type', 'All Risks');
    }
    for (const exposure of data?.liabilityExposures ?? []) await this.fillCmbcExposure(exposure);
  }

  /** LIABILITY → Public and Product Liability → <section> → EXPOSURE: fills the exposure grid row and questions. */
  private async fillCmbcExposure(data: CmbcExposure): Promise<void> {
    const { page } = this;
    const node = page.getByText(data.section, { exact: true }).first();
    if (!(await node.isVisible())) {
      await page.getByText('LIABILITY', { exact: true }).first().click();
      const ppl = page.getByText('Public and Product Liability', { exact: true }).first();
      await ppl.click();
      if (!(await node.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
        // Expand the node via its ⊕ toggle
        await page.locator('li[role=treeitem]').filter({ has: ppl }).first().locator('.k-treeview-toggle').first().click();
      }
    }
    await node.click();
    await expect(page.locator('.breadcrumb, nav').getByText(data.section, { exact: true }).first())
      .toBeVisible({ timeout: 30_000 })
      .catch(() => {});
    await page.getByText('EXPOSURE', { exact: true }).first().click();

    const grid = new EditableGrid(page, data.grid);
    await expect(grid.root).toBeVisible({ timeout: 30_000 });
    if ((await grid.rows().count()) === 0) await grid.addRow();
    for (const [colId, option] of Object.entries(data.options)) {
      // Trade category / hazard are derived from Region and the trade code, so give them a moment to auto-fill
      const expected = new RegExp(`^\\s*${escapeRegExp(option)}`);
      if (await expect(grid.cell(0, colId)).toHaveText(expected, { timeout: 5_000 }).then(() => true, () => false)) continue;
      await grid.selectOption(0, colId, option, expected);
    }
    for (const [colId, value] of Object.entries(data.values)) {
      await grid.setText(0, colId, value);
      await expect(grid.cell(0, colId)).toHaveText(Number(value).toLocaleString('en-GB'));
    }
    for (const [label, option] of Object.entries(data.questions ?? {})) {
      await selectDropdown(page, label, option);
    }
  }

  /** Quote → PDBI → SCHEDULE: the CMBC schedule grid header (Import/Delete/⋮ buttons live here). */
  private async openCmbcSchedule() {
    const { page } = this;
    await page.getByText('PDBI', { exact: true }).first().click();
    await page.getByText('SCHEDULE', { exact: true }).first().click();
    const header = page.getByText('CMBC', { exact: true }).last().locator('xpath=ancestor::header[1]');
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
  async importCmbcSchedule(filePath: string): Promise<void> {
    const { page } = this;
    const { header, scheduleCount } = await this.openCmbcSchedule();
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
      const { scheduleCount: after } = await this.openCmbcSchedule();
      expect(after, 'schedule items after import').toBe(scheduleCount + 1);
    }).toPass({ timeout: 90_000 });
  }
  /**
   * Quote → PDBI → SCHEDULE → ⋮ → "Geocode and Get Peril Score". The app starts a background job and opens the Data Import
   * wizard in a new tab; its Pending Tasks page is worked through: Continue (geocoding complete) → Geocoding Results → Next →
   * Continue (peril score complete) → Confirm Import → Finish. A renewal quote's copied schedule items are not geocoded, and
   * Get Price refuses them ("The Geocoding for all schedule items have not been done"), so this runs before pricing.
   * The newest task is always the first row, so earlier unfinished tasks are left alone.
   */
  async geocodeAndGetPerilScore(): Promise<void> {
    const { page } = this;
    const { header } = await this.openCmbcSchedule();
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
