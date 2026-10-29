import { Locator, Page, expect } from '@playwright/test';
import {
  acknowledgeUntil,
  acknowledgeWarnings,
  businessAction,
  clickSave,
  listActions,
  reloadWithMenu,
  saveAcknowledgingWarnings,
  waitForIdle,
} from '../../../pages/advantagego/entity';
import { expandSectionFor, field, fieldContainer, selectDropdown } from '../../../pages/advantagego/kendo';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { inceptionDate } from '../../../support/dates';
import { FleetSectionsPage, setGridCell } from '../FleetSectionsPage';
import {
  fleetAssignee,
  fleetClaims,
  fleetCommission,
  fleetQuote,
  fleetRiskPostcode,
  fleetScheduleFile,
  fleetSections,
  fleetSubmission,
  fleetSubmissionDetails,
  fleetUwAccpvPick,
  fleetUwPeriodChoice,
} from '../data';

// How long Fleet waits for generated documents to reach Completed: its documents take several minutes on this host.
export const fleetDocumentWait = { retries: 6, delayMs: 20_000 };

// Fleet's own quote → policy steps. PI (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/**
 * The Fleet quote every other Fleet quote is copied from. It is the quote created from the submission (see createFleetQuote), so
 * there is no fixed reference quote: whoever needs a model first builds it, later users in the same worker reuse it.
 */
export const fleetModel = { url: '' };

/** New Submission (inception today − 10 days) → Convert to Quote: the bare quote, with no offering, sections or schedule yet. */
export async function createFleetSubmissionQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const newSubmission = new NewSubmissionPage(page);
  await newSubmission.open();
  await newSubmission.fill(fleetSubmission());
  const { reference, contractId } = await newSubmission.submit();
  await recordContract('Fleet Submission', reference, `/ui/Submission/Edit/${contractId}`);

  const submission = new SubmissionPage(page);
  await submission.open(contractId);
  await submission.completeDetails(fleetSubmissionDetails);
  const quote = await submission.convertToQuote(fleetQuote);
  await recordContract('Fleet Quote', quote.reference, quote.url);
  return { submissionId: contractId, ...quote };
}

/**
 * A complete Fleet quote built from a submission: offering + FLEET risk section, vehicle schedule, commission. Becomes the model
 * (fleetModel) the other Fleet quotes are copied from.
 */
export async function createFleetQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const quote = await createFleetSubmissionQuote(page);
  const sections = new FleetSectionsPage(page);
  await sections.addFleetSections(quote.url, fleetSections);
  await sections.open(quote.url);
  await sections.importFleetSchedule(fleetScheduleFile);
  await getCommission(page, quote.url);
  fleetModel.url = quote.url;
  return quote;
}

/** ⋮ → Model on the model quote (built first when this worker has none): a fresh quote with sections and schedule already filled in. */
export async function createFleetModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  if (!fleetModel.url) await createFleetQuote(page);
  const copy = await new QuotePage(page).modelCopy(fleetModel.url, { inceptsOn: inceptionDate() });
  await recordContract('Fleet Quote (Model copy)', copy.reference, copy.url);
  return copy;
}

/**
 * A priced quote → (Next Stage if still on offer) → Issue Quote. The Licence Referral raised for another underwriter is
 * forwarded to the signed-in user and approved from the quote's History → Tasks, then the quote is issued and its
 * documents generated. Fleet prices at UW Review & Process, so the quote may already be past Risk Details.
 */
