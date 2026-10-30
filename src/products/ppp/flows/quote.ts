import { Page, expect } from '@playwright/test';
import { acknowledgeUntil, businessAction, listActions, reloadWithMenu, saveAcknowledgingWarnings, waitForIdle } from '../../../pages/advantagego/entity';
import { fieldContainer } from '../../../pages/advantagego/kendo';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { inceptionDate } from '../../../support/dates';
import { PppSectionsPage } from '../PppSectionsPage';
import { pppAssignee, pppCommission, pppQuote, pppScheduleFile, pppSections, pppSubmission, pppSubmissionDetails } from '../data';

// How long PPP waits for generated documents to reach Completed: its documents take several minutes on this host.
export const pppDocumentWait = { retries: 6, delayMs: 20_000 };

// PPP's own quote → policy steps. PI (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/**
 * The PPP quote every other PPP quote is copied from: the quote created from the submission in the "PPP - Quote" chain (or built by
 * createPppModelCopy). There is no fixed reference quote.
 */
export const pppModel = { url: '' };

/** New Submission (inception today − 10 days) → Convert to Quote: the bare quote, with no offering or risk section yet. */
export async function createPppSubmissionQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const newSubmission = new NewSubmissionPage(page);
  await newSubmission.open();
  await newSubmission.fill(pppSubmission());
  const { reference, contractId } = await newSubmission.submit();
  await recordContract('PPP Submission', reference, `/ui/Submission/Edit/${contractId}`);

  const submission = new SubmissionPage(page);
  await submission.open(contractId);
  await submission.completeDetails(pppSubmissionDetails);
  const quote = await submission.convertToQuote(pppQuote);
  await recordContract('PPP Quote', quote.reference, quote.url);
  return { submissionId: contractId, ...quote };
}

/**
 * A complete PPP quote built from a submission: offering + PPP risk section, the Broker Commission override and the geocoded schedule.
 * Becomes the model (pppModel). The covers the rating engine asks for are not selected here yet: the first run lists them.
 */
export async function createPppQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const quote = await createPppSubmissionQuote(page);
  const sections = new PppSectionsPage(page);
  await sections.addPppSections(quote.url, pppSections, pppCommission.brokerPercent);
  await sections.open(quote.url);
  await sections.importPppSchedule(pppScheduleFile);
  pppModel.url = quote.url;
  return quote;
}

/** ⋮ → Model on the model quote (built first when this worker has none): a fresh quote with sections, schedule and exposure already filled in. */
export async function createPppModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  if (!pppModel.url) await createPppQuote(page);
  const copy = await new QuotePage(page).modelCopy(pppModel.url, { inceptsOn: inceptionDate() });
  await recordContract('PPP Quote (Model copy)', copy.reference, copy.url);
  return copy;
}

/**
 * A priced quote → (Next Stage if still on offer) → Issue Quote. The Licence Referral raised for another underwriter is
 * forwarded to the signed-in user and approved from the quote's History → Tasks, then the quote is issued and its
 * documents generated. PPP prices at UW Review & Process, so the quote may already be past Risk Details.
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
  step = 'PPP Policy',
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
    await docs.expectAllDocumentsCompleted(pppDocumentWait);
  }
  return policy;
}

/**
 * ⋮ → Next Stage. PPP answers with a warnings banner ("Please enter a value in Product Liability Section - Selected Product
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
  }
}

/**
 * ⋮ → Get Price on an PPP quote. A quote still at Risk Details (a fresh Model copy) is moved on with Next Stage first.
 *
 * PPP RULE (as for CMBC): a renewal quote's copied schedule items arrive un-geocoded and Get Price refuses them ("The Geocoding
 * for all schedule items have not been done"). Pass `geocodeFirst` for those to run Geocode and Get Peril Score before pricing.
 */
export async function priceQuote(page: Page, quoteUrl: string, { geocodeFirst = false } = {}): Promise<void> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  if ((await listActions(page)).includes('Next Stage')) await nextStage(page);
  const sections = new PppSectionsPage(page);
  await sections.open(quoteUrl);
  if (geocodeFirst) await sections.geocodeAndGetPerilScore();
  await sections.getPrice([pppSections.riskSection]);
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
 * A fresh Bound PPP policy: Model copy of the reference quote → price → issue (self-approved) → take up.
 * Copies the model quote (built from a submission first when this worker has none).
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createPppModelCopy(page);
  await priceQuote(page, copy.url);
  await issueWithSelfApproval(page, copy.url, pppSections.riskSection, pppAssignee);
  // Set-up policy for the cancellation / renewal tests: its documents are asserted by the Taken up quote test, not here
  return takeUpAndBind(page, copy.url, pppSections.riskSection, 'PPP Policy', () => {}, false);
}
