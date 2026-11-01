import fs from 'fs';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyAtInception, cancelPolicyMidTerm, confirmEndorsement, confirmMta, endorsePolicy, issueEndorsement, priceEndorsement, priceMta, reinstatePolicy, reverseEndorsement, startEndorsement, startInceptionCancellationMta, startMidTermCancellationMta, takeUpEndorsement } from '../../src/products/cmbc/flows/policy';
import { cmbcDocumentWait,
  buildCmbcSections,
  cmbcModel,
  createBoundPolicy,
  createCmbcModelCopy,
  convertCmbcSubmission,
  createCmbcSubmission,
  fillCtaRationale,
  issueWithSelfApproval,
  priceQuote,
} from '../../src/products/cmbc/flows/quote';
import { cmbc } from '../../src/products/cmbc';
import { CmbcSectionsPage } from '../../src/products/cmbc/CmbcSectionsPage';
import {
  cmbcAssignee,
  cmbcCancellation,
  cmbcCommission,
  cmbcDocument,
  cmbcEndorsement,
  cmbcInceptionCancellation,
  cmbcReinstatement,
  cmbcScheduleFile,
  cmbcSections,
} from '../../src/products/cmbc/data';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../src/pages/advantagego/QuotePage';
import { readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { recordContract } from '../../src/support/contracts';
import { blockingSteps, persisted } from '../../src/support/runState';

const cmbcPremiumGrossLabel = 'Policy Period Premium Gross of Comm. & Net of IPT';

// Values handed down the chains, kept for the run (src/support/runState.ts). The chains run in order but do not stop at a
// failed test: Playwright carries on with the next one in a fresh worker, which reads these back.
const chain = persisted('cmbc-chain', {
  submissionId: undefined as number | undefined,
  mtcBaseQuoteUrl: '', // Mid Term Cancellation: base quote → converted → Bound policy → cancellation MTA (→ confirmed)
  mtcBaseConvertedUrl: '',
  mtcBasePolicyUrl: cmbc.env('CANCEL_POLICY_URL'),
  mtcBaseMtaUrl: cmbc.env('CANCEL_MTA_URL'),
  mtcBaseConfirmed: !!cmbc.env('CANCEL_MTA_URL'),
  icBaseQuoteUrl: '', // Inception Cancellation: base quote → converted → Bound policy → MTA (→ confirmed)
  icBaseConvertedUrl: '',
  icBasePolicyUrl: cmbc.env('INCEPTION_POLICY_URL'),
  icBaseMtaUrl: cmbc.env('INCEPTION_MTA_URL'),
  icBaseConfirmed: !!cmbc.env('INCEPTION_MTA_URL'),
  endorsementUrl: cmbc.env('ENDORSEMENT_URL'), // the General Endorsement: endorsement quote → converted (endorsementConvertedUrl) → Bound (endorsedPolicyUrl)
  endorsementConvertedUrl: '',
  renewalBaseQuoteUrl: '', // the renewal's own base policy: Model copy → … → converted → Bound (renewalBasePolicyUrl)
  renewalBaseConvertedUrl: '',
  renewalBasePolicyUrl: cmbc.env('RENEWAL_BASE_POLICY_URL'), // the renewal chain: base policy → renewal quote → converted → Bound renewal policy
  renewalQuoteUrl: cmbc.env('RENEWAL_QUOTE_URL'),
  renewalConvertedPolicyUrl: '',
  renewalPolicyUrl: cmbc.env('RENEWAL_POLICY_URL'),
  renewalEndorsedPolicyUrl: '',
  cancellationMtaUrl: '', // the Mid-Term Cancellation MTA (its documents are checked on their own)
  inceptionMtaUrl: '',
  endorsedPolicyUrl: '',
  convertedPolicyUrl: '', // created by Policy Conversion, Bound by Confirm Cover (then also policyUrl)
  policyUrl: cmbc.env('POLICY_URL'),
  quoteUrl: cmbc.env('QUOTE_URL'),
  quoteReference: '',
});
// Get Price, geocoding, Issue Quote, Taken Up (Confirm Cover), Confirm Endorsement … cannot be done without: a test that needs
// one of them is skipped as "Blocked" once it has failed (steps.needs); every other failure just lets the chain carry on.
const steps = blockingSteps('cmbc-chain');
test.afterEach(async ({}, testInfo) => steps.record(testInfo));
// One ordered sequence for the whole file, in one worker: Quote → Quote lifecycle → Policy → Cancellation → Renewal. Everything after
// Taken Up needs the Bound policy it makes (or a Model copy of the same quote taken up the same way), so nothing runs ahead of it.
test.describe.configure({ mode: 'default' });

test.describe('CMBC - Quote', { tag: ['@flow', '@cmbc-flow'] }, () => {
  test.describe.configure({ mode: 'default' });

  // New Submission (inception today − 10 days) → Submit
  test('Create Submission', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    test.skip(!!cmbc.env('QUOTE_URL'), 'CMBC_QUOTE_URL is set');
    const submission = await createCmbcSubmission(page);
    chain.submissionId = submission.contractId;
    testInfo.annotations.push({ type: 'submission', description: `${submission.reference} (${submission.contractId})` });
  });

  // The submission's remaining details → Convert to Quote: the quote the rest of the chain works on
  test('Convert to Quote', async ({ page }, testInfo) => {
    steps.needs('Create Submission');
    test.setTimeout(8 * 60_000);
    test.skip(!!cmbc.env('QUOTE_URL'), 'CMBC_QUOTE_URL is set');
    test.skip(chain.submissionId === undefined, 'No submission (Create Submission did not complete)');
    const quote = await convertCmbcSubmission(page, chain.submissionId!);
    chain.quoteUrl = quote.url;
    chain.quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
  });

  // Offering, PDBI and Liability with their child sections, details and exposures, and a Selected % for every section: one test, as the
  // app keeps the sections in memory only and saves them once all of it is filled. ⋮ Get Commission follows as its own test.
  test('Convert to Quote with PDBI and Liability child sections', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('QUOTE_URL'), 'CMBC_QUOTE_URL is set');
    test.skip(!chain.quoteUrl, 'No quote');
    testInfo.annotations.push({ type: 'section validation', description: await buildCmbcSections(page, chain.quoteUrl) });
  });

  test('Insert schedule with geocoding and peril score', async ({ page }) => {
    steps.needs('Convert to Quote with PDBI and Liability child sections');
    test.setTimeout(12 * 60_000);
    const sections = new CmbcSectionsPage(page);
    await sections.open(chain.quoteUrl);
    await sections.importCmbcSchedule(cmbcScheduleFile);
  });

  test('Get Commission', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote with PDBI and Liability child sections');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    // The connector leaves "not rated" sections empty: they get the broker %. When Get Commission errors, the Broker Commission is
    // added by hand ("+", or its blank % filled) so the chain carries on, and this test then fails with the connector's error.
    const { rejected, error } = await quote.getCommissionOrAddManually(cmbcCommission.brokerPercent);
    if (rejected.length) testInfo.annotations.push({ type: 'commission not rated', description: rejected.join(', ') });
    cmbcModel.url = chain.quoteUrl; // sections, schedule and commission are on it now: the model the other CMBC quotes are copied from
    if (error) throw error;
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    steps.needs('Insert schedule with geocoding and peril score');
    // CMBC only offers ⋮ → Get Price from UW Review & Process onwards
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.nextStage();
    const sections = new CmbcSectionsPage(page);
    await sections.open(chain.quoteUrl);
    await sections.expectCmbcStructure(cmbcSections);
    await sections.getPrice([cmbcSections.riskSections[0]]);
    const premium = await readPremium(page, chain.quoteUrl, cmbcPremiumGrossLabel);
    expect(premium.policyPeriodGross).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    steps.needs('Convert to Quote with PDBI and Liability child sections');
    const docs = new QuoteDocumentsPage(page);
    await docs.open(chain.quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(cmbcDocument);
    const file = await docs.download(title);
    expect(file.size).toBe(fs.statSync(cmbcDocument.filePath).size);
    await docs.expectDownloadedOn(title);
  });

  test('Search / Advance Search', async ({ page }) => {
    steps.needs('Convert to Quote with PDBI and Liability child sections');
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
    await issueWithSelfApproval(page, chain.quoteUrl, cmbcSections.riskSections[0], cmbcAssignee);
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002)
  test('MultiQuote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote');
    test.setTimeout(5 * 60_000);
    if (!chain.quoteReference) {
      await new QuotePage(page).open(chain.quoteUrl);
      chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
    }
    const multi = await new QuotePage(page).convertToMultiQuote(chain.quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(chain.quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(chain.quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('CMBC Multi Quote', multi.reference, multi.url);
  });

  // ⋮ → Taken Up opens the unsaved Policy Conversion (a Provisional policy, "To Take Up the quote the risk will be saved"): this checks
  // the action gets there (open tasks, warnings, a re-price when asked). Nothing is saved yet: the quote stays Quoted and ⋮ still
  // offers Taken Up, so "Policy Conversion" runs it again on its own page.
  test('Quote Taken up', async ({ page }) => {
    steps.needs('Issue Quote');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  // ⋮ → Taken Up → Policy Conversion → Save: the policy is created (Provisional) and the quote becomes Taken Up
  test('Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Quote Taken up');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.convertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('CMBC Policy', policy.reference, policy.url);
  });

  // ⋮ → Requote is offered once the quote is Taken Up → Ok → Save creates the new version
  test('Requote', async ({ page }, testInfo) => {
    steps.needs('Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.convertedPolicyUrl && !chain.policyUrl, 'The quote was not taken up (no policy conversion)');
    if (!chain.quoteReference) {
      await new QuotePage(page).open(chain.quoteUrl);
      chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
    }
    const requote = await new QuotePage(page).requote(chain.quoteUrl);
    expect(requote.reference, 'a new quote version').toMatch(/^RSK\d+Q\d+$/);
    expect(requote.reference).not.toBe(chain.quoteReference);
    testInfo.annotations.push({ type: 'requote', description: requote.reference });
    await recordContract('CMBC Requote', requote.reference, requote.url);
  });

  test.fixme('Documents/datalake payload generation', async () => {});
  test.fixme('Data lake pricing/quote/schedule', async () => {});
  test.fixme('Check ALS and server folder payloads', async () => {});
  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

test.describe('CMBC - Policy', { tag: ['@flow', '@cmbc-flow'] }, () => {

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
    const statuses = await docs.expectAllDocumentsCompleted(cmbcDocumentWait);
    testInfo.annotations.push({ type: 'documents', description: `${statuses.length} completed` });
  });
  // General Endorsement, one test per step: endorsement quote → Get Price → Issue → Take Up Endorsement (Policy
  // Conversion) → Confirm Endorsement. CMBC_ENDORSEMENT_URL carries on from an endorsement quote already started (one endorsement per
  // policy at a time), CMBC_ENDORSED_POLICY_URL from an endorsed policy.
  test('MTA - GE - Endorsement Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // a Bound policy is all it needs (its documents may still have failed)
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('ENDORSEMENT_URL') || !!cmbc.env('ENDORSED_POLICY_URL'), 'An existing endorsement is used (CMBC_ENDORSEMENT_URL / _ENDORSED_POLICY_URL)');
    test.skip(!chain.policyUrl, 'No Bound policy');
    const endorsement = await startEndorsement(page, chain.policyUrl, cmbcEndorsement);
    chain.endorsementUrl = endorsement.url;
    testInfo.annotations.push({ type: 'quote', description: endorsement.reference });
  });

  test('MTA - GE - Get Pricing', async ({ page }) => {
    steps.needs('MTA - GE - Endorsement Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('ENDORSED_POLICY_URL'), 'CMBC_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await priceEndorsement(page, chain.endorsementUrl, cmbcSections.riskSections[0]);
  });

  test('MTA - GE - Issue Quote', async ({ page }) => {
    steps.needs('MTA - GE - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('ENDORSED_POLICY_URL'), 'CMBC_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await issueEndorsement(page, chain.endorsementUrl, cmbcSections.riskSections[0]);
  });

  test('MTA - GE - Take Up Endorsement', async ({ page }, testInfo) => {
    steps.needs('MTA - GE - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('ENDORSED_POLICY_URL'), 'CMBC_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    const endorsed = await takeUpEndorsement(page, chain.endorsementUrl, cmbcSections.riskSections[0]);
    chain.endorsementConvertedUrl = endorsed.url;
    testInfo.annotations.push({ type: 'policy', description: endorsed.reference });
  });

  test('MTA - GE - Confirm Endorsement', async ({ page }) => {
    steps.needs('MTA - GE - Take Up Endorsement');
    test.setTimeout(5 * 60_000);
    const endorsedUrl = chain.endorsementConvertedUrl || cmbc.env('ENDORSED_POLICY_URL');
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
    await docs.expectAllDocumentsCompleted(cmbcDocumentWait);
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    if (!chain.endorsedPolicyUrl) steps.needs('MTA - GE - Confirm Endorsement');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, chain.endorsedPolicyUrl, cmbcEndorsement.reasonDescription);
  });

});

// Renewal: a Bound New Business policy of its own (a Model copy of the quote made from the submission, taken through the same
// operations), renewed, and the renewal quote taken through the same steps as a new one, one test per operation.
// CMBC_RENEWAL_BASE_POLICY_URL renews an existing Bound policy, CMBC_RENEWAL_QUOTE_URL carries on from an existing renewal quote,
// CMBC_RENEWAL_POLICY_URL from an existing Bound renewal policy.
test.describe('CMBC - Renewal', { tag: ['@flow', '@cmbc-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const renewalPolicyGiven = !!cmbc.env('RENEWAL_POLICY_URL');

  // The renewal's own Bound New Business policy, made the way the main one is: ⋮ → Model copy of the quote made from the submission →
  // Get Price → Issue Quote → Taken Up + Policy Conversion → Confirm Cover, one test each
  test('Renewal - Base - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no renewal either
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_BASE_POLICY_URL') || !!cmbc.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    const copy = await createCmbcModelCopy(page);
    chain.renewalBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // The copied schedule is geocoded + peril scored before Get Price, which refuses it otherwise ("The Geocoding for all schedule
  // items have not been done"): Schedule ⋮ → Geocode and Get Peril Score → the wizard → Save
  test('Renewal - Base - Geocoding and Peril Scoring', async ({ page }) => {
    steps.needs('Renewal - Base - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_BASE_POLICY_URL') || !!cmbc.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    const sections = new CmbcSectionsPage(page);
    await sections.open(chain.renewalBaseQuoteUrl);
    await sections.geocodeAndGetPerilScore();
  });

  test('Renewal - Base - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Base - Geocoding and Peril Scoring');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_BASE_POLICY_URL') || !!cmbc.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.renewalBaseQuoteUrl); // Next Stage → Get Price (geocoded by the test above)
  });

  test('Renewal - Base - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Base - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_BASE_POLICY_URL') || !!cmbc.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.renewalBaseQuoteUrl, cmbcSections.riskSections[0], cmbcAssignee);
  });

  test('Renewal - Base - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Base - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_BASE_POLICY_URL') || !!cmbc.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalBaseQuoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('CMBC Renewal Base Policy', policy.reference, policy.url);
  });

  test('Renewal - Base - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Base - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_BASE_POLICY_URL') || !!cmbc.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
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
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!!cmbc.env('RENEWAL_QUOTE_URL'), 'CMBC_RENEWAL_QUOTE_URL is set');
    test.skip(!chain.renewalBasePolicyUrl, 'No Bound policy to renew');
    const policy = new PolicyPage(page);
    await policy.open(chain.renewalBasePolicyUrl);
    await policy.renew({ expectSchedules: true });
    const renewal = await policy.saveRenewal();
    chain.renewalQuoteUrl = renewal.url;
    testInfo.annotations.push({ type: 'quote', description: renewal.reference });
    await recordContract('CMBC Renewal Quote', renewal.reference, renewal.url);
  });

  // The copied schedule is geocoded + peril scored before Get Price, which refuses it otherwise ("The Geocoding for all schedule
  // items have not been done"): Schedule ⋮ → Geocode and Get Peril Score → the wizard → Save (a renewal quote's copied items arrive un-geocoded)
  test('Renewal - Geocoding and Peril Scoring', async ({ page }) => {
    steps.needs('Renewal - Renew Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const sections = new CmbcSectionsPage(page);
    await sections.open(chain.renewalQuoteUrl);
    await sections.geocodeAndGetPerilScore();
  });

  test('Renewal - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Geocoding and Peril Scoring');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await fillCtaRationale(page, chain.renewalQuoteUrl); // the renewal inherits a CTA whose rationale Issue Quote demands
    await priceQuote(page, chain.renewalQuoteUrl); // starts at Risk Details: Next Stage → Get Price
  });

  test('Renewal - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await issueWithSelfApproval(page, chain.renewalQuoteUrl, cmbcSections.riskSections[0], cmbcAssignee);
  });

  // ⋮ → Taken Up (on a renewal: "Quote Taken Up") reaches the unsaved Policy Conversion; nothing is saved yet (see "Quote Taken up")
  test('Renewal - Quote Taken up', async ({ page }) => {
    steps.needs('Renewal - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  test('Renewal - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Quote Taken up');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalConvertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('CMBC Renewal Policy', policy.reference, policy.url);
  });

  test('Renewal - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'CMBC_RENEWAL_POLICY_URL is set');
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
    await docs.expectAllDocumentsCompleted(cmbcDocumentWait);
  });
});

