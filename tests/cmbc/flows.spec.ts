import fs from 'fs';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyMidTerm, endorsePolicy, reinstatePolicy } from '../../src/products/cmbc/flows/policy';
import { createBoundPolicy, createCmbcModelCopy, issueWithSelfApproval, priceQuote, takeUpAndBind } from '../../src/products/cmbc/flows/quote';
import { cmbc } from '../../src/products/cmbc';
import { CmbcSectionsPage } from '../../src/products/cmbc/CmbcSectionsPage';
import {
  cmbcAssignee,
  cmbcCancellation,
  cmbcDocument,
  cmbcEndorsement,
  cmbcQuote,
  cmbcReinstatement,
  cmbcScheduleFile,
  cmbcSections,
  cmbcSubmission,
  cmbcSubmissionDetails,
} from '../../src/products/cmbc/data';
import { NewSubmissionPage } from '../../src/pages/advantagego/NewSubmissionPage';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../src/pages/advantagego/QuotePage';
import { readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { SubmissionPage } from '../../src/pages/advantagego/SubmissionPage';
import { recordContract } from '../../src/support/contracts';

const cmbcPremiumGrossLabel = 'Policy Period Premium Gross of Comm. & Net of IPT';
let policyUrl = cmbc.env('POLICY_URL');

test.describe.serial('CMBC - Submission, conversion and schedule', { tag: ['@smoke', '@cmbc-flow'] }, () => {
  let quoteUrl = '';

  test('Convert to Quote with PDBI and Liability child sections', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const newSubmission = new NewSubmissionPage(page);
    await newSubmission.open();
    await newSubmission.fill(cmbcSubmission());
    const submission = await newSubmission.submit();
    await recordContract('CMBC Submission', submission.reference, `/ui/Submission/Edit/${submission.contractId}`);

    const submissionPage = new SubmissionPage(page);
    await submissionPage.open(submission.contractId);
    await submissionPage.completeDetails(cmbcSubmissionDetails);
    const quote = await submissionPage.convertToQuote(cmbcQuote);
    quoteUrl = quote.url;
    await recordContract('CMBC Quote', quote.reference, quote.url);
    testInfo.annotations.push({ type: 'quote', description: quote.reference });

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
    testInfo.annotations.push({
      type: 'section validation',
      description: (await page.locator('text=/Please enter|Error\\(s\\)/').allInnerTexts()).join(' | '),
    });

    // CMBC commission comes from the Commission connector (⋮ → Get Commission), not manual entry
    const rejected = await new QuotePage(page).getCommission();
    if (rejected.length) testInfo.annotations.push({ type: 'commission not rated', description: rejected.join(', ') });

    await sections.save();
    await sections.open(quoteUrl);
    await sections.expectCmbcStructure(cmbcSections);
    if (cmbc.env('PAUSE')) await page.pause();
  });
});

