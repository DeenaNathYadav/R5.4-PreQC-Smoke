import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { businessAction, listActions } from '../../src/pages/advantagego/entity';
import { cancelPolicyMidTerm, endorsePolicy, reinstatePolicy } from '../../src/flows/endorsePolicy';
import { createBoundPolicy, issueWithSelfApproval, takeUpAndBind } from '../../src/flows/quoteToPolicy';
import { env } from '../../src/config/env';
import { pi } from '../../src/products/pi';
import { piDecline, piDocument, piEndorsement, piMidTermCancellation, piReinstatement, piQuote, piCommission, piSections, piSubmission, piSubmissionDetails, piTask } from '../../src/products/pi/data';
import { createPiQuote, piLifecycle } from '../../src/products/pi/flows';
import { PiSectionsPage } from '../../src/products/pi/PiSectionsPage';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { NewSubmissionPage } from '../../src/pages/advantagego/NewSubmissionPage';
import { SubmissionPage } from '../../src/pages/advantagego/SubmissionPage';
import { QuoteSectionsPage, readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { IssueOutcome, QuotePage } from '../../src/pages/advantagego/QuotePage';
import { recordContract } from '../../src/support/contracts';

// The bound policy: created by "Quote Taken up…" below, or an existing one (PI_POLICY_URL) for the policy rows alone
let policyUrl: string = pi.env('POLICY_URL');

// One test per row of the "PI" sheet in "AXA R5.4 - CMBC-MTP-Fleet Smoke.xlsx".
// test.fixme = not automated yet (reported as skipped). Remove it as each flow is implemented.

// Serial: each step builds on the submission/quote created by the previous one.
test.describe.serial('PI - Quote', { tag: ['@smoke', '@pi-flow'] }, () => {
  let submissionId: number;
  let submissionReference = '';
  let quoteReference = '';
  // PI_QUOTE_URL lets quote-level steps run alone against an existing quote (e.g. -g "Get Pricing")
  let quoteUrl: string = pi.env('QUOTE_URL');

  // When steps run alone on an existing quote (PI_QUOTE_URL) the references weren't captured by the creating steps
  const ensureReferences = async (page: Page) => {
    if (quoteReference) return;
    await new QuotePage(page).open(quoteUrl);
    quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
    submissionReference = quoteReference.slice(0, 11); // RSK00038356 01 Q001 → RSK00038356
  };

  // PI_TEMPLATE_QUOTE_URL = an issued quote to copy with ⋮ → Model instead of creating a submission and converting it
  const template = pi.env('TEMPLATE_QUOTE_URL');

  test('Create Quote (Model copy of the template quote)', async ({ page }, testInfo) => {
    test.skip(!template, 'PI_TEMPLATE_QUOTE_URL is not set: the quote is created through Create Submission + Convert to Quote');
    const copy = await new QuotePage(page).modelCopy(template);
    quoteUrl = copy.url;
    quoteReference = copy.reference;
    submissionReference = copy.reference.slice(0, 11);
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
    await recordContract('Quote (Model copy)', copy.reference, copy.url);
    console.log(`PI quote created (Model copy): ${copy.reference} → ${copy.url}`);
  });

  // Always run (one smoke test of New Submission → Convert to Quote). With a template the chain below carries on with the
  // Model copy, so this submission and its quote are not used by the later steps.
  test('Create Submission', async ({ page }, testInfo) => {
    const newSubmission = new NewSubmissionPage(page);
    await newSubmission.open();
    await newSubmission.fill(piSubmission());
    const { reference, contractId } = await newSubmission.submit();
    submissionId = contractId;
    if (!template) submissionReference = reference;
    testInfo.annotations.push({ type: 'submission', description: `${reference} (${contractId})` });
    await recordContract('Submission', reference, `/ui/Submission/Edit/${contractId}`);
    console.log(`PI submission created: ${reference} → /ui/Submission/Edit/${contractId}`);

    // Required by Convert to Quote but not asked for on the New Submission form
    const submission = new SubmissionPage(page);
    await submission.open(submissionId);
    await submission.completeDetails(piSubmissionDetails);
  });

  test('Convert to Quote', async ({ page }, testInfo) => {
    const submission = new SubmissionPage(page);
    await submission.open(submissionId);
    const quote = await submission.convertToQuote(piQuote);
    if (!template) {
      quoteUrl = quote.url;
      quoteReference = quote.reference;
    }
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    await recordContract('Quote', quote.reference, quote.url);
    console.log(`PI quote created: ${quote.reference} → ${quote.url}`);
  });

  let issueOutcome: IssueOutcome | undefined;
  let quoteIssued = false;

  test('Get Pricing', async ({ page }, testInfo) => {
    const sections = new PiSectionsPage(page);
    await sections.open(quoteUrl);
    if (!template) {
      await sections.addRiskSection(piSections.riskSection);
      await sections.fillPiRiskDetails(piSections);
      await sections.saveExpectingValidation(); // limit & excess missing → coverage nodes appear
      await sections.setLimitAndExcess(piSections.limitAndExcess);
      await sections.save();
    } // a Model copy already carries the risk section, activities, income and limit & excess

    // Pass = "Price is returned back from the rating engine" success toast
    await sections.getPrice([piSections.riskSection]);

    const premium = await readPremium(page, quoteUrl);
    expect(premium.policyPeriodGross, 'Policy Period Premium Gross of Comm. & IPT').toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
    console.log(`PI premium: ${JSON.stringify(premium)}`);
  });

  // PI is not eligible for ⋮ → Get Commission: the Broker Commission deduction is added manually (+ in Commission).
  // Next Stage → Issue Quote need this Broker Commission row. It is only kept once the quote has its risk
  // sections, so this runs after "Get Pricing" (Issue Quote re-prices when commission changed the premium).
  test('Get Commission', async ({ page }) => {
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    if (!template) await quote.addBrokerCommission(piCommission.brokerPercent); // a Model copy already has the 12% row
    await quote.expectBrokerCommission();
  });

  test('Quote create task', async ({ page }) => {
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.createTask(piTask);
    expect(await quote.taskStatus(quoteUrl, piTask.taskType, piTask.subject)).toBe('Not Started');

    // Close the task again: card ⋮ → Complete
    await quote.approveTask(quoteUrl, piTask.taskType, 'Complete', piTask.subject);
    await expect
      .poll(() => quote.taskStatus(quoteUrl, piTask.taskType, piTask.subject), { timeout: 60_000, intervals: [3_000] })
      .toBe('Completed');
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    const docs = new QuoteDocumentsPage(page);
    await docs.open(quoteUrl);
    await docs.attachAutomaticTerms(); // automatic wording
    const title = await docs.upload(piDocument); // manual upload

    const file = await docs.download(title);
    // The app adds "(2)", "(3)"… to the name when a document with the same name was uploaded before
    expect(file.fileName).toMatch(/^pi-smoke-doc(\(\d+\))?\.pdf$/);
    expect(file.size, 'downloaded bytes').toBe(fs.statSync(piDocument.filePath).size);
    await docs.expectDownloadedOn(title);

    // "Generate Document" only appears once the quote is issued (Quoted stage)
    if (issueOutcome === 'issued') {
      await docs.open(quoteUrl);
      await docs.generateDocuments();
    }
  });

  test('Quote History Check and Link Tasks & License', async ({ page }) => {
    await ensureReferences(page);
    const quote = new QuotePage(page);

    await quote.openHistoryTab(quoteUrl, 'Timeline');
    await expect(page.getByText('UpdateQuote', { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Price', { exact: true }).locator('visible=true').first()).toBeVisible();

    await quote.openHistoryTab(quoteUrl, 'Links');
    if (template) {
      // A Model copy has no submission link: the Links tab lists the quote itself as the Original
      await expect(page.getByText(quoteReference, { exact: true }).locator('visible=true').first()).toBeVisible();
      await expect(page.getByText('Original', { exact: true }).locator('visible=true').first()).toBeVisible();
    } else {
      // the submission this quote was converted from
      await expect(page.getByText(submissionReference, { exact: true }).locator('visible=true').first()).toBeVisible();
      await expect(page.getByText('Converted', { exact: true }).locator('visible=true').first()).toBeVisible();
    }

    // Tasks raised on the quote (the Licence Referral task is checked in "License Check - Task Generation")
    expect(await quote.taskStatus(quoteUrl, piTask.taskType, piTask.subject)).toBe('Completed');

    await quote.openHistoryTab(quoteUrl, 'Licence');
    await expect(page.getByText('Risk Audit Trail', { exact: true }).locator('visible=true').first()).toBeVisible();
  });

  test('Search / Advance Search', async ({ page }) => {
    await ensureReferences(page);
    const search = new SearchPage(page);
    await search.open();
    await search.search(quoteReference);
    await search.expectResultCount('Quotes', 1);

    // The results panel occasionally doesn't render after Apply (the filter chip shows but no groups), so retry the whole search
    await expect(async () => {
      await search.open();
      await search.selectCategory('Risk-Quote');
      await search.search(quoteReference);
      await search.openAdvancedFilters();
      await search.fillAdvancedText('Contract Reference', quoteReference);
      await search.applyAdvancedFilters();
      await search.expectResultCount('Quotes', 1, 20_000);
    }).toPass({ timeout: 120_000 });
  });

  // Our QC user has a licence level of 0, so issuing raises a Licence Referral task for approval.
  test('License Check - Task Generation', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.nextStage(); // Risk Details → UW Review & Process
    issueOutcome = await quote.issueQuote([piSections.riskSection]);
    if (issueOutcome === 'referred') {
      expect(await quote.taskStatus(quoteUrl, 'Licence Referral')).toBe('Not Started');
    }
  });

  // The Licence Referral is raised for another underwriter, so it is forwarded to the signed-in user and approved from
  // the quote's History → Tasks card (LICENCE_SELF_APPROVE=0 disables that and waits for a real approver instead, up to APPROVAL_WAIT_MINUTES).
  test('Issue Quote', async ({ page }) => {
    const waitMinutes = Number(env('APPROVAL_WAIT_MINUTES', '0'));
    test.setTimeout((waitMinutes + 12) * 60_000);
    const quote = new QuotePage(page);
    await ensureReferences(page);
    // Run alone on an existing quote (PI_QUOTE_URL) the licence check didn't run here: assume it raised the referral
    if (!issueOutcome && pi.env('QUOTE_URL')) issueOutcome = 'referred';

    if (issueOutcome === 'referred') {
      if (env('LICENCE_SELF_APPROVE') !== '0' && (await quote.taskStatus(quoteUrl, 'Licence Referral')) === 'Not Started') {
        await quote.forwardTask(quoteUrl, 'Licence Referral', piTask.assignee);
        await quote.approveTask(quoteUrl, 'Licence Referral');
        // The status takes a few seconds to change after Approve
        await expect
          .poll(() => quote.taskStatus(quoteUrl, 'Licence Referral'), { timeout: 120_000, intervals: [5_000] })
          .toBe('Approved');
      }

      const deadline = Date.now() + waitMinutes * 60_000;
      let status = await quote.taskStatus(quoteUrl, 'Licence Referral');
      while (status !== 'Approved' && Date.now() < deadline) {
        await page.waitForTimeout(30_000);
        status = await quote.taskStatus(quoteUrl, 'Licence Referral');
      }
      test.skip(status !== 'Approved', `Licence Referral is "${status}" - awaiting approval (set APPROVAL_WAIT_MINUTES to wait)`);

      await quote.open(quoteUrl);
      expect(await quote.issueQuote([piSections.riskSection])).toBe('issued');
    }
    await quote.waitForDocumentGeneration(quoteUrl); // the record is view-only while documents are generated
    quoteIssued = true;
  });

  // Taken Up / Requote / Multi-Quote need an issued quote (Licence Referral approved by a Level 2/3 underwriter).
  // Taken Up → Policy Conversion → Save (policy created) → Confirm Cover (Bound). Needs the quote issued by the step above.
  test('Quote Taken up and conversion to Policy', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    test.skip(!quoteIssued && !pi.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.takeUp([piSections.riskSection]);

    const policyPage = new PolicyPage(page);
    const policy = await policyPage.saveConversion();
    policyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('Policy', policy.reference, policy.url);
    console.log(`PI policy created: ${policy.reference} → ${policy.url}`);
    await policyPage.confirmCover();

    // The policy documents (schedule, covering letter, drafts) are generated in the background: all must end Completed
    const docs = new QuoteDocumentsPage(page, 'Policy');
    await docs.open(policy.url);
    const statuses = await docs.expectAllDocumentsCompleted();
    console.log(`PI policy documents: ${statuses.length} completed`);
  });
  test.fixme('MultiQuote / Requote', async () => {});
});

// Own quote, so a decline can't take the chain's quote away from later steps (and an earlier failure can't skip it).
test.describe('PI - Quote lifecycle', { tag: ['@smoke', '@pi-flow'] }, () => {
  // Needs a quote of its own: declining ends the chain's quote, which later steps still use.
  test('Decline / Not Taken up / Mark as Lost', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const { url } = await createPiQuote(page);
    const quote = new QuotePage(page);
    await quote.open(url);
    await quote.closeQuote('Declined', piDecline.reason, piDecline.description);
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  });
});


test.describe('PI - Policy', { tag: ['@smoke', '@pi-flow'] }, () => {
  // Policy → General Endorsement → fill the Endorsement section → Save (creates the endorsement quote) → Get Price.
  // PI_ENDORSEMENT_URL prices an existing endorsement quote instead of starting a new one (one endorsement per policy at a time).
  test('MTA - GE Pricing', async ({ page }) => {
    test.setTimeout(15 * 60_000);
    const resume = { endorsementUrl: pi.env('ENDORSEMENT_URL'), endorsedPolicyUrl: pi.env('ENDORSED_POLICY_URL') };
    test.skip(!policyUrl && !resume.endorsementUrl && !resume.endorsedPolicyUrl, 'No bound policy (Taken Up did not run; set PI_POLICY_URL to use an existing one)');
    await endorsePolicy(page, policyUrl, piSections.riskSection, piEndorsement, resume);
  });
  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
  test.fixme('MTA - Reversal', async () => {});
});


// Renewal: needs a Bound New Business policy of its own (not the one the endorsement used), made from a Model copy of the
// template quote. PI_RENEWAL_BASE_POLICY_URL reuses an existing Bound policy instead.
test.describe('PI - Renewal', { tag: ['@smoke', '@pi-flow'] }, () => {
  test('Renewals - Pricing/License/Task, then endorsement on the renewal policy', async ({ page }, testInfo) => {
    test.setTimeout(20 * 60_000);
    const template = piLifecycle.templateQuoteUrl;
    test.skip(!template && !pi.env('RENEWAL_BASE_POLICY_URL') && !pi.env('RENEWAL_POLICY_URL'), 'PI_TEMPLATE_QUOTE_URL is not set');
    // PI_RENEWAL_POLICY_URL resumes at the endorsement on an existing Bound renewal policy
    if (pi.env('RENEWAL_POLICY_URL')) {
      await endorsePolicy(page, pi.env('RENEWAL_POLICY_URL'), piSections.riskSection, piEndorsement, {
        endorsementUrl: pi.env('RENEWAL_ENDORSEMENT_URL'), // resumes from an endorsement quote already started on it
      });
      return;
    }

    let basePolicyUrl = pi.env('RENEWAL_BASE_POLICY_URL');
    // (not needed when resuming from an existing renewal quote)
    if (!basePolicyUrl && !pi.env('RENEWAL_QUOTE_URL')) {
      const copy = await new QuotePage(page).modelCopy(template);
      await recordContract('Quote (Model copy)', copy.reference, copy.url);
      await new QuoteSectionsPage(page).open(copy.url);
      await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
      await issueWithSelfApproval(page, copy.url, piSections.riskSection, piTask.assignee);
      const policy = await takeUpAndBind(page, copy.url, piSections.riskSection, 'Base Policy');
      basePolicyUrl = policy.url;
      testInfo.annotations.push({ type: 'base policy', description: policy.reference });
      console.log(`PI renewal base policy: ${policy.reference} → ${policy.url}`);
    }

    // Renew the Bound policy → Save the renewal quote. PI_RENEWAL_QUOTE_URL resumes from an existing renewal quote.
    let renewalUrl = pi.env('RENEWAL_QUOTE_URL');
    if (!renewalUrl) {
      const policyPage = new PolicyPage(page);
      await policyPage.open(basePolicyUrl);
      await policyPage.renew();
      const renewal = await policyPage.saveRenewal();
      renewalUrl = renewal.url;
      await recordContract('Renewal Quote', renewal.reference, renewal.url);
      testInfo.annotations.push({ type: 'renewal quote', description: renewal.reference });
      console.log(`PI renewal quote: ${renewal.reference} → ${renewal.url}`);
    }

    // The renewal quote goes the same way as a new one: price → issue (approval) → take up → Bound renewal policy
    await new QuotePage(page).open(renewalUrl);
    await new QuoteSectionsPage(page).getPrice([piSections.riskSection]);
    await issueWithSelfApproval(page, renewalUrl, piSections.riskSection, piTask.assignee);
    const renewalPolicy = await takeUpAndBind(page, renewalUrl, piSections.riskSection, 'Renewal Policy');
    testInfo.annotations.push({ type: 'renewal policy', description: renewalPolicy.reference });
    console.log(`PI renewal policy: ${renewalPolicy.reference} → ${renewalPolicy.url}`);

    // …and the General Endorsement on the same renewal policy
    await endorsePolicy(page, renewalPolicy.url, piSections.riskSection, piEndorsement);
  });
});


// Cancellations are New Business only. Each needs its own Bound policy (quote → policy → cancellation), made from a Model copy;
// PI_CANCEL_POLICY_URL reuses an existing Bound policy while debugging.
test.describe('PI - Cancellation', { tag: ['@smoke', '@pi-flow'] }, () => {
  test('MTA - Mid Term Cancellation and Reinstate Policy', async ({ page }, testInfo) => {
    test.setTimeout(20 * 60_000);
    test.skip(!pi.env('TEMPLATE_QUOTE_URL') && !pi.env('CANCEL_POLICY_URL'), 'PI_TEMPLATE_QUOTE_URL is not set');
    let cancelPolicyUrl = pi.env('CANCEL_POLICY_URL');
    if (!cancelPolicyUrl) {
      const policy = await createBoundPolicy(page, piLifecycle);
      cancelPolicyUrl = policy.url;
      testInfo.annotations.push({ type: 'policy', description: policy.reference });
      console.log(`PI cancellation policy: ${policy.reference} → ${policy.url}`);
    }

    const cancellationUrl = await cancelPolicyMidTerm(
      page,
      cancelPolicyUrl,
      piSections.riskSection,
      piMidTermCancellation,
      pi.env('CANCEL_MTA_URL'),
    );
    console.log(`PI cancellation MTA: ${cancellationUrl}`);

    // Reinstate the same cancelled policy
    const reinstatementUrl = await reinstatePolicy(
      page,
      cancellationUrl,
      piReinstatement,
      pi.env('REINSTATE_MTA_URL'),
    );
    console.log(`PI reinstatement MTA: ${reinstatementUrl}`);
  });
});
