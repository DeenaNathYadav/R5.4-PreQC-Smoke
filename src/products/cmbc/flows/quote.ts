import { Page, expect } from '@playwright/test';
import { listActions } from '../../../pages/advantagego/entity';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { inceptionDate } from '../../../support/dates';
import { cmbc } from '..';
import { CmbcSectionsPage } from '../CmbcSectionsPage';
import { cmbcAssignee, cmbcQuote, cmbcSections, cmbcSubmission, cmbcSubmissionDetails } from '../data';

// How long CMBC waits for generated documents to reach Completed: its documents take several minutes on this host.
export const cmbcDocumentWait = { retries: 6, delayMs: 20_000 };

// CMBC's own quote → policy steps. PI (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/** ⋮ → Model on the CMBC reference quote: a fresh quote with sections, schedule and exposure already filled in. */
export async function createCmbcModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  const template = cmbc.env('TEMPLATE_QUOTE_URL');
  if (!template) throw new Error('CMBC_TEMPLATE_QUOTE_URL is not set');
  const copy = await new QuotePage(page).modelCopy(template, { inceptsOn: inceptionDate() });
  await recordContract('CMBC Quote (Model copy)', copy.reference, copy.url);
  return copy;
}

export async function createCmbcQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  if (cmbc.env('TEMPLATE_QUOTE_URL')) return { submissionId: 0, ...(await createCmbcModelCopy(page)) };

  const newSubmission = new NewSubmissionPage(page);
  await newSubmission.open();
  await newSubmission.fill(cmbcSubmission());
  const { reference, contractId } = await newSubmission.submit();
  await recordContract('CMBC Submission', reference, `/ui/Submission/Edit/${contractId}`);

  const submission = new SubmissionPage(page);
  await submission.open(contractId);
  await submission.completeDetails(cmbcSubmissionDetails);
  const quote = await submission.convertToQuote(cmbcQuote);
  await recordContract('CMBC Quote', quote.reference, quote.url);
  return { submissionId: contractId, ...quote };
}

/**
 * A priced quote → (Next Stage if still on offer) → Issue Quote. The Licence Referral raised for another underwriter is
 * forwarded to the signed-in user and approved from the quote's History → Tasks, then the quote is issued and its
 * documents generated. CMBC prices at UW Review & Process, so the quote may already be past Risk Details.
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
export async function takeUpAndBind(page: Page, quoteUrl: string, riskSection: string, step = 'CMBC Policy'): Promise<CreatedPolicy> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  await quote.takeUp([riskSection]);
  const policyPage = new PolicyPage(page);
  const policy = await policyPage.saveConversion();
  await recordContract(step, policy.reference, policy.url);
  await policyPage.confirmCover();
  const docs = new QuoteDocumentsPage(page, 'Policy');
  await docs.open(policy.url);
  await docs.expectAllDocumentsCompleted(cmbcDocumentWait);
  return policy;
}

/**
 * ⋮ → Get Price on a CMBC quote. CMBC only offers Get Price from UW Review & Process, so a quote still at Risk Details
 * (a fresh Model copy, a new renewal quote) is moved on with Next Stage first.
 *
 * CMBC RULE: Geocoding + Peril Scoring of the schedule is mandatory before Get Price on every transaction (New Business,
 * Renewal, endorsement …); otherwise GetPrice fails with "The Geocoding for all schedule items have not been done".
 * Model copies and endorsement quotes already carry geocoded items, but a renewal quote's schedule does not: pass
 * `geocodeFirst` for those to run Geocode and Get Peril Score before pricing.
 */
export async function priceQuote(page: Page, quoteUrl: string, { geocodeFirst = false } = {}): Promise<void> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  if ((await listActions(page)).includes('Next Stage')) await quote.nextStage();
  const sections = new CmbcSectionsPage(page);
  await sections.open(quoteUrl);
  // A renewal quote's schedule items arrive un-geocoded and Get Price refuses them, so geocode + peril score them first
  if (geocodeFirst) await sections.geocodeAndGetPerilScore();
  await sections.getPrice([cmbcSections.riskSections[0]]);
}

/**
 * A fresh Bound CMBC policy: Model copy of the reference quote → price → issue (self-approved) → take up.
 * Needs CMBC_TEMPLATE_QUOTE_URL.
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createCmbcModelCopy(page);
  await priceQuote(page, copy.url);
  await issueWithSelfApproval(page, copy.url, cmbcSections.riskSections[0], cmbcAssignee);
  return takeUpAndBind(page, copy.url, cmbcSections.riskSections[0]);
}
