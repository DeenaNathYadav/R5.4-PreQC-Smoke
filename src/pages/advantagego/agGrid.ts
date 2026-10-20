import { Locator, Page, expect } from '@playwright/test';

// Helpers for the editable AG Grid tables on AdvantageGo screens (e.g. "Professional Indemnity Activities").
// Each table sits under an <h4> title with an "Add <title>" button; cells are addressed by AG Grid col-id.

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class EditableGrid {
  readonly root: Locator;

  constructor(private readonly page: Page, private readonly title: string) {
    // The grid nearest after its heading (other, hidden panels may also contain grids)
    this.root = page.locator(`xpath=//h4[normalize-space()="${title}"]/following::div[contains(@class,"ag-root-wrapper")][1]`);
  }

  rows(): Locator {
    return this.root.locator('.ag-center-cols-container .ag-row');
  }

  cell(rowIndex: number, colId: string): Locator {
    return this.root.locator(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"] .ag-cell[col-id="${colId}"]`);
  }

  /** Clicks "Add <title>" and returns the new row's index. */
  async addRow(): Promise<number> {
    const before = await this.rows().count();
    await this.root.scrollIntoViewIfNeeded();
    // The add button sits beside the heading; its title varies ("Add New", "Add Limit and Excess")
    await this.page
      .locator(`xpath=//h4[normalize-space()="${this.title}"]/ancestor::div[contains(@class,"row-icon-wrapper")][1]`)
      .locator('button[title^="Add"]')
      .click();
    await expect(this.rows()).toHaveCount(before + 1);
    return before;
  }

  async setText(rowIndex: number, colId: string, value: string): Promise<void> {
    const cell = this.cell(rowIndex, colId);
    await cell.dblclick();
    await this.page.keyboard.press('Control+A'); // numeric cells start at 0.00
    await this.page.keyboard.type(value);
    await this.page.keyboard.press('Enter');
    // Numbers are displayed formatted (20000 → 20,000; 100 → 100.00)
    await expect(cell).not.toHaveText('');
  }

  /**
   * Dropdown cell editor (Kendo combobox inside the cell). Some lists show "CODE Description"
   * (e.g. "AGGR Aggregate") and the cell then displays "AGGR - Aggregate", so `option` matches
   * the start of the option text and `expected` is what the cell should show afterwards.
   */
  async selectOption(rowIndex: number, colId: string, option: string, expected: string | RegExp = option): Promise<void> {
    const cell = this.cell(rowIndex, colId);
    await cell.dblclick();
    await this.page
      .getByRole('option')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(option)}(\\s|$)`) })
      .first()
      .click();
    await this.page.keyboard.press('Tab'); // commits the editor
    await expect(cell).toHaveText(expected);
  }
}
