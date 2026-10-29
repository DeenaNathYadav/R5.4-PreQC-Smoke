import { Page, expect } from '@playwright/test';
import { listActions } from '../../../pages/advantagego/entity';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { QuoteSectionsPage } from '../../../pages/advantagego/QuoteSectionsPage';
import { PiSectionsPage } from '../PiSectionsPage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { inceptionDate } from '../../../support/dates';
import { piCommission, piQuote, piSections, piSubmission, piSubmissionDetails, piTask } from '../data';

// PI's own quote → policy steps. CMBC (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/**
 * The PI quote every other PI quote is copied from: the quote created from the submission in the "PI - Quote" chain (or built by
 * createPiModelCopy). There is no fixed reference quote.
 */
export const piModel = { url: '' };

/** New Submission (inception today − 10 days) → complete details → Convert to Quote: the bare quote, with no sections yet. */
export async function createPiQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const newSubmission = new NewSubmissionPage(page);
  await newSubmission.open();
  await newSubmission.fill(piSubmission());
  const { reference, contractId } = await newSubmission.submit();
  await recordContract('PI Submission', reference, `/ui/Submission/Edit/${contractId}`);

  const submission = new SubmissionPage(page);
  await submission.open(contractId);
  await submission.completeDetails(piSubmissionDetails);
  const quote = await submission.convertToQuote(piQuote);
  await recordContract('PI Quote', quote.reference, quote.url);
  return { submissionId: contractId, ...quote };
}

/** Quote → Sections: the Accountants risk section with its activities, income, limit and excess, saved. */
export async function addPiSections(page: Page, quoteUrl: string): Promise<void> {
  const sections = new PiSectionsPage(page);
  await sections.open(quoteUrl);
  await sections.addRiskSection(piSections.riskSection);
  await sections.fillPiRiskDetails(piSections);
  await sections.saveExpectingValidation(); // limit & excess missing → coverage nodes appear
  await sections.setLimitAndExcess(piSections.limitAndExcess);
  await sections.save();
}

/** A complete PI quote built from a submission: sections, a price, then the Broker Commission override. Becomes the model (piModel). */
export async function createPiModelQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const quote = await createPiQuote(page);
  await addPiSections(page, quote.url);
  await new PiSectionsPage(page).getPrice([piSections.riskSection]);
  const quotePage = new QuotePage(page);
  await quotePage.open(quote.url);
  await quotePage.addBrokerCommission(piCommission.brokerPercent, { requireDefaultRow: true });
  piModel.url = quote.url;
  return quote;
}

/** ⋮ → Model on the model quote (built first when this worker has none): a fresh quote with sections and commission already on it. */
export async function createPiModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  if (!piModel.url) await createPiModelQuote(page);
  const copy = await new QuotePage(page).modelCopy(piModel.url, { inceptsOn: inceptionDate() });
  await recordContract('PI Quote (Model copy)', copy.reference, copy.url);
  return copy;
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
export async function takeUpAndBind(page: Page, quoteUrl: string, riskSection: string, step = 'PI Policy'): Promise<CreatedPolicy> {
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
 * A fresh Bound New Business PI policy: Model copy of the model quote → price → issue (self-approved) → take up.
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createPiModelCopy(page);
  await new QuotePage(page).open(copy.url);
  await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  await issueWithSelfApproval(page, copy.url, piSections.riskSection, piTask.assignee);
  return takeUpAndBind(page, copy.url, piSections.riskSection);
}