export async function issueWithSelfApproval(page: Page, quoteUrl: string, riskSection: string, assignee: string): Promise<void> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  const actions = await listActions(page);
  // Already issued (e.g. resuming): "Taken Up" / "Quote Taken Up" is on offer, so there is nothing to do but wait for documents
  if (actions.some((a) => /Taken Up$/.test(a) && !/Not Taken Up/.test(a))) {
    await quote.waitUntilEditable(quoteUrl);
    return;
  }
  if (actions.includes('Next Stage')) await quote.nextStage();
  let outcome = await quote.issueQuote([riskSection]);
  // Each "referred" raises a Licence Referral for another underwriter: forward it to us, approve it, then issue again.
  // The status flips to Approved a moment before the approval counts, so give it a few seconds and allow a couple of rounds.
  for (let round = 0; round < 3 && outcome === 'referred'; round++) {
    await quote.forwardTask(quoteUrl, 'Licence Referral', assignee);
    await quote.approveLicenceReferral(quoteUrl);
    await page.waitForTimeout(15_000);
    await quote.open(quoteUrl);
    outcome = await quote.issueQuote([riskSection]);
  }
  expect(outcome, 'quote issued after approval').toBe('issued');
  await quote.waitForDocumentGeneration(quoteUrl);
}

/** An issued quote → Taken Up → Policy Conversion → Save → Confirm Cover (Bound), then all policy documents Completed. */
export async function takeUpAndBind(
  page: Page,
  quoteUrl: string,
  riskSection: string,
  step = 'Fleet Policy',
  onBound: (policy: CreatedPolicy) => void = () => {},
  checkDocuments = true,
): Promise<CreatedPolicy> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  await quote.takeUp([riskSection]);
  const policyPage = new PolicyPage(page);
  const policy = await policyPage.saveConversion();
  await recordContract(step, policy.reference, policy.url);
  await policyPage.confirmCover();
  onBound(policy); // the policy is usable even when its documents later end "In Error"
  if (checkDocuments) {
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(policy.url);
    await docs.expectAllDocumentsCompleted(fleetDocumentWait);
  }
  return policy;
}

/**
 * ⋮ → Next Stage. Fleet answers with a warnings banner ("Please enter a value in Product Liability Section - Selected Product
 * Hazard field") whose ACKNOWLEDGE link lets the move through, so it is acknowledged until "Quote Saved" shows.
 */
export async function nextStage(page: Page): Promise<void> {
  const saved = page.locator('.toast').filter({ hasText: 'Quote Saved' });
  for (let attempt = 1; ; attempt++) {
    await businessAction(page, 'Next Stage');
    await acknowledgeUntil(page, async () => (await saved.count()) > 0, 60_000);
    if ((await saved.count()) > 0) return;
    if (attempt >= 3) throw new Error('Next Stage did not report "Quote Saved" after 3 attempts');
    await reloadWithMenu(page);
    // The move may have gone through without the toast being seen: Next Stage is then no longer on offer
    if (!(await listActions(page)).includes('Next Stage')) return;
  }
}

const claimsYearsLabel = 'Number of years claims experience';

/**
 * The Claims Experience Analysis table has one row per year ("Year" 1 … 6). For each of the first `years` rows, Vehicle Years Earned
 * is set when it is still 0, and the most recent year gets the number of claims (Claim Count: All) when that is empty or 0.
 * Returns whether a cell was changed.
 */
async function fillClaimsExperienceYears(page: Page, years: number): Promise<boolean> {
  let changed = false;
  // The year rows are the "Aggregated Claims" section's table (collapsed on a fresh quote)
  const yearRows = page.locator('.ag-row').filter({ has: page.locator('.ag-cell[col-id="VehicleYearsEarned"]') });
  if (!(await yearRows.first().isVisible())) {
    await page.getByRole('button', { name: 'Aggregated Claims', exact: true }).click();
    await expect(yearRows.first()).toBeVisible({ timeout: 30_000 });
  }
  for (let year = 1; year <= years; year++) {
    const row = page
      .locator('.ag-row')
      .filter({ has: page.locator('.ag-cell[col-id="VehicleYearsEarned"]') })
      .filter({ has: page.locator('.ag-cell[col-id="Year"]', { hasText: new RegExp(`^\\s*${year}\\s*$`) }) })
      .first();
    await expect(row, `Claims Experience Analysis row for year ${year}`).toBeVisible({ timeout: 30_000 });
    if (!(Number((await row.locator('.ag-cell[col-id="VehicleYearsEarned"]').innerText()).trim()) > 0)) {
      await setGridCell(page, row, 'VehicleYearsEarned', fleetClaims.vehicleYearsEarned);
      changed = true;
    }
    if (year === 1 && !(Number((await row.locator('.ag-cell[col-id="ClaimCountAll"]').innerText()).trim()) > 0)) {
      await setGridCell(page, row, 'ClaimCountAll', fleetClaims.claimCount);
      changed = true;
    }
  }
  return changed;
}

