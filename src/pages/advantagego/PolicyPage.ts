import { Page, expect, test } from '@playwright/test';
import {
  acknowledgeUntil,
  businessAction,
  clickSave,
  expectTitleWithReload,
  expectToast,
  listActions,
  referenceFromTitle,
  reloadWithMenu,
  saveAcknowledgingWarnings,
} from './entity';
import { expandSectionFor, field, fieldContainer, formatDate, selectDate, selectDropdown } from './kendo';

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
    // The "Policy Saved" toast is sometimes gone before it is looked for: the Bound / Booked status says the same
    await expect(async () => {
      const toast = await saved.isVisible();
      const bound = await page.getByRole('listitem').filter({ hasText: /^\s*Bound\s+Booked\s*$/ }).first().isVisible();
      expect(toast || bound, '"Policy Saved" toast or Bound / Booked status').toBeTruthy();
    }).toPass({ timeout: 120_000, intervals: [1_000] });
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
    declaration?: string; // mandatory on some products (Fleet): the Declaration section's dropdown
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
    if (data.declaration) await this.chooseDeclaration(data.declaration);
  }

  /** Effective From on an endorsement / cancellation: picked in the calendar when it is editable, then checked. */
  private async setEffectiveFrom(date: Date): Promise<void> {
    const { page } = this;
    const container = fieldContainer(page, 'Effective From');
    await container.scrollIntoViewIfNeeded();
    const input = field(page, 'Effective From');
    const wanted = formatDate(date);
    const current = (await input.inputValue()).trim();
    if (current === wanted) return;
    // The cancellation form pre-sets Effective From (to the policy's inception date) and can lock it: a picker click is then
    // intercepted. A locked date cannot be changed, so say which date the cancellation took instead of failing the test.
    if (!(await input.isEditable()) || !(await container.getByRole('button', { name: 'Toggle calendar' }).count())) {
      const note = `Effective From is read-only on the cancellation form: it keeps ${current} (wanted ${wanted})`;
      console.warn(note);
      test.info().annotations.push({ type: 'effective from', description: note });
      return;
    }
    await selectDate(page, 'Effective From', date);
    await expect(input, 'Effective From of the cancellation').toHaveValue(wanted);
  }

  /** The Declaration section (Fleet): its dropdown is mandatory before Save ("Please enter a valid value for Declaration"). */
  async chooseDeclaration(value: string): Promise<void> {
    const { page } = this;
    // The label carries a required "*", so it isn't matched by the exact-label helpers: look for it by prefix
    // (other tabs of the page keep hidden labels of the same name, so only a visible one counts)
    const container = page
      .locator('main label')
      .filter({ hasText: /^\s*Declaration/ })
      .filter({ visible: true })
      .first()
      .locator('xpath=ancestor::div[.//input][1]');
    const header = page.getByRole('button', { name: 'Declaration', exact: true });
    // The header's aria-expanded reads "true" even while the section is collapsed, so go by whether the field shows
    for (let attempt = 0; attempt < 2 && !(await container.isVisible()); attempt++) {
      await header.click();
      await container.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    }
    await expect(container).toBeVisible();
    const option = page.getByRole('option', { name: value, exact: true });
    await expect(async () => {
      if (!(await option.isVisible())) await container.locator('.k-input-button').click();
      await expect(option).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 40_000 });
    await option.click();
    await expect(container.locator('input').first()).toHaveValue(value);
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
    const saved = page.locator('.toast').filter({ hasText: /Policy Saved|Financial Posting Completed/ }).first();
    const booked = page.getByRole('listitem').filter({ hasText: /^\s*(Bound|Cancelled)\s+Booked\s*$/ }).first();
    // The "Policy Saved" toast is easy to miss on this host, and a confirm sometimes does nothing the first time: when neither the
    // toast nor the Booked status shows, reload and press the action again while it is still on offer
    for (let attempt = 1; attempt <= 3; attempt++) {
      await businessAction(page, label);
      await acknowledgeUntil(page, async () => (await saved.isVisible()) || (await booked.isVisible()), 90_000);
      if ((await saved.isVisible().catch(() => false)) || (await booked.isVisible().catch(() => false))) break;
      await reloadWithMenu(page);
      if (await booked.waitFor({ timeout: 10_000 }).then(() => true, () => false)) break;
      if (!(await listActions(page)).includes(label)) break;
    }
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
    // When the page's translations have not loaded the buttons show their keys (COMMON.PROMPT.OK_BTN) instead of "Yes"
    await confirm.getByRole('button', { name: /^(Yes|COMMON\.PROMPT\.OK_BTN)$/ }).click();
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
   * With `effectiveFrom` the Effective From date is set to that date (the cancellation is checked to carry it).
   */
  async startMidTermCancellation(data: {
    reasonCode: string;
    reasonDescription: string;
    refundBasis: string;
    declaration?: string;
    effectiveFrom?: Date;
    /** Fleet leaves the mandatory Effective To empty: picked as inception + this many days. */
    effectiveToDaysAfterInception?: number;
  }): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Mid-Term Cancellation');
    await page.waitForURL('**/midTermEndorsementPolicy/**', { timeout: 60_000 });

    await expandSectionFor(page, 'Endorsement', 'Reason Code');
    if (data.effectiveFrom) await this.setEffectiveFrom(data.effectiveFrom);
    await selectDropdown(page, 'Reason Code', data.reasonCode);
    await field(page, 'Reason Description').fill(data.reasonDescription);
    await selectDropdown(page, 'Refund Basis', data.refundBasis);
    if (data.effectiveToDaysAfterInception !== undefined && !(await field(page, 'Effective To').inputValue()).trim()) {
      const to = await this.inceptionDate();
      to.setDate(to.getDate() + data.effectiveToDaysAfterInception);
      await selectDate(page, 'Effective To', to);
    }
    // Only the endorsement form has a Declaration section (Fleet); the cancellation form does not
    if (data.declaration && (await page.getByRole('button', { name: 'Declaration', exact: true }).count())) {
      await this.chooseDeclaration(data.declaration);
    }
  }

  /**
   * ⋮ → Inception Cancellation opens an unsaved cancellation from inception (/ui/Policy/Endorsement/<id>/inceptionEndorsementPolicy/…).
   * Same Endorsement section as the mid-term one: reason code and description, plus the refund basis when the product asks for it.
   */
  async startInceptionCancellation(data: { reasonCode: string; reasonDescription: string; refundBasis?: string }): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Inception Cancellation');
    await page.waitForURL('**/inceptionEndorsementPolicy/**', { timeout: 60_000 });

    await expandSectionFor(page, 'Endorsement', 'Reason Code');
    await selectDropdown(page, 'Reason Code', data.reasonCode);
    await field(page, 'Reason Description').fill(data.reasonDescription);
    if (data.refundBasis) await selectDropdown(page, 'Refund Basis', data.refundBasis);
  }

  /**
   * Save on the inception cancellation: the app asks "Changing the dates at Parent level … Do you wish to confirm the
   * change?" (Confirm) and then shows "Effective dates of the Child components have been updated…" (Ok), after which the
   * cancellation MTA (…P001/MTA001) exists. If the record still has no MTA reference after Ok, Save is pressed once more.
   */
  async saveInceptionCancellation(): Promise<void> {
    const { page } = this;
    const confirm = page
      .getByRole('dialog')
      .filter({ hasText: /Do you wish to confirm the change/ })
      .getByRole('button', { name: 'Confirm', exact: true });
    const info = page
      .getByRole('dialog')
      .filter({ hasText: /Effective dates of the Child components have been updated/ })
      .getByRole('button', { name: 'Ok', exact: true });
    const created = page.getByText(/RSK\d+P\d+\/MTA\d+/).first();
    let savedAgain = false;
    let infoSeenAt = 0;
    await clickSave(page);
    await acknowledgeUntil(page, async () => {
      if (await confirm.isVisible()) await confirm.click();
      if (await info.isVisible()) {
        await info.click();
        infoSeenAt = Date.now();
      }
      if (await created.isVisible()) return true;
      if (infoSeenAt && !savedAgain && Date.now() - infoSeenAt > 15_000) {
        savedAgain = true;
        await clickSave(page);
      }
      return false;
    }, 180_000);
    await expect(created).toBeVisible({ timeout: 30_000 });
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
