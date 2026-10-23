import { Page, expect } from '@playwright/test';
import { listActions } from '../../../pages/advantagego/entity';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { QuoteSectionsPage } from '../../../pages/advantagego/QuoteSectionsPage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { pi } from '..';
import { piQuote, piSections, piSubmission, piSubmissionDetails, piTask } from '../data';

// PI's own quote → policy steps. CMBC (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/** New Submission → complete details → Convert to Quote. For tests that need a quote of their own. */
export async function createPiQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  // A template quote (an issued one) is much quicker: Model copies it into a fresh quote in a few seconds
  const template = pi.env('TEMPLATE_QUOTE_URL');
  if (template) {
    const copy = await new QuotePage(page).modelCopy(template);
    await recordContract('Quote (Model copy)', copy.reference, copy.url);
    return { submissionId: 0, ...copy };
  }
  const newSubmission = new NewSubmissionPage(page);
  await newSubmission.open();
  await newSubmission.fill(piSubmission());
  const { reference, contractId } = await newSubmission.submit();
  await recordContract('Submission', reference, `/ui/Submission/Edit/${contractId}`);

  const submission = new SubmissionPage(page);
  await submission.open(contractId);
  await submission.completeDetails(piSubmissionDetails);
  const quote = await submission.convertToQuote(piQuote);
  await recordContract('Quote', quote.reference, quote.url);
  return { submissionId: contractId, ...quote };
}

/**
 * A priced quote → Next Stage → Issue Quote. The Licence Referral raised for another underwriter is forwarded to the
 * signed-in user and approved from the quote's History → Tasks, then the quote is issued and its documents generated.
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
  await quote.nextStage(); // Risk Details → UW Review & Process
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
export async function takeUpAndBind(page: Page, quoteUrl: string, riskSection: string, step = 'Policy'): Promise<CreatedPolicy> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  await quote.takeUp([riskSection]);
  const policyPage = new PolicyPage(page);
  const policy = await policyPage.saveConversion();
  await recordContract(step, policy.reference, policy.url);
  await policyPage.confirmCover();
  const docs = new QuoteDocumentsPage(page, 'Policy');
  await docs.open(policy.url);
  await docs.expectAllDocumentsCompleted();
  return policy;
}

/**
 * A fresh Bound New Business PI policy: Model copy of the template quote → price → issue (self-approved) → take up.
 * Needs PI_TEMPLATE_QUOTE_URL (an issued quote to copy).
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const template = pi.env('TEMPLATE_QUOTE_URL');
  if (!template) throw new Error('PI_TEMPLATE_QUOTE_URL is not set: needed to make a fresh quote with Model');
  const quote = new QuotePage(page);
  const copy = await quote.modelCopy(template);
  await recordContract('Quote (Model copy)', copy.reference, copy.url);
  await quote.open(copy.url);
  await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  await issueWithSelfApproval(page, copy.url, piSections.riskSection, piTask.assignee);
  return takeUpAndBind(page, copy.url, piSections.riskSection);
}
