import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { businessAction, listActions } from '../../src/pages/advantagego/entity';
import { cancelPolicyMidTerm, confirmEndorsement, confirmMta, endorsePolicy, issueEndorsement, priceEndorsement, priceMta, reinstatePolicy, reverseEndorsement, startEndorsement, startMidTermCancellationMta, takeUpEndorsement } from '../../src/products/pi/flows/policy';
import { addPiSections, createBoundPolicy, createPiModelCopy, issueWithSelfApproval, piModel } from '../../src/products/pi/flows/quote';
import { env } from '../../src/config/env';
import { pi } from '../../src/products/pi';
import { piDecline, piNotTakenUp, piLost, piDocument, piEndorsement, piCancellation, piReinstatement, piQuote, piCommission, piSections, piSubmission, piSubmissionDetails, piTask } from '../../src/products/pi/data';
import { PiSectionsPage } from '../../src/products/pi/PiSectionsPage';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { NewSubmissionPage } from '../../src/pages/advantagego/NewSubmissionPage';
import { SubmissionPage } from '../../src/pages/advantagego/SubmissionPage';
import { QuoteSectionsPage, readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { IssueOutcome, QuotePage } from '../../src/pages/advantagego/QuotePage';
import { recordContract } from '../../src/support/contracts';
import { blockingSteps, persisted } from '../../src/support/runState';
import { inceptionDate } from '../../src/support/dates';

// One test per row of the "PI" sheet in "AXA R5.4 - CMBC-MTP-Fleet Smoke (1).xlsx".
// test.fixme = not automated yet (reported as skipped). Remove it as each flow is implemented.

// In order: each step builds on the submission/quote created by the previous one. The bound policy is created by "Quote Taken up…",
// or an existing one (PI_POLICY_URL) serves the policy rows alone.
//
// Values handed down the chains, kept for the run (src/support/runState.ts). The chains run in order but do not stop at a
// failed test: Playwright carries on with the next one in a fresh worker, which reads these back.
const chain = persisted('pi-chain', {
  mtcBaseQuoteUrl: '', // Mid Term Cancellation: base quote → converted → Bound policy → cancellation MTA (→ confirmed)
  mtcBaseConvertedUrl: '',
  mtcBasePolicyUrl: pi.env('CANCEL_POLICY_URL'),
  mtcBaseMtaUrl: pi.env('CANCEL_MTA_URL'),
  mtcBaseConfirmed: !!pi.env('CANCEL_MTA_URL'),
  endorsementUrl: pi.env('ENDORSEMENT_URL'), // the General Endorsement: endorsement quote → converted (endorsementConvertedUrl) → Bound (endorsedPolicyUrl)
  endorsementConvertedUrl: '',
  renewalBaseQuoteUrl: '', // the renewal's own base policy: Model copy → … → converted → Bound (renewalBasePolicyUrl)
  renewalBaseConvertedUrl: '',
  ntuQuoteUrl: '', // the Model copies Not Taken Up / Mark as Lost close
  lostQuoteUrl: '',
  renewalBasePolicyUrl: pi.env('RENEWAL_BASE_POLICY_URL'), // the renewal chain: base policy → renewal quote → converted → Bound renewal policy
  renewalQuoteUrl: pi.env('RENEWAL_QUOTE_URL'),
  renewalConvertedPolicyUrl: '',
  renewalPolicyUrl: pi.env('RENEWAL_POLICY_URL'),
  renewalEndorsedPolicyUrl: '',
  cancellationMtaUrl: '', // the Mid-Term Cancellation MTA (its documents are checked on their own)
  inceptionMtaUrl: '',
  convertedPolicyUrl: '', // created by Policy Conversion, Bound by Confirm Cover (then also policyUrl)
  policyUrl: pi.env('POLICY_URL'),
  submissionId: undefined as number | undefined,
  submissionReference: '',
  quoteReference: '',
  quoteUrl: pi.env('QUOTE_URL'),
  issueOutcome: undefined as IssueOutcome | undefined,
  quoteIssued: false,
  endorsedPolicyUrl: pi.env('ENDORSED_POLICY_URL'),
});
// Get Price, geocoding, Issue Quote, Taken Up (Confirm Cover), Confirm Endorsement … cannot be done without: a test that needs
// one of them is skipped as "Blocked" once it has failed (steps.needs); every other failure just lets the chain carry on.
const steps = blockingSteps('pi-chain');
test.afterEach(async ({}, testInfo) => steps.record(testInfo));
// One ordered sequence for the whole file, in one worker: Quote → Quote lifecycle → Policy → Cancellation → Renewal. Everything after
// Taken Up needs the Bound policy it makes (or a Model copy of the same quote taken up the same way), so nothing runs ahead of it.
test.describe.configure({ mode: 'default' });

test.describe('PI - Quote', { tag: ['@flow', '@pi-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  // PI_QUOTE_URL lets quote-level steps run alone against an existing quote (e.g. -g "Get Pricing")

  // When steps run alone on an existing quote (PI_QUOTE_URL) the references weren't captured by the creating steps
  const ensureReferences = async (page: Page) => {
    if (chain.quoteReference) return;
    await new QuotePage(page).open(chain.quoteUrl);
    chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
    chain.submissionReference = chain.quoteReference.slice(0, 11); // RSK00038356 01 Q001 → RSK00038356
  };

  // New Submission (inception today − 10 days) → Convert to Quote: the quote the rest of the chain works on, and the model the other
  // PI quotes are copied from (there is no fixed reference quote)
  test('Create Submission', async ({ page }, testInfo) => {
    const newSubmission = new NewSubmissionPage(page);
    await newSubmission.open();
    await newSubmission.fill(piSubmission());
    const { reference, contractId } = await newSubmission.submit();
    chain.submissionId = contractId;
    chain.submissionReference = reference;
    testInfo.annotations.push({ type: 'submission', description: `${reference} (${contractId})` });
    await recordContract('PI Submission', reference, `/ui/Submission/Edit/${contractId}`);
    console.log(`PI submission created: ${reference} → /ui/Submission/Edit/${contractId}`);

    // Required by Convert to Quote but not asked for on the New Submission form
    const submission = new SubmissionPage(page);
    await submission.open(chain.submissionId);
    await submission.completeDetails(piSubmissionDetails);
  });

  test('Convert to Quote', async ({ page }, testInfo) => {
    steps.needs('Create Submission');
    test.skip(chain.submissionId === undefined, 'No submission (Create Submission did not complete)');
    const submission = new SubmissionPage(page);
    await submission.open(chain.submissionId!);
    const quote = await submission.convertToQuote(piQuote);
    chain.quoteUrl = quote.url;
    chain.quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    await recordContract('PI Quote', quote.reference, quote.url);
    console.log(`PI quote created: ${quote.reference} → ${quote.url}`);
  });


  test('Get Pricing', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    const sections = new PiSectionsPage(page);
    await addPiSections(page, chain.quoteUrl);

    // Pass = "Price is returned back from the rating engine" success toast
    await sections.getPrice([piSections.riskSection]);

    const premium = await readPremium(page, chain.quoteUrl);
    expect(premium.policyPeriodGross, 'Policy Period Premium Gross of Comm. & IPT').toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
    console.log(`PI premium: ${JSON.stringify(premium)}`);
  });

  // PI is not eligible for ⋮ → Get Commission: the Override % of the defaulted Broker Commission row is set manually.
  // Next Stage → Issue Quote need this Broker Commission row. It is only kept once the quote has its risk
  // sections, so this runs after "Get Pricing" (Issue Quote re-prices when commission changed the premium).
  test('Add Broker Commission', async ({ page }) => {
    steps.needs('Convert to Quote');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.addBrokerCommission(piCommission.brokerPercent); // existing Broker Commission row → its %, otherwise a row is added with +
    await quote.expectBrokerCommission();
    piModel.url = chain.quoteUrl; // sections and commission are on it now: the model the other PI quotes are copied from
  });

  test('Quote create task', async ({ page }) => {
    steps.needs('Convert to Quote');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.createTask(piTask);
    expect(await quote.taskStatus(chain.quoteUrl, piTask.taskType, piTask.subject)).toBe('Not Started');

    // Close the task again: card ⋮ → Complete
    await quote.approveTask(chain.quoteUrl, piTask.taskType, 'Complete', piTask.subject);
    await expect
      .poll(() => quote.taskStatus(chain.quoteUrl, piTask.taskType, piTask.subject), { timeout: 60_000, intervals: [3_000] })
      .toBe('Completed');
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    steps.needs('Convert to Quote');
    const docs = new QuoteDocumentsPage(page);
    await docs.open(chain.quoteUrl);
    await docs.attachAutomaticTerms(); // automatic wording
    const title = await docs.upload(piDocument); // manual upload

    const file = await docs.download(title);
    // The app adds "(2)", "(3)"… to the name when a document with the same name was uploaded before
    expect(file.fileName).toMatch(/^smoke-doc(\(\d+\))?\.pdf$/);
    expect(file.size, 'downloaded bytes').toBe(fs.statSync(piDocument.filePath).size);
    await docs.expectDownloadedOn(title);

    // "Generate Document" only appears once the quote is issued (Quoted stage)
    if (chain.issueOutcome === 'issued') {
      await docs.open(chain.quoteUrl);
      await docs.generateDocuments();
    }
  });

  test('Quote History Check and Link Tasks & License', async ({ page }) => {
    steps.needs('Convert to Quote');
    await ensureReferences(page);
    const quote = new QuotePage(page);

    await quote.openHistoryTab(chain.quoteUrl, 'Timeline');
    await expect(page.getByText('UpdateQuote', { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Price', { exact: true }).locator('visible=true').first()).toBeVisible();

    await quote.openHistoryTab(chain.quoteUrl, 'Links');
    // the submission this quote was converted from
    await expect(page.getByText(chain.submissionReference, { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Converted', { exact: true }).locator('visible=true').first()).toBeVisible();

    // Tasks raised on the quote (the Licence Referral task is checked in "License Check - Task Generation")
    expect(await quote.taskStatus(chain.quoteUrl, piTask.taskType, piTask.subject)).toBe('Completed');

    await quote.openHistoryTab(chain.quoteUrl, 'Licence');
    await expect(page.getByText('Risk Audit Trail', { exact: true }).locator('visible=true').first()).toBeVisible();
  });

  test('Search / Advance Search', async ({ page }) => {
    steps.needs('Convert to Quote');
    await ensureReferences(page);
    const search = new SearchPage(page);
    await search.open();
    await search.search(chain.quoteReference);
    await search.expectResultCount('Quotes', 1);

    // The results panel occasionally doesn't render after Apply (the filter chip shows but no groups), so retry the whole search
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

  // Our QC user has a licence level of 0, so issuing raises a Licence Referral task for approval.
  test('License Check - Task Generation', async ({ page }) => {
    steps.needs('Get Pricing');
    test.setTimeout(6 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.nextStage(); // Risk Details → UW Review & Process
    chain.issueOutcome = await quote.issueQuote([piSections.riskSection]);
    if (chain.issueOutcome === 'referred') {
      expect(await quote.taskStatus(chain.quoteUrl, 'Licence Referral')).toBe('Not Started');
    }
  });

  // The Licence Referral is raised for another underwriter, so it is forwarded to the signed-in user and approved from
  // the quote's History → Tasks card (LICENCE_SELF_APPROVE=0 disables that and waits for a real approver instead, up to APPROVAL_WAIT_MINUTES).
  test('Issue Quote', async ({ page }) => {
    steps.needs('Get Pricing');
    const waitMinutes = Number(env('APPROVAL_WAIT_MINUTES', '0'));
    test.setTimeout((waitMinutes + 12) * 60_000);
    const quote = new QuotePage(page);
    await ensureReferences(page);
    // Run alone on an existing quote (PI_QUOTE_URL) the licence check didn't run here: assume it raised the referral
    if (!chain.issueOutcome && pi.env('QUOTE_URL')) chain.issueOutcome = 'referred';

    if (chain.issueOutcome === 'referred') {
      if (env('LICENCE_SELF_APPROVE') !== '0' && (await quote.taskStatus(chain.quoteUrl, 'Licence Referral')) === 'Not Started') {
        await quote.forwardTask(chain.quoteUrl, 'Licence Referral', piTask.assignee);
        await quote.approveLicenceReferral(chain.quoteUrl); // the status takes a few seconds to change after Approve
      }

      const deadline = Date.now() + waitMinutes * 60_000;
      let status = await quote.taskStatus(chain.quoteUrl, 'Licence Referral');
      while (status !== 'Approved' && Date.now() < deadline) {
        await page.waitForTimeout(30_000);
        status = await quote.taskStatus(chain.quoteUrl, 'Licence Referral');
      }
      test.skip(status !== 'Approved', `Licence Referral is "${status}" - awaiting approval (set APPROVAL_WAIT_MINUTES to wait)`);

      await quote.open(chain.quoteUrl);
      expect(await quote.issueQuote([piSections.riskSection])).toBe('issued');
    }
    await quote.waitForDocumentGeneration(chain.quoteUrl); // the record is view-only while documents are generated
    chain.quoteIssued = true;
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002).
  // The source quote stays as it is, so the take-up below still works on it.
  test('MultiQuote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.quoteIssued && !pi.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    await ensureReferences(page);
    const multi = await new QuotePage(page).convertToMultiQuote(chain.quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(chain.quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(chain.quoteReference.slice(0, 13));
    await expect(page.getByText('Provisional', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('PI Multi Quote', multi.reference, multi.url);
    console.log(`PI multi quote: ${multi.reference} → ${multi.url}`);
  });

  // Taken Up needs an issued quote (Licence Referral approved by a Level 2/3 underwriter).
  // ⋮ → Taken Up opens the unsaved Policy Conversion (a Provisional policy, "To Take Up the quote the risk will be saved"): this checks
  // the action gets there (open tasks, warnings, a re-price when asked). Nothing is saved yet: the quote stays Quoted and ⋮ still
  // offers Taken Up, so "Policy Conversion" runs it again on its own page.
  test('Quote Taken up', async ({ page }) => {
    steps.needs('Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.quoteIssued && !pi.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([piSections.riskSection]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  // ⋮ → Taken Up → Policy Conversion → Save: the policy is created (Provisional) and the quote becomes Taken Up
  test('Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Quote Taken up');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([piSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.convertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PI Policy', policy.reference, policy.url);
  });

  // ⋮ → Requote is enabled once the quote is Taken Up (it is greyed out at Risk Details and Quoted) → Ok → Save creates the new version.
  test('Requote', async ({ page }, testInfo) => {
    steps.needs('Policy Conversion'); // ⋮ → Requote is offered once the quote is Taken Up
    test.setTimeout(5 * 60_000);
    test.skip(!chain.convertedPolicyUrl && !chain.policyUrl, 'The quote was not taken up (no policy conversion)');
    await ensureReferences(page);
    const requote = await new QuotePage(page).requote(chain.quoteUrl);
    expect(requote.reference, 'a new quote version').toMatch(/^RSK\d+Q\d+$/);
    expect(requote.reference).not.toBe(chain.quoteReference);
    await expect(page.getByText('Provisional', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    testInfo.annotations.push({ type: 'requote', description: requote.reference });
    await recordContract('PI Requote', requote.reference, requote.url);
    console.log(`PI requote: ${requote.reference} → ${requote.url} (toast: ${requote.toast})`);
  });
});

// Own quotes (Model copies), so closing one can't take the chain's quote away from later steps.
test.describe('PI - Quote lifecycle', { tag: ['@flow', '@pi-flow'] }, () => {
  // Declined, Not Taken Up and Lost are each an end state of a quote (the other two are no longer offered after one of them), so
  // each test closes a Model copy of its own: the quote made from the submission is never touched.

  // ⋮ → Declined → Decline Reason + description → Decline
  test('Decline', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    test.setTimeout(10 * 60_000);
    const copy = await createPiModelCopy(page);
    const quote = new QuotePage(page);
    await quote.open(copy.url);
    await quote.closeQuote('Declined', piDecline.reason, piDecline.description);
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // Not Taken Up is offered on an issued quote: its own ⋮ → Model copy → Get Price → Issue Quote, one test each, then Not Taken Up
  test('Not Taken Up - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote'); // the copy goes the way the quote it copies went
    test.setTimeout(10 * 60_000);
    const copy = await createPiModelCopy(page);
    chain.ntuQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Not Taken Up - Get Pricing', async ({ page }) => {
    steps.needs('Not Taken Up - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    await new QuotePage(page).open(chain.ntuQuoteUrl);
    await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  });

  test('Not Taken Up - Issue Quote', async ({ page }) => {
    steps.needs('Not Taken Up - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.ntuQuoteUrl, piSections.riskSection, piTask.assignee);
  });

  // The quote then shows the status "Not Taken Up" and "This risk was marked as … The reason recorded was '…'" (the ⋮ menu keeps
  // listing every action, so it proves nothing). The reason is the first one the list offers.
  test('Not Taken Up', async ({ page }, testInfo) => {
    steps.needs('Not Taken Up - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No issued Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.ntuQuoteUrl);
    await quote.closeQuote('Not Taken Up', undefined, piNotTakenUp.description);
    const notice = await quote.expectMarkedAs(chain.ntuQuoteUrl, 'Not Taken Up');
    testInfo.annotations.push({ type: 'quote', description: notice });
  });

  // Mark as Lost is offered on an issued quote: its own ⋮ → Model copy → Get Price → Issue Quote, one test each, then Mark as Lost
  test('Mark as Lost - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote'); // the copy goes the way the quote it copies went
    test.setTimeout(10 * 60_000);
    const copy = await createPiModelCopy(page);
    chain.lostQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Mark as Lost - Get Pricing', async ({ page }) => {
    steps.needs('Mark as Lost - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    await new QuotePage(page).open(chain.lostQuoteUrl);
    await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  });

  test('Mark as Lost - Issue Quote', async ({ page }) => {
    steps.needs('Mark as Lost - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.lostQuoteUrl, piSections.riskSection, piTask.assignee);
  });

  // The quote then shows the status "Lost" and "This risk was marked as … The reason recorded was '…'" (the ⋮ menu keeps
  // listing every action, so it proves nothing). The reason is the first one the list offers.
  test('Mark as Lost', async ({ page }, testInfo) => {
    steps.needs('Mark as Lost - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No issued Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.lostQuoteUrl);
    await quote.markAsLost(piLost.description);
    const notice = await quote.expectMarkedAs(chain.lostQuoteUrl, 'Lost');
    testInfo.annotations.push({ type: 'quote', description: notice });
  });
});


// In order: the reversal undoes the endorsement made by "MTA - GE Pricing".
test.describe('PI - Policy', { tag: ['@flow', '@pi-flow'] }, () => {
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
    const statuses = await docs.expectAllDocumentsCompleted();
    testInfo.annotations.push({ type: 'documents', description: `${statuses.length} completed` });
  });

  // General Endorsement, one test per step: endorsement quote → Get Price → Issue → Take Up Endorsement (Policy
  // Conversion) → Confirm Endorsement. PI_ENDORSEMENT_URL carries on from an endorsement quote already started (one endorsement per
  // policy at a time), PI_ENDORSED_POLICY_URL from an endorsed policy.
  test('MTA - GE - Endorsement Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // a Bound policy is all it needs (its documents may still have failed)
    test.setTimeout(10 * 60_000);
    test.skip(!!pi.env('ENDORSEMENT_URL') || !!pi.env('ENDORSED_POLICY_URL'), 'An existing endorsement is used (PI_ENDORSEMENT_URL / _ENDORSED_POLICY_URL)');
    test.skip(!chain.policyUrl, 'No Bound policy');
    const endorsement = await startEndorsement(page, chain.policyUrl, piEndorsement);
    chain.endorsementUrl = endorsement.url;
    testInfo.annotations.push({ type: 'quote', description: endorsement.reference });
  });

  test('MTA - GE - Get Pricing', async ({ page }) => {
    steps.needs('MTA - GE - Endorsement Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!pi.env('ENDORSED_POLICY_URL'), 'PI_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await priceEndorsement(page, chain.endorsementUrl, piSections.riskSection);
  });

  test('MTA - GE - Issue Quote', async ({ page }) => {
    steps.needs('MTA - GE - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!pi.env('ENDORSED_POLICY_URL'), 'PI_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await issueEndorsement(page, chain.endorsementUrl, piSections.riskSection);
  });

  test('MTA - GE - Take Up Endorsement', async ({ page }, testInfo) => {
    steps.needs('MTA - GE - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!pi.env('ENDORSED_POLICY_URL'), 'PI_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    const endorsed = await takeUpEndorsement(page, chain.endorsementUrl, piSections.riskSection);
    chain.endorsementConvertedUrl = endorsed.url;
    testInfo.annotations.push({ type: 'policy', description: endorsed.reference });
  });

  test('MTA - GE - Confirm Endorsement', async ({ page }) => {
    steps.needs('MTA - GE - Take Up Endorsement');
    test.setTimeout(5 * 60_000);
    const endorsedUrl = chain.endorsementConvertedUrl || pi.env('ENDORSED_POLICY_URL');
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
    await docs.expectAllDocumentsCompleted();
  });
  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    if (!chain.endorsedPolicyUrl) steps.needs('MTA - GE - Confirm Endorsement');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.endorsedPolicyUrl, 'No endorsed policy (MTA - GE Pricing and Confirm Endorsement did not complete)');
    await reverseEndorsement(page, chain.endorsedPolicyUrl, piEndorsement.reasonDescription);
  });
});


// Renewal: a Bound New Business policy of its own (a Model copy of the quote made from the submission, taken through the same
// operations), renewed, and the renewal quote taken through the same steps as a new one, one test per operation.
// PI_RENEWAL_BASE_POLICY_URL renews an existing Bound policy, PI_RENEWAL_QUOTE_URL carries on from an existing renewal quote,
// PI_RENEWAL_POLICY_URL from an existing Bound renewal policy.
test.describe('PI - Renewal', { tag: ['@flow', '@pi-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const renewalPolicyGiven = !!pi.env('RENEWAL_POLICY_URL');

  // The renewal's own Bound New Business policy, made the way the main one is: ⋮ → Model copy of the quote made from the submission →
  // Get Price → Issue Quote → Taken Up + Policy Conversion → Confirm Cover, one test each
  test('Renewal - Base - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no renewal either
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!!pi.env('RENEWAL_BASE_POLICY_URL') || !!pi.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    const copy = await createPiModelCopy(page);
    chain.renewalBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Renewal - Base - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Base - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!!pi.env('RENEWAL_BASE_POLICY_URL') || !!pi.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await new QuotePage(page).open(chain.renewalBaseQuoteUrl);
    await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  });

  test('Renewal - Base - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Base - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!!pi.env('RENEWAL_BASE_POLICY_URL') || !!pi.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.renewalBaseQuoteUrl, piSections.riskSection, piTask.assignee);
  });

  test('Renewal - Base - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Base - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!!pi.env('RENEWAL_BASE_POLICY_URL') || !!pi.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalBaseQuoteUrl);
    await quote.takeUp([piSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PI Renewal Base Policy', policy.reference, policy.url);
  });

  test('Renewal - Base - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Base - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!!pi.env('RENEWAL_BASE_POLICY_URL') || !!pi.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
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
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!!pi.env('RENEWAL_QUOTE_URL'), 'PI_RENEWAL_QUOTE_URL is set');
    test.skip(!chain.renewalBasePolicyUrl, 'No Bound policy to renew');
    const policy = new PolicyPage(page);
    await policy.open(chain.renewalBasePolicyUrl);
    await policy.renew();
    const renewal = await policy.saveRenewal();
    chain.renewalQuoteUrl = renewal.url;
    testInfo.annotations.push({ type: 'quote', description: renewal.reference });
    await recordContract('PI Renewal Quote', renewal.reference, renewal.url);
  });

  test('Renewal - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Renew Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await new QuotePage(page).open(chain.renewalQuoteUrl);
    await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  });

  test('Renewal - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await issueWithSelfApproval(page, chain.renewalQuoteUrl, piSections.riskSection, piTask.assignee);
  });

  // ⋮ → Taken Up (on a renewal: "Quote Taken Up") reaches the unsaved Policy Conversion; nothing is saved yet (see "Quote Taken up")
  test('Renewal - Quote Taken up', async ({ page }) => {
    steps.needs('Renewal - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([piSections.riskSection]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  test('Renewal - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Quote Taken up');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([piSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalConvertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PI Renewal Policy', policy.reference, policy.url);
  });

  test('Renewal - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'PI_RENEWAL_POLICY_URL is set');
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
    await docs.expectAllDocumentsCompleted();
  });

  // General Endorsement on the Bound renewal policy. PI_RENEWAL_ENDORSEMENT_URL carries on from an endorsement quote already started.
  test('Renewal - MTA - GE Pricing and Confirm Endorsement', async ({ page }) => {
    if (!chain.renewalPolicyUrl) steps.needs('Renewal - Confirm Cover');
    test.setTimeout(15 * 60_000);
    test.skip(!chain.renewalPolicyUrl, 'No Bound renewal policy');
    const resume = { endorsementUrl: pi.env('RENEWAL_ENDORSEMENT_URL') };
    chain.renewalEndorsedPolicyUrl = (await endorsePolicy(page, chain.renewalPolicyUrl, piSections.riskSection, piEndorsement, resume)).endorsedPolicyUrl;
  });

  test('Renewal - MTA - GE Documents - Generation', async ({ page }) => {
    steps.needs('Renewal - MTA - GE Pricing and Confirm Endorsement');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.renewalEndorsedPolicyUrl, 'No endorsement on the renewal policy');
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(chain.renewalEndorsedPolicyUrl);
    await docs.expectAllDocumentsCompleted();
  });
});


// Cancellations are New Business only. Each needs its own Bound policy (quote → policy → cancellation), made from a Model copy;
// PI_CANCEL_POLICY_URL reuses an existing Bound policy while debugging.
test.describe('PI - Cancellation', { tag: ['@flow', '@pi-flow'] }, () => {
  // Mid Term Cancellation on a Bound policy of its own (a Model copy of the quote made from the submission, taken through the same
  // operations, one test each), then the cancellation MTA one step at a time, its documents, and Reinstate Policy on it.
  // PI_CANCEL_POLICY_URL cancels an existing Bound policy instead, PI_CANCEL_MTA_URL / _REINSTATE_MTA_URL carry on from existing MTAs.
  test('MTC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!pi.env('CANCEL_POLICY_URL') || !!pi.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PI_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    const copy = await createPiModelCopy(page);
    chain.mtcBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('MTC - Get Pricing', async ({ page }) => {
    steps.needs('MTC - Model Quote');
    test.setTimeout(12 * 60_000);
    test.skip(!!pi.env('CANCEL_POLICY_URL') || !!pi.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PI_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await new QuotePage(page).open(chain.mtcBaseQuoteUrl);
    await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
  });

  test('MTC - Issue Quote', async ({ page }) => {
    steps.needs('MTC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!pi.env('CANCEL_POLICY_URL') || !!pi.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PI_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.mtcBaseQuoteUrl, piSections.riskSection, piTask.assignee);
  });

  test('MTC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('MTC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!pi.env('CANCEL_POLICY_URL') || !!pi.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PI_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.mtcBaseQuoteUrl);
    await quote.takeUp([piSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.mtcBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('PI MTC Policy', policy.reference, policy.url);
  });

  test('MTC - Confirm Cover', async ({ page }) => {
    steps.needs('MTC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!pi.env('CANCEL_POLICY_URL') || !!pi.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (PI_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.mtcBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.mtcBasePolicyUrl = chain.mtcBaseConvertedUrl;
  });

  // ⋮ Mid Term Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // PI_CANCEL_MTA_URL carries on from an MTA that already exists.
  test('MTA - Mid Term Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.mtcBasePolicyUrl) steps.needs('MTC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!pi.env('CANCEL_MTA_URL'), 'PI_CANCEL_MTA_URL is set');
    test.skip(!chain.mtcBasePolicyUrl, 'No Bound base policy');
    chain.mtcBaseMtaUrl = await startMidTermCancellationMta(page, chain.mtcBasePolicyUrl, piCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.mtcBaseMtaUrl });
  });

  test('MTA - Mid Term Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.mtcBaseMtaUrl) steps.needs('MTA - Mid Term Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.mtcBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.mtcBaseMtaUrl, piSections.riskSection);
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
    await docs.expectAllDocumentsCompleted();
  });

  // ⋮ Reinstate Contract on the cancellation MTA → Save creates the next MTA (…/MTA002); the backend prices and confirms it, so the
  // outcome is checked (policy Bound again, "Reinstate Contract" in the Endorsement grid, the actions of a live policy)
  test('Reinstate Policy', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Confirm Cancellation');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.mtcBaseConfirmed, 'The cancellation was not confirmed');
    await reinstatePolicy(page, chain.mtcBaseMtaUrl, piReinstatement, pi.env('REINSTATE_MTA_URL'));
  });

});
