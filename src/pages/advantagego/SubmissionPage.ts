import { Page, expect } from '@playwright/test';
import { expandSectionFor, field, fieldContainer, selectAutocomplete, selectDropdown } from './kendo';
import { businessAction, clickSave, referenceFromTitle } from './entity';

/** Fields the New Submission form doesn't ask for, but Convert to Quote requires. */
export interface SubmissionDetails {
  transactionType: string;
  businessCategory: string;
  underwriter: string;
}

/** A field that must be filled on the quote before it can be saved (varies by product). */
export interface RequiredQuoteField {
  section: string;
  label: string;
  value: string;
}

export interface AnalysisCode {
  type: string;
  value: string;
}

export interface ConvertToQuoteData {
  /** As listed in the Product dropdown, e.g. "Professional Indemnity". */
  product: string;
  /** Auto-filled from the product; checked when provided. */
  insuranceType?: string;
  contractStructure?: string;
  requiredFields?: RequiredQuoteField[];
  analysisCodes?: AnalysisCode[];
}

export interface CreatedQuote {
  reference: string;
  url: string;
}

export class SubmissionPage {
  constructor(private readonly page: Page) {}

  /** contractId is the number in /ui/Submission/<tab>/<contractId>. */
  async open(contractId: number): Promise<void> {
    await this.page.goto(`/ui/Submission/Edit/${contractId}`);
    await expect(this.page).toHaveTitle(/Underwriting - RSK\d+$/);
    // On a cold environment the page can stay blank (title set, no content): reload until the toolbar renders
    const more = this.page.locator('button[title="More"]').first();
    let attempt = 0;
    await expect(async () => {
      if (attempt++ > 0) await this.page.reload();
      await expect(more).toBeVisible({ timeout: 20_000 });
    }).toPass({ timeout: 120_000 });
  }

  async completeDetails(details: SubmissionDetails): Promise<void> {
    const { page } = this;
    await expandSectionFor(page, 'Submission Information', 'Transaction Type');
    await selectDropdown(page, 'Transaction Type', details.transactionType);
    await selectDropdown(page, 'Business Category', details.businessCategory);
    await expandSectionFor(page, 'Underwriter Details', 'Underwriter Name');
    await selectAutocomplete(page, 'Underwriter Name', details.underwriter.split(',')[0], details.underwriter);

    const saved = page.waitForResponse((r) => /api\/submission\/UpdateSubmission/i.test(r.url()), { timeout: 60_000 });
    await clickSave(page);
    expect((await saved).ok(), 'UpdateSubmission succeeded').toBeTruthy();
  }

  /** ⋮ → Convert to Quote → pick product → Confirm → fill required fields → Save. */
  async convertToQuote(data: ConvertToQuoteData): Promise<CreatedQuote> {
    const { page } = this;
    await businessAction(page, 'Convert to Quote');
    await expect(page.getByText('Product and Method of Placement')).toBeVisible({ timeout: 30_000 });

    await selectDropdown(page, 'Product', data.product);
    if (data.insuranceType) await expect(field(page, 'Insurance Type')).toHaveValue(data.insuranceType);
    if (data.contractStructure) await expect(field(page, 'Contract Structure')).toHaveValue(data.contractStructure);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.waitForURL('**/ui/Quote/Conversion', { timeout: 60_000 });

    for (const f of data.requiredFields ?? []) {
      await expandSectionFor(page, f.section, f.label);
      await fieldContainer(page, f.label).scrollIntoViewIfNeeded();
      await selectDropdown(page, f.label, f.value);
    }
    if (data.analysisCodes?.length) {
      const section = page.getByRole('button', { name: 'Analysis Codes', exact: true });
      const grid = section.locator('xpath=following::div[contains(@class,"ag-root-wrapper")][1]');
      if (!(await grid.isVisible())) await section.click();
      await expect(grid).toBeVisible();
      for (const code of data.analysisCodes) {
        const row = grid.locator('.ag-center-cols-container .ag-row').filter({ hasText: code.type }).first();
        const value = row.locator('.ag-cell[col-id="CodeValue"]');
        const option = page
          .getByRole('option')
          .filter({ hasText: new RegExp(`^\\s*${code.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`) })
          .first();
        await expect(async () => {
          if ((await value.innerText()).includes(code.value)) return;
          await value.dblclick();
          await expect(option).toBeVisible({ timeout: 5_000 });
          await option.click();
          await page.keyboard.press('Tab');
          await expect(value).toContainText(code.value);
        }).toPass({ timeout: 40_000 });
      }
    }

    // The quote only gets a reference once saved: /ui/Quote/Conversion → /ui/Quote/Edit/<id>
    await clickSave(page);
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 90_000 });
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url() };
  }
}