/**
 * Details → Claims Experience Analysis → Years Claims Experience → "Number of years claims experience": makes sure it is above 0
 * (`fleetClaims.years` when it is 0 or empty), which is what makes the quote eligible for ⋮ → Experience Call. Saves only when
 * the value was changed. Returns whether it was changed.
 */
export async function setClaimsExperience(page: Page, quoteUrl: string, years = fleetClaims.years): Promise<boolean> {
  await new QuotePage(page).open(quoteUrl);
  if (!(await fieldContainer(page, claimsYearsLabel).isVisible())) {
    // The sub-section sits inside "Claims Experience Analysis": open that first when the sub-section header is not on screen
    const subSection = page.getByRole('button', { name: 'Years Claims Experience', exact: true });
    if (!(await subSection.isVisible())) await page.getByRole('button', { name: 'Claims Experience Analysis', exact: true }).click();
    await expandSectionFor(page, 'Years Claims Experience', claimsYearsLabel);
  }
  await fieldContainer(page, claimsYearsLabel).scrollIntoViewIfNeeded();
  let changed = false;
  if (!/^[1-9]/.test((await field(page, claimsYearsLabel).inputValue()).trim())) {
    await selectDropdown(page, claimsYearsLabel, years); // 0 or empty → above 0
    changed = true;
  }
  const shown = Number.parseInt((await field(page, claimsYearsLabel).inputValue()).trim(), 10); // "6+" → 6
  if (await fillClaimsExperienceYears(page, shown)) changed = true;
  if (!changed) return false;
  await waitForIdle(page);
  // The Details tab shows no "Quote Saved" toast, so wait for the save call itself
  const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
  await clickSave(page);
  expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
  await acknowledgeWarnings(page);
  return true;
}

/**
 * The Details inputs Get Price insists on besides the claims experience: Submission Information → Risk Postcode, and Underwriter Picks →
 * UW Period Choice ("UW Pick") with its UW ACCPV Pick (£). Fills only what is empty, then saves. Returns whether anything changed.
 */
export async function fillFleetPricingInputs(page: Page, quoteUrl: string): Promise<boolean> {
  await new QuotePage(page).open(quoteUrl);
  let changed = false;

  await expandSectionFor(page, 'Submission Information', 'Risk Postcode');
  const postcode = field(page, 'Risk Postcode');
  if (!(await postcode.inputValue()).trim()) {
    await postcode.fill(fleetRiskPostcode);
    changed = true;
  }

  if (!(await fieldContainer(page, 'UW Period Choice').isVisible())) {
    // "Underwriter Picks" sits inside "Claims Experience Analysis": open that first when the sub-section header is not on screen
    const picks = page.getByRole('button', { name: 'Underwriter Picks', exact: true });
    if (!(await picks.isVisible())) await page.getByRole('button', { name: 'Claims Experience Analysis', exact: true }).click();
    await expandSectionFor(page, 'Underwriter Picks', 'UW Period Choice');
  }
  await fieldContainer(page, 'UW Period Choice').scrollIntoViewIfNeeded();
  if (!(await field(page, 'UW Period Choice').inputValue()).trim()) {
    await selectDropdown(page, 'UW Period Choice', fleetUwPeriodChoice);
    changed = true;
  }
  const pick = field(page, 'UW ACCPV Pick (£)');
  if (!(Number((await pick.inputValue()).replace(/,/g, '')) > 0)) {
    await pick.fill(fleetUwAccpvPick);
    await page.keyboard.press('Tab');
    changed = true;
  }
  if (!changed) return false;
  await waitForIdle(page);
  const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
  await clickSave(page);
  expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
  await acknowledgeWarnings(page);
  return true;
}

