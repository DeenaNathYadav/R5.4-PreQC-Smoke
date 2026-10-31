import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyMidTerm, endorsePolicy, reinstatePolicy, reverseEndorsement } from '../../src/products/fleet/flows/policy';
import {
  createBoundPolicy,
  createFleetModelCopy,
  createFleetSubmissionQuote,
  fleetModel,
  getCommission,
  getExperienceCall,
  issueWithSelfApproval,
  priceQuote,
  takeUpAndBind,
} from '../../src/products/fleet/flows/quote';
import { fleet } from '../../src/products/fleet';
import { FleetSectionsPage } from '../../src/products/fleet/FleetSectionsPage';
import {
  fleetAssignee,
  fleetCancellation,
  fleetCommission,
  fleetDecline,
  fleetDocument,
  fleetEndorsement,
  fleetReinstatement,
  fleetScheduleFile,
  fleetSections,
  fleetTask,
} from '../../src/products/fleet/data';
import { PolicyPage } from '../../src/pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../../src/pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../../src/pages/advantagego/QuotePage';
import { readPremium } from '../../src/pages/advantagego/QuoteSectionsPage';
import { SearchPage } from '../../src/pages/advantagego/SearchPage';
import { recordContract } from '../../src/support/contracts';

// One test per row of the "Fleet" sheet in "AXA R5.4 - CMBC-MTP-Fleet Smoke (1).xlsx".
// The first quote is created from a submission (inception today − 10 days) and built up in the "Fleet - Quote" chain; every other
// Fleet quote is a ⋮ → Model copy of it (there is no fixed reference quote). test.fixme = backend evidence, not automated.
// Fleet's Premium section has Annual and Pro Rata premiums (no "Policy Period" ones)
const fleetPremiumGrossLabel = 'Pro Rata Premium Gross of Comm. & Net of IPT';
const fleetPremiumNetLabel = 'Pro Rata Premium Net of Comm. & IPT';
let policyUrl = fleet.env('POLICY_URL');

