import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyAtInception, cancelPolicyMidTerm, confirmEndorsement, confirmMta, endorsePolicy, issueEndorsement, priceEndorsement, priceMta, reinstatePolicy, reverseEndorsement, startEndorsement, startInceptionCancellationMta, startMidTermCancellationMta, takeUpEndorsement } from '../../src/products/mtp/flows/policy';
import { createMtpModelCopy, mtpDocumentWait,
  buildMtpSections,
  createBoundPolicy,
  convertMtpSubmission,
  createMtpSubmission,
  fillCtaRationale,
  issueWithSelfApproval,
  mtpModel,
  priceQuote,
} from '../../src/products/mtp/flows/quote';
import { mtp } from '../../src/products/mtp';
import { MtpSectionsPage } from '../../src/products/mtp/MtpSectionsPage';
import {
  mtpAssignee,
  mtpCancellation,
  mtpCommission,
  mtpDocument,
  mtpEndorsement,
  mtpInceptionCancellation,
  mtpReinstatement,
  mtpScheduleFile,
  mtpSections,
} from '../../src/products/mtp/data';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../src/pages/advantagego/QuotePage';
import { readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { recordContract } from '../../src/support/contracts';
import { blockingSteps, persisted } from '../../src/support/runState';

const mtpPremiumGrossLabel = 'Policy Period Premium Gross of Comm. & Net of IPT';

// Values handed down the chains, kept for the run (src/support/runState.ts). The chains run in order but do not stop at a
// failed test: Playwright carries on with the next one in a fresh worker, which reads these back.
const chain = persisted('mtp-chain', {
  submissionId: undefined as number | undefined,
  mtcBaseQuoteUrl: '', // Mid Term Cancellation: base quote → converted → Bound policy → cancellation MTA (→ confirmed)
  mtcBaseConvertedUrl: '',
  mtcBasePolicyUrl: mtp.env('CANCEL_POLICY_URL'),
  mtcBaseMtaUrl: mtp.env('CANCEL_MTA_URL'),
  mtcBaseConfirmed: !!mtp.env('CANCEL_MTA_URL'),
  icBaseQuoteUrl: '', // Inception Cancellation: base quote → converted → Bound policy → MTA (→ confirmed)
  icBaseConvertedUrl: '',
  icBasePolicyUrl: mtp.env('INCEPTION_POLICY_URL'),
  icBaseMtaUrl: mtp.env('INCEPTION_MTA_URL'),
  icBaseConfirmed: !!mtp.env('INCEPTION_MTA_URL'),
  endorsementUrl: mtp.env('ENDORSEMENT_URL'), // the General Endorsement: endorsement quote → converted (endorsementConvertedUrl) → Bound (endorsedPolicyUrl)
  endorsementConvertedUrl: '',
  renewalBaseQuoteUrl: '', // the renewal's own base policy: Model copy → … → converted → Bound (renewalBasePolicyUrl)
  renewalBaseConvertedUrl: '',
  renewalBasePolicyUrl: mtp.env('RENEWAL_BASE_POLICY_URL'), // the renewal chain: base policy → renewal quote → converted → Bound renewal policy
  renewalQuoteUrl: mtp.env('RENEWAL_QUOTE_URL'),
  renewalConvertedPolicyUrl: '',
  renewalPolicyUrl: mtp.env('RENEWAL_POLICY_URL'),
  renewalEndorsedPolicyUrl: '',
  cancellationMtaUrl: '', // the Mid-Term Cancellation MTA (its documents are checked on their own)
  inceptionMtaUrl: '',
  convertedPolicyUrl: '', // created by Policy Conversion, Bound by Confirm Cover (then also policyUrl)
  policyUrl: mtp.env('POLICY_URL'),
  quoteUrl: mtp.env('QUOTE_URL'),
  quoteReference: '',
  endorsedPolicyUrl: mtp.env('ENDORSED_POLICY_URL'),
});
// Get Price, geocoding, Issue Quote, Taken Up (Confirm Cover), Confirm Endorsement … cannot be done without: a test that needs
// one of them is skipped as "Blocked" once it has failed (steps.needs); every other failure just lets the chain carry on.
const steps = blockingSteps('mtp-chain');
test.afterEach(async ({}, testInfo) => steps.record(testInfo));
// One ordered sequence for the whole file, in one worker: Quote → Quote lifecycle → Policy → Cancellation → Renewal. Everything after
// Taken Up needs the Bound policy it makes (or a Model copy of the same quote taken up the same way), so nothing runs ahead of it.
test.describe.configure({ mode: 'default' });

test.describe('MTP - Quote', { tag: ['@flow', '@mtp-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const ensureReference = async (page: Page) => {
    if (chain.quoteReference) return;
    await new QuotePage(page).open(chain.quoteUrl);
    chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
  };

  // New Submission (inception today − 10 days) → Submit
  test('Create Submission', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    test.skip(!!mtp.env('QUOTE_URL'), 'MTP_QUOTE_URL is set');
    const submission = await createMtpSubmission(page);
    chain.submissionId = submission.contractId;
    testInfo.annotations.push({ type: 'submission', description: `${submission.reference} (${submission.contractId})` });
  });

  // The submission's remaining details → Convert to Quote: the quote the rest of the chain works on
  test('Convert to Quote', async ({ page }, testInfo) => {
    steps.needs('Create Submission');
    test.setTimeout(8 * 60_000);
    test.skip(!!mtp.env('QUOTE_URL'), 'MTP_QUOTE_URL is set');
    test.skip(chain.submissionId === undefined, 'No submission (Create Submission did not complete)');
    const quote = await convertMtpSubmission(page, chain.submissionId!);
    chain.quoteUrl = quote.url;
    chain.quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
  });

  // PDBI, Liability, Road Risks and Legal Expenses (the offering, SME, is defaulted) → details → ⋮ Get Commission and the Selected %
  // the sections cannot be saved without → Save: one test, as the sections stay in memory until that Save. The model the other MTP
  // quotes are copied from.
  test('Convert to Quote with PDBI, Liability, Road Risks and Legal Expenses', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!mtp.env('QUOTE_URL'), 'MTP_QUOTE_URL is set');
    test.skip(!chain.quoteUrl, 'No quote');
    testInfo.annotations.push({ type: 'section validation', description: await buildMtpSections(page, chain.quoteUrl) });
  });

  test('Insert schedule with geocoding and peril score', async ({ page }) => {
    steps.needs('Convert to Quote with PDBI, Liability, Road Risks and Legal Expenses');
    test.setTimeout(12 * 60_000);
    const sections = new MtpSectionsPage(page);
    await sections.open(chain.quoteUrl);
    await sections.importMtpSchedule(mtpScheduleFile);
  });

  test('Get Commission', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote with PDBI, Liability, Road Risks and Legal Expenses');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    // The connector leaves "not rated" sections empty: they get the broker %. When Get Commission errors, the Broker Commission is
    // added by hand ("+", or its blank % filled) so the chain carries on, and this test then fails with the connector's error.
    const { rejected, error } = await quote.getCommissionOrAddManually(mtpCommission.brokerPercent);
    if (rejected.length) testInfo.annotations.push({ type: 'commission not rated', description: rejected.join(', ') });
    mtpModel.url = chain.quoteUrl; // sections, schedule and commission are on it now: the model the other MTP quotes are copied from
    if (error) throw error;
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    steps.needs('Insert schedule with geocoding and peril score');
    await priceQuote(page, chain.quoteUrl);
    const premium = await readPremium(page, chain.quoteUrl, mtpPremiumGrossLabel);
    expect(premium.policyPeriodGross).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    steps.needs('Convert to Quote with PDBI, Liability, Road Risks and Legal Expenses');
    const docs = new QuoteDocumentsPage(page);
    await docs.open(chain.quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(mtpDocument);
    const file = await docs.download(title);
    expect(file.size).toBe(fs.statSync(mtpDocument.filePath).size);
    await docs.expectDownloadedOn(title);
  });

  test('Search / Advance Search', async ({ page }) => {
    steps.needs('Convert to Quote with PDBI, Liability, Road Risks and Legal Expenses');
    if (!chain.quoteReference) {
      await new QuotePage(page).open(chain.quoteUrl);
      chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
    }
    const search = new SearchPage(page);
    await search.open();
    await search.search(chain.quoteReference);
    await search.expectResultCount('Quotes', 1);
    await search.open();
    await search.selectCategory('Risk-Quote');
    await search.search(chain.quoteReference);
    await search.openAdvancedFilters();
    await search.fillAdvancedText('Contract Reference', chain.quoteReference);
    await search.applyAdvancedFilters();
    await search.expectResultCount('Quotes', 1);
  });

  test('Issue Quote', async ({ page }) => {
    steps.needs('Get Pricing');
    test.setTimeout(12 * 60_000);
    await issueWithSelfApproval(page, chain.quoteUrl, mtpSections.riskSections[0], mtpAssignee);
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002).
  test('MultiQuote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote');
    test.setTimeout(5 * 60_000);
    await ensureReference(page);
    const multi = await new QuotePage(page).convertToMultiQuote(chain.quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(chain.quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(chain.quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('MTP Multi Quote', multi.reference, multi.url);
  });

  // ⋮ → Taken Up opens the unsaved Policy Conversion (a Provisional policy, "To Take Up the quote the risk will be saved"): this checks
  // the action gets there (open tasks, warnings, a re-price when asked). Nothing is saved yet: the quote stays Quoted and ⋮ still
  // offers Taken Up, so "Policy Conversion" runs it again on its own page.
  test('Quote Taken up', async ({ page }) => {
    steps.needs('Issue Quote');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  // ⋮ → Taken Up → Policy Conversion → Save: the policy is created (Provisional) and the quote becomes Taken Up
  test('Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Quote Taken up');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.convertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('MTP Policy', policy.reference, policy.url);
  });

  // ⋮ → Requote is enabled once the quote is Taken Up → Ok → Save creates the new version.
  test('Requote', async ({ page }, testInfo) => {
    steps.needs('Policy Conversion'); // ⋮ → Requote is offered once the quote is Taken Up
    test.setTimeout(5 * 60_000);
    await ensureReference(page);
    const requote = await new QuotePage(page).requote(chain.quoteUrl);
    expect(requote.reference, 'a new quote version').toMatch(/^RSK\d+Q\d+$/);
    expect(requote.reference).not.toBe(chain.quoteReference);
    testInfo.annotations.push({ type: 'requote', description: requote.reference });
    await recordContract('MTP Requote', requote.reference, requote.url);
  });

  test.fixme('Documents/datalake payload generation', async () => {});
  test.fixme('Data lake pricing/quote/schedule', async () => {});
  test.fixme('Check ALS and server folder payloads', async () => {});
  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

// In order: the reversal undoes the endorsement made by the general endorsement.
test.describe('MTP - Policy', { tag: ['@flow', '@mtp-flow'] }, () => {
  test.describe.configure({ mode: 'default' });

  // ⋮ → Confirm Cover on the converted policy: Review → On Cover, Bound / Booked. The Bound policy is what the policy tests work on.
  test('Confirm Cover', async ({ page }) => {
    steps.needs('Policy Conversion');
    test.setTimeout(5 * 60_000);
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.convertedPolicyUrl);
    await policyPage.confirmCover();
    chain.policyUrl = chain.convertedPolicyUrl;
  });

  // The policy documents (schedule, covering letter, drafts) are generated in the background after Confirm Cover: all must end
  // Completed. A document the service could not generate ("In Error") fails this test alone; the policy tests carry on.
  test('Policy Documents - Generation', async ({ page }, testInfo) => {
    steps.needs('Confirm Cover');
    test.setTimeout(10 * 60_000);
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(chain.policyUrl);
    const statuses = await docs.expectAllDocumentsCompleted(mtpDocumentWait);
    testInfo.annotations.push({ type: 'documents', description: `${statuses.length} completed` });
  });

  // General Endorsement, one test per step: endorsement quote → Get Price → Issue → Take Up Endorsement (Policy
  // Conversion) → Confirm Endorsement. MTP_ENDORSEMENT_URL carries on from an endorsement quote already started (one endorsement per
  // policy at a time), MTP_ENDORSED_POLICY_URL from an endorsed policy.
  test('MTA - GE - Endorsement Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // a Bound policy is all it needs (its documents may still have failed)
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('ENDORSEMENT_URL') || !!mtp.env('ENDORSED_POLICY_URL'), 'An existing endorsement is used (MTP_ENDORSEMENT_URL / _ENDORSED_POLICY_URL)');
    test.skip(!chain.policyUrl, 'No Bound policy');
    const endorsement = await startEndorsement(page, chain.policyUrl, mtpEndorsement);
    chain.endorsementUrl = endorsement.url;
    testInfo.annotations.push({ type: 'quote', description: endorsement.reference });
  });

  test('MTA - GE - Get Pricing', async ({ page }) => {
    steps.needs('MTA - GE - Endorsement Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('ENDORSED_POLICY_URL'), 'MTP_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await priceEndorsement(page, chain.endorsementUrl, mtpSections.riskSections[0]);
  });

  test('MTA - GE - Issue Quote', async ({ page }) => {
    steps.needs('MTA - GE - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!mtp.env('ENDORSED_POLICY_URL'), 'MTP_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await issueEndorsement(page, chain.endorsementUrl, mtpSections.riskSections[0]);
  });

  test('MTA - GE - Take Up Endorsement', async ({ page }, testInfo) => {
    steps.needs('MTA - GE - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('ENDORSED_POLICY_URL'), 'MTP_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    const endorsed = await takeUpEndorsement(page, chain.endorsementUrl, mtpSections.riskSections[0]);
    chain.endorsementConvertedUrl = endorsed.url;
    testInfo.annotations.push({ type: 'policy', description: endorsed.reference });
  });

  test('MTA - GE - Confirm Endorsement', async ({ page }) => {
    steps.needs('MTA - GE - Take Up Endorsement');
    test.setTimeout(5 * 60_000);
    const endorsedUrl = chain.endorsementConvertedUrl || mtp.env('ENDORSED_POLICY_URL');
    test.skip(!endorsedUrl, 'No endorsed policy (Take Up Endorsement did not complete)');
    await confirmEndorsement(page, endorsedUrl);
    chain.endorsedPolicyUrl = endorsedUrl;
  });

  // The endorsement documents: generated in the background after the confirmation, all must end Completed.
  // A document the service could not generate ("In Error") fails this test alone; nothing else depends on it.
  test('MTA - GE Documents - Generation', async ({ page }) => {
    if (!chain.endorsedPolicyUrl) steps.needs('MTA - GE - Confirm Endorsement');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(chain.endorsedPolicyUrl);
    await docs.expectAllDocumentsCompleted(mtpDocumentWait);
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    if (!chain.endorsedPolicyUrl) steps.needs('MTA - GE - Confirm Endorsement');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, chain.endorsedPolicyUrl, mtpEndorsement.reasonDescription);
  });
});

test.describe('MTP - Cancellation', { tag: ['@flow', '@mtp-flow'] }, () => {
  // Mid Term Cancellation on a Bound policy of its own (a Model copy of the quote made from the submission, taken through the same
  // operations, one test each), then the cancellation MTA one step at a time, its documents, and Reinstate Policy on it.
  // MTP_CANCEL_POLICY_URL cancels an existing Bound policy instead, MTP_CANCEL_MTA_URL / _REINSTATE_MTA_URL carry on from existing MTAs.
  test('MTC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('CANCEL_POLICY_URL') || !!mtp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (MTP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    const copy = await createMtpModelCopy(page);
    chain.mtcBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('MTC - Get Pricing', async ({ page }) => {
    steps.needs('MTC - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!mtp.env('CANCEL_POLICY_URL') || !!mtp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (MTP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.mtcBaseQuoteUrl); // geocodes first when the copy's schedule is not geocoded
  });

  test('MTC - Issue Quote', async ({ page }) => {
    steps.needs('MTC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!mtp.env('CANCEL_POLICY_URL') || !!mtp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (MTP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.mtcBaseQuoteUrl, mtpSections.riskSections[0], mtpAssignee);
  });

  test('MTC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('MTC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('CANCEL_POLICY_URL') || !!mtp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (MTP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.mtcBaseQuoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.mtcBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('MTP MTC Policy', policy.reference, policy.url);
  });

  test('MTC - Confirm Cover', async ({ page }) => {
    steps.needs('MTC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!mtp.env('CANCEL_POLICY_URL') || !!mtp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (MTP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.mtcBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.mtcBasePolicyUrl = chain.mtcBaseConvertedUrl;
  });

  // ⋮ Mid Term Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // MTP_CANCEL_MTA_URL carries on from an MTA that already exists.
  test('MTA - Mid Term Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.mtcBasePolicyUrl) steps.needs('MTC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('CANCEL_MTA_URL'), 'MTP_CANCEL_MTA_URL is set');
    test.skip(!chain.mtcBasePolicyUrl, 'No Bound base policy');
    chain.mtcBaseMtaUrl = await startMidTermCancellationMta(page, chain.mtcBasePolicyUrl, mtpCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.mtcBaseMtaUrl });
  });

  test('MTA - Mid Term Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.mtcBaseMtaUrl) steps.needs('MTA - Mid Term Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.mtcBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.mtcBaseMtaUrl, mtpSections.riskSections[0]);
  });

  test('MTA - Mid Term Cancellation - Confirm Cancellation', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Get Pricing');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.mtcBaseMtaUrl, 'No cancellation MTA');
    await confirmMta(page, chain.mtcBaseMtaUrl);
    chain.mtcBaseConfirmed = true;
  });

  // The cancellation documents: generated in the background after the confirmation, all must end Completed.
  // A document the service could not generate ("In Error") fails this test alone; nothing else depends on it.
  test('MTA - Mid Term Cancellation Documents - Generation', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Confirm Cancellation');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.mtcBaseConfirmed, 'The cancellation was not confirmed');
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(chain.mtcBaseMtaUrl);
    await docs.expectAllDocumentsCompleted(mtpDocumentWait);
  });

  // ⋮ Reinstate Contract on the cancellation MTA → Save creates the next MTA (…/MTA002); the backend prices and confirms it, so the
  // outcome is checked (policy Bound again, "Reinstate Contract" in the Endorsement grid, the actions of a live policy)
  test('Reinstate Policy', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Confirm Cancellation');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.mtcBaseConfirmed, 'The cancellation was not confirmed');
    await reinstatePolicy(page, chain.mtcBaseMtaUrl, mtpReinstatement, mtp.env('REINSTATE_MTA_URL'));
  });


  // Inception Cancellation on a Bound policy of its own, the same way. MTP_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL reuse existing records.
  test('IC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('INCEPTION_POLICY_URL') || !!mtp.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (MTP_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    const copy = await createMtpModelCopy(page);
    chain.icBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('IC - Get Pricing', async ({ page }) => {
    steps.needs('IC - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!mtp.env('INCEPTION_POLICY_URL') || !!mtp.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (MTP_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.icBaseQuoteUrl); // geocodes first when the copy's schedule is not geocoded
  });

  test('IC - Issue Quote', async ({ page }) => {
    steps.needs('IC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!mtp.env('INCEPTION_POLICY_URL') || !!mtp.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (MTP_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.icBaseQuoteUrl, mtpSections.riskSections[0], mtpAssignee);
  });

  test('IC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('IC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('INCEPTION_POLICY_URL') || !!mtp.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (MTP_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.icBaseQuoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.icBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('MTP IC Policy', policy.reference, policy.url);
  });

  test('IC - Confirm Cover', async ({ page }) => {
    steps.needs('IC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!mtp.env('INCEPTION_POLICY_URL') || !!mtp.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (MTP_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.icBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.icBasePolicyUrl = chain.icBaseConvertedUrl;
  });

  // ⋮ Inception Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // MTP_INCEPTION_MTA_URL carries on from an MTA that already exists.
  test('MTA - Inception Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.icBasePolicyUrl) steps.needs('IC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!mtp.env('INCEPTION_MTA_URL'), 'MTP_INCEPTION_MTA_URL is set');
    test.skip(!chain.icBasePolicyUrl, 'No Bound base policy');
    chain.icBaseMtaUrl = await startInceptionCancellationMta(page, chain.icBasePolicyUrl, mtpInceptionCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.icBaseMtaUrl });
  });

  test('MTA - Inception Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.icBaseMtaUrl) steps.needs('MTA - Inception Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.icBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.icBaseMtaUrl, mtpSections.riskSections[0]);
  });

  test('MTA - Inception Cancellation - Confirm Cancellation', async ({ page }) => {
    steps.needs('MTA - Inception Cancellation - Get Pricing');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.icBaseMtaUrl, 'No cancellation MTA');
    await confirmMta(page, chain.icBaseMtaUrl);
    chain.icBaseConfirmed = true;
  });

  // The inception cancellation documents: generated in the background after the confirmation, all must end Completed.
  // A document the service could not generate ("In Error") fails this test alone; nothing else depends on it.
  test('MTA - Inception Cancellation Documents - Generation', async ({ page }) => {
    steps.needs('MTA - Inception Cancellation - Confirm Cancellation');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.icBaseConfirmed, 'The cancellation was not confirmed');
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(chain.icBaseMtaUrl);
    await docs.expectAllDocumentsCompleted(mtpDocumentWait);
  });

});

