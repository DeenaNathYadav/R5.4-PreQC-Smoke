import { Page } from '@playwright/test';
import { QuoteLifecycle } from '../../flows/quoteToPolicy';
import { NewSubmissionPage } from '../../pages/advantagego/NewSubmissionPage';
import { QuotePage } from '../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../support/contracts';
import { cmbc } from '.';
import { cmbcAssignee, cmbcQuote, cmbcSections, cmbcSubmission, cmbcSubmissionDetails } from './data';

/** How CMBC plugs into the shared quote → policy flows (src/flows/quoteToPolicy.ts). */
export const cmbcLifecycle: QuoteLifecycle = {
  riskSection: cmbcSections.riskSections[0],
  assignee: cmbcAssignee,
  templateQuoteUrl: cmbc.env('TEMPLATE_QUOTE_URL'),
  templateEnvName: 'CMBC_TEMPLATE_QUOTE_URL',
  stepPrefix: 'CMBC ',
  nextStageBeforePricing: true,
};

/** ⋮ → Model on the CMBC reference quote: a fresh quote with sections, schedule and exposure already filled in. */
export async function createCmbcModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  if (!cmbcLifecycle.templateQuoteUrl) throw new Error('CMBC_TEMPLATE_QUOTE_URL is not set');
  const copy = await new QuotePage(page).modelCopy(cmbcLifecycle.templateQuoteUrl);
  await recordContract('CMBC Quote (Model copy)', copy.reference, copy.url);
  return copy;
}

export async function createCmbcQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  if (cmbcLifecycle.templateQuoteUrl) return { submissionId: 0, ...(await createCmbcModelCopy(page)) };

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
