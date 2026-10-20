import { Page, expect } from '@playwright/test';
import { businessAction, clickSave, expectTitleWithReload, expectToast, referenceFromTitle } from './entity';
import { expandSectionFor, field, selectDate, selectDropdown } from './kendo';

export interface CreatedPolicy {
  reference: string;
  url: string;
}

/** Policy screens: the conversion page reached from a quote's Taken Up, and the bound policy afterwards. */
export class PolicyPage {
  constructor(private readonly page: Page) {}

  async open(policyUrl: string): Promise<void> {
    const id = policyUrl.match(/\/ui\/Policy\/\w+\/(\d+)/)![1];
    await this.page.goto(`/ui/Policy/Edit/${id}`);
    await expectTitleWithReload(this.page, /RSK\d+P\d+/);
  }

  /**
   * On /ui/Policy/Conversion (after Taken Up): Save creates the policy ("Risk has been converted to Policy")
   * and moves to /ui/Policy/Edit/<id>.
   */
  async saveConversion(): Promise<CreatedPolicy> {
    const { page } = this;
    await page.waitForURL('**/ui/Policy/Conversion', { timeout: 90_000 });
    await expect(page.locator('button[title="Save"]').first()).toBeVisible({ timeout: 60_000 });
    await clickSave(page);
    await page.waitForURL(/\/ui\/Policy\/Edit\/\d+/, { timeout: 120_000 });
    const reference = await referenceFromTitle(page, /RSK\d+P\d+/);
    return { reference, url: page.url() };
  }