// Renewal: a Bound New Business policy of its own (a Model copy of the quote made from the submission, taken through the same
// operations), renewed, and the renewal quote taken through the same steps as a new one, one test per operation.
// MTP_RENEWAL_BASE_POLICY_URL renews an existing Bound policy, MTP_RENEWAL_QUOTE_URL carries on from an existing renewal quote,
// MTP_RENEWAL_POLICY_URL from an existing Bound renewal policy.
test.describe('MTP - Renewal', { tag: ['@flow', '@mtp-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const renewalPolicyGiven = !!mtp.env('RENEWAL_POLICY_URL');

  // The renewal's own Bound New Business policy, made the way the main one is: ⋮ → Model copy of the quote made from the submission →
  // Get Price → Issue Quote → Taken Up + Policy Conversion → Confirm Cover, one test each
  test('Renewal - Base - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no renewal either
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!!mtp.env('RENEWAL_BASE_POLICY_URL') || !!mtp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    const copy = await createMtpModelCopy(page);
    chain.renewalBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Renewal - Base - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Base - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!!mtp.env('RENEWAL_BASE_POLICY_URL') || !!mtp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.renewalBaseQuoteUrl); // geocodes first when the copy's schedule is not geocoded
  });

  test('Renewal - Base - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Base - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!!mtp.env('RENEWAL_BASE_POLICY_URL') || !!mtp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.renewalBaseQuoteUrl, mtpSections.riskSections[0], mtpAssignee);
  });

  test('Renewal - Base - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Base - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!!mtp.env('RENEWAL_BASE_POLICY_URL') || !!mtp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalBaseQuoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('MTP Renewal Base Policy', policy.reference, policy.url);
  });

  test('Renewal - Base - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Base - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!!mtp.env('RENEWAL_BASE_POLICY_URL') || !!mtp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.renewalBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.renewalBasePolicyUrl = chain.renewalBaseConvertedUrl;
  });

  // ⋮ → Renew - Quote → risk sections → Save: the renewal quote (…02Q001)
  test('Renewal - Renew Quote', async ({ page }, testInfo) => {
    if (!chain.renewalBasePolicyUrl) steps.needs('Renewal - Base - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!!mtp.env('RENEWAL_QUOTE_URL'), 'MTP_RENEWAL_QUOTE_URL is set');
    test.skip(!chain.renewalBasePolicyUrl, 'No Bound policy to renew');
    const policy = new PolicyPage(page);
    await policy.open(chain.renewalBasePolicyUrl);
    await policy.renew();
    const renewal = await policy.saveRenewal();
    chain.renewalQuoteUrl = renewal.url;
    testInfo.annotations.push({ type: 'quote', description: renewal.reference });
    await recordContract('MTP Renewal Quote', renewal.reference, renewal.url);
  });

  test('Renewal - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Renew Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await fillCtaRationale(page, chain.renewalQuoteUrl); // the renewal inherits a CTA whose rationale Get Price / Issue Quote demand
    await priceQuote(page, chain.renewalQuoteUrl); // geocodes first when the renewal's copied schedule is not geocoded
  });

  test('Renewal - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await issueWithSelfApproval(page, chain.renewalQuoteUrl, mtpSections.riskSections[0], mtpAssignee);
  });

  // ⋮ → Taken Up (on a renewal: "Quote Taken Up") reaches the unsaved Policy Conversion; nothing is saved yet (see "Quote Taken up")
  test('Renewal - Quote Taken up', async ({ page }) => {
    steps.needs('Renewal - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  test('Renewal - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Quote Taken up');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([mtpSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalConvertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('MTP Renewal Policy', policy.reference, policy.url);
  });

  test('Renewal - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'MTP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalConvertedPolicyUrl, 'No converted renewal policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.renewalConvertedPolicyUrl);
    await policyPage.confirmCover();
    chain.renewalPolicyUrl = chain.renewalConvertedPolicyUrl;
  });

  // The renewal policy documents, generated after Confirm Cover: an "In Error" document fails this test alone
  test('Renewal - Policy Documents - Generation', async ({ page }) => {
    steps.needs('Renewal - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.renewalPolicyUrl, 'No Bound renewal policy');
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(chain.renewalPolicyUrl);
    await docs.expectAllDocumentsCompleted(mtpDocumentWait);
  });
});
