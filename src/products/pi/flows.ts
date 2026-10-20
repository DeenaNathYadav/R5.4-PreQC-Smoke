import { Page } from '@playwright/test';
import { QuoteLifecycle } from '../../flows/quoteToPolicy';
import { NewSubmissionPage } from '../../pages/advantagego/NewSubmissionPage';
import { QuotePage } from '../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../support/contracts';
import { pi } from '.';
import { piQuote, piSections, piSubmission, piSubmissionDetails, piTask } from './data';

/** How PI plugs into the shared quote → policy flows (src/flows/quoteToPolicy.ts). */
export const piLifecycle: QuoteLifecycle = {
  riskSection: piSections.riskSection,
  assignee: piTask.assignee,
  templateQuoteUrl: pi.env('TEMPLATE_QUOTE_URL'),
  templateEnvName: 'PI_TEMPLATE_QUOTE_URL',
};

/** New Submission → complete details → Convert to Quote. For tests that need a quote of their own. */
export async function createPiQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  // A template quote (an issued one) is much quicker: Model copies it into a fresh quote in a few seconds
  if (piLifecycle.templateQuoteUrl) {
    const copy = await new QuotePage(page).modelCopy(piLifecycle.templateQuoteUrl);
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
