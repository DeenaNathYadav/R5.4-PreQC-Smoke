import { Locator, Page, expect } from '@playwright/test';
import {
  acknowledgeUntil,
  acknowledgeWarnings,
  businessAction,
  clickSave,
  expectTitleWithReload,
  expectToast,
  referenceFromTitle,
  reloadWithMenu,
  saveAcknowledgingWarnings,
  waitForIdle,
} from './entity';
import { expandSectionFor, field, fieldContainer, formatDate, selectDate, selectDialogDropdown, selectDialogMulti } from './kendo';
import { QuoteSectionsPage } from './QuoteSectionsPage';

const quoteId = (quoteUrl: string) => quoteUrl.match(/\/ui\/Quote\/\w+\/(\d+)/)![1];

const TASK_STATUS = /\b(Not Started|In Progress|Approved|Rejected|Completed)\b/;

export type IssueOutcome = 'issued' | 'referred';

export interface TaskData {
  taskType: string;
  reason: string;
  /** Person the task is assigned to (Assigned To = Individual). */
  assignee: string;
  subject: string;
}

/** Quote workflow actions (DETAILS / HISTORY tabs and the ⋮ menu). */
export class QuotePage {
  constructor(private readonly page: Page) {}

  async open(quoteUrl: string, tab: 'Edit' | 'History' = 'Edit'): Promise<void> {
    const url = `/ui/Quote/${tab}/${quoteId(quoteUrl)}`;
    await this.page.goto(url);
    await expectTitleWithReload(this.page, /RSK\d+Q\d+/, { url });
  }

  private get errorBanner(): Locator {
    // "1 Error(s) have been discovered" is split across elements, so match the label alone
    return this.page.getByText('Error(s)');
  }

  private get warningBanner(): Locator {
    return this.page.getByText('Warning(s)');
  }

  /** Confirms the "Move workflow to next stage" dialog (shown by Issue Quote). */
  private async confirmMoveToNextStage(): Promise<void> {
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Move workflow to next stage' });
    await dialog.getByRole('button', { name: 'Ok', exact: true }).click();
  }

  /** After a reload, DETAILS → Commission lists a "Broker Commission" deduction (proves it was saved). */
  async expectBrokerCommission(): Promise<void> {
    const { page } = this;
    await page.reload();
    const section = page.getByRole('button', { name: /^Commissions?$/ });
    // The Details tab re-renders for a moment after it opens, so the section element can detach under the call: retry
    await expect(async () => {
      await section.scrollIntoViewIfNeeded({ timeout: 8_000 });
    }).toPass({ timeout: 40_000, intervals: [1_000] });
    const grid = section.locator('xpath=following::div[contains(@class,"ag-root-wrapper")][1]');
    if (!(await grid.isVisible())) await section.click();
    await expect(grid.locator('.ag-cell[col-id="DeductionTypeId"]', { hasText: 'Broker Commission' })).toBeVisible({
      timeout: 30_000,
    });
  }

