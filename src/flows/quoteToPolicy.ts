import { Page, expect } from '@playwright/test';
import { listActions } from '../pages/advantagego/entity';
import { PolicyPage, CreatedPolicy } from '../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../pages/advantagego/QuotePage';
import { QuoteSectionsPage } from '../pages/advantagego/QuoteSectionsPage';
import { recordContract } from '../support/contracts';

/**
 * A priced quote → Next Stage → Issue Quote. The Licence Referral raised for another underwriter is forwarded to the
 * signed-in user and approved from the quote's History → Tasks, then the quote is issued and its documents generated.
 */
export async function issueWithSelfApproval(
  page: Page,
  quoteUrl: string,
  riskSection: string,
  assignee: string,
  { nextStageIfOffered = false } = {},
): Promise<void> {
  const quote = new QuotePage(page);
  await quote.open(quoteUrl);
  const actions = await listActions(page);
  // Already issued (e.g. resuming): "Taken Up" / "Quote Taken Up" is on offer, so there is nothing to do but wait for documents
  if (actions.some((a) => /Taken Up$/.test(a) && !/Not Taken Up/.test(a))) {
    await quote.waitUntilEditable(quoteUrl);
    return;
  }
  // CMBC prices at UW Review & Process, so the quote may already be past Risk Details
  if (!nextStageIfOffered || actions.includes('Next Stage')) await quote.nextStage(); // Risk Details → UW Review & Process
  let outcome = await quote.issueQuote([riskSection]);
  // Each "referred" raises a Licence Referral for another underwriter: forward it to us, approve it, then issue again.
  // The status flips to Approved a moment before the approval counts, so give it a few seconds and allow a couple of rounds.
  for (let round = 0; round < 3 && outcome === 'referred'; round++) {
    await quote.forwardTask(quoteUrl, 'Licence Referral', assignee);
    await quote.approveTask(quoteUrl, 'Licence Referral');
    await expect.poll(() => quote.taskStatus(quoteUrl, 'Licence Referral'), { timeout: 120_000, intervals: [5_000] }).toBe('Approved');
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

/** What the shared quote → policy flows need to know about a product (one per product, in src/products/<key>/flows.ts). */
export interface QuoteLifecycle {
  /** The risk section the price / issue / take-up dialogs list, e.g. 'Accountants' or 'PDBI'. */
  riskSection: string;
  /** Underwriter the Licence Referral is forwarded to (the signed-in user), as shown in the Forward dialog. */
  assignee: string;
  /** An issued quote copied with ⋮ → Model to get a fresh quote in seconds (<KEY>_TEMPLATE_QUOTE_URL). */
  templateQuoteUrl: string;
  /** Env var named in the error when `templateQuoteUrl` is empty. */
  templateEnvName: string;
  /** Prefix for the contracts-table step names, e.g. 'CMBC ' → 'CMBC Quote (Model copy)'. */
  stepPrefix?: string;
  /** CMBC only offers ⋮ → Get Price from UW Review & Process, so it moves to that stage before pricing. */
  nextStageBeforePricing?: boolean;
}

/**
 * A fresh Bound New Business policy: Model copy of the template quote → price → issue (self-approved) → take up.
 * Needs the product's template quote (an issued quote to copy).
 */
export async function createBoundPolicy(page: Page, lifecycle: QuoteLifecycle): Promise<CreatedPolicy> {
  const { riskSection, assignee, templateQuoteUrl, templateEnvName, stepPrefix = '', nextStageBeforePricing = false } = lifecycle;
  if (!templateQuoteUrl) throw new Error(`${templateEnvName} is not set: needed to make a fresh quote with Model`);
  const quote = new QuotePage(page);
  const copy = await quote.modelCopy(templateQuoteUrl);
  await recordContract(`${stepPrefix}Quote (Model copy)`, copy.reference, copy.url);
  await quote.open(copy.url);
  const sections = new QuoteSectionsPage(page);
  if (nextStageBeforePricing) {
    await quote.nextStage();
    await sections.open(copy.url);
  }
  await sections.getPrice([riskSection]);
  await issueWithSelfApproval(page, copy.url, riskSection, assignee, { nextStageIfOffered: nextStageBeforePricing });
  return takeUpAndBind(page, copy.url, riskSection, `${stepPrefix}Policy`);
}
