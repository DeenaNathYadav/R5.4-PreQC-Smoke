import { Page, expect } from '@playwright/test';
import { businessAction, clickSave, expectTitleWithReload, expectToast, referenceFromTitle, acknowledgeUntil, saveAcknowledgingWarnings } from './entity';
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
    const url = `/ui/Policy/Edit/${id}`;
    await this.page.goto(url);
    await expectTitleWithReload(this.page, /RSK\d+P\d+/, { url });
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
    // A warnings banner (ACKNOWLEDGE) can hold the action back, as with the other confirm actions
    const saved = page.locator('.toast').filter({ hasText: 'Policy Saved' }).first();
    await acknowledgeUntil(page, () => saved.isVisible());
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
    await saveAcknowledgingWarnings(page, async () => /\/ui\/Quote\/Edit\/\d+/.test(page.url()));
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 30_000 });
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
    const saved = page.locator('.toast').filter({ hasText: /Policy Saved|Financial Posting Completed/ }).first();
    await acknowledgeUntil(page, () => saved.isVisible());
    await expectToast(page, /Policy Saved|Financial Posting Completed/, 'any', 30_000);
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

  /**
   * Endorsement grid → the row's ⋮ (Action column) → Reverse → "Are you sure you want to reverse this endorsement?" → Yes.
   * `rowText` picks the endorsement row (e.g. its Reason Description).
   */
  async reverseEndorsement(rowText: string): Promise<void> {
    const { page } = this;
    await page.getByRole('button', { name: 'Endorsement', exact: true }).first().click();
    const row = page.getByRole('row').filter({ hasText: rowText }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('button.dropdown-toggle').click();
    await row.locator('.dropdown-menu a', { hasText: 'Reverse' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: /Are you sure you want to reverse this endorsement/ });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(confirm).toBeHidden({ timeout: 60_000 });
  }

  /**
   * After Reverse → Yes: the header status reads "Reversed" and the reversed endorsement's grid row changes from Bound to
   * Reversed (the original endorsement 000 stays Bound). Retries through reloads while the backend finishes.
   */
  async expectEndorsementReversed(rowText: string, timeout = 120_000): Promise<void> {
    const { page } = this;
    await expect(async () => {
      await page.reload();
      await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('listitem').filter({ hasText: /\bReversed\b/ }).first()).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Endorsement', exact: true }).first().click();
      const row = page.getByRole('row').filter({ hasText: rowText }).first();
      await expect(row).toContainText('Reversed', { timeout: 10_000 });
      await expect(page.getByRole('row').filter({ hasText: 'Original' }).first()).toContainText('Bound');
    }).toPass({ timeout, intervals: [5_000] });
  }

  /** Header status block reads "Bound Booked" (endorsement) or "Cancelled Booked" (cancellation); the grid below has hidden duplicates. */
  async expectConfirmed(timeout = 60_000): Promise<void> {
    await expect(this.page.getByRole('listitem').filter({ hasText: /^\s*(Bound|Cancelled)\s+Booked\s*$/ }).first()).toBeVisible({ timeout });
  }

  /**
   * ⋮ → Renew - Quote → dialog "Renewal" step 1 (risk sections, all pre-ticked) → NEXT → step 2 (schedules) → RENEW.
   * Creates the renewal quote. `expectSchedules`: the product has a schedule (CMBC) - wait for its rows and tick them.
   * PI has none, so its step 2 shows an empty grid.
   */
  async renew({ expectSchedules = false }: { expectSchedules?: boolean } = {}): Promise<void> {
    const { page } = this;
    this.termBeforeRenewal = await this.termText().catch(() => '');
    await businessAction(page, 'Renew - Quote');
    const dialog = page.getByRole('dialog').filter({ hasText: /Select the Risk Sections for renewal/ });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'NEXT', exact: true }).click();
    const schedulesStep = page.getByRole('dialog').filter({ hasText: /Select schedules for renewal/ });
    await expect(schedulesStep).toBeVisible({ timeout: 60_000 });
    // The schedules grid fills in a moment after the step opens. Renewing before it has rendered, or with "Renew Schedules"
    // unticked, gives a renewal quote with NO schedule items, so wait for the rows and make sure the column is ticked.
    if (expectSchedules) {
      await expect(schedulesStep.locator('.ag-row').locator('visible=true').first()).toBeVisible({ timeout: 30_000 });
      for (const box of await schedulesStep.locator('.ag-header-select-all .ag-checkbox-input-wrapper').locator('visible=true').all()) {
        if (!(await box.evaluate((e) => e.classList.contains('ag-checked')))) await box.click();
      }
    }
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
    // The page opens showing the policy being renewed and swaps in the renewal quote a moment later; a Save in between
    // saves the policy (api/policy/UpdatePolicy) instead of creating the renewal. The renewal term in the header
    // ("Inception - Expiry Date" a year on) shows the swap has happened.
    if (this.termBeforeRenewal) {
      await expect
        .poll(() => this.termText().catch(() => this.termBeforeRenewal), { timeout: 60_000, intervals: [1_000] })
        .not.toBe(this.termBeforeRenewal)
        .catch(() => {}); // header never changed: carry on as before rather than fail on an assumption about the screen
    }
    await saveAcknowledgingWarnings(page, async () => /\/ui\/Quote\/Edit\/\d+/.test(page.url()));
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 30_000 });
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url() };
  }

  private termBeforeRenewal = '';

  /** The header's "Inception - Expiry Date" text, e.g. "19/10/2026 - 18/10/2027". */
  private async termText(): Promise<string> {
    const header = this.page.getByText(/\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}/).first();
    return (await header.innerText({ timeout: 10_000 })).replace(/\s+/g, ' ').trim();
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
    await saveAcknowledgingWarnings(page, () => page.getByText(/RSK\d+P\d+\/MTA\d+/).first().isVisible());
    await expect(page.getByText(/RSK\d+P\d+\/MTA\d+/).first()).toBeVisible({ timeout: 30_000 });
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
    await saveAcknowledgingWarnings(page, () => page.getByText(/RSK\d+P\d+\/MTA\d+/).first().isVisible());
    await expect(page.getByText(/RSK\d+P\d+\/MTA\d+/).first()).toBeVisible({ timeout: 30_000 });
  }
}