/**
 * ⋮ → Experience Call. It is offered from UW Review & Process (next to Get Price, not at Risk Details), so a quote still at Risk
 * Details is moved on with Next Stage first. Fleet needs the call before Get Price: the backend answers "An Experience Call is
 * required to proceed" and, after a change to the experience fields, "…perform an Experience Call again"; a price taken before the
 * call must be taken again ("You must Get Price again after completing the Experience Call").
 * The menu label is found by name (/Experience ?Call/), so its exact wording does not matter.
 *  - `setClaims` (default): first makes sure the claims experience is above 0 (see setClaimsExperience), while the quote is still
 *    editable at Risk Details.
 *  - `required` (default): the test fails when the action is not offered; otherwise the call is skipped when it is not on offer.
 * Returns whether the call was made.
 */
export async function getExperienceCall(page: Page, quoteUrl: string, { required = true, setClaims = true } = {}): Promise<boolean> {
  if (setClaims) {
    await setClaimsExperience(page, quoteUrl);
    await fillFleetPricingInputs(page, quoteUrl); // the other inputs Get Price insists on
  }
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  if ((await listActions(page)).includes('Next Stage')) await nextStage(page);
  const actions = await listActions(page);
  const action = actions.find((a) => /Experience ?Call/i.test(a));
  if (!action) {
    expect(required, `⋮ offers the Experience Call once claims are above 0 (offered: ${actions.join(' | ')})`).toBe(false);
    return false;
  }
  await businessAction(page, action);
  await acknowledgeWarnings(page, 15_000);
  await waitForIdle(page);
  await expect(page.locator('.toast.toast-error'), `errors after "${action}"`).toHaveCount(0);
  await reloadWithMenu(page);
  await expect(page.getByText('Error(s)'), `errors after "${action}"`).toHaveCount(0);
  return true;
}

/**
 * ⋮ → Get Price on a Fleet quote. A quote still at Risk Details (a fresh Model copy) gets its claims experience set above 0, is moved
 * on with Next Stage and makes the Experience Call first (see getExperienceCall); only then is it priced.
 * Fleet's schedule is vehicles, so there is no geocoding / peril score step before pricing (unlike CMBC, MTP and PPP).
 */
export async function priceQuote(page: Page, quoteUrl: string): Promise<void> {
  await getExperienceCall(page, quoteUrl);
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  if ((await listActions(page)).includes('Next Stage')) await nextStage(page);
  const sections = new FleetSectionsPage(page);
  await sections.open(quoteUrl);
  await sections.getPrice([fleetSections.riskSection]);
}

/**
 * A renewal quote carries the Commercial Trading Adjustment from the policy it renews and Issue Quote then refuses it
 * ("CTA rationale field is mandatory"): Details → Premium → Commercial Trading Adjustment Rationale, pick the first reason, Save.
 * Does nothing when a rationale is already set.
 */