test.describe('CMBC - Cancellation', { tag: ['@flow', '@cmbc-flow'] }, () => {
  // Mid Term Cancellation on a Bound policy of its own (a Model copy of the quote made from the submission, taken through the same
  // operations, one test each), then the cancellation MTA one step at a time, its documents, and Reinstate Policy on it.
  // CMBC_CANCEL_POLICY_URL cancels an existing Bound policy instead, CMBC_CANCEL_MTA_URL / _REINSTATE_MTA_URL carry on from existing MTAs.
  test('MTC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('CANCEL_POLICY_URL') || !!cmbc.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (CMBC_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    const copy = await createCmbcModelCopy(page);
    chain.mtcBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // The copied schedule is geocoded + peril scored before Get Price, which refuses it otherwise ("The Geocoding for all schedule
  // items have not been done"): Schedule ⋮ → Geocode and Get Peril Score → the wizard → Save
  test('MTC - Geocoding and Peril Scoring', async ({ page }) => {
    steps.needs('MTC - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('CANCEL_POLICY_URL') || !!cmbc.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (CMBC_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    const sections = new CmbcSectionsPage(page);
    await sections.open(chain.mtcBaseQuoteUrl);
    await sections.geocodeAndGetPerilScore();
  });

  test('MTC - Get Pricing', async ({ page }) => {
    steps.needs('MTC - Geocoding and Peril Scoring');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('CANCEL_POLICY_URL') || !!cmbc.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (CMBC_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.mtcBaseQuoteUrl); // Next Stage → Get Price (geocoded by the test above)
  });

  test('MTC - Issue Quote', async ({ page }) => {
    steps.needs('MTC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('CANCEL_POLICY_URL') || !!cmbc.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (CMBC_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.mtcBaseQuoteUrl, cmbcSections.riskSections[0], cmbcAssignee);
  });

  test('MTC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('MTC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('CANCEL_POLICY_URL') || !!cmbc.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (CMBC_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.mtcBaseQuoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.mtcBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('CMBC MTC Policy', policy.reference, policy.url);
  });

  test('MTC - Confirm Cover', async ({ page }) => {
    steps.needs('MTC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!cmbc.env('CANCEL_POLICY_URL') || !!cmbc.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (CMBC_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.mtcBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.mtcBasePolicyUrl = chain.mtcBaseConvertedUrl;
  });

  // ⋮ Mid Term Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // CMBC_CANCEL_MTA_URL carries on from an MTA that already exists.
  test('MTA - Mid Term Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.mtcBasePolicyUrl) steps.needs('MTC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('CANCEL_MTA_URL'), 'CMBC_CANCEL_MTA_URL is set');
    test.skip(!chain.mtcBasePolicyUrl, 'No Bound base policy');
    chain.mtcBaseMtaUrl = await startMidTermCancellationMta(page, chain.mtcBasePolicyUrl, cmbcCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.mtcBaseMtaUrl });
  });

  test('MTA - Mid Term Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.mtcBaseMtaUrl) steps.needs('MTA - Mid Term Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.mtcBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.mtcBaseMtaUrl, cmbcSections.riskSections[0]);
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
    await docs.expectAllDocumentsCompleted(cmbcDocumentWait);
  });

  // ⋮ Reinstate Contract on the cancellation MTA → Save creates the next MTA (…/MTA002); the backend prices and confirms it, so the
  // outcome is checked (policy Bound again, "Reinstate Contract" in the Endorsement grid, the actions of a live policy)
  test('Reinstate Policy', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Confirm Cancellation');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.mtcBaseConfirmed, 'The cancellation was not confirmed');
    await reinstatePolicy(page, chain.mtcBaseMtaUrl, cmbcReinstatement, cmbc.env('REINSTATE_MTA_URL'));
  });


  // Inception Cancellation on a Bound policy of its own, the same way. CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL reuse existing records.
  test('IC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_POLICY_URL') || !!cmbc.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    const copy = await createCmbcModelCopy(page);
    chain.icBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // The copied schedule is geocoded + peril scored before Get Price, which refuses it otherwise ("The Geocoding for all schedule
  // items have not been done"): Schedule ⋮ → Geocode and Get Peril Score → the wizard → Save
  test('IC - Geocoding and Peril Scoring', async ({ page }) => {
    steps.needs('IC - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_POLICY_URL') || !!cmbc.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    const sections = new CmbcSectionsPage(page);
    await sections.open(chain.icBaseQuoteUrl);
    await sections.geocodeAndGetPerilScore();
  });

  test('IC - Get Pricing', async ({ page }) => {
    steps.needs('IC - Geocoding and Peril Scoring');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_POLICY_URL') || !!cmbc.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.icBaseQuoteUrl); // Next Stage → Get Price (geocoded by the test above)
  });

  test('IC - Issue Quote', async ({ page }) => {
    steps.needs('IC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_POLICY_URL') || !!cmbc.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.icBaseQuoteUrl, cmbcSections.riskSections[0], cmbcAssignee);
  });

  test('IC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('IC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_POLICY_URL') || !!cmbc.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.icBaseQuoteUrl);
    await quote.takeUp([cmbcSections.riskSections[0]]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.icBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('CMBC IC Policy', policy.reference, policy.url);
  });

  test('IC - Confirm Cover', async ({ page }) => {
    steps.needs('IC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_POLICY_URL') || !!cmbc.env('INCEPTION_MTA_URL'), 'An existing policy or inception MTA is used (CMBC_INCEPTION_POLICY_URL / _INCEPTION_MTA_URL)');
    test.skip(!chain.icBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.icBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.icBasePolicyUrl = chain.icBaseConvertedUrl;
  });

  // ⋮ Inception Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // CMBC_INCEPTION_MTA_URL carries on from an MTA that already exists.
  test('MTA - Inception Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.icBasePolicyUrl) steps.needs('IC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!cmbc.env('INCEPTION_MTA_URL'), 'CMBC_INCEPTION_MTA_URL is set');
    test.skip(!chain.icBasePolicyUrl, 'No Bound base policy');
    chain.icBaseMtaUrl = await startInceptionCancellationMta(page, chain.icBasePolicyUrl, cmbcInceptionCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.icBaseMtaUrl });
  });

  test('MTA - Inception Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.icBaseMtaUrl) steps.needs('MTA - Inception Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.icBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.icBaseMtaUrl, cmbcSections.riskSections[0]);
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
    await docs.expectAllDocumentsCompleted(cmbcDocumentWait);
  });


});
