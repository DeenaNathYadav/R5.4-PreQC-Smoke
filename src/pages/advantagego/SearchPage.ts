import { Page, expect } from '@playwright/test';

export type SearchCategory = 'All' | 'Risk-Submission' | 'Risk-Quote' | 'Risk-Policy' | 'Party' | 'Notes' | 'Tasks' | 'Groups';

/** Header search: category + keyword → grouped results ("Quotes (1)"), plus the Advanced Filters panel. */
export class SearchPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/ui/home/dashboard');
    await expect(this.keywordBox).toBeVisible();
  }

  private get keywordBox() {
    return this.page.getByPlaceholder('Enter keyword to search');
  }

  async selectCategory(category: SearchCategory): Promise<void> {
    await this.page.getByText('All', { exact: true }).first().click();
    await this.page.getByText(category, { exact: true }).click();
  }

  async search(keyword: string): Promise<void> {
    await this.keywordBox.fill(keyword);
    await this.keywordBox.press('Enter');
  }

  /** Waits until a result group heading shows the expected count, e.g. ("Quotes", 1) → button "Quotes (1)". */
  async expectResultCount(group: string, count: number, timeout = 60_000): Promise<void> {
    await expect(this.page.getByRole('button', { name: `${group} (${count})`, exact: true })).toBeVisible({ timeout });
  }

  /** Advanced Filters only enable once a category is chosen and a search has run. */
  async openAdvancedFilters(): Promise<void> {
    await this.page.locator('.testing-filter').click();
    await expect(this.page.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
    // Applied filter values are appended to the keyword, so clear it and let the filters do the searching
    await this.keywordBox.fill('');
  }

  async fillAdvancedText(label: string, value: string): Promise<void> {
    // The input follows its label in the panel; climbing to a common ancestor would reach the keyword box
    await this.page.locator(`xpath=//label[normalize-space()="${label}"]/following::input[1]`).fill(value);
  }

  async applyAdvancedFilters(): Promise<void> {
    await this.page.getByRole('button', { name: 'Apply', exact: true }).click();
  }
}