export async function fillCtaRationale(page: Page, quoteUrl: string): Promise<void> {
  await expect(async () => {
    await page.goto(quoteUrl);
    await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 120_000 });
  await page.getByText('Premium', { exact: true }).first().click();
  const rationale = fieldContainer(page, 'Commercial Trading Adjustment Rationale');
  await rationale.scrollIntoViewIfNeeded();
  if ((await rationale.locator('input').first().inputValue()).trim()) return;
  await rationale.locator('.k-input-button').click();
  const option = page.getByRole('option').first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(rationale.locator('input').first()).not.toHaveValue('');
  await waitForIdle(page);
  await saveAcknowledgingWarnings(page, async () => (await page.locator('.toast').filter({ hasText: 'Quote Saved' }).count()) > 0, 60_000);
  await expect(page.locator('.toast').filter({ hasText: 'Quote Saved' }).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * A fresh Bound Fleet policy: Model copy of the reference quote → price → issue (self-approved) → take up.
 * Copies the model quote (built from a submission first when this worker has none).
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createFleetModelCopy(page);
  await priceQuote(page, copy.url);
  await issueWithSelfApproval(page, copy.url, fleetSections.riskSection, fleetAssignee);
  // Set-up policy for the cancellation / renewal tests: its documents are asserted by the Taken up quote test, not here
  return takeUpAndBind(page, copy.url, fleetSections.riskSection, 'Fleet Policy', () => {}, false);
}

/**
 * ⋮ → Get Commission (eligible for Fleet). The connector answers in a "Confirm Commission Updates" dialog (Accept) and, when it rates
 * the Fleet section, Details → Commissions shows its Selected % (col-id RatePercentage). The test agency is on the manual look-up
 * table, so the connector answers error 90063 and leaves the Fleet row (created by the offering) without rates: its Selected % is then
 * typed in (`fleetCommission.brokerPercent`) and saved. Returns the Selected %.
 */
export async function getCommission(page: Page, quoteUrl: string): Promise<number> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  await quote.getCommission(); // dialog accepted; sections it could not rate are left unchanged
  const openCommissions = async () => {
    await page.reload();
    await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Commissions', exact: true }).click();
    const row = page.locator('.ag-row').filter({ has: page.locator('[col-id="DeductionTypeId"]', { hasText: 'Fleet' }) }).first();
    await expect(row, 'the Fleet commission row').toBeVisible({ timeout: 30_000 });
    return row;
  };
  const selectedOf = async (row: Locator) => Number((await row.locator('[col-id="RatePercentage"]').innerText()).replace(/,/g, '')) || 0;

  let row = await openCommissions();
  if ((await selectedOf(row)) > 0) return selectedOf(row);

  await setGridCell(page, row, 'RatePercentage', fleetCommission.brokerPercent);
  const saved = page.waitForResponse((r) => /api\/quote\/UpdateQuote/i.test(r.url()), { timeout: 60_000 });
  await clickSave(page);
  expect((await saved).ok(), 'UpdateQuote succeeded').toBeTruthy();
  await acknowledgeWarnings(page);

  row = await openCommissions();
  const selected = await selectedOf(row);
  expect(selected, 'Selected % of the Fleet commission').toBeGreaterThan(0);
  return selected;
}

/**
 * A renewal quote arrives without two inputs Get Price insists on ("Claim Experience is required to Get Price" and "UW Period
 * Choice is required to Get Price"): Details → Years Claims Experience → Number of years claims experience (0) and Underwriter
 * Picks → UW Period Choice (UW Pick), as on the New Business quote. Fills only what is empty, then Save.
 */
export async function fillRenewalPricingInputs(page: Page, quoteUrl: string): Promise<void> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  let changed = false;

  await expandSectionFor(page, 'Years Claims Experience', 'Number of years claims experience');
  const years = field(page, 'Number of years claims experience');
  if (!(await years.inputValue()).trim()) {
    await years.fill('0');
    changed = true;
  }

  await expandSectionFor(page, 'Underwriter Picks', 'UW Period Choice');
  if (!(await field(page, 'UW Period Choice').inputValue()).trim()) {
    await selectDropdown(page, 'UW Period Choice', 'UW Pick');
    changed = true;
  }

  if (!changed) return;
  await waitForIdle(page);
  await saveAcknowledgingWarnings(page, async () => (await page.locator('.toast').filter({ hasText: 'Quote Saved' }).count()) > 0, 60_000);
  await expect(page.locator('.toast').filter({ hasText: 'Quote Saved' }).first()).toBeVisible({ timeout: 30_000 });
}
