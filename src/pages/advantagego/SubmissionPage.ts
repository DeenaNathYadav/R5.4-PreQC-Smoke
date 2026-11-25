import { Page, expect } from '@playwright/test';
import { expandSectionFor, field, fieldContainer, selectAutocomplete, selectDropdown } from './kendo';
import { acknowledgeWarnings, businessAction, referenceFromTitle, clickSave, saveAcknowledgingWarnings, trackApiRequests, waitForIdle } from './entity';

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

/** A numbered question (not a <label> field) whose answer is a dropdown, e.g. MTP's "1. Has the broker visited the client...?". */
export interface RequiredQuestion {
  section: string;
  /** Start of the question text, e.g. "1. Has the broker visited the client". */
  question: string;
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
  requiredQuestions?: RequiredQuestion[];
  analysisCodes?: AnalysisCode[];
  /**
   * Extra time (ms) to wait on the conversion page after the required fields are filled, before Save: the app's own browser rules
   * (e.g. PPP's default offering and risk section) run then. Only products that set it wait.
   */
  waitBeforeSaveMs?: number;
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
    await acknowledgeWarnings(page);
  }

  /**
   * ⋮ → Convert to Quote → pick product → Confirm → wait for the conversion page to finish loading → fill required fields → wait
   * again → Save. The conversion page keeps loading after its fields show (e.g. PPP loads its default offering's risk section into the
   * page); touching it or saving before that finishes saves the quote without them (PPP: no cover, so every later save is refused).
   */
  async convertToQuote(data: ConvertToQuoteData): Promise<CreatedQuote> {
    const { page } = this;
    const requests = trackApiRequests(page);
    try {
      return await this.convertAndSave(data, requests);
    } finally {
      requests.stop();
    }
  }

  private async convertAndSave(data: ConvertToQuoteData, requests: ReturnType<typeof trackApiRequests>): Promise<CreatedQuote> {
    const { page } = this;
    await businessAction(page, 'Convert to Quote');
    await expect(page.getByText('Product and Method of Placement')).toBeVisible({ timeout: 30_000 });

    await selectDropdown(page, 'Product', data.product);
    if (data.insuranceType) await expect(field(page, 'Insurance Type')).toHaveValue(data.insuranceType);
    if (data.contractStructure) await expect(field(page, 'Contract Structure')).toHaveValue(data.contractStructure);
    // Picking the product makes the app load its offerings and their risk sections; Confirm before that has finished opens the
    // conversion page without the offering's default risk section (PPP: the quote is then saved with no cover). Wait as a user does.
    await waitForIdle(page);
    await requests.settled(3_000, 60_000);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.waitForURL('**/ui/Quote/Conversion', { timeout: 60_000 });
    // Let the conversion page finish setting itself up before touching any field, as a user does: it loads the defaulted offering
    // and (PPP) its default risk section into the page, which the Save then stores. Filling fields while that is still loading has
    // left PPP quotes saved without their risk section (no cover, so every later save is refused).
    await waitForIdle(page);
    await requests.settled(3_000, 90_000);

    for (const f of data.requiredFields ?? []) {
      await expandSectionFor(page, f.section, f.label);
      await fieldContainer(page, f.label).scrollIntoViewIfNeeded();
      await selectDropdown(page, f.label, f.value);
    }
    for (const q of data.requiredQuestions ?? []) {
      // The Risk Validation header is not a button (unlike Analysis Codes), so it is found by its text
      const header = page.getByText(q.section, { exact: true }).first();
      const combo = page
        .locator(`xpath=//*[starts-with(normalize-space(translate(., ' ', ' ')), "${q.question}")]/following::kendo-combobox[1]`)
        .first();
      // The conversion page keeps loading for a while: wait for it, then open the section until the question shows
      await waitForIdle(page);
      await expect(async () => {
        if (!(await combo.isVisible())) {
          await header.scrollIntoViewIfNeeded();
          await header.click({ timeout: 8_000 });
        }
        await expect(combo).toBeVisible({ timeout: 6_000 });
      }).toPass({ timeout: 90_000, intervals: [2_000] });
      await combo.scrollIntoViewIfNeeded();
      await combo.locator('.k-input-button').click();
      await page.getByRole('option', { name: q.value, exact: true }).click();
      await expect(combo.locator('input')).toHaveValue(q.value);
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

    // Let the conversion page finish loading before saving: no API request in flight for 3 s (and the product's own extra wait)
    await waitForIdle(page);
    if (data.waitBeforeSaveMs) {
      console.log(`Conversion page: fields filled, waiting ${Math.round(data.waitBeforeSaveMs / 1000)} s before Save`);
      await page.waitForTimeout(data.waitBeforeSaveMs);
    }
    await requests.settled(3_000, 90_000);
    // The quote only gets a reference once saved: /ui/Quote/Conversion → /ui/Quote/Edit/<id>
    await saveAcknowledgingWarnings(page, async () => /\/ui\/Quote\/Edit\/\d+/.test(page.url()), 90_000);
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 90_000 });
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url() };
  }
}