  /** ⋮ → Confirm Cover: Review → On Cover, status Bound / Booked. */
  async confirmCover(): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Confirm Cover');
    await expectToast(page, 'Policy Saved', 'any', 120_000);
    await expect(page.getByText('Bound', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  }

  /**
   * ⋮ → General Endorsement opens an unsaved endorsement (/ui/Quote/Endorsement/<id>/generalEndorsementWithQuote/…).
   * Fills the Endorsement section: type, effective-from date, reason code and description.
   */
  async startGeneralEndorsement(data: {
    endorsementType: string;
    effectiveFromDaysAfterInception: number;
    reasonCode: string;
    reasonDescription: string;
  }): Promise<void> {
    const { page } = this;
    await businessAction(page, 'General Endorsement');
    await page.waitForURL('**/generalEndorsementWithQuote/**', { timeout: 60_000 });

    await expandSectionFor(page, 'Endorsement', 'Endorsement Type');
    await selectDropdown(page, 'Endorsement Type', data.endorsementType);
    const from = await this.inceptionDate();
    from.setDate(from.getDate() + data.effectiveFromDaysAfterInception);
    await selectDate(page, 'Effective From', from);
    await selectDropdown(page, 'Reason Code', data.reasonCode);
    await field(page, 'Reason Description').fill(data.reasonDescription);
  }

  /**
   * Save on the endorsement page creates the endorsement quote (reference …Q002) linked to the policy and opens it
   * at /ui/Quote/Edit/<id>. Only one endorsement can be in progress per policy.
   */
  async saveEndorsement(): Promise<{ reference: string; url: string }> {
    const { page } = this;
    await clickSave(page);
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 120_000 });
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url() };
  }

  /** ⋮ → Confirm Endorsement (after Take Up Endorsement): binds the endorsement; the Endorsement grid then shows it Bound. */
  async confirmEndorsement(): Promise<void> {
    await this.confirmChange('Confirm Endorsement');
  }

  /** ⋮ → the confirm action on offer (Confirm Endorsement / Confirm Cancellation …): binds the change. */
  async confirmChange(label: string): Promise<void> {
    const { page } = this;
    await businessAction(page, label);
    await expectToast(page, /Policy Saved|Financial Posting Completed/, 'any', 120_000);
    await this.expectConfirmed();
  }

  /**
   * After Reinstate Contract: the backend completes the reinstatement itself, so the header goes back to Bound / Booked and
   * the Endorsement grid shows the latest MTA as "Reinstate Contract" (the earlier cancellation stays listed as Cancelled).
   * Retries through reloads while the backend finishes.
   */
  async expectReinstated(timeout = 120_000): Promise<void> {
    const { page } = this;
    await expect(async () => {
      await page.reload();
      await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 30_000 });
      await this.expectConfirmed(10_000);
      // Fresh load = collapsed section: one click expands it (the form field helper would toggle it back on this grid)
      await page.getByRole('button', { name: 'Endorsement', exact: true }).first().click();
      const rows = page.getByRole('row').filter({ hasText: /Reinstate Contract/ });
      await expect(rows.first()).toBeVisible({ timeout: 10_000 });
      await expect(rows.first()).toContainText(/Taken Up|Bound|Booked/);
    }).toPass({ timeout, intervals: [5_000] });
  }

  /** Header status block reads "Bound Booked" (endorsement) or "Cancelled Booked" (cancellation); the grid below has hidden duplicates. */
  async expectConfirmed(timeout = 60_000): Promise<void> {
    await expect(this.page.getByRole('listitem').filter({ hasText: /^\s*(Bound|Cancelled)\s+Booked\s*$/ }).first()).toBeVisible({ timeout });
  }

  /**
   * ⋮ → Renew - Quote → dialog "Renewal" step 1 (risk sections, all pre-ticked) → NEXT → step 2 (schedules) → RENEW.
   * Creates the renewal quote.
   */
  async renew(): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Renew - Quote');
    const dialog = page.getByRole('dialog').filter({ hasText: /Select the Risk Sections for renewal/ });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'NEXT', exact: true }).click();
    await expect(page.getByRole('dialog').filter({ hasText: /Select schedules for renewal/ })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'RENEW', exact: true }).click();

    // "Risk Sections that are not available in Product Offerings for renewal dates will be removed." → Ok
    const confirm = page.getByRole('dialog').filter({ hasText: /not available in Product Offerings for renewal dates/ });
    await expect(confirm).toBeVisible({ timeout: 60_000 });
    await confirm.getByRole('button', { name: 'Ok', exact: true }).click();
  }

  /**
   * After renew(): /ui/Quote/Renew is the unsaved renewal quote. Save creates it (reference …Q001 on the renewal
   * risk) and opens it at /ui/Quote/Edit/<id>.
   */
  async saveRenewal(): Promise<{ reference: string; url: string }> {
    const { page } = this;
    await page.waitForURL('**/ui/Quote/Renew', { timeout: 90_000 });
    await expect(page.locator('button[title="Save"]').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await clickSave(page);
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 120_000 });
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url() };
  }

  /** The policy term's start, from the header's "Inception - Expiry Date" (e.g. "17/10/2027 - 16/10/2028"). */
  async inceptionDate(): Promise<Date> {
    const header = this.page.getByText(/\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}/).first();
    await expect(header).toBeVisible({ timeout: 30_000 });
    const [, dd, mm, yyyy] = (await header.innerText()).match(/(\d{2})\/(\d{2})\/(\d{4})/)!;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }

  /**
   * ⋮ → Mid-Term Cancellation opens an unsaved cancellation (/ui/Policy/Endorsement/<id>/midTermEndorsementPolicy/…).
   * The Endorsement section has the type and Effective From pre-set; this picks the reason code, description and refund basis.
   */
  async startMidTermCancellation(data: { reasonCode: string; reasonDescription: string; refundBasis: string }): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Mid-Term Cancellation');
    await page.waitForURL('**/midTermEndorsementPolicy/**', { timeout: 60_000 });

    await expandSectionFor(page, 'Endorsement', 'Reason Code');
    await selectDropdown(page, 'Reason Code', data.reasonCode);
    await field(page, 'Reason Description').fill(data.reasonDescription);
    await selectDropdown(page, 'Refund Basis', data.refundBasis);
  }

  /** Save on the cancellation page creates the cancellation MTA on the policy: the header reference becomes …P001/MTA001. */
  async saveCancellation(): Promise<void> {
    const { page } = this;
    await clickSave(page);
    await expect(page.getByText(/RSK\d+P\d+\/MTA\d+/).first()).toBeVisible({ timeout: 120_000 });
  }

  /**
   * On the cancelled MTA record: ⋮ → Reinstate Contract opens an unsaved reinstatement
   * (/ui/Policy/Endorsement/<id>/ReinstateContract/…) with type and reason code pre-set; only the description is entered.
   */
  async startReinstatement(data: { reasonDescription: string }): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Reinstate Contract');
    await page.waitForURL('**/ReinstateContract/**', { timeout: 60_000 });
    await expandSectionFor(page, 'Endorsement', 'Reason Description');
    await field(page, 'Reason Description').fill(data.reasonDescription);
  }

  /** Save creates the reinstatement MTA (…P001/MTA002) at /ui/Policy/Edit/<id>. */
  async saveReinstatement(): Promise<void> {
    const { page } = this;
    await clickSave(page);
    await expect(page.getByText(/RSK\d+P\d+\/MTA\d+/).first()).toBeVisible({ timeout: 120_000 });
  }
}
