import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyAtInception, cancelPolicyMidTerm, endorsePolicy, reinstatePolicy, reverseEndorsement } from '../../src/products/mtp/flows/policy';
import {
  buildMtpSections,
  createBoundPolicy,
  createMtpSubmissionQuote,
  fillCtaRationale,
  issueWithSelfApproval,
  mtpModel,
  priceQuote,
  takeUpAndBind,
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

const mtpPremiumGrossLabel = 'Policy Period Premium Gross of Comm. & Net of IPT';
let policyUrl = mtp.env('POLICY_URL');

test.describe.serial('MTP - Quote', { tag: ['@flow', '@mtp-flow'] }, () => {
  let quoteUrl = mtp.env('QUOTE_URL');
  let quoteReference = '';
  const ensureReference = async (page: Page) => {
    if (quoteReference) return;
    await new QuotePage(page).open(quoteUrl);
    quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
  };

  // New Submission (inception today − 10 days) → Convert to Quote → PDBI, Liability, Road Risks and Legal Expenses → commission: the
  // quote the rest of the chain works on, and the model the other MTP quotes are copied from
  test('Convert to Quote with PDBI, Liability, Road Risks and Legal Expenses', async ({ page }, testInfo) => {
    test.setTimeout(15 * 60_000);
    test.skip(!!quoteUrl, 'MTP_QUOTE_URL is set');
    const quote = await createMtpSubmissionQuote(page);
    quoteUrl = quote.url;
    quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
    testInfo.annotations.push({ type: 'section validation', description: await buildMtpSections(page, quote.url) });
  });

  test('Insert schedule with geocoding and peril score', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const sections = new MtpSectionsPage(page);
    await sections.open(quoteUrl);
    await sections.importMtpSchedule(mtpScheduleFile);
  });

  test('Get Commission', async ({ page }, testInfo) => {
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    const rejected = await quote.getCommission();
    if (rejected.length) testInfo.annotations.push({ type: 'commission not rated', description: rejected.join(', ') });
    await quote.fillEmptyCommissionRates(mtpCommission.brokerPercent); // the connector leaves "not rated" sections empty
    mtpModel.url = quoteUrl; // sections, schedule and commission are on it now: the model the other MTP quotes are copied from
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    await priceQuote(page, quoteUrl);
    const premium = await readPremium(page, quoteUrl, mtpPremiumGrossLabel);
    expect(premium.policyPeriodGross).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    const docs = new QuoteDocumentsPage(page);
    await docs.open(quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(mtpDocument);
    const file = await docs.download(title);
    expect(file.size).toBe(fs.statSync(mtpDocument.filePath).size);
    await docs.expectDownloadedOn(title);
  });

  test('Search / Advance Search', async ({ page }) => {
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
    await issueWithSelfApproval(page, quoteUrl, mtpSections.riskSections[0], mtpAssignee);
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002).
  test('MultiQuote', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);
    await ensureReference(page);
    const multi = await new QuotePage(page).convertToMultiQuote(quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('MTP Multi Quote', multi.reference, multi.url);
  });

  test('Quote Taken up and conversion to Policy', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    // The policy URL is kept as soon as the policy is Bound, so the policy tests still run if its documents end "In Error"
    const policy = await takeUpAndBind(page, quoteUrl, mtpSections.riskSections[0], 'MTP Policy', (bound) => {
      policyUrl = bound.url;
    });
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
  });

  // ⋮ → Requote is enabled once the quote is Taken Up → Ok → Save creates the new version.
  test('Requote', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);
    await ensureReference(page);
    const requote = await new QuotePage(page).requote(quoteUrl);
    expect(requote.reference, 'a new quote version').toMatch(/^RSK\d+Q\d+$/);
    expect(requote.reference).not.toBe(quoteReference);
    testInfo.annotations.push({ type: 'requote', description: requote.reference });
    await recordContract('MTP Requote', requote.reference, requote.url);
  });

  test.fixme('Documents/datalake payload generation', async () => {});
  test.fixme('Data lake pricing/quote/schedule', async () => {});
  test.fixme('Check ALS and server folder payloads', async () => {});
  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

