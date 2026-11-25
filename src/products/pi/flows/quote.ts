import { Page, expect } from '@playwright/test';
import { listActions } from '../../../pages/advantagego/entity';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { QuoteSectionsPage } from '../../../pages/advantagego/QuoteSectionsPage';
import { PiSectionsPage } from '../PiSectionsPage';
import { addPiBrokerCommission } from '../commission';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { persisted } from '../../../support/runState';
import { inceptionDate } from '../../../support/dates';
import { piCommission, piQuote, piSections, piSubmission, piSubmissionDetails, piTask } from '../data';

// PI's own quote → policy steps. CMBC (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/**
 * The PI quote every other PI quote is copied from: the quote created from the submission in the "PI - Quote" chain (or built by
 * createPiModelCopy). There is no fixed reference quote.
 */
export const piModel = persisted('pi-model', { url: '' }); // kept for the run, so a failed test does not lose it

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
/**
 * The Broker Commission and the risk section, saved together in one go:
 * 1. DETAILS → Commission → "+" → Broker Commission → Selected % = 12 (not saved yet);
 * 2. the SECTIONS tab clicked inside the app (the 12% stays on the page) → "+" → the Accountants risk section → its risk details →
 *    a Save the app refuses for the missing limit and excess (that is what makes the coverage entries appear; nothing is stored) →
 *    limit and excess;
 * 3. Save: the commission, the section, its details, limit and excess are stored together.
 */
export async function addPiBrokerAndSections(page: Page, quoteUrl: string): Promise<'added' | 'set' | 'kept'> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  const outcome = await addPiBrokerCommission(page, piCommission.brokerPercent, { save: false });

  await page.getByRole('button', { name: 'Sections', exact: true }).first().click();
  await expect(page.getByText('Risk Sections', { exact: true })).toBeVisible({ timeout: 60_000 });
  const sections = new PiSectionsPage(page);
  await sections.addRiskSection(piSections.riskSection);
  await sections.fillPiRiskDetails(piSections);
  await sections.saveExpectingValidation(); // limit & excess missing → coverage nodes appear (refused, nothing stored)
  await sections.setLimitAndExcess(piSections.limitAndExcess);
  await sections.save(); // stores the commission and the section together
  return outcome;
}

/** A complete PI quote built from a submission: Broker Commission and sections (one Save), then a price. Becomes the model (piModel). */
export async function createPiModelQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const quote = await createPiQuote(page);
  await addPiBrokerAndSections(page, quote.url);
  const sections = new PiSectionsPage(page);
  await sections.open(quote.url);
  await sections.getPrice([piSections.riskSection]);
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
export async function issueWithSelfApproval(page: Page, quoteUrl: string, riskSection: string): Promise<void> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  const actions = await listActions(page);
  // Already issued (e.g. resuming): "Taken Up" / "Quote Taken Up" is on offer, so there is nothing to do but wait for documents
  if (actions.some((a) => /Taken Up$/.test(a) && !/Not Taken Up/.test(a))) {
    await quote.waitUntilEditable(quoteUrl);
    return;
  }
  // Risk Details → UW Review & Process (already there when an earlier attempt advanced it: no "Next Stage" is offered then)
  if (actions.includes('Next Stage')) await quote.nextStage();
  let outcome = await quote.issueQuote([riskSection]);
  // Each "referred" raises a Licence Referral for another underwriter: forward it to us, approve it, then issue again.
  // The status flips to Approved a moment before the approval counts, so give it a few seconds and allow a couple of rounds.
  for (let round = 0; round < 3 && outcome === 'referred'; round++) {
    await quote.forwardTask(quoteUrl, 'Licence Referral');
    await quote.approveLicenceReferral(quoteUrl);
    await page.waitForTimeout(15_000);
    await quote.open(quoteUrl);
    outcome = await quote.issueQuote([riskSection]);
  }
  expect(outcome, 'quote issued after approval').toBe('issued');
  await quote.waitForDocumentGeneration(quoteUrl);
}

/** An issued quote → Taken Up → Policy Conversion → Save → Confirm Cover (Bound), then (`checkDocuments`) all policy documents Completed. */
export async function takeUpAndBind(
  page: Page,
  quoteUrl: string,
  riskSection: string,
  step = 'PI Policy',
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
    await docs.expectAllDocumentsCompleted();
  }
  return policy;
}

/**
 * A fresh Bound New Business PI policy: Model copy of the model quote → price → issue (self-approved) → take up.
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createPiModelCopy(page);
  await new QuotePage(page).open(copy.url);
  await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  await issueWithSelfApproval(page, copy.url, piSections.riskSection);
  // Set-up policy for the cancellation / renewal tests: its documents are asserted by the Taken up quote test, not here
  return takeUpAndBind(page, copy.url, piSections.riskSection, 'PI Policy', () => {}, false);
}