test.describe.serial('Fleet - Quote', { tag: ['@flow', '@fleet-flow'] }, () => {
  let quoteUrl = fleet.env('QUOTE_URL');
  let quoteReference = '';
  let quoteIssued = false;
  const ensureReference = async (page: Page) => {
    if (quoteReference) return;
    await new QuotePage(page).open(quoteUrl);
    quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
  };

  // New Submission (inception today − 10 days) → Convert to Quote: the quote the rest of the chain works on, and the model the other
  // Fleet quotes are copied from
  test('Convert to Quote', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    test.skip(!!quoteUrl, 'FLEET_QUOTE_URL is set');
    const quote = await createFleetSubmissionQuote(page);
    quoteUrl = quote.url;
    quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
  });

  // Offering → FLEET risk section with its covers (COMP, TPFT, TPO, Laid Up), Risk Details answered, Save
  test('Add Fleet risk section and covers', async ({ page }) => {
    test.setTimeout(8 * 60_000);
    await new FleetSectionsPage(page).addFleetSections(quoteUrl, fleetSections);
  });

  test('Insert schedule by import (vehicle lookup)', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const sections = new FleetSectionsPage(page);
    await sections.open(quoteUrl);
    await sections.importFleetSchedule(fleetScheduleFile);
  });

  // Fleet is eligible for ⋮ → Get Commission: the connector fills Details → Commissions (Fleet row, Standard % / Selected %)
  test('Get Commission', async ({ page }) => {
    await getCommission(page, quoteUrl);
    fleetModel.url = quoteUrl; // sections, schedule and commission are on it now: the model the other Fleet quotes are copied from
  });

  // Number of years claims experience above 0 makes the quote eligible for ⋮ → Experience Call, which comes before Get Price
  test('Get Experience Call', async ({ page }) => {
    test.setTimeout(8 * 60_000);
    expect(await getExperienceCall(page, quoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000); // claims experience, Next Stage and the Experience Call come before the price
    await priceQuote(page, quoteUrl);
    const premium = await readPremium(page, quoteUrl, fleetPremiumGrossLabel, fleetPremiumNetLabel);
    expect(premium.policyPeriodGross, fleetPremiumGrossLabel).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote create task', async ({ page }) => {
    test.setTimeout(8 * 60_000); // the task status takes minutes to flip on this host
    const quote = new QuotePage(page);
    await quote.open(quoteUrl);
    await quote.createTask(fleetTask);
    expect(await quote.taskStatus(quoteUrl, fleetTask.taskType, fleetTask.subject)).toBe('Not Started');
    // Close the task again: card ⋮ → Complete
    await quote.approveTask(quoteUrl, fleetTask.taskType, 'Complete', fleetTask.subject);
    await expect
      .poll(() => quote.taskStatus(quoteUrl, fleetTask.taskType, fleetTask.subject), { timeout: 240_000, intervals: [10_000] })
      .toBe('Completed');
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    const docs = new QuoteDocumentsPage(page);
    await docs.open(quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(fleetDocument);
    const file = await docs.download(title);
    expect(file.size, 'downloaded bytes').toBe(fs.statSync(fleetDocument.filePath).size);
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

    expect(await quote.taskStatus(quoteUrl, fleetTask.taskType, fleetTask.subject)).toBe('Completed');
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
    await issueWithSelfApproval(page, quoteUrl, fleetSections.riskSection, fleetAssignee);
    quoteIssued = true;
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002)
  test('MultiQuote', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);
    test.skip(!quoteIssued && !fleet.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    await ensureReference(page);
    const multi = await new QuotePage(page).convertToMultiQuote(quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('Fleet Multi Quote', multi.reference, multi.url);
  });

  test('Quote Taken up and conversion to Policy', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    test.skip(!quoteIssued && !fleet.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    // The policy URL is kept as soon as the policy is Bound, so the policy tests still run if its documents end "In Error"
    const policy = await takeUpAndBind(page, quoteUrl, fleetSections.riskSection, 'Fleet Policy', (bound) => {
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
    await recordContract('Fleet Requote', requote.reference, requote.url);
  });

  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

// Own quote, so a decline can't take the chain's quote away from later steps
test.describe('Fleet - Quote lifecycle', { tag: ['@flow', '@fleet-flow'] }, () => {
  test('Decline / Not Taken up / Mark as Lost', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const copy = await createFleetModelCopy(page);
    const quote = new QuotePage(page);
    await quote.open(copy.url);
    await quote.closeQuote('Declined', fleetDecline.reason, fleetDecline.description);
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  });
});

// Serial: the reversal undoes the endorsement made by "MTA - GE Pricing".
test.describe.serial('Fleet - Policy', { tag: ['@flow', '@fleet-flow'] }, () => {
  let endorsedPolicyUrl = fleet.env('ENDORSED_POLICY_URL'); // lets the reversal run alone on an existing endorsed policy

  test('MTA - GE Pricing and Confirm Endorsement', async ({ page }) => {
    test.setTimeout(18 * 60_000);
    const resume = { endorsementUrl: fleet.env('ENDORSEMENT_URL'), endorsedPolicyUrl };
    test.skip(!policyUrl && !resume.endorsementUrl && !resume.endorsedPolicyUrl, 'No bound policy (Taken Up did not run; set FLEET_POLICY_URL to use an existing one)');
    ({ endorsedPolicyUrl } = await endorsePolicy(page, policyUrl, fleetSections.riskSection, fleetEndorsement, resume));
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    test.skip(!endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, endorsedPolicyUrl, fleetEndorsement.reasonDescription);
  });
});

test.describe('Fleet - Cancellation', { tag: ['@flow', '@fleet-flow'] }, () => {
  test('MTA - Mid Term Cancellation Policy and Reinstate Policy', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    const basePolicyUrl = fleet.env('CANCEL_POLICY_URL') || (await createBoundPolicy(page)).url;
    const cancellationUrl = await cancelPolicyMidTerm(page, basePolicyUrl, fleetSections.riskSection, fleetCancellation, fleet.env('CANCEL_MTA_URL'));
    await reinstatePolicy(page, cancellationUrl, fleetReinstatement, fleet.env('REINSTATE_MTA_URL'));
  });
});

test.describe('Fleet - Renewal', { tag: ['@flow', '@fleet-flow'] }, () => {
  // Own Bound policy, then Renew - Quote → Save → price → issue → take up → Bound renewal policy.
  // FLEET_RENEWAL_BASE_POLICY_URL reuses a Bound policy; FLEET_RENEWAL_QUOTE_URL carries on from an existing renewal quote.
  test('Renewals', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    let renewalUrl = fleet.env('RENEWAL_QUOTE_URL');
    if (!renewalUrl) {
      const basePolicyUrl = fleet.env('RENEWAL_BASE_POLICY_URL') || (await createBoundPolicy(page)).url;
      const policy = new PolicyPage(page);
      await policy.open(basePolicyUrl);
      await policy.renew();
      const renewal = await policy.saveRenewal();
      renewalUrl = renewal.url;
      await recordContract('Fleet Renewal Quote', renewal.reference, renewal.url);
    }
    await priceQuote(page, renewalUrl);
    await issueWithSelfApproval(page, renewalUrl, fleetSections.riskSection, fleetAssignee);
    await takeUpAndBind(page, renewalUrl, fleetSections.riskSection, 'Fleet Renewal Policy');
  });
});
