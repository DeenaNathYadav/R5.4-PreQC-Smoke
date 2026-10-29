import { expect } from '@playwright/test';
import { EditableGrid } from '../../pages/advantagego/agGrid';
import { QuoteSectionsPage, escapeRegExp } from '../../pages/advantagego/QuoteSectionsPage';

export interface ActivityRow {
  /** Exact option text, e.g. "Audit / company tax / accountancy - banks / financial". */
  activity: string;
  percentage: string;
  /** Auto-filled from the activity; checked when provided. */
  expectedSplitFactor?: string;
}

export interface IncomeRow {
  incomeType: string;
  currentYear: string;
  /** Last complete financial years 1..5, most recent first. */
  previousYears: string[];
}

export interface LimitAndExcess {
  /** Coverage node in the section tree, e.g. "Professional Indemnity". */
  coverage: string;
  /** Code from the Limit Basis list, e.g. "AGGR" (shown as "AGGR - Aggregate"). */
  limitBasis: string;
  limitAmount: string;
  excessAmount: string;
}

export interface PiSectionData {
  riskSection: string;
  trade: string;
  activities: ActivityRow[];
  income: IncomeRow[];
  limitAndExcess: LimitAndExcess;
}

/** Quote → SECTIONS for PI: the Accountants risk section's trade, activities, income and limit & excess. */
export class PiSectionsPage extends QuoteSectionsPage {
  async fillPiRiskDetails(data: PiSectionData): Promise<void> {
    await this.selectQuestion('1. Trade', data.trade);

    const activities = new EditableGrid(this.page, 'Professional Indemnity Activities');
    for (const a of data.activities) {
      const row = await activities.addRow();
      await activities.selectOption(row, 'Activities', a.activity);
      await activities.setText(row, 'Percentage', a.percentage);
      if (a.expectedSplitFactor) await expect(activities.cell(row, 'Split Factor')).toHaveText(a.expectedSplitFactor);
    }

    const income = new EditableGrid(this.page, 'Professional Indemnity Income');
    for (const i of data.income) {
      const row = await income.addRow();
      await income.selectOption(row, 'IncomeType', i.incomeType);
      await income.setText(row, 'CurrentYearFinancial', i.currentYear);
      for (const [n, value] of i.previousYears.entries()) await income.setText(row, `YearFinancial${n + 1}`, value);
    }
  }

  /**
   * Coverages → <coverage> → Financials → "Limit and Excess" grid (first row, pre-created in GBP).
   * The coverage nodes only appear in the tree after the risk details have been saved once,
   * so call this after saveExpectingValidation().
   */
  async setLimitAndExcess(data: LimitAndExcess): Promise<void> {
    const { page } = this;
    await page.getByText(data.coverage, { exact: true }).first().click();
    await expect(page.getByText(`Coverage : ${data.coverage}`)).toBeVisible();

    // The Financials panel doesn't always render on its own; selecting its tab loads the grid
    const limitHeading = page.getByRole('heading', { name: 'Limit and Excess' });
    if (!(await limitHeading.isVisible())) await page.getByText('FINANCIALS', { exact: true }).click();
    await expect(limitHeading).toBeVisible({ timeout: 30_000 });
    const grid = new EditableGrid(page, 'Limit and Excess');
    await expect(grid.rows()).toHaveCount(1, { timeout: 30_000 });
    await grid.selectOption(0, 'Basis', data.limitBasis, new RegExp(`^${escapeRegExp(data.limitBasis)} - `));
    // Choosing the Basis leaves the next editor (Currency) open over the Amount cell: click the heading to close it
    await limitHeading.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option').first()).toBeHidden({ timeout: 10_000 }).catch(() => {});
    await grid.setText(0, 'Amount', data.limitAmount);
    await grid.setText(0, '_excessAmount', data.excessAmount);
  }
}
