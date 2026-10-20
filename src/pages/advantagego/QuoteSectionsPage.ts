import { Page, expect } from '@playwright/test';
import { businessAction, clickSave, expectToast, waitForIdle } from './entity';
import { expandSectionFor, field } from './kendo';

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Premium {
  policyPeriodGross: number;
  policyPeriodNet: number;
  calculatedOn: string;
}

export const quoteId = (quoteUrl: string) => quoteUrl.match(/\/ui\/Quote\/\w+\/(\d+)/)![1];

/** Quote → SECTIONS tab: risk sections, their risk details grids and coverages. */
export class QuoteSectionsPage {
  constructor(protected readonly page: Page) {}

  /** Accepts the quote's /ui/Quote/Edit/<id> URL (or any quote tab URL). */
  async open(quoteUrl: string): Promise<void> {
    await this.page.goto(`/ui/Quote/Section/${quoteId(quoteUrl)}`);
    await expect(this.page.getByText('Risk Sections', { exact: true })).toBeVisible();
  }

  /** `verifyTree` (used by CMBC): require the name in the section tree and recover a row that stays a blank picker. */
  async addRiskSection(name: string, { verifyTree = false } = {}): Promise<void> {
    const { page } = this;
    // The details panel also shows the section name while the tree row can stay a blank picker
    const added = verifyTree
      ? page.locator('li[role=treeitem] span.k-treeview-leaf').filter({ has: page.getByText(name.toUpperCase(), { exact: true }) }).first()
      : page.getByText(name.toUpperCase(), { exact: true }).first();
    const blankPicker = page.locator('li[role=treeitem] .risk-sections-dropdown button[title="Delete"]').first();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await added.isVisible()) return;
      if (attempt) await page.keyboard.press('Escape');
      if (verifyTree && (await blankPicker.isVisible())) await blankPicker.click();
      // "+" in the Risk Sections header is the first (untitled) button after the heading
      const add = page.getByRole('heading', { name: 'Risk Sections', level: 4 }).locator('xpath=following::button[1]');
      // Disabled while a previous offering/section change is still being applied
      await expect(add).toBeEnabled({ timeout: 90_000 });
      await add.click();
      const picker = page.getByPlaceholder('Select a Risk Section');
      await picker.locator('xpath=ancestor::kendo-combobox[1]').locator('.k-input-button').click();
      const option = page.getByRole('option', { name, exact: true });
      if (await option.click({ timeout: 10_000 }).then(() => true, () => false)) {
        if (!verifyTree) {
          await expect(added).toBeVisible({ timeout: 30_000 });
          return;
        }
        if (await added.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
          // The row can revert to a blank picker while the previous section is still being applied
          await waitForIdle(page);
          await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
          await page.waitForTimeout(2_000);
          if (await added.isVisible()) return;
        }
      }
    }
    await expect(added).toBeVisible();
  }

  async addChildRiskSection(parent: string, child: string): Promise<void> {
    const { page } = this;
    const node = page
      .locator('span.k-treeview-leaf')
      .filter({ has: page.getByText(parent, { exact: true }) })
      .first();
    await node.hover({ timeout: 60_000 });
    await node.locator('button[title="Add"]').click({ timeout: 60_000 });
    const picker = page.getByPlaceholder(new RegExp(`Select a child Risk Section of ${escapeRegExp(parent)}`, 'i'));
    await picker.locator('xpath=ancestor::kendo-combobox[1]').locator('.k-input-button').click();
    await page.getByRole('option', { name: child, exact: true }).click();
    await expect(page.getByText(child, { exact: true }).first()).toBeVisible();
  }

  async selectOffering(name: string): Promise<void> {
    const { page } = this;
    const input = page.locator('input[placeholder="Offering:"], input[placeholder="Select"]').first();
    if ((await input.inputValue()) === name) return;
    const combo = input.locator('xpath=ancestor::kendo-combobox[1]');
    await combo.locator('.k-input-button').click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(input).toHaveValue(name);
  }

  /** Dropdown that follows a numbered question label, e.g. "1. Trade". */
  async selectQuestion(question: string, option: string): Promise<void> {
    const { page } = this;
    const combo = page
      .locator(`xpath=//*[starts-with(normalize-space(translate(., ' ', ' ')), "${question}")]/following::kendo-combobox[1]`)
      .first();
    await combo.locator('.k-input-button').click();
    await page
      .getByRole('option')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(option)}\\s*$`) })
      .first()
      .click();
    await expect(combo.locator('input')).toHaveValue(option);
  }

  /** Saves; fails if the app shows validation errors, otherwise expects the "Quote Saved" toast. */
  async save(): Promise<void> {
    await clickSave(this.page);
    await expectToast(this.page, 'Quote Saved', 'any', 60_000);
    await expect(this.page.locator('text=/Error\\(s\\) have been discovered/'), 'validation errors after save').toHaveCount(0);
  }

  /** Save attempt that is expected to fail validation (it makes the coverage nodes appear in the tree). */
  async saveExpectingValidation(): Promise<void> {
    await clickSave(this.page);
    await expect(this.page.locator('text=/Error\\(s\\) have been discovered/')).toBeVisible({ timeout: 30_000 });
  }

  /**
   * ⋮ → Get Price → dialog (risk sections ticked) → Get Price.
   * Passes when the success toast "Price is returned back from the rating engine" appears.
   */
  async getPrice(riskSections: string[]): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Get Price');
    const dialog = page.getByRole('dialog').filter({ hasText: 'Select the Risk Sections to Get Price' });
    // Checkboxes aren't linked to their labels, so check the section names are listed and all boxes ticked.
    for (const s of riskSections) await expect(dialog.getByText(s, { exact: true })).toBeVisible();
    for (const box of await dialog.locator('input[type=checkbox]').all()) await expect(box).toBeChecked();

    const priced = page.waitForResponse((r) => /api\/quote\/GetPrice/i.test(r.url()), { timeout: 120_000 });
    await dialog.getByRole('button', { name: 'Get Price', exact: true }).click();
    await expectToast(page, 'Price is returned back from the rating engine', 'success');
    expect((await priced).ok(), 'GetPrice API succeeded').toBeTruthy();
  }
}

/** Reads the Premium section of the quote's Details tab (CMBC labels gross as "…Gross of Comm. & Net of IPT"). */
export async function readPremium(
  page: Page,
  quoteUrl: string,
  grossLabel = 'Policy Period Premium Gross of Comm. & IPT',
): Promise<Premium> {
  await page.goto(`/ui/Quote/Edit/${quoteId(quoteUrl)}`);
  await expandSectionFor(page, 'Premium', 'Calculated On');
  const num = async (label: string) => Number((await field(page, label).inputValue()).replace(/,/g, ''));
  return {
    policyPeriodGross: await num(grossLabel),
    policyPeriodNet: await num('Policy Period Premium Net of Comm. & IPT'),
    calculatedOn: await field(page, 'Calculated On').inputValue(),
  };
}
