import { Page, expect } from '@playwright/test';
import { listActions, saveAcknowledgingWarnings, waitForIdle } from '../../../pages/advantagego/entity';
import { fieldContainer } from '../../../pages/advantagego/kendo';
import { NewSubmissionPage } from '../../../pages/advantagego/NewSubmissionPage';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { SubmissionPage } from '../../../pages/advantagego/SubmissionPage';
import { recordContract } from '../../../support/contracts';
import { inceptionDate } from '../../../support/dates';
import { CmbcSectionsPage } from '../CmbcSectionsPage';
import { cmbcAssignee, cmbcCommission, cmbcQuote, cmbcScheduleFile, cmbcSections, cmbcSubmission, cmbcSubmissionDetails } from '../data';

// How long CMBC waits for generated documents to reach Completed: its documents take several minutes on this host.
export const cmbcDocumentWait = { retries: 6, delayMs: 20_000 };

// CMBC's own quote → policy steps. PI (and every other product) has its own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.

/**
 * The CMBC quote every other CMBC quote is copied from: the quote created from the submission in the "CMBC - Quote" chain (or built by
 * createCmbcModelCopy). There is no fixed reference quote.
 */
export const cmbcModel = { url: '' };

/** New Submission (inception today − 10 days) → Convert to Quote: the bare quote, with no offering or sections yet. */
export async function createCmbcSubmissionQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
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
 * Quote → Sections: offering, PDBI and Liability with their child sections, the required details and exposures, then the commission
 * (⋮ → Get Commission, and a Selected % for every section the connector could not rate) and a final Save. Returns the validation text
 * the first Save listed (what was still missing at that point), for the report.
 */
export async function buildCmbcSections(page: Page, quoteUrl: string): Promise<string> {
  const sections = new CmbcSectionsPage(page);
  await sections.open(quoteUrl);
  await sections.selectOffering(cmbcSections.offering);
  for (const riskSection of cmbcSections.riskSections) {
    if (!(await page.getByText(riskSection, { exact: true }).first().isVisible())) {
      const optionName = riskSection === 'LIABILITY' ? 'Liability' : riskSection;
      await sections.addRiskSection(optionName, { verifyTree: true });
      if (riskSection === 'PDBI') {
        await expect(page.getByText('Business Interruption', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText('Property Damage', { exact: true }).first()).toBeVisible();
      }
    }
  }
  await sections.addChildRiskSection('LIABILITY', 'Public and Product Liability');
  await sections.expectCmbcStructure(cmbcSections);
  await sections.fillCmbcRequiredDetails(cmbcSections);
  // With section data complete, the only validation left is the empty commission (Selected %)
  await sections.saveExpectingValidation();
  const validation = (await page.locator('text=/Please enter|Error\\(s\\)/').allInnerTexts()).join(' | ');

  // Get Commission and the final Save stay on the Sections page: the sections are only in memory until that Save succeeds
  const quote = new QuotePage(page);
  await quote.getCommission();
  await sections.save();
  await sections.open(quoteUrl);
  await sections.expectCmbcStructure(cmbcSections);
  // Sections the connector could not rate (error 90063) keep an empty Selected %: give them one (Details tab)
  await quote.open(quoteUrl);
  await quote.fillEmptyCommissionRates(cmbcCommission.brokerPercent);
  return validation;
}

/** A complete CMBC quote built from a submission: sections, commission and the geocoded schedule. Becomes the model (cmbcModel). */
export async function createCmbcQuote(page: Page): Promise<{ submissionId: number; reference: string; url: string }> {
  const quote = await createCmbcSubmissionQuote(page);
  await buildCmbcSections(page, quote.url);
  const sections = new CmbcSectionsPage(page);
  await sections.open(quote.url);
  await sections.importCmbcSchedule(cmbcScheduleFile);
  cmbcModel.url = quote.url;
  return quote;
}

/** ⋮ → Model on the model quote (built first when this worker has none): a fresh quote with sections, schedule and exposure already filled in. */
export async function createCmbcModelCopy(page: Page): Promise<{ reference: string; url: string }> {
  if (!cmbcModel.url) await createCmbcQuote(page);
  const copy = await new QuotePage(page).modelCopy(cmbcModel.url, { inceptsOn: inceptionDate() });
  await recordContract('CMBC Quote (Model copy)', copy.reference, copy.url);
  return copy;
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
 * Copies the model quote (built from a submission first when this worker has none).
 */
export async function createBoundPolicy(page: Page): Promise<CreatedPolicy> {
  const copy = await createCmbcModelCopy(page);
  await priceQuote(page, copy.url);
  await issueWithSelfApproval(page, copy.url, cmbcSections.riskSections[0], cmbcAssignee);
  return takeUpAndBind(page, copy.url, cmbcSections.riskSections[0]);
}
