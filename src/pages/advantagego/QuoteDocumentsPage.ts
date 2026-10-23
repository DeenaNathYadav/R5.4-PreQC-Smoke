import fs from 'fs';
import { Page, expect } from '@playwright/test';
import { selectDialogDropdown } from './kendo';
import { businessAction, expectToast } from './entity';

const entityId = (url: string) => url.match(/\/ui\/(?:Quote|Policy)\/\w+\/(\d+)/)![1];

export interface UploadData {
  /** Local file to upload (the app rejects types like .txt; PDF works). */
  filePath: string;
  documentType: string;
}

/** DOCUMENTS tab of a quote or policy: Documents grid (upload / download) and Terms (wordings). */
export class QuoteDocumentsPage {
  constructor(private readonly page: Page, private readonly entity: 'Quote' | 'Policy' = 'Quote') {}

  private entityUrl = '';

  async open(entityUrl: string): Promise<void> {
    this.entityUrl = entityUrl;
    await this.page.goto(`/ui/${this.entity}/Documents/${entityId(entityUrl)}`);
    await expect(this.page.getByText(/Documents \(\d+\)/).first()).toBeVisible({ timeout: 60_000 });
  }

  /** Terms tab → Attach Terms → Automatic Wording. Passes whether the wording was just attached or already was. */
  async attachAutomaticTerms(): Promise<void> {
    const { page } = this;
    await page.getByText('Terms', { exact: true }).locator('visible=true').first().click();
    await page.getByRole('button', { name: 'Attach Terms' }).first().click();
    await page.getByText('Automatic Wording', { exact: true }).click();
    // Either the terms are attached now or the app says they already were; both leave a wording in the tree.
    await expect(page.getByText('Policy wording', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await this.open(this.entityUrl); // back to the Documents grid ("Documents" also labels the page tab and the side nav)
  }

  /** Documents grid: + → Attach File → pick the file → choose a document type → Attach. */
  async upload(data: UploadData): Promise<string> {
    const { page } = this;
    const title = data.filePath.split(/[\\/]/).pop()!;
    await page.locator('[title="Attach File(s)"]').first().click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Attach File', { exact: true }).click()]);
    await chooser.setFiles(data.filePath);

    const dialog = page.getByRole('dialog').filter({ hasText: 'Document Title' });
    await expect(dialog).toBeVisible();
    await selectDialogDropdown(page, dialog, 'Document Type', data.documentType);
    await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
    // The grid fills a few seconds after the dialog closes; on a slow document service it can stay at "(0)" until refreshed
    for (let attempt = 1; ; attempt++) {
      try {
        await expect(this.row(title)).toBeVisible({ timeout: 40_000 });
        return title;
      } catch (e) {
        if (attempt >= 3) throw e;
        await this.open(this.entityUrl);
      }
    }
  }

  /** Status of every document row in the grid, e.g. ["Completed", "In Progress"]. */
  async statuses(): Promise<string[]> {
    const cells = this.page.locator('.ag-center-cols-container .ag-row .ag-cell[col-id="status"]');
    return (await cells.allInnerTexts()).map((t) => t.trim());
  }

  /**
   * Generated documents (policy schedule, covering letter…) start as "In Progress". Checks that every document
   * reaches "Completed": refreshes the list by switching Terms → Documents, waits `delayMs` and retries up to `retries` times.
   */
  async expectAllDocumentsCompleted(opts: { delayMs?: number; retries?: number } = {}): Promise<string[]> {
    const { delayMs = 20_000, retries = 2 } = opts;
    const { page } = this;
    let statuses: string[] = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await page.waitForTimeout(delayMs);
      await page.getByText('Terms', { exact: true }).locator('visible=true').first().click();
      await this.open(this.entityUrl); // back to the Documents grid with fresh statuses
      await expect(this.page.locator('.ag-center-cols-container .ag-row').first()).toBeVisible({ timeout: 30_000 });
      statuses = await this.statuses();
      if (statuses.length > 0 && statuses.every((s) => /^completed$/i.test(s))) return statuses;
      // "In Error" is final (the document service failed to generate it): waiting longer cannot help
      if (statuses.some((s) => /error/i.test(s))) throw new Error(`Document generation failed: ${statuses.join(', ')}`);
    }
    throw new Error(`Not all documents completed after ${retries + 1} checks (${delayMs / 1000}s apart): ${statuses.join(', ')}`);
  }

  /** Clicks the row's Download action and returns the downloaded file's size in bytes. */
  async download(title: string): Promise<{ fileName: string; size: number }> {
    const { page } = this;
    const rowIndex = await this.row(title).getAttribute('row-index');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      // Row actions (Preview / Download / Edit) live in the grid's pinned-right container
      page.locator(`.ag-pinned-right-cols-container .ag-row[row-index="${rowIndex}"] [title="Download"]`).click(),
    ]);
    const path = await download.path();
    return { fileName: download.suggestedFilename(), size: fs.statSync(path).size };
  }

  /** "Downloaded On" is filled in for the row once it has been downloaded. */
  async expectDownloadedOn(title: string): Promise<void> {
    await expect(this.row(title).locator('.ag-cell[col-id="downloadedDateTime"]')).not.toBeEmpty({ timeout: 30_000 });
  }

  /** ⋮ → Generate Document → Generate (all listed templates are pre-selected). */
  async generateDocuments(): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Generate Document');
    const dialog = page.getByRole('dialog').filter({ hasText: 'Generate Document(s) for' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await expectToast(page, /document/i, 'any', 120_000);
  }

  private row(title: string) {
    return this.page.locator('.ag-center-cols-container .ag-row').filter({ hasText: title }).first();
  }
}
