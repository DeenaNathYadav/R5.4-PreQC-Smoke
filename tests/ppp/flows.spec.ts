import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyMidTerm, endorsePolicy, reinstatePolicy, reverseEndorsement } from '../../src/products/ppp/flows/policy';
import {
  createBoundPolicy,
  createPppModelCopy,
  createPppSubmissionQuote,
  issueWithSelfApproval,
  pppModel,
  priceQuote,
  takeUpAndBind,
} from '../../src/products/ppp/flows/quote';
import { ppp } from '../../src/products/ppp';
import { PppSectionsPage } from '../../src/products/ppp/PppSectionsPage';
import {
  pppAssignee,
  pppCancellation,
  pppCommission,
  pppDecline,
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

// One test per row of the "PPP-Module" sheet in "AXA R5.4 - CMBC-MTP-Fleet Smoke (1).xlsx".
// The first quote is created from a submission (inception today − 10 days) and built up in the "PPP - Quote" chain; every other PPP
// quote is a ⋮ → Model copy of it (there is no fixed reference quote). test.fixme = backend evidence, not automated.
const pppPremiumGrossLabel = 'Policy Period Premium Gross of Comm. & Net of IPT';
let policyUrl = ppp.env('POLICY_URL');

test.describe.serial('PPP - Quote', { tag: ['@flow', '@ppp-flow'] }, () => {
  let quoteUrl = ppp.env('QUOTE_URL');
  let quoteReference = '';
  let quoteIssued = false;
  const ensureReference = async (page: Page) => {
    if (quoteReference) return;
    await new QuotePage(page).open(quoteUrl);
    quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
  };

  // New Submission (inception today − 10 days) → Convert to Quote: the quote the rest of the chain works on, and the model the other
  // PPP quotes are copied from
  test('Convert to Quote', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    test.skip(!!quoteUrl, 'PPP_QUOTE_URL is set');
    const quote = await createPppSubmissionQuote(page);
    quoteUrl = quote.url;
    quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
  });

  // Offering (the first one listed) → PPP risk section; Save lists what the covers still need
  test('Add PPP risk section and covers', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    const { offering, validation } = await new PppSectionsPage(page).addPppSections(quoteUrl, pppSections, pppCommission.brokerPercent);
    testInfo.annotations.push({ type: 'offering', description: offering });
    testInfo.annotations.push({ type: 'section validation', description: validation });
  });

  test('Insert schedule with geocoding and peril score', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const sections = new PppSectionsPage(page);
    await sections.open(quoteUrl);
    await sections.importPppSchedule(pppScheduleFile);
  });

  // PPP is not eligible for ⋮ → Get Commission. Broker Commission is a deduction on Details → Commission: the row defaulted on the
  // quote (checked) gets its Override %
  test('Add Broker Commission', async ({ page }) => {
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.addBrokerCommission(pppCommission.brokerPercent); // existing Broker Commission row → its %, otherwise a row is added with +
    await quote.expectBrokerCommission();
    pppModel.url = quoteUrl; // sections, schedule and commission are on it now: the model the other PPP quotes are copied from
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    await priceQuote(page, quoteUrl);
    const premium = await readPremium(page, quoteUrl, pppPremiumGrossLabel);
    expect(premium.policyPeriodGross, 'Policy Period Premium Gross of Comm. & Net of IPT').toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote create task', async ({ page }) => {
    test.setTimeout(12 * 60_000); // the task status takes minutes to flip on this host
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.createTask(pppTask);
    expect(await quote.taskStatus(quoteUrl, pppTask.taskType, pppTask.subject)).toBe('Not Started');
    // Close the task again: card ⋮ → Complete
    // The Complete click sometimes has no effect (the card stays "Not Started", as with Approve): repeat it, 80 seconds apiece
    await expect(async () => {
      await quote.approveTask(quoteUrl, pppTask.taskType, 'Complete', pppTask.subject);
      await expect
        .poll(() => quote.taskStatus(quoteUrl, pppTask.taskType, pppTask.subject), { timeout: 80_000, intervals: [10_000] })
        .toBe('Completed');
    }).toPass({ timeout: 6 * 60_000 });
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    const docs = new QuoteDocumentsPage(page);
    await docs.open(quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(pppDocument);
    const file = await docs.download(title);
    expect(file.size, 'downloaded bytes').toBe(fs.statSync(pppDocument.filePath).size);
    await docs.expectDownloadedOn(title);
  });

  test('Quote History Check and Link Tasks', async ({ page }) => {
    await ensureReference(page);
    const quote = new QuotePage(page);
    await quote.openHistoryTab(quoteUrl, 'Timeline');
    await expect(page.getByText('UpdateQuote', { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Price', { exact: true }).locator('visible=true').first()).toBeVisible();

    // A Model copy has no submission link: the Links tab lists the quote itself as the Original
    await quote.openHistoryTab(quoteUrl, 'Links');
    await expect(page.getByText(quoteReference, { exact: true }).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Original', { exact: true }).locator('visible=true').first()).toBeVisible();

    expect(await quote.taskStatus(quoteUrl, pppTask.taskType, pppTask.subject)).toBe('Completed');
  });

  test('Search / Advance Search', async ({ page }) => {
    await ensureReference(page);
    const search = new SearchPage(page);
    await search.open();
    await search.search(quoteReference);
    await search.expectResultCount('Quotes', 1);

    // The results panel occasionally doesn't render after Apply, so retry the whole search
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

  // Licence Referral raised for another underwriter is forwarded to the signed-in user and approved, then the quote is issued
  test('Issue Quote', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    await issueWithSelfApproval(page, quoteUrl, pppSections.riskSection, pppAssignee);
    quoteIssued = true;
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002)
  test('MultiQuote', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);
    test.skip(!quoteIssued && !ppp.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    await ensureReference(page);
    const multi = await new QuotePage(page).convertToMultiQuote(quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('PPP Multi Quote', multi.reference, multi.url);
  });

  test('Quote Taken up and conversion to Policy', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    test.skip(!quoteIssued && !ppp.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    // The policy URL is kept as soon as the policy is Bound, so the policy tests still run if its documents end "In Error"
    const policy = await takeUpAndBind(page, quoteUrl, pppSections.riskSection, 'PPP Policy', (bound) => {
      policyUrl = bound.url;
    });
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
  });

  // ⋮ → Requote is enabled once the quote is Taken Up → Ok → Save creates the new version
  test('Requote', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);
    test.skip(!policyUrl, 'The quote was not taken up (no policy)');
    await ensureReference(page);
    const requote = await new QuotePage(page).requote(quoteUrl);
    expect(requote.reference, 'a new quote version').toMatch(/^RSK\d+Q\d+$/);
    expect(requote.reference).not.toBe(quoteReference);
    testInfo.annotations.push({ type: 'requote', description: requote.reference });
    await recordContract('PPP Requote', requote.reference, requote.url);
  });

  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

// Own quote, so a decline can't take the chain's quote away from later steps
test.describe('PPP - Quote lifecycle', { tag: ['@flow', '@ppp-flow'] }, () => {
  test('Decline / Not Taken up / Mark as Lost', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const copy = await createPppModelCopy(page);
    const quote = new QuotePage(page);
    await quote.open(copy.url);
    await quote.closeQuote('Declined', pppDecline.reason, pppDecline.description);
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  });
});

// Serial: the reversal undoes the endorsement made by "MTA - GE Pricing".
test.describe.serial('PPP - Policy', { tag: ['@flow', '@ppp-flow'] }, () => {
  let endorsedPolicyUrl = ppp.env('ENDORSED_POLICY_URL'); // lets the reversal run alone on an existing endorsed policy

  test('MTA - GE Pricing and Confirm Endorsement', async ({ page }) => {
    test.setTimeout(18 * 60_000);
    const resume = { endorsementUrl: ppp.env('ENDORSEMENT_URL'), endorsedPolicyUrl };
    test.skip(!policyUrl && !resume.endorsementUrl && !resume.endorsedPolicyUrl, 'No bound policy (Taken Up did not run; set PPP_POLICY_URL to use an existing one)');
    ({ endorsedPolicyUrl } = await endorsePolicy(page, policyUrl, pppSections.riskSection, pppEndorsement, resume));
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    test.skip(!endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, endorsedPolicyUrl, pppEndorsement.reasonDescription);
  });
});

test.describe('PPP - Cancellation', { tag: ['@flow', '@ppp-flow'] }, () => {
  test('MTA - Mid Term Cancellation Policy and Reinstate Policy', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    const basePolicyUrl = ppp.env('CANCEL_POLICY_URL') || (await createBoundPolicy(page)).url;
    const cancellationUrl = await cancelPolicyMidTerm(page, basePolicyUrl, pppSections.riskSection, pppCancellation, ppp.env('CANCEL_MTA_URL'));
    await reinstatePolicy(page, cancellationUrl, pppReinstatement, ppp.env('REINSTATE_MTA_URL'));
  });
});

test.describe('PPP - Renewal', { tag: ['@flow', '@ppp-flow'] }, () => {
  // Own Bound policy, then Renew - Quote → Save → price → issue → take up → Bound renewal policy.
  // PPP_RENEWAL_BASE_POLICY_URL reuses a Bound policy; PPP_RENEWAL_QUOTE_URL carries on from an existing renewal quote.
  test('Renewals', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    let renewalUrl = ppp.env('RENEWAL_QUOTE_URL');
    if (!renewalUrl) {
      const basePolicyUrl = ppp.env('RENEWAL_BASE_POLICY_URL') || (await createBoundPolicy(page)).url;
      const policy = new PolicyPage(page);
      await policy.open(basePolicyUrl);
      await policy.renew();
      const renewal = await policy.saveRenewal();
      renewalUrl = renewal.url;
      await recordContract('PPP Renewal Quote', renewal.reference, renewal.url);
    }
    await priceQuote(page, renewalUrl, { geocodeFirst: true });
    await issueWithSelfApproval(page, renewalUrl, pppSections.riskSection, pppAssignee);
    await takeUpAndBind(page, renewalUrl, pppSections.riskSection, 'PPP Renewal Policy');
  });
});