  /**
   * PI and PPP aren't eligible for ⋮ → Get Commission, so the Broker Commission deduction is set by hand:
   * DETAILS → Commission → the Broker Commission row's Selected % (→ Save). When the quote has no Broker Commission row yet, one is
   * added with "+" (Deduction Type "Broker Commission"); with `requireDefaultRow` a missing row fails the test instead.
   */
  async addBrokerCommission(percent: string, { requireDefaultRow = false } = {}): Promise<void> {
    const { page } = this;
    const section = page.getByRole('button', { name: /^Commissions?$/ });
    // The Details tab re-renders for a moment after it opens, so the section element can detach under the call: retry
    await expect(async () => {
      await section.scrollIntoViewIfNeeded({ timeout: 8_000 });
    }).toPass({ timeout: 40_000, intervals: [1_000] });
    const grid = section.locator('xpath=following::div[contains(@class,"ag-root-wrapper")][1]');
    if (!(await grid.isVisible())) await section.click();
    await expect(grid).toBeVisible();

    const rows = grid.locator('.ag-center-cols-container .ag-row');
    // A product can already carry a Broker Commission row (empty Override %): update it instead of adding a second one
    const existing = rows.filter({ has: page.locator('.ag-cell[col-id="DeductionTypeId"]', { hasText: 'Broker Commission' }) });
    if (requireDefaultRow) expect(await existing.count(), 'a Broker Commission row is already defaulted on the quote').toBeGreaterThan(0);
    let row;
    if (await existing.count()) {
      row = existing.first();
    } else {
      const before = await rows.count();
      await page.locator('button[title^="Add Commission"]').click();
      await expect(rows).toHaveCount(before + 1);
      row = rows.nth(before);

      const type = row.locator('.ag-cell[col-id="DeductionTypeId"]');
      await type.dblclick();
      await page.getByRole('option').filter({ hasText: 'Broker Commission' }).first().click();
      await page.keyboard.press('Tab'); // commits the editor
      await expect(type).toHaveText('Broker Commission');
    }

    const rate = row.locator('.ag-cell[col-id="RatePercentage"]');
    // The editor occasionally doesn't open on the first double-click, so retry until the value sticks
    await expect(async () => {
      // The new row sits at the very bottom of the scrolling panel, so bring the cell fully into view first
      await rate.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 250);
      await rate.dblclick();
      await page.keyboard.press('Control+A');
      await page.keyboard.type(percent);
      await page.keyboard.press('Enter');
      await expect(rate).toContainText(percent, { timeout: 4_000 });
    }).toPass({ timeout: 30_000 });

