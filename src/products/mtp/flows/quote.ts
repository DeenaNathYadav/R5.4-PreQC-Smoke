import { Page, expect } from '@playwright/test';
import { acknowledgeUntil, businessAction, gotoWithMenu, listActions, saveAcknowledgingWarnings, waitForIdle } from '../../../pages/advantagego/entity';
import { fieldContainer } from '../../../pages/advantagego/kendo';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { inceptionDate } from '../../../support/dates';
import { mtp } from '..';
import { MtpSectionsPage } from '../MtpSectionsPage';
import { mtpAssignee, mtpQuote, mtpSections, mtpSubmission, mtpSubmissionDetails } from '../data';

// How long MTP waits for generated documents to reach Completed: its documents take several minutes on this host.
export const mtpDocumentWait = { retries: 6, delayMs: 20_000 };

// MTP's own quote → policy steps. PI (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/** ⋮ → Model on the MTP reference quote: a fresh quote with sections, schedule and exposure already filled in. */
export async function createMtpModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  const template = mtp.env('TEMPLATE_QUOTE_URL');
  if (!template) throw new Error('MTP_TEMPLATE_QUOTE_URL is not set');
  const copy = await new QuotePage(page).modelCopy(template, { inceptsOn: inceptionDate() });
  await recordContract('MTP Quote (Model copy)', copy.reference, copy.url);
  return copy;
}

export async function createMtpQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  if (mtp.env('TEMPLATE_QUOTE_URL')) return { submissionId: 0, ...(await createMtpModelCopy(page)) };

  const newSubmission = new NewSubmissionPage(page);
  await newSubmission.open();
  await newSubmission.fill(mtpSubmission());
  const { reference, contractId } = await newSubmission.submit();
  await recordContract('MTP Submission', reference, `/ui/Submission/Edit/${contractId}`);

  const submission = new SubmissionPage(page);
  await submission.open(contractId);
  await submission.completeDetails(mtpSubmissionDetails);
  const quote = await submission.convertToQuote(mtpQuote);
  await recordContract('MTP Quote', quote.reference, quote.url);
  return { submissionId: contractId, ...quote };
}

/**
 * A priced quote → (Next Stage if still on offer) → Issue Quote. The Licence Referral raised for another underwriter is
 * forwarded to the signed-in user and approved from the quote's History → Tasks, then the quote is issued and its
 * documents generated. MTP prices at UW Review & Process, so the quote may already be past Risk Details.
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
  step = 'MTP Policy',
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
    await docs.expectAllDocumentsCompleted(mtpDocumentWait);
  }
  return policy;
}

/**
 * ⋮ → Next Stage. MTP answers with a warnings banner ("Please enter a value in Product Liability Section - Selected Product
 * Hazard field") whose ACKNOWLEDGE link lets the move through, so it is acknowledged until "Quote Saved" shows.
 */
export async function nextStage(page: Page): Promise<void> {
  const saved = page.locator('.toast').filter({ hasText: 'Quote Saved' });
  for (let attempt = 1; ; attempt++) {
    await businessAction(page, 'Next Stage');
    await acknowledgeUntil(page, async () => (await saved.count()) > 0, 60_000);
    if ((await saved.count()) > 0) return;
    if (attempt >= 3) throw new Error('Next Stage did not report "Quote Saved" after 3 attempts');
    await page.reload();
    await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
  }
}

/**
 * ⋮ → Get Price on an MTP quote. Get Price is only offered from the second stage, UW Review & Process, so a quote still at
 * Risk Details (a fresh Model copy, a new renewal quote) is moved on with Next Stage first. Geocoding + Peril Score of the
 * schedule is mandatory before pricing: if it is missing (a renewal's copied schedule items arrive un-geocoded) it is done first.
 */
export async function priceQuote(page: Page, quoteUrl: string): Promise<void> {
  await gotoWithMenu(page, quoteUrl); // the host sometimes renders a blank page: reload until the ⋮ menu is there
  if ((await listActions(page)).includes('Next Stage')) await nextStage(page);
  const sections = new MtpSectionsPage(page);
  await sections.open(quoteUrl);
  await sections.getPriceGeocodingIfMissing([mtpSections.riskSections[0]]);
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
 * A fresh Bound MTP policy: Model copy of the reference quote → price → issue (self-approved) → take up.
 * Needs MTP_TEMPLATE_QUOTE_URL.
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createMtpModelCopy(page);
  await priceQuote(page, copy.url);
  await issueWithSelfApproval(page, copy.url, mtpSections.riskSections[0], mtpAssignee);
  // Set-up policy for the cancellation / renewal tests: its documents are asserted by the Taken up quote test, not here
  return takeUpAndBind(page, copy.url, mtpSections.riskSections[0], 'MTP Policy', () => {}, false);
}