// Serial: the reversal undoes the endorsement made by the general endorsement.
test.describe.serial('MTP - Policy', { tag: ['@flow', '@mtp-flow'] }, () => {
  let endorsedPolicyUrl = mtp.env('ENDORSED_POLICY_URL'); // lets the reversal run alone on an existing endorsed policy

  test('MTA - GE Pricing and Confirm Endorsement', async ({ page }) => {
    test.setTimeout(18 * 60_000);
    const resume = { endorsementUrl: mtp.env('ENDORSEMENT_URL'), endorsedPolicyUrl };
    test.skip(!policyUrl && !resume.endorsementUrl && !resume.endorsedPolicyUrl, 'No MTP policy or endorsement URL is available');
    ({ endorsedPolicyUrl } = await endorsePolicy(page, policyUrl, mtpSections.riskSections[0], mtpEndorsement, resume));
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    test.skip(!endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, endorsedPolicyUrl, mtpEndorsement.reasonDescription);
  });
});

test.describe('MTP - Cancellation', { tag: ['@flow', '@mtp-flow'] }, () => {
  test('MTA - Mid Term Cancellation Policy and Reinstate Policy', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    const basePolicyUrl = mtp.env('CANCEL_POLICY_URL') || (await createBoundPolicy(page)).url;
    const cancellationUrl = await cancelPolicyMidTerm(
      page,
      basePolicyUrl,
      mtpSections.riskSections[0],
      mtpCancellation,
      mtp.env('CANCEL_MTA_URL'),
    );
    await reinstatePolicy(page, cancellationUrl, mtpReinstatement, mtp.env('REINSTATE_MTA_URL'));
  });

  // Own Bound policy (the mid-term cancellation above uses another one). MTP_INCEPTION_POLICY_URL reuses an existing Bound policy.
  test('MTA - Inception Cancellation Policy', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    const basePolicyUrl = mtp.env('INCEPTION_POLICY_URL') || (await createBoundPolicy(page)).url;
    await cancelPolicyAtInception(
      page,
      basePolicyUrl,
      mtpSections.riskSections[0],
      mtpInceptionCancellation,
      mtp.env('INCEPTION_MTA_URL'),
    );
  });
});

test.describe('MTP - Renewal', { tag: ['@flow', '@mtp-flow'] }, () => {
  // Own Bound policy (a Model copy taken up), then Renew - Quote → Save → price → issue → take up → Bound renewal policy.
  // MTP_RENEWAL_BASE_POLICY_URL reuses an existing Bound policy; MTP_RENEWAL_QUOTE_URL carries on from an existing renewal quote.
  test('Renewals', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    let renewalUrl = mtp.env('RENEWAL_QUOTE_URL');
    if (!renewalUrl) {
      const basePolicyUrl = mtp.env('RENEWAL_BASE_POLICY_URL') || (await createBoundPolicy(page)).url;
      const policy = new PolicyPage(page);
      await policy.open(basePolicyUrl);
      await policy.renew();
      const renewal = await policy.saveRenewal();
      renewalUrl = renewal.url;
      await recordContract('MTP Renewal Quote', renewal.reference, renewal.url);
    }
    await fillCtaRationale(page, renewalUrl); // the renewal inherits a CTA whose rationale Get Price / Issue Quote demand
    await priceQuote(page, renewalUrl); // geocodes first when the renewal's copied schedule is not geocoded
    await issueWithSelfApproval(page, renewalUrl, mtpSections.riskSections[0], mtpAssignee);
    await takeUpAndBind(page, renewalUrl, mtpSections.riskSections[0], 'MTP Renewal Policy');
  });
});