    // The Details tab shows no "Quote Saved" toast, so wait for the save call itself
    const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
    await clickSave(page);
    expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
    await acknowledgeWarnings(page);
    // A "…may impact the premium, please press Get Price" banner is expected now; pricing follows in the next step.
  }

  /**
   * Details → Commissions: gives every commission row that has no Selected % the value `percent`. The commission connector answers
   * "not rated" for the test agency (error 90063) and leaves such rows empty, and a quote cannot move on without them. Rows that
   * already have a rate (and blank placeholder rows) are left alone; saves only when something changed. Returns how many rows were set.
   */
  async fillEmptyCommissionRates(percent: string): Promise<number> {
    const { page } = this;
    const section = page.getByRole('button', { name: /^Commissions?$/ });
    // The Details tab re-renders for a moment after it opens, so the section element can detach under the call: retry
    await expect(async () => {
      await section.scrollIntoViewIfNeeded({ timeout: 8_000 });
    }).toPass({ timeout: 40_000, intervals: [1_000] });
    const grid = section.locator('xpath=following::div[contains(@class,"ag-root-wrapper")][1]');
    if (!(await grid.isVisible())) await section.click();
    await expect(grid).toBeVisible();

    const rows = grid.locator('.ag-center-cols-container .ag-row').filter({ has: page.locator('.ag-cell[col-id="DeductionTypeId"]') });
    let changed = 0;
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      if (!(await row.locator('.ag-cell[col-id="DeductionTypeId"]').innerText()).trim()) continue; // blank placeholder row
      const rate = row.locator('.ag-cell[col-id="RatePercentage"]');
      if (Number((await rate.innerText()).replace(/,/g, '')) > 0) continue;
      await expect(async () => {
        await rate.scrollIntoViewIfNeeded();
        await rate.dblclick();
        await page.keyboard.press('Control+A');
        await page.keyboard.type(percent);
        await page.keyboard.press('Enter');
        await expect(rate).toContainText(percent, { timeout: 4_000 });
      }).toPass({ timeout: 30_000 });
      changed++;
    }
    if (!changed) return 0;
    const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
    await clickSave(page);
    expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
    await acknowledgeWarnings(page);
    return changed;
  }

  /**
   * CMBC: ⋮ → Get Commission → "Confirm Commission Updates" → Accept.
   * Sections the connector can't rate (e.g. error 90063 for agencies on the manual look-up table) are listed
   * in the dialog and left unchanged; returns those section names.
   */
  async getCommission(): Promise<string[]> {
    const { page } = this;
    const response = page.waitForResponse(
      (r) => /CommissionConnector\/GetCommissionRates/i.test(r.url()) && r.request().method() === 'POST',
      { timeout: 120_000 },
    );
    await businessAction(page, 'Get Commission');
    expect((await response).ok(), 'GetCommissionRates succeeded').toBeTruthy();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Confirm Commission Updates' }).first();
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await waitForIdle(page);
    await expect(dialog.locator('.ag-row').first()).toBeVisible({ timeout: 30_000 }).catch(() => {});
    const rejected = (await dialog.locator('.ag-row').allInnerTexts())
      .map((t) => t.replace(/^Contract\s*/, '').trim())
      .filter(Boolean);
    // The dialog re-renders while its grid loads; retry until the Accept click closes it
    await expect(async () => {
      await waitForIdle(page);
      if (await dialog.isVisible()) await dialog.getByRole('button', { name: /^accept$/i }).click({ timeout: 10_000 });
      await expect(dialog).toBeHidden({ timeout: 15_000 });
    }).toPass({ timeout: 120_000 });
    return [...new Set(rejected)];
  }

  /** ⋮ → Next Stage (Risk Details → UW Review & Process). Needs Broker Commission on the quote. */
  async nextStage(): Promise<void> {
    const { page } = this;
    const saved = page.locator('.toast').filter({ hasText: 'Quote Saved' }).first();
    // A quote that has only just been saved (a new renewal quote) can answer the first Next Stage with a bare HTTP 400 and
    // no "Quote Saved" toast; the same call succeeds after a reload, so retry that way before giving up.
    for (let attempt = 1; ; attempt++) {
      await businessAction(page, 'Next Stage');
      await acknowledgeUntil(page, async () => (await saved.count()) > 0, attempt < 3 ? 30_000 : 60_000);
      if ((await saved.count()) > 0) break;
      if (attempt >= 3) throw new Error('Next Stage did not report "Quote Saved" after 3 attempts');
      await reloadWithMenu(page);
    }
    await expect(this.errorBanner, 'errors after Next Stage').toHaveCount(0);
  }

  /**
   * ⋮ → Issue Quote → Ok. Re-prices when asked to ("…please press Get Price"). If the risk exceeds the
   * user's licence, acknowledges the warning (which raises a Licence Referral task) and returns 'referred'.
   */
  async issueQuote(riskSections: string[]): Promise<IssueOutcome> {
    const { page } = this;
    for (let attempt = 0; attempt < 3; attempt++) {
      await businessAction(page, 'Issue Quote');
      await this.confirmMoveToNextStage();

      const issued = page.getByText('Quote Issued', { exact: true });
      const needsPrice = page.getByText(/please press Get Price/);
      await expect(issued.or(needsPrice).or(this.warningBanner).first()).toBeVisible({ timeout: 180_000 }); // authority check can take a while

      if (await issued.isVisible()) return 'issued';

      if (await needsPrice.isVisible()) {
        // Premium-affecting changes (e.g. commission) since the last pricing
        const dialogShown = await new QuoteSectionsPage(page).getPrice(riskSections, { dialogOptional: true });
        // Priced without the section dialog: the warnings banner that follows disables ⋮ until it is acknowledged,
        // so carry on to the acknowledge step below instead of asking for Issue Quote again.
        const warned = !dialogShown && (await this.warningBanner.first().waitFor({ timeout: 20_000 }).then(() => true, () => false));
        if (!warned) continue;
      }

      // "Risk has exceeded Authority Limit. Please acknowledge the Warning to initiate an approval…"
      await page.getByText('ACKNOWLEDGE', { exact: true }).click();
      const sections = new QuoteSectionsPage(page);
      const moveDialog = page.getByRole('dialog').filter({ hasText: 'Move workflow to next stage' });
      const referred = page.locator('.toast').filter({ hasText: 'Task generated successfully and sent to Approval Group' }).first();
      // What follows depends on the quote: a price may be asked for first (the Get Price dialog opens, then Issue Quote is
      // run again), otherwise the usual "Move workflow" confirmation, or - CMBC within authority - the quote is issued straight away
      await expect(moveDialog.or(sections.priceDialog).or(referred).or(issued).first()).toBeVisible({ timeout: 120_000 });
      if (await sections.priceDialog.isVisible()) {
        await sections.confirmPriceDialog(riskSections);
        continue;
      }
      if (await moveDialog.isVisible()) await this.confirmMoveToNextStage();
      await expect(referred.or(issued).first()).toBeVisible({ timeout: 120_000 });
      return (await referred.isVisible()) ? 'referred' : 'issued';
    }
    throw new Error('Issue Quote still asks for Get Price after re-pricing');
  }

  /**
   * ⋮ → Taken Up on an issued quote. The risk is saved first; if that changed the premium the app asks for
   * "…please press Get Price", so re-price once and retry. Ends on /ui/Policy/Conversion.
   */
  async takeUp(riskSections: string[]): Promise<void> {
    const { page } = this;
    for (let attempt = 0; attempt < 2; attempt++) {
      // "Taken Up" on a new-business quote, "Quote Taken Up" on a renewal quote
      await page.locator('button[title="More"]').first().click();
      await page.locator('.dropdown-menu:visible').getByText(/^\s*(Quote )?Taken Up\s*$/).first().click();
      const needsPrice = page.getByText(/please press Get Price/);
      const openTasks = page.getByRole('dialog').filter({ hasText: 'open tasks to be completed' });
      await expect(async () => {
        // "There are open tasks to be completed, do you want to continue?" when other tasks are still open
        if (await openTasks.isVisible()) await openTasks.getByRole('button', { name: 'Ok', exact: true }).click();
        // Any warning (e.g. PPP "One or more locations does not have Survey Details") is acknowledged so the take-up goes through
        // (the warning text stays on screen after it is acknowledged, so click only while the link is still offered)
        const acknowledge = page.getByText('ACKNOWLEDGE', { exact: true }).first();
        if (await acknowledge.isVisible()) await acknowledge.click({ timeout: 5_000 }).catch(() => {});
        const converting = /\/ui\/Policy\/Conversion/.test(page.url());
        expect(converting || (await needsPrice.isVisible())).toBeTruthy();
      }).toPass({ timeout: 90_000, intervals: [1_000] });

      if (/\/ui\/Policy\/Conversion/.test(page.url())) return;
      await new QuoteSectionsPage(page).getPrice(riskSections, { dialogOptional: true });
    }
    throw new Error('Taken Up still asks for Get Price after re-pricing');
  }

  /**
   * ⋮ → Model on an issued quote opens an unsaved copy in a new tab (sections, activities, income and the broker
   * commission come along); Save there creates a brand-new quote with its own risk number. Returns it, tab closed.
   * `inceptsOn` sets the copy's inception date before Save (see setQuoteInceptionDate).
   */
  async modelCopy(sourceQuoteUrl: string, { inceptsOn }: { inceptsOn?: Date } = {}): Promise<{ reference: string; url: string }> {
    const { page } = this;
    await this.open(sourceQuoteUrl);
    const [copy] = await Promise.all([page.context().waitForEvent('page', { timeout: 90_000 }), businessAction(page, 'Model')]);
    await copy.waitForLoadState('networkidle').catch(() => {});
    await expect(copy.locator('button[title="Save"]').first()).toBeVisible({ timeout: 60_000 });
    if (inceptsOn) await setQuoteInceptionDate(copy, inceptsOn);
    await copy.locator('button[title="Save"]').first().click();
    // A changed inception date asks "Changing the dates at Parent level shall change the dates of their child components" on Save
    const datesConfirm = copy.getByRole('dialog').filter({ hasText: /Changing the dates at Parent level/ });
    await acknowledgeUntil(
      copy,
      async () => {
        if (await datesConfirm.isVisible()) await datesConfirm.getByRole('button', { name: 'Confirm', exact: true }).click();
        return /\/ui\/Quote\/Edit\/\d+/.test(copy.url());
      },
      120_000,
    );
    await copy.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 120_000 });
    const reference = await referenceFromTitle(copy, /RSK\d+Q\d+/);
    const url = copy.url();
    await copy.close();
    return { reference, url };
  }

  /**
   * ⋮ → Convert to Multi Quote (offered on an issued quote) opens an unsaved copy at /ui/Quote/MultiQuote (no reference yet);
   * Save creates the next quote of the same risk (…Q002, Provisional / In Progress) and toasts "MultiQuote created from Quote".
   */
  async convertToMultiQuote(sourceQuoteUrl: string): Promise<{ reference: string; url: string }> {
    const { page } = this;
    await this.open(sourceQuoteUrl);
    await businessAction(page, 'Convert to Multi Quote');
    await page.waitForURL('**/ui/Quote/MultiQuote', { timeout: 90_000 });
    await expect(page.locator('button[title="Save"]').first()).toBeVisible({ timeout: 60_000 });
    await waitForIdle(page);
    await saveAcknowledgingWarnings(page, async () => /\/ui\/Quote\/Edit\/\d+/.test(page.url()));
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 120_000 });
    await expectToast(page, /MultiQuote created from Quote/, 'any', 30_000);
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url() };
  }

  /**
   * ⋮ → Requote (enabled once the quote is Taken Up) → "open tasks to be completed, do you want to continue" → Ok opens an
   * unsaved requote at /ui/Quote/ReQuote; Save creates the new quote version and moves to /ui/Quote/Edit/<id>.
   */
  async requote(sourceQuoteUrl: string): Promise<{ reference: string; url: string; toast: string }> {
    const { page } = this;
    await this.open(sourceQuoteUrl);
    await businessAction(page, 'Requote');
    const confirm = page.getByRole('dialog').filter({ hasText: /open tasks to be completed/ });
    // Only shown while the quote still has open tasks
    if (await confirm.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await confirm.getByRole('button', { name: 'Ok', exact: true }).click();
    await page.waitForURL('**/ui/Quote/ReQuote', { timeout: 90_000 });
    await expect(page.locator('button[title="Save"]').first()).toBeVisible({ timeout: 60_000 });
    await waitForIdle(page);
    await saveAcknowledgingWarnings(page, async () => /\/ui\/Quote\/Edit\/\d+/.test(page.url()));
    await page.waitForURL(/\/ui\/Quote\/Edit\/\d+/, { timeout: 120_000 });
    const toast = (await page.locator('.toast').first().innerText({ timeout: 10_000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    const reference = await referenceFromTitle(page, /RSK\d+Q\d+/);
    return { reference, url: page.url(), toast };
  }

  /**
   * Take-up validates the mandatory "Quote Expiry Date" (Submission Information), which is empty on a renewal's
   * endorsement quote. Fills it (today + `daysAhead`) and saves when it is empty; does nothing (returns false) when it already has a value; returns true after saving a new one.
   */
  async ensureQuoteExpiryDate(daysAhead = 30): Promise<boolean> {
    const { page } = this;
    await expandSectionFor(page, 'Submission Information', 'Quote Expiry Date');
    if ((await field(page, 'Quote Expiry Date').inputValue()).trim()) return false;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + daysAhead);
    await selectDate(page, 'Quote Expiry Date', expiry);
    const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
    await clickSave(page);
    expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
    await acknowledgeWarnings(page);
    return true; // the premium is now flagged as possibly changed: re-price before taking up
  }

  /** HISTORY sub-tabs: Timeline | Links | Tasks | Licence (labels are upper-cased by CSS only). */
  async openHistoryTab(quoteUrl: string, tab: 'Timeline' | 'Links' | 'Tasks' | 'Licence'): Promise<void> {
    await this.open(quoteUrl, 'History');
    await this.page.getByRole('button', { name: tab, exact: true }).click();
  }

  /**
   * HISTORY → TASKS: status of a task card, e.g. "Licence Referral" → "Not Started" | "Approved".
   * The task list loads after the tab renders, so this waits for the card to show a status.
   */
  async taskStatus(quoteUrl: string, taskName: string, subject?: string): Promise<string> {
    await this.openHistoryTab(quoteUrl, 'Tasks');
    // Anchor on the task card's own text block; a looser match can hit Timeline entries that mention the task
    let card = this.page.locator('div.task-details-data').filter({ hasText: taskName });
    if (subject) card = card.filter({ hasText: subject });
    // A Model copy carries the template's old tasks, so the task this run just created is the newest (last) match.
    // The list can stay empty on a slow environment: reopen the tab if no card shows up
    let attempt = 0;
    await expect(async () => {
      if (attempt++ > 0) await this.openHistoryTab(quoteUrl, 'Tasks');
      await expect(card.last()).toBeVisible({ timeout: 25_000 });
    }).toPass({ timeout: 150_000 });
    const text = await card.last().locator('.task-status .status').innerText();
    return text.match(TASK_STATUS)?.[1] ?? text.trim();
  }

  /** ⋮ → Create Task → fill the required fields → Assign. */
  async createTask(task: TaskData): Promise<void> {
    const { page } = this;
    await businessAction(page, 'Create Task');
    const dialog = page.getByRole('dialog').filter({ hasText: 'Create Task for' });
    await expect(dialog).toBeVisible();
    await selectDialogDropdown(page, dialog, 'Task Type', task.taskType); // also defaults the due date
    await selectDialogMulti(page, dialog, 'Reason(s)', task.reason);
    await selectDialogDropdown(page, dialog, 'Enter Name', task.assignee);
    await dialog.getByPlaceholder('Enter Text Here').first().fill(task.subject);
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
    await expectToast(page, 'Task Created Successfully', 'any', 60_000);
  }

  /** ⋮ → Declined / Not Taken Up (same dialog shape, different reason list) → confirm. */
  async closeQuote(action: 'Declined' | 'Not Taken Up', reason: string, description: string): Promise<void> {
    const { page } = this;
    await businessAction(page, action);
    const dialog = page.getByRole('dialog').filter({ hasText: /Mark As (Declined|Not Taken Up)/ });
    await expect(dialog).toBeVisible();
    await selectDialogDropdown(page, dialog, action === 'Declined' ? 'Decline Reason' : 'Not Taken Up Reason', reason);
    await dialog.getByPlaceholder('Enter Text Here').last().fill(description);
    await dialog.getByRole('button', { name: action === 'Declined' ? 'Decline' : 'Not Taken Up', exact: true }).click();
  }

  /**
   * HISTORY → TASKS → task card ⋮ → Forward → "Assign to Other" (Individual) → Assign.
   * Used to hand the Licence Referral to the signed-in user so it can be approved there (see approveTask).
   */
  async forwardTask(quoteUrl: string, taskName: string, assignee: string): Promise<void> {
    const { page } = this;
    await this.openHistoryTab(quoteUrl, 'Tasks');
    // Each task is an <li>: its text, then a .status-action-container with the ⋮ trigger and the (hidden) menu items
    const text = page.locator('div.task-details-data').filter({ hasText: taskName }).last(); // newest: copies carry old tasks
    await expect(text).toBeVisible({ timeout: 60_000 });
    const card = text.locator('xpath=ancestor::li[1]');
    await card.locator('.status-action-container a.dropdown-toggle').click();
    // The <app-anchor-tag> wrapper sits over its <button> and takes the click
    await card.locator('app-anchor-tag#Task_Action').filter({ hasText: 'Forward' }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Assign to Other' });
    await expect(dialog).toBeVisible();
    const person = dialog.getByRole('combobox');
    await person.click();
    await person.pressSequentially(assignee, { delay: 40 });
    await page.getByRole('option').filter({ hasText: new RegExp(`^\\s*${assignee}`) }).first().click();
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  }

  /**
   * HISTORY → TASKS → task card ⋮ → Approve (or Complete, for tasks that offer that instead).
   * Works once the task is assigned to the signed-in user (see forwardTask). Confirms any dialog that follows.
   */
  async approveTask(quoteUrl: string, taskName: string, only?: 'Approve' | 'Complete', subject?: string): Promise<void> {
    const { page } = this;
    await this.openHistoryTab(quoteUrl, 'Tasks');
    let texts = page.locator('div.task-details-data').filter({ hasText: taskName });
    if (subject) texts = texts.filter({ hasText: subject });
    const text = texts.last(); // newest: copies carry old tasks
    await expect(text).toBeVisible({ timeout: 60_000 });
    const card = text.locator('xpath=ancestor::li[1]');
    await card.locator('.status-action-container a.dropdown-toggle').click();
    // Prefer Approve; "Complete" would close the task without approving it
    const items = card.locator('app-anchor-tag#Task_Action');
    const approve = items.filter({ hasText: /^\s*Approve\s*$/ });
    const complete = items.filter({ hasText: /^\s*Complete\s*$/ });
    if (only !== 'Complete' && (await approve.count())) await approve.first().click();
    else if (only !== 'Approve' && (await complete.count())) await complete.first().click();
    else throw new Error(`No Approve/Complete in the "${taskName}" task menu: ${(await items.allInnerTexts()).map((t) => t.trim()).join(' | ')}`);

    // Some actions ask for confirmation / comments first
    const dialog = page.getByRole('dialog').first();
    if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await dialog.getByRole('button', { name: /^(Ok|Yes|Approve|Complete|Confirm|Submit)$/i }).first().click();
    }
  }

  /**
   * Approves the newest "Licence Referral" task and waits for it to read Approved. The Approve click sometimes has no
   * effect (the card stays "Not Started"), so it is repeated up to three times, 45 seconds apiece.
   */
  async approveLicenceReferral(quoteUrl: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      await this.approveTask(quoteUrl, 'Licence Referral');
      const approved = await expect
        .poll(() => this.taskStatus(quoteUrl, 'Licence Referral'), { timeout: 45_000, intervals: [5_000] })
        .toBe('Approved')
        .then(() => true, () => false);
      if (approved) return;
      if (attempt >= 3) throw new Error('Licence Referral is still not Approved after 3 approve attempts');
    }
  }

  /**
   * After the quote is issued the record is view-only while documents are generated
   * ("…document generation is currently in progress…"). Reloads until that notice is gone.
   */
  async waitForDocumentGeneration(quoteUrl: string, timeoutMs = 5 * 60_000): Promise<void> {
    await expect(async () => {
      await this.open(quoteUrl);
      await expect(this.page.getByText('Quote Issued', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(this.page.getByText(/view-only mode as document generation/)).toHaveCount(0);
    }).toPass({ timeout: timeoutMs, intervals: [10_000] });
  }

  /** Reloads until the "view-only … document generation is in progress" notice is gone (any record type). */
  async waitUntilEditable(url: string, timeoutMs = 5 * 60_000): Promise<void> {
    await expect(async () => {
      await this.page.goto(url);
      await expect(this.page.locator('button[title="More"]').first()).toBeVisible({ timeout: 30_000 });
      await this.page.waitForTimeout(3_000); // the notice appears just after load
      await expect(this.page.getByText(/view-only mode as document generation/)).toHaveCount(0);
    }).toPass({ timeout: timeoutMs, intervals: [10_000] });
  }

  async expectIssued(): Promise<void> {
    await expect(this.page.getByText('Quote Issued', { exact: true })).toBeVisible();
  }
}

const INCEPTION_LABELS = ['Incepts On', 'Inception Date', 'Inception'];

/**
 * Sets the inception date on a quote page that is still unsaved (the Model copy tab). The label differs between screens,
 * so each of INCEPTION_LABELS is tried (opening Submission Information when the field is not on screen). When the quote has
 * no editable inception field the date is left as copied and a warning is logged, so the run carries on.
 * Returns whether the date was set.
 */
export async function setQuoteInceptionDate(page: Page, date: Date): Promise<boolean> {
  const anyLabelShown = async () => {
    for (const label of INCEPTION_LABELS) if (await fieldContainer(page, label).isVisible()) return true;
    return false;
  };
  // The Model copy tab renders its sections a little after the Save button: wait for the header, then open it once
  // (a second click would collapse it again)
  const submissionInfo = page.getByRole('button', { name: 'Submission Information', exact: true });
  await submissionInfo.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
  if (!(await anyLabelShown()) && (await submissionInfo.isVisible())) {
    await submissionInfo.click();
    await expect.poll(anyLabelShown, { timeout: 30_000 }).toBe(true).catch(() => {});
  }
  for (const label of INCEPTION_LABELS) {
    const container = fieldContainer(page, label);
    if (!(await container.isVisible()) || !(await container.getByRole('button', { name: 'Toggle calendar' }).count())) continue;
    await container.scrollIntoViewIfNeeded();
    if ((await field(page, label).inputValue()).trim() !== formatDate(date)) {
      await selectDate(page, label, date);
      // "Changing the dates at Parent level shall change the dates of their child components" asks for a Confirm
      const confirm = page.getByRole('dialog').filter({ hasText: /Changing the dates at Parent level/ });
      if (await confirm.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) {
        await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(confirm).toBeHidden({ timeout: 15_000 });
      }
    }
    await expect(field(page, label), `${label} on the Model copy`).toHaveValue(formatDate(date));
    return true;
  }
  console.warn(`Inception date ${formatDate(date)} was not set on the Model copy: no editable ${INCEPTION_LABELS.join(' / ')} field found`);
  return false;
}