test.describe.serial('CMBC - Quote operations', { tag: ['@smoke', '@cmbc-flow'] }, () => {
  let quoteUrl = cmbc.env('QUOTE_URL');
  let quoteReference = '';

  test('Create working quote from reference model', async ({ page }, testInfo) => {
    test.skip(!!quoteUrl, 'CMBC_QUOTE_URL is set');
    const copy = await createCmbcModelCopy(page);
    quoteUrl = copy.url;
    quoteReference = copy.reference;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('Insert schedule with geocoding and peril score', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const sections = new CmbcSectionsPage(page);
    await sections.open(quoteUrl);
    await sections.importCmbcSchedule(cmbcScheduleFile);
  });

  test('Get Commission', async ({ page }, testInfo) => {
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    const rejected = await quote.getCommission();
    if (rejected.length) testInfo.annotations.push({ type: 'commission not rated', description: rejected.join(', ') });
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    // CMBC only offers ⋮ → Get Price from UW Review & Process onwards
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.nextStage();
    const sections = new CmbcSectionsPage(page);
    await sections.open(quoteUrl);
    await sections.expectCmbcStructure(cmbcSections);
    await sections.getPrice([cmbcSections.riskSections[0]]);
    const premium = await readPremium(page, quoteUrl, cmbcPremiumGrossLabel);
    expect(premium.policyPeriodGross).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote Terms and document upload/download', async ({ page }) => {
    const docs = new QuoteDocumentsPage(page);
    await docs.open(quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(cmbcDocument);
    const file = await docs.download(title);
    expect(file.size).toBe(fs.statSync(cmbcDocument.filePath).size);
    await docs.expectDownloadedOn(title);
  });

  test('Search / Advance search Quote', async ({ page }) => {
    if (!quoteReference) {
      await new QuotePage(page).open(quoteUrl);
      quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
    }
    const search = new SearchPage(page);
    await search.open();
    await search.search(quoteReference);
    await search.expectResultCount('Quotes', 1);
    await search.open();
    await search.selectCategory('Risk-Quote');
    await search.search(quoteReference);
    await search.openAdvancedFilters();
    await search.fillAdvancedText('Contract Reference', quoteReference);
    await search.applyAdvancedFilters();
    await search.expectResultCount('Quotes', 1);
  });

  test('Issue Quote', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    await issueWithSelfApproval(page, quoteUrl, cmbcSections.riskSections[0], cmbcAssignee);
  });

  test('Taken up quote', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const policy = await takeUpAndBind(page, quoteUrl, cmbcSections.riskSections[0], 'CMBC Policy');
    policyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
  });

  test.fixme('Requote', async () => {});
  test.fixme('Multi-Quote', async () => {});
  test.fixme('Documents/datalake payload generation', async () => {});
  test.fixme('Data lake pricing/quote/schedule', async () => {});
  test.fixme('Check ALS and server folder payloads', async () => {});
  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

test.describe('CMBC - Policy operations', { tag: ['@smoke', '@cmbc-flow'] }, () => {
  test('General endorsement through take-up and MTA pricing', async ({ page }) => {
    test.setTimeout(18 * 60_000);
    test.skip(!policyUrl && !cmbc.env('ENDORSEMENT_URL'), 'No CMBC policy or endorsement URL is available');
    await endorsePolicy(
      page,
      policyUrl,
      cmbcSections.riskSections[0],
      cmbcEndorsement,
      { endorsementUrl: cmbc.env('ENDORSEMENT_URL') },
    );
  });

  test('Renewals - Pricing', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const basePolicy = await createBoundPolicy(page);
    const policy = new PolicyPage(page);
    await policy.open(basePolicy.url);
    await policy.renew({ expectSchedules: true });
    const renewal = await policy.saveRenewal();
    await recordContract('CMBC Renewal Quote', renewal.reference, renewal.url);
    await priceQuote(page, renewal.url, { geocodeFirst: true }); // starts at Risk Details (no Get Price there) and its schedule is not geocoded
    await issueWithSelfApproval(page, renewal.url, cmbcSections.riskSections[0], cmbcAssignee);
    await takeUpAndBind(page, renewal.url, cmbcSections.riskSections[0], 'CMBC Renewal Policy');
  });

  test('MTA - Mid Term Cancellation Policy - Pricing and Reinstate Policy', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    const basePolicyUrl = cmbc.env('CANCEL_POLICY_URL') || (await createBoundPolicy(page)).url;
    const cancellationUrl = await cancelPolicyMidTerm(
      page,
      basePolicyUrl,
      cmbcSections.riskSections[0],
      cmbcCancellation,
      cmbc.env('CANCEL_MTA_URL'),
    );
    await reinstatePolicy(page, cancellationUrl, cmbcReinstatement, cmbc.env('REINSTATE_MTA_URL'));
  });

  test.fixme('MTA - Inception Cancellation Policy - Pricing', async () => {});
  test.fixme('MTA - Reversal', async () => {});
});
