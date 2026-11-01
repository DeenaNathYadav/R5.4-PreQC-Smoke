import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyMidTerm, confirmEndorsement, confirmMta, endorsePolicy, issueEndorsement, priceEndorsement, priceMta, reinstatePolicy, reverseEndorsement, startEndorsement, startMidTermCancellationMta, takeUpEndorsement } from '../../src/products/ppp/flows/policy';
import { pppDocumentWait, fillCtaRationale,
  createBoundPolicy,
  createPppModelCopy,
  createPppSubmissionQuote,
  issueWithSelfApproval,
  pppModel,
  priceQuote,
} from '../../src/products/ppp/flows/quote';
import { ppp } from '../../src/products/ppp';
import { PppSectionsPage } from '../../src/products/ppp/PppSectionsPage';
import {
  pppAssignee,
  pppCancellation,
  pppCommission,
  pppDecline, pppNotTakenUp, pppLost,
  pppDocument,
  pppEndorsement,
  pppQuote,
  pppReinstatement,
  pppScheduleFile,
  pppSections,
  pppSubmission,
  pppSubmissionDetails,
  pppTask,
} from '../../src/products/ppp/data';
import { NewSubmissionPage } from '../../src/pages/advantagego/NewSubmissionPage';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../src/pages/advantagego/QuotePage';
import { readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { SubmissionPage } from '../../src/pages/advantagego/SubmissionPage';
import { recordContract } from '../../src/support/contracts';
import { blockingSteps, persisted } from '../../src/support/runState';

// One test per row of the "PPP-Module" sheet in "AXA R5.4 - CMBC-MTP-Fleet Smoke (1).xlsx".
// The first quote is created from a submission (inception today − 10 days) and built up in the "PPP - Quote" chain; every other PPP
// quote is a ⋮ → Model copy of it (there is no fixed reference quote). test.fixme = backend evidence, not automated.
const pppPremiumGrossLabel = 'Policy Period Premium Gross of Comm. & Net of IPT';

// Values handed down the chains, kept for the run (src/support/runState.ts). The chains run in order but do not stop at a
// failed test: Playwright carries on with the next one in a fresh worker, which reads these back.
const chain = persisted('ppp-chain', {
  mtcBaseQuoteUrl: '', // Mid Term Cancellation: base quote → converted → Bound policy → cancellation MTA (→ confirmed)
  mtcBaseConvertedUrl: '',
  mtcBasePolicyUrl: ppp.env('CANCEL_POLICY_URL'),
  mtcBaseMtaUrl: ppp.env('CANCEL_MTA_URL'),
  mtcBaseConfirmed: !!ppp.env('CANCEL_MTA_URL'),
  reinstateMtaUrl: ppp.env('REINSTATE_MTA_URL'), // the reinstatement MTA, once saved: a re-run checks it again instead of starting another
  endorsementUrl: ppp.env('ENDORSEMENT_URL'), // the General Endorsement: endorsement quote → converted (endorsementConvertedUrl) → Bound (endorsedPolicyUrl)
  endorsementConvertedUrl: '',
  renewalBaseQuoteUrl: '', // the renewal's own base policy: Model copy → … → converted → Bound (renewalBasePolicyUrl)
  renewalBaseConvertedUrl: '',
  ntuQuoteUrl: '', // the Model copies Not Taken Up / Mark as Lost close
  lostQuoteUrl: '',
  renewalBasePolicyUrl: ppp.env('RENEWAL_BASE_POLICY_URL'), // the renewal chain: base policy → renewal quote → converted → Bound renewal policy
  renewalQuoteUrl: ppp.env('RENEWAL_QUOTE_URL'),
  renewalConvertedPolicyUrl: '',
  renewalPolicyUrl: ppp.env('RENEWAL_POLICY_URL'),
  renewalEndorsedPolicyUrl: '',
  cancellationMtaUrl: '', // the Mid-Term Cancellation MTA (its documents are checked on their own)
  inceptionMtaUrl: '',
  convertedPolicyUrl: '', // created by Policy Conversion, Bound by Confirm Cover (then also policyUrl)
  policyUrl: ppp.env('POLICY_URL'),
  quoteUrl: ppp.env('QUOTE_URL'),
  quoteReference: '',
  quoteIssued: false,
  endorsedPolicyUrl: ppp.env('ENDORSED_POLICY_URL'),
});
// Get Price, geocoding, Issue Quote, Taken Up (Confirm Cover), Confirm Endorsement … cannot be done without: a test that needs
// one of them is skipped as "Blocked" once it has failed (steps.needs); every other failure just lets the chain carry on.
const steps = blockingSteps('ppp-chain');
test.afterEach(async ({}, testInfo) => steps.record(testInfo));
// One ordered sequence for the whole file, in one worker: Quote → Quote lifecycle → Policy → Cancellation → Renewal. Everything after
// Taken Up needs the Bound policy it makes (or a Model copy of the same quote taken up the same way), so nothing runs ahead of it.
test.describe.configure({ mode: 'default' });

test.describe('PPP - Quote', { tag: ['@flow', '@ppp-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const ensureReference = async (page: Page) => {
    if (chain.quoteReference) return;
    await new QuotePage(page).open(chain.quoteUrl);
    chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
  };

  // New Submission (inception today − 10 days) → Convert to Quote: the quote the rest of the chain works on, and the model the other
  // PPP quotes are copied from
  test('Convert to Quote', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    test.skip(!!ppp.env('QUOTE_URL'), 'PPP_QUOTE_URL is set');
    const quote = await createPppSubmissionQuote(page);
    chain.quoteUrl = quote.url;
    chain.quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
  });

  // Offering (the first one listed) → PPP risk section; Save lists what the covers still need
  test('Add PPP risk section and covers', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    test.setTimeout(8 * 60_000);
    const { offering, validation } = await new PppSectionsPage(page).addPppSections(chain.quoteUrl, pppSections, pppCommission.brokerPercent);
    testInfo.annotations.push({ type: 'offering', description: offering });
    testInfo.annotations.push({ type: 'section validation', description: validation });
  });

  test('Insert schedule with geocoding and peril score', async ({ page }) => {
    steps.needs('Add PPP risk section and covers');
    test.setTimeout(12 * 60_000);
    const sections = new PppSectionsPage(page);
    await sections.open(chain.quoteUrl);
    await sections.importPppSchedule(pppScheduleFile);
  });

  // PPP is not eligible for ⋮ → Get Commission. Broker Commission is a deduction on Details → Commission: the row defaulted on the
  // quote (checked) gets its Override %
  test('Add Broker Commission', async ({ page }) => {
    steps.needs('Convert to Quote');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.addBrokerCommission(pppCommission.brokerPercent); // existing Broker Commission row → its %, otherwise a row is added with +
    await quote.expectBrokerCommission();
    pppModel.url = chain.quoteUrl; // sections, schedule and commission are on it now: the model the other PPP quotes are copied from
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    steps.needs('Add PPP risk section and covers', 'Insert schedule with geocoding and peril score');
    await priceQuote(page, chain.quoteUrl);
    const premium = await readPremium(page, chain.quoteUrl, pppPremiumGrossLabel);
    expect(premium.policyPeriodGross, 'Policy Period Premium Gross of Comm. & Net of IPT').toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote create task', async ({ page }) => {
    steps.needs('Convert to Quote');
    test.setTimeout(12 * 60_000); // the task status takes minutes to flip on this host
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.createTask(pppTask);
    expect(await quote.taskStatus(chain.quoteUrl, pppTask.taskType, pppTask.subject)).toBe('Not Started');
    // Close the task again: card ⋮ → Complete
    // The Complete click sometimes has no effect (the card stays "Not Started", as with Approve): repeat it, 80 seconds apiece
    await expect(async () => {
      await quote.approveTask(chain.quoteUrl, pppTask.taskType, 'Complete', pppTask.subject);
      await expect
        .poll(() => quote.taskStatus(chain.quoteUrl, pppTask.taskType, pppTask.subject), { timeout: 80_000, intervals: [10_000] })
        .toBe('Completed');
    }).toPass({ timeout: 6 * 60_000 });
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    steps.needs('Convert to Quote');
    const docs = new QuoteDocumentsPage(page);
    await docs.open(chain.quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(pppDocument);
    const file = await docs.download(title);
    expect(file.size, 'downloaded bytes').toBe(fs.statSync(pppDocument.filePath).size);
    await docs.expectDownloadedOn(title);
  });

  test('Quote History Check and Link Tasks', async ({ page }) => {
    steps.needs('Convert to Quote');
    await ensureReference(page);
    const quote = new QuotePage(page);
    await quote.openHistoryTab(chain.quoteUrl, 'Timeline');
    await expect(page.getByText('UpdateQuote', { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Price', { exact: true }).locator('visible=true').first()).toBeVisible();

    // A Model copy has no submission link: the Links tab lists the quote itself as the Original
    await quote.openHistoryTab(chain.quoteUrl, 'Links');
    await expect(page.getByText(chain.quoteReference, { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Original', { exact: true }).locator('visible=true').first()).toBeVisible();

    expect(await quote.taskStatus(chain.quoteUrl, pppTask.taskType, pppTask.subject)).toBe('Completed');
  });

  test('Search / Advance Search', async ({ page }) => {
    steps.needs('Convert to Quote');
    await ensureReference(page);
    const search = new SearchPage(page);
    await search.open();
    await search.search(chain.quoteReference);
    await search.expectResultCount('Quotes', 1);

    // The results panel occasionally doesn't render after Apply, so retry the whole search
    await expect(async () => {
      await search.open();
      await search.selectCategory('Risk-Quote');
      await search.search(chain.quoteReference);
      await search.openAdvancedFilters();
      await search.fillAdvancedText('Contract Reference', chain.quoteReference);
      await search.applyAdvancedFilters();
      await search.expectResultCount('Quotes', 1, 20_000);
    }).toPass({ timeout: 120_000 });
  });

  // Licence Referral raised for another underwriter is forwarded to the signed-in user and approved, then the quote is issued
  test('Issue Quote', async ({ page }) => {
    steps.needs('Get Pricing');
    test.setTimeout(12 * 60_000);
    await issueWithSelfApproval(page, chain.quoteUrl, pppSections.riskSection, pppAssignee);
    chain.quoteIssued = true;
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002)
  test('MultiQuote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.quoteIssued && !ppp.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    await ensureReference(page);
    const multi = await new QuotePage(page).convertToMultiQuote(chain.quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(chain.quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(chain.quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('PPP Multi Quote', multi.reference, multi.url);
  });

  // ⋮ → Taken Up opens the unsaved Policy Conversion (a Provisional policy, "To Take Up the quote the risk will be saved"): this checks
  // the action gets there (open tasks, warnings, a re-price when asked). Nothing is saved yet: the quote stays Quoted and ⋮ still
  // offers Taken Up, so "Policy Conversion" runs it again on its own page.
  test('Quote Taken up', async ({ page }) => {
    steps.needs('Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.quoteIssued && !ppp.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([pppSections.riskSection]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  // ⋮ → Taken Up → Policy Conversion → Save: the policy is created (Provisional) and the quote becomes Taken Up
  test('Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Quote Taken up');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([pppSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.convertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PPP Policy', policy.reference, policy.url);
  });

  // ⋮ → Requote is enabled once the quote is Taken Up → Ok → Save creates the new version
  test('Requote', async ({ page }, testInfo) => {
    steps.needs('Policy Conversion'); // ⋮ → Requote is offered once the quote is Taken Up
    test.setTimeout(5 * 60_000);
    test.skip(!chain.convertedPolicyUrl && !chain.policyUrl, 'The quote was not taken up (no policy conversion)');
    await ensureReference(page);
    const requote = await new QuotePage(page).requote(chain.quoteUrl);
    expect(requote.reference, 'a new quote version').toMatch(/^RSK\d+Q\d+$/);
    expect(requote.reference).not.toBe(chain.quoteReference);
    testInfo.annotations.push({ type: 'requote', description: requote.reference });
    await recordContract('PPP Requote', requote.reference, requote.url);
  });

  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

// Own quote, so a decline can't take the chain's quote away from later steps
test.describe('PPP - Quote lifecycle', { tag: ['@flow', '@ppp-flow'] }, () => {
  // Declined, Not Taken Up and Lost are each an end state of a quote (the other two are no longer offered after one of them), so
  // each test closes a Model copy of its own: the quote made from the submission is never touched.

  // ⋮ → Declined → Decline Reason + description → Decline
  test('Decline', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    test.setTimeout(10 * 60_000);
    const copy = await createPppModelCopy(page);
    const quote = new QuotePage(page);
    await quote.open(copy.url);
    await quote.closeQuote('Declined', pppDecline.reason, pppDecline.description);
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // Not Taken Up is offered on an issued quote: its own ⋮ → Model copy → Get Price → Issue Quote, one test each, then Not Taken Up
  test('Not Taken Up - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote'); // the copy goes the way the quote it copies went
    test.setTimeout(10 * 60_000);
    const copy = await createPppModelCopy(page);
    chain.ntuQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Not Taken Up - Get Pricing', async ({ page }) => {
    steps.needs('Not Taken Up - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.ntuQuoteUrl, { geocodeFirst: true }); // the copy's schedule is geocoded + peril scored like the original
  });

  test('Not Taken Up - Issue Quote', async ({ page }) => {
    steps.needs('Not Taken Up - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.ntuQuoteUrl, pppSections.riskSection, pppAssignee);
  });

  // The quote then shows the status "Not Taken Up" and "This risk was marked as … The reason recorded was '…'" (the ⋮ menu keeps
  // listing every action, so it proves nothing). The reason is the first one the list offers.
  test('Not Taken Up', async ({ page }, testInfo) => {
    steps.needs('Not Taken Up - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No issued Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.ntuQuoteUrl);
    await quote.closeQuote('Not Taken Up', undefined, pppNotTakenUp.description);
    const notice = await quote.expectMarkedAs(chain.ntuQuoteUrl, 'Not Taken Up');
    testInfo.annotations.push({ type: 'quote', description: notice });
  });

  // Mark as Lost is offered on an issued quote: its own ⋮ → Model copy → Get Price → Issue Quote, one test each, then Mark as Lost
  test('Mark as Lost - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote'); // the copy goes the way the quote it copies went
    test.setTimeout(10 * 60_000);
    const copy = await createPppModelCopy(page);
    chain.lostQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Mark as Lost - Get Pricing', async ({ page }) => {
    steps.needs('Mark as Lost - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.lostQuoteUrl, { geocodeFirst: true }); // the copy's schedule is geocoded + peril scored like the original
  });

  test('Mark as Lost - Issue Quote', async ({ page }) => {
    steps.needs('Mark as Lost - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.lostQuoteUrl, pppSections.riskSection, pppAssignee);
  });

  // The quote then shows the status "Lost" and "This risk was marked as … The reason recorded was '…'" (the ⋮ menu keeps
  // listing every action, so it proves nothing). The reason is the first one the list offers.
  test('Mark as Lost', async ({ page }, testInfo) => {
    steps.needs('Mark as Lost - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No issued Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.lostQuoteUrl);
    await quote.markAsLost(pppLost.description);
    const notice = await quote.expectMarkedAs(chain.lostQuoteUrl, 'Lost');
    testInfo.annotations.push({ type: 'quote', description: notice });
  });
});

// In order: the reversal undoes the endorsement made by "MTA - GE Pricing".
test.describe('PPP - Policy', { tag: ['@flow', '@ppp-flow'] }, () => {
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
    const statuses = await docs.expectAllDocumentsCompleted(pppDocumentWait);
    testInfo.annotations.push({ type: 'documents', description: `${statuses.length} completed` });
  });

  // General Endorsement, one test per step: endorsement quote → Get Price → Issue → Take Up Endorsement (Policy
  // Conversion) → Confirm Endorsement. PPP_ENDORSEMENT_URL carries on from an endorsement quote already started (one endorsement per
  // policy at a time), PPP_ENDORSED_POLICY_URL from an endorsed policy.
  test('MTA - GE - Endorsement Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // a Bound policy is all it needs (its documents may still have failed)
    test.setTimeout(10 * 60_000);
    test.skip(!!ppp.env('ENDORSEMENT_URL') || !!ppp.env('ENDORSED_POLICY_URL'), 'An existing endorsement is used (PPP_ENDORSEMENT_URL / _ENDORSED_POLICY_URL)');
    test.skip(!chain.policyUrl, 'No Bound policy');
    const endorsement = await startEndorsement(page, chain.policyUrl, pppEndorsement);
    chain.endorsementUrl = endorsement.url;
    testInfo.annotations.push({ type: 'quote', description: endorsement.reference });
  });

  test('MTA - GE - Get Pricing', async ({ page }) => {
    steps.needs('MTA - GE - Endorsement Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!ppp.env('ENDORSED_POLICY_URL'), 'PPP_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await priceEndorsement(page, chain.endorsementUrl, pppSections.riskSection);
  });

  test('MTA - GE - Issue Quote', async ({ page }) => {
    steps.needs('MTA - GE - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!ppp.env('ENDORSED_POLICY_URL'), 'PPP_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await issueEndorsement(page, chain.endorsementUrl, pppSections.riskSection);
  });

  test('MTA - GE - Take Up Endorsement', async ({ page }, testInfo) => {
    steps.needs('MTA - GE - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!ppp.env('ENDORSED_POLICY_URL'), 'PPP_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    const endorsed = await takeUpEndorsement(page, chain.endorsementUrl, pppSections.riskSection);
    chain.endorsementConvertedUrl = endorsed.url;
    testInfo.annotations.push({ type: 'policy', description: endorsed.reference });
  });

  test('MTA - GE - Confirm Endorsement', async ({ page }) => {
    steps.needs('MTA - GE - Take Up Endorsement');
    test.setTimeout(5 * 60_000);
    const endorsedUrl = chain.endorsementConvertedUrl || ppp.env('ENDORSED_POLICY_URL');
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
    await docs.expectAllDocumentsCompleted(pppDocumentWait);
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    if (!chain.endorsedPolicyUrl) steps.needs('MTA - GE - Confirm Endorsement');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, chain.endorsedPolicyUrl, pppEndorsement.reasonDescription);
  });
});

test.describe('PPP - Cancellation', { tag: ['@flow', '@ppp-flow'] }, () => {
  // Mid Term Cancellation on a Bound policy of its own (a Model copy of the quote made from the submission, taken through the same
  // operations, one test each), then the cancellation MTA one step at a time, its documents, and Reinstate Policy on it.
  // PPP_CANCEL_POLICY_URL cancels an existing Bound policy instead, PPP_CANCEL_MTA_URL / _REINSTATE_MTA_URL carry on from existing MTAs.
  test('MTC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!ppp.env('CANCEL_POLICY_URL') || !!ppp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PPP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    const copy = await createPppModelCopy(page);
    chain.mtcBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('MTC - Get Pricing', async ({ page }) => {
    steps.needs('MTC - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!ppp.env('CANCEL_POLICY_URL') || !!ppp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PPP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.mtcBaseQuoteUrl, { geocodeFirst: true }); // the copy's schedule is geocoded + peril scored like the original
  });

  test('MTC - Issue Quote', async ({ page }) => {
    steps.needs('MTC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!ppp.env('CANCEL_POLICY_URL') || !!ppp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PPP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.mtcBaseQuoteUrl, pppSections.riskSection, pppAssignee);
  });

  test('MTC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('MTC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!ppp.env('CANCEL_POLICY_URL') || !!ppp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PPP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.mtcBaseQuoteUrl);
    await quote.takeUp([pppSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.mtcBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PPP MTC Policy', policy.reference, policy.url);
  });

  test('MTC - Confirm Cover', async ({ page }) => {
    steps.needs('MTC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!ppp.env('CANCEL_POLICY_URL') || !!ppp.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PPP_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.mtcBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.mtcBasePolicyUrl = chain.mtcBaseConvertedUrl;
  });

  // ⋮ Mid Term Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // PPP_CANCEL_MTA_URL carries on from an MTA that already exists.
  test('MTA - Mid Term Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.mtcBasePolicyUrl) steps.needs('MTC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!ppp.env('CANCEL_MTA_URL'), 'PPP_CANCEL_MTA_URL is set');
    test.skip(!chain.mtcBasePolicyUrl, 'No Bound base policy');
    chain.mtcBaseMtaUrl = await startMidTermCancellationMta(page, chain.mtcBasePolicyUrl, pppCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.mtcBaseMtaUrl });
  });

  test('MTA - Mid Term Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.mtcBaseMtaUrl) steps.needs('MTA - Mid Term Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.mtcBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.mtcBaseMtaUrl, pppSections.riskSection);
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
    await docs.expectAllDocumentsCompleted(pppDocumentWait);
  });

  // ⋮ Reinstate Contract on the cancellation MTA → Save creates the next MTA (…/MTA002); the backend prices and confirms it, so the
  // outcome is checked (policy Bound again, "Reinstate Contract" in the Endorsement grid, the actions of a live policy)
  test('Reinstate Policy', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Confirm Cancellation');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.mtcBaseConfirmed, 'The cancellation was not confirmed');
    // A cancellation can be reinstated only once, even when that reinstatement went into error: a re-run cancels a fresh Bound
    // policy (Model copy → price → issue → take up → Mid-Term Cancellation → price → confirm) and reinstates that one instead
    if (chain.reinstateMtaUrl && !ppp.env('REINSTATE_MTA_URL')) {
      test.setTimeout(45 * 60_000);
      const policy = await createBoundPolicy(page);
      chain.mtcBasePolicyUrl = policy.url;
      chain.mtcBaseMtaUrl = await cancelPolicyMidTerm(page, policy.url, pppSections.riskSection, pppCancellation);
      chain.reinstateMtaUrl = '';
    }
    await reinstatePolicy(page, chain.mtcBaseMtaUrl, pppReinstatement, ppp.env('REINSTATE_MTA_URL'), undefined, (url) => (chain.reinstateMtaUrl = url));
  });

});

// Renewal: a Bound New Business policy of its own (a Model copy of the quote made from the submission, taken through the same
// operations), renewed, and the renewal quote taken through the same steps as a new one, one test per operation.
// PPP_RENEWAL_BASE_POLICY_URL renews an existing Bound policy, PPP_RENEWAL_QUOTE_URL carries on from an existing renewal quote,
// PPP_RENEWAL_POLICY_URL from an existing Bound renewal policy.
test.describe('PPP - Renewal', { tag: ['@flow', '@ppp-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const renewalPolicyGiven = !!ppp.env('RENEWAL_POLICY_URL');

  // The renewal's own Bound New Business policy, made the way the main one is: ⋮ → Model copy of the quote made from the submission →
  // Get Price → Issue Quote → Taken Up + Policy Conversion → Confirm Cover, one test each
  test('Renewal - Base - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no renewal either
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!!ppp.env('RENEWAL_BASE_POLICY_URL') || !!ppp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    const copy = await createPppModelCopy(page);
    chain.renewalBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Renewal - Base - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Base - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!!ppp.env('RENEWAL_BASE_POLICY_URL') || !!ppp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.renewalBaseQuoteUrl, { geocodeFirst: true }); // the copy's schedule is geocoded + peril scored like the original
  });

  test('Renewal - Base - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Base - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!!ppp.env('RENEWAL_BASE_POLICY_URL') || !!ppp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.renewalBaseQuoteUrl, pppSections.riskSection, pppAssignee);
  });

  test('Renewal - Base - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Base - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!!ppp.env('RENEWAL_BASE_POLICY_URL') || !!ppp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalBaseQuoteUrl);
    await quote.takeUp([pppSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PPP Renewal Base Policy', policy.reference, policy.url);
  });

  test('Renewal - Base - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Base - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!!ppp.env('RENEWAL_BASE_POLICY_URL') || !!ppp.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
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
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!!ppp.env('RENEWAL_QUOTE_URL'), 'PPP_RENEWAL_QUOTE_URL is set');
    test.skip(!chain.renewalBasePolicyUrl, 'No Bound policy to renew');
    const policy = new PolicyPage(page);
    await policy.open(chain.renewalBasePolicyUrl);
    await policy.renew();
    const renewal = await policy.saveRenewal();
    chain.renewalQuoteUrl = renewal.url;
    testInfo.annotations.push({ type: 'quote', description: renewal.reference });
    await recordContract('PPP Renewal Quote', renewal.reference, renewal.url);
  });

  test('Renewal - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Renew Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    // A renewal quote's copied schedule items arrive un-geocoded: geocode + peril score first
    await fillCtaRationale(page, chain.renewalQuoteUrl); // the renewal inherits a CTA whose rationale Issue Quote demands
    await priceQuote(page, chain.renewalQuoteUrl, { geocodeFirst: true });
  });

  test('Renewal - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await issueWithSelfApproval(page, chain.renewalQuoteUrl, pppSections.riskSection, pppAssignee);
  });

  // ⋮ → Taken Up (on a renewal: "Quote Taken Up") reaches the unsaved Policy Conversion; nothing is saved yet (see "Quote Taken up")
  test('Renewal - Quote Taken up', async ({ page }) => {
    steps.needs('Renewal - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([pppSections.riskSection]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  test('Renewal - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Quote Taken up');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([pppSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalConvertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PPP Renewal Policy', policy.reference, policy.url);
  });

  test('Renewal - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'PPP_RENEWAL_POLICY_URL is set');
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
    await docs.expectAllDocumentsCompleted(pppDocumentWait);
  });
});
