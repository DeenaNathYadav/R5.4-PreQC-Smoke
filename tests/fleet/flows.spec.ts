import fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { cancelPolicyMidTerm, confirmEndorsement, confirmMta, endorsePolicy, endorsementExperienceCall, issueEndorsement, priceEndorsement, priceMta, reinstatePolicy, reverseEndorsement, startEndorsement, startMidTermCancellationMta, takeUpEndorsement } from '../../src/products/fleet/flows/policy';
import { fleetDocumentWait, fillCtaRationale, getAxaClaims,
  createBoundPolicy,
  createFleetModelCopy,
  createFleetSubmissionQuote,
  fleetModel,
  getCommission,
  getExperienceCall,
  issueWithSelfApproval,
  priceQuote,
} from '../../src/products/fleet/flows/quote';
import { fleet } from '../../src/products/fleet';
import { FleetSectionsPage } from '../../src/products/fleet/FleetSectionsPage';
import {
  fleetAssignee,
  fleetCancellation,
  fleetCommission,
  fleetDecline, fleetNotTakenUp, fleetLost, fleetManualVehicle,
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
import { blockingSteps, persisted } from '../../src/support/runState';

// One test per row of the "Fleet" sheet in "AXA R5.4 - CMBC-MTP-Fleet Smoke (1).xlsx".
// The first quote is created from a submission (inception today − 10 days) and built up in the "Fleet - Quote" chain; every other
// Fleet quote is a ⋮ → Model copy of it (there is no fixed reference quote). test.fixme = backend evidence, not automated.
// Fleet's Premium section has Annual and Pro Rata premiums (no "Policy Period" ones)
const fleetPremiumGrossLabel = 'Pro Rata Premium Gross of Comm. & Net of IPT';
const fleetPremiumNetLabel = 'Pro Rata Premium Net of Comm. & IPT';

// Values handed down the chains, kept for the run (src/support/runState.ts). The chains run in order but do not stop at a
// failed test: Playwright carries on with the next one in a fresh worker, which reads these back.
const chain = persisted('fleet-chain', {
  mtcBaseQuoteUrl: '', // Mid Term Cancellation: base quote → converted → Bound policy → cancellation MTA (→ confirmed)
  mtcBaseConvertedUrl: '',
  mtcBasePolicyUrl: fleet.env('CANCEL_POLICY_URL'),
  mtcBaseMtaUrl: fleet.env('CANCEL_MTA_URL'),
  mtcBaseConfirmed: !!fleet.env('CANCEL_MTA_URL'),
  endorsementUrl: fleet.env('ENDORSEMENT_URL'), // the General Endorsement: endorsement quote → converted (endorsementConvertedUrl) → Bound (endorsedPolicyUrl)
  endorsementConvertedUrl: '',
  scheduleQuoteUrl: '', // the Model copy the schedule and claims tests change
  renewalBaseQuoteUrl: '', // the renewal's own base policy: Model copy → … → converted → Bound (renewalBasePolicyUrl)
  renewalBaseConvertedUrl: '',
  ntuQuoteUrl: '', // the Model copies Not Taken Up / Mark as Lost close
  lostQuoteUrl: '',
  renewalBasePolicyUrl: fleet.env('RENEWAL_BASE_POLICY_URL'), // the renewal chain: base policy → renewal quote → converted → Bound renewal policy
  renewalQuoteUrl: fleet.env('RENEWAL_QUOTE_URL'),
  renewalConvertedPolicyUrl: '',
  renewalPolicyUrl: fleet.env('RENEWAL_POLICY_URL'),
  renewalEndorsedPolicyUrl: '',
  cancellationMtaUrl: '', // the Mid-Term Cancellation MTA (its documents are checked on their own)
  inceptionMtaUrl: '',
  convertedPolicyUrl: '', // created by Policy Conversion, Bound by Confirm Cover (then also policyUrl)
  policyUrl: fleet.env('POLICY_URL'),
  quoteUrl: fleet.env('QUOTE_URL'),
  quoteReference: '',
  quoteIssued: false,
  endorsedPolicyUrl: fleet.env('ENDORSED_POLICY_URL'),
});
// Get Price, geocoding, Issue Quote, Taken Up (Confirm Cover), Confirm Endorsement … cannot be done without: a test that needs
// one of them is skipped as "Blocked" once it has failed (steps.needs); every other failure just lets the chain carry on.
const steps = blockingSteps('fleet-chain');
test.afterEach(async ({}, testInfo) => steps.record(testInfo));
// One ordered sequence for the whole file, in one worker: Quote → Quote lifecycle → Policy → Cancellation → Renewal. Everything after
// Taken Up needs the Bound policy it makes (or a Model copy of the same quote taken up the same way), so nothing runs ahead of it.
test.describe.configure({ mode: 'default' });

test.describe('Fleet - Quote', { tag: ['@flow', '@fleet-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const ensureReference = async (page: Page) => {
    if (chain.quoteReference) return;
    await new QuotePage(page).open(chain.quoteUrl);
    chain.quoteReference = (await page.title()).match(/RSK\d+Q\d+/)![0];
  };

  // New Submission (inception today − 10 days) → Convert to Quote: the quote the rest of the chain works on, and the model the other
  // Fleet quotes are copied from
  test('Convert to Quote', async ({ page }, testInfo) => {
    test.setTimeout(8 * 60_000);
    test.skip(!!fleet.env('QUOTE_URL'), 'FLEET_QUOTE_URL is set');
    const quote = await createFleetSubmissionQuote(page);
    chain.quoteUrl = quote.url;
    chain.quoteReference = quote.reference;
    testInfo.annotations.push({ type: 'quote', description: quote.reference });
    expect(quote.reference).toMatch(/^RSK\d+Q001$/);
  });

  // Offering → FLEET risk section with its covers (COMP, TPFT, TPO, Laid Up), Risk Details answered, Save
  test('Add Fleet risk section and covers', async ({ page }) => {
    steps.needs('Convert to Quote');
    test.setTimeout(8 * 60_000);
    await new FleetSectionsPage(page).addFleetSections(chain.quoteUrl, fleetSections);
  });

  test('Insert schedule by import (vehicle lookup)', async ({ page }) => {
    steps.needs('Add Fleet risk section and covers');
    test.setTimeout(12 * 60_000);
    const sections = new FleetSectionsPage(page);
    await sections.open(chain.quoteUrl);
    await sections.importFleetSchedule(fleetScheduleFile);
  });

  // Fleet is eligible for ⋮ → Get Commission: the connector fills Details → Commissions (Fleet row, Standard % / Selected %)
  test('Get Commission', async ({ page }) => {
    steps.needs('Add Fleet risk section and covers');
    // Sections, schedule and commission are on it now: the model the other Fleet quotes are copied from. Set first, because an
    // errored Get Commission (which fails this test) has still had the commission added by hand.
    fleetModel.url = chain.quoteUrl;
    await getCommission(page, chain.quoteUrl);
  });

  // Number of years claims experience above 0 makes the quote eligible for ⋮ → Experience Call, which comes before Get Price
  test('Get Experience Call', async ({ page }) => {
    steps.needs('Convert to Quote');
    test.setTimeout(8 * 60_000);
    expect(await getExperienceCall(page, chain.quoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('Get Pricing', async ({ page }, testInfo) => {
    steps.needs('Insert schedule by import (vehicle lookup)', 'Get Experience Call');
    test.setTimeout(6 * 60_000);
    await priceQuote(page, chain.quoteUrl, { experienceCall: false }); // the Get Experience Call test moved it on and made the call
    const premium = await readPremium(page, chain.quoteUrl, fleetPremiumGrossLabel, fleetPremiumNetLabel);
    expect(premium.policyPeriodGross, fleetPremiumGrossLabel).toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'premium', description: JSON.stringify(premium) });
  });

  test('Quote create task', async ({ page }) => {
    steps.needs('Convert to Quote');
    test.setTimeout(8 * 60_000); // the task status takes minutes to flip on this host
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.createTask(fleetTask);
    expect(await quote.taskStatus(chain.quoteUrl, fleetTask.taskType, fleetTask.subject)).toBe('Not Started');
    // Close the task again: card ⋮ → Complete
    await quote.approveTask(chain.quoteUrl, fleetTask.taskType, 'Complete', fleetTask.subject);
    await expect
      .poll(() => quote.taskStatus(chain.quoteUrl, fleetTask.taskType, fleetTask.subject), { timeout: 240_000, intervals: [10_000] })
      .toBe('Completed');
  });

  test('Quote Documents (automatic/manual) - Generation and Download', async ({ page }) => {
    steps.needs('Convert to Quote');
    const docs = new QuoteDocumentsPage(page);
    await docs.open(chain.quoteUrl);
    await docs.attachAutomaticTerms();
    const title = await docs.upload(fleetDocument);
    const file = await docs.download(title);
    expect(file.size, 'downloaded bytes').toBe(fs.statSync(fleetDocument.filePath).size);
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

    expect(await quote.taskStatus(chain.quoteUrl, fleetTask.taskType, fleetTask.subject)).toBe('Completed');
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
    await issueWithSelfApproval(page, chain.quoteUrl, fleetSections.riskSection, fleetAssignee);
    chain.quoteIssued = true;
  });

  // ⋮ → Convert to Multi Quote (offered on the issued quote) → Save creates the next quote of the same risk (…Q002)
  test('MultiQuote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.quoteIssued && !fleet.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    await ensureReference(page);
    const multi = await new QuotePage(page).convertToMultiQuote(chain.quoteUrl);
    expect(multi.reference, 'a new quote of the same risk').toMatch(/^RSK\d+Q\d+$/);
    expect(multi.reference).not.toBe(chain.quoteReference);
    expect(multi.reference.slice(0, 13), 'same risk as the source quote').toBe(chain.quoteReference.slice(0, 13));
    testInfo.annotations.push({ type: 'multi quote', description: multi.reference });
    await recordContract('Fleet Multi Quote', multi.reference, multi.url);
  });

  // ⋮ → Taken Up opens the unsaved Policy Conversion (a Provisional policy, "To Take Up the quote the risk will be saved"): this checks
  // the action gets there (open tasks, warnings, a re-price when asked). Nothing is saved yet: the quote stays Quoted and ⋮ still
  // offers Taken Up, so "Policy Conversion" runs it again on its own page.
  test('Quote Taken up', async ({ page }) => {
    steps.needs('Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.quoteIssued && !fleet.env('QUOTE_URL'), 'The quote is not issued (Issue Quote did not complete)');
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([fleetSections.riskSection]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  // ⋮ → Taken Up → Policy Conversion → Save: the policy is created (Provisional) and the quote becomes Taken Up
  test('Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Quote Taken up');
    test.setTimeout(10 * 60_000);
    const quote = new QuotePage(page);
    await quote.open(chain.quoteUrl);
    await quote.takeUp([fleetSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.convertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('Fleet Policy', policy.reference, policy.url);
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
    await recordContract('Fleet Requote', requote.reference, requote.url);
  });

  test.fixme('Data Lake - Quote/Pricing/MTA/Schedule/ALS', async () => {});
});

// Own quote, so a decline can't take the chain's quote away from later steps
test.describe('Fleet - Quote lifecycle', { tag: ['@flow', '@fleet-flow'] }, () => {
  // Declined, Not Taken Up and Lost are each an end state of a quote (the other two are no longer offered after one of them), so
  // each test closes a Model copy of its own: the quote made from the submission is never touched.

  // ⋮ → Declined → Decline Reason + description → Decline
  test('Decline', async ({ page }, testInfo) => {
    steps.needs('Convert to Quote');
    test.setTimeout(10 * 60_000);
    const copy = await createFleetModelCopy(page);
    const quote = new QuotePage(page);
    await quote.open(copy.url);
    await quote.closeQuote('Declined', fleetDecline.reason, fleetDecline.description);
    await expect(page.getByText('Declined', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // Not Taken Up is offered on an issued quote: its own ⋮ → Model copy → Get Price → Issue Quote, one test each, then Not Taken Up
  test('Not Taken Up - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote'); // the copy goes the way the quote it copies went
    test.setTimeout(10 * 60_000);
    const copy = await createFleetModelCopy(page);
    chain.ntuQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // Claims experience + pricing inputs (one Save) → Next Stage → ⋮ Experience Call, as on the quote it copies
  test('Not Taken Up - Experience Call', async ({ page }) => {
    steps.needs('Not Taken Up - Model Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    expect(await getExperienceCall(page, chain.ntuQuoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('Not Taken Up - Get Pricing', async ({ page }) => {
    steps.needs('Not Taken Up - Experience Call');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.ntuQuoteUrl, { experienceCall: false });
  });

  test('Not Taken Up - Issue Quote', async ({ page }) => {
    steps.needs('Not Taken Up - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.ntuQuoteUrl, fleetSections.riskSection, fleetAssignee);
  });

  // The quote then shows the status "Not Taken Up" and "This risk was marked as … The reason recorded was '…'" (the ⋮ menu keeps
  // listing every action, so it proves nothing). The reason is the first one the list offers.
  test('Not Taken Up', async ({ page }, testInfo) => {
    steps.needs('Not Taken Up - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.ntuQuoteUrl, 'No issued Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.ntuQuoteUrl);
    await quote.closeQuote('Not Taken Up', undefined, fleetNotTakenUp.description);
    const notice = await quote.expectMarkedAs(chain.ntuQuoteUrl, 'Not Taken Up');
    testInfo.annotations.push({ type: 'quote', description: notice });
  });

  // Mark as Lost is offered on an issued quote: its own ⋮ → Model copy → Get Price → Issue Quote, one test each, then Mark as Lost
  test('Mark as Lost - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Issue Quote'); // the copy goes the way the quote it copies went
    test.setTimeout(10 * 60_000);
    const copy = await createFleetModelCopy(page);
    chain.lostQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // Claims experience + pricing inputs (one Save) → Next Stage → ⋮ Experience Call, as on the quote it copies
  test('Mark as Lost - Experience Call', async ({ page }) => {
    steps.needs('Mark as Lost - Model Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    expect(await getExperienceCall(page, chain.lostQuoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('Mark as Lost - Get Pricing', async ({ page }) => {
    steps.needs('Mark as Lost - Experience Call');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.lostQuoteUrl, { experienceCall: false });
  });

  test('Mark as Lost - Issue Quote', async ({ page }) => {
    steps.needs('Mark as Lost - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.lostQuoteUrl, fleetSections.riskSection, fleetAssignee);
  });

  // The quote then shows the status "Lost" and "This risk was marked as … The reason recorded was '…'" (the ⋮ menu keeps
  // listing every action, so it proves nothing). The reason is the first one the list offers.
  test('Mark as Lost', async ({ page }, testInfo) => {
    steps.needs('Mark as Lost - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!chain.lostQuoteUrl, 'No issued Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.lostQuoteUrl);
    await quote.markAsLost(fleetLost.description);
    const notice = await quote.expectMarkedAs(chain.lostQuoteUrl, 'Lost');
    testInfo.annotations.push({ type: 'quote', description: notice });
  });
});

// Schedule and claims rows of the Fleet sheet, on a Model copy of their own (the chain's quote keeps the schedule it is priced on):
// Get AXA Claims, a vehicle added, changed and deleted by hand on the SCHEDULE grid, and the schedule export.
// Adding the schedule by import (with the CDL vehicle lookup) is "Insert schedule by import" in the Quote chain. The
// "Create Individual Party/Organisation" row is not part of the product smoke.
test.describe('Fleet - Schedule and Claims', { tag: ['@flow', '@fleet-flow'] }, () => {
  test('Schedule - Model Quote', async ({ page }, testInfo) => {
    steps.needs('Insert schedule by import (vehicle lookup)');
    test.setTimeout(10 * 60_000);
    const copy = await createFleetModelCopy(page);
    chain.scheduleQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // ⋮ → Get AXA Claims: the claims connector must answer OK
  test('Get Claims', async ({ page }) => {
    steps.needs('Schedule - Model Quote');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.scheduleQuoteUrl, 'No Model copy');
    await getAxaClaims(page, chain.scheduleQuoteUrl);
  });

  // SCHEDULE → Add New (+) → Vehicle Registration → Save: one more schedule item
  test('Add Schedule Manually', async ({ page }) => {
    steps.needs('Schedule - Model Quote');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.scheduleQuoteUrl, 'No Model copy');
    await new FleetSectionsPage(page).addScheduleRow(chain.scheduleQuoteUrl, fleetManualVehicle.registration);
  });

  // The added vehicle's registration changed in the grid → Save
  test('Update Schedule Manually', async ({ page }) => {
    steps.needs('Add Schedule Manually');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.scheduleQuoteUrl, 'No Model copy');
    await new FleetSectionsPage(page).updateScheduleRow(chain.scheduleQuoteUrl, fleetManualVehicle.registration, fleetManualVehicle.updatedRegistration);
  });

  // Export → Export downloads the schedule (.xlsx)
  test('Export Schedule', async ({ page }, testInfo) => {
    steps.needs('Schedule - Model Quote');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.scheduleQuoteUrl, 'No Model copy');
    const file = await new FleetSectionsPage(page).exportSchedule(chain.scheduleQuoteUrl);
    expect(file.fileName, 'an Excel file').toMatch(/.xlsx$/i);
    expect(file.size, 'the export is not empty').toBeGreaterThan(0);
    testInfo.annotations.push({ type: 'export', description: `${file.fileName} (${file.size} bytes)` });
  });

  // The vehicle changed above ticked → Delete (−) → "deleted permanently … continue?" Ok: one schedule item fewer
  test('Delete Schedule Manually', async ({ page }) => {
    steps.needs('Update Schedule Manually');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.scheduleQuoteUrl, 'No Model copy');
    await new FleetSectionsPage(page).deleteScheduleRow(chain.scheduleQuoteUrl, fleetManualVehicle.updatedRegistration);
  });
});

// In order: the reversal undoes the endorsement made by "MTA - GE Pricing".
test.describe('Fleet - Policy', { tag: ['@flow', '@fleet-flow'] }, () => {
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
    const statuses = await docs.expectAllDocumentsCompleted(fleetDocumentWait);
    testInfo.annotations.push({ type: 'documents', description: `${statuses.length} completed` });
  });

  // General Endorsement, one test per step: endorsement quote → Experience Call → Get Price → Issue → Take Up Endorsement (Policy
  // Conversion) → Confirm Endorsement. FLEET_ENDORSEMENT_URL carries on from an endorsement quote already started (one endorsement per
  // policy at a time), FLEET_ENDORSED_POLICY_URL from an endorsed policy.
  test('MTA - GE - Endorsement Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // a Bound policy is all it needs (its documents may still have failed)
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('ENDORSEMENT_URL') || !!fleet.env('ENDORSED_POLICY_URL'), 'An existing endorsement is used (FLEET_ENDORSEMENT_URL / _ENDORSED_POLICY_URL)');
    test.skip(!chain.policyUrl, 'No Bound policy');
    const endorsement = await startEndorsement(page, chain.policyUrl, fleetEndorsement);
    chain.endorsementUrl = endorsement.url;
    testInfo.annotations.push({ type: 'quote', description: endorsement.reference });
  });

  test('MTA - GE - Experience Call', async ({ page }) => {
    steps.needs('MTA - GE - Endorsement Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('ENDORSED_POLICY_URL'), 'FLEET_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await endorsementExperienceCall(page, chain.endorsementUrl);
  });

  test('MTA - GE - Get Pricing', async ({ page }) => {
    steps.needs('MTA - GE - Experience Call');
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('ENDORSED_POLICY_URL'), 'FLEET_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await priceEndorsement(page, chain.endorsementUrl, fleetSections.riskSection, { experienceCall: false });
  });

  test('MTA - GE - Issue Quote', async ({ page }) => {
    steps.needs('MTA - GE - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!fleet.env('ENDORSED_POLICY_URL'), 'FLEET_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    await issueEndorsement(page, chain.endorsementUrl, fleetSections.riskSection);
  });

  test('MTA - GE - Take Up Endorsement', async ({ page }, testInfo) => {
    steps.needs('MTA - GE - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('ENDORSED_POLICY_URL'), 'FLEET_ENDORSED_POLICY_URL is set (an endorsed policy is used)');
    test.skip(!chain.endorsementUrl, 'No endorsement quote');
    const endorsed = await takeUpEndorsement(page, chain.endorsementUrl, fleetSections.riskSection);
    chain.endorsementConvertedUrl = endorsed.url;
    testInfo.annotations.push({ type: 'policy', description: endorsed.reference });
  });

  test('MTA - GE - Confirm Endorsement', async ({ page }) => {
    steps.needs('MTA - GE - Take Up Endorsement');
    test.setTimeout(5 * 60_000);
    const endorsedUrl = chain.endorsementConvertedUrl || fleet.env('ENDORSED_POLICY_URL');
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
    await docs.expectAllDocumentsCompleted(fleetDocumentWait);
  });

  // Endorsement grid → ⋮ → Reverse on the Bound endorsement made above
  test('MTA - Reversal', async ({ page }) => {
    if (!chain.endorsedPolicyUrl) steps.needs('MTA - GE - Confirm Endorsement');
    test.setTimeout(5 * 60_000);
    test.skip(!chain.endorsedPolicyUrl, 'No endorsed policy (the general endorsement did not complete)');
    await reverseEndorsement(page, chain.endorsedPolicyUrl, fleetEndorsement.reasonDescription);
  });
});

test.describe('Fleet - Cancellation', { tag: ['@flow', '@fleet-flow'] }, () => {
  // Mid Term Cancellation on a Bound policy of its own (a Model copy of the quote made from the submission, taken through the same
  // operations, one test each), then the cancellation MTA one step at a time, its documents, and Reinstate Policy on it.
  // FLEET_CANCEL_POLICY_URL cancels an existing Bound policy instead, FLEET_CANCEL_MTA_URL / _REINSTATE_MTA_URL carry on from existing MTAs.
  test('MTC - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no cancellation either
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('CANCEL_POLICY_URL') || !!fleet.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (FLEET_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    const copy = await createFleetModelCopy(page);
    chain.mtcBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  test('MTC - Experience Call', async ({ page }) => {
    steps.needs('MTC - Model Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('CANCEL_POLICY_URL') || !!fleet.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (FLEET_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    expect(await getExperienceCall(page, chain.mtcBaseQuoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('MTC - Get Pricing', async ({ page }) => {
    steps.needs('MTC - Experience Call');
    test.setTimeout(12 * 60_000);
    test.skip(!!fleet.env('CANCEL_POLICY_URL') || !!fleet.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (FLEET_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.mtcBaseQuoteUrl, { experienceCall: false }); // the Experience Call test moved it on and made the call
  });

  test('MTC - Issue Quote', async ({ page }) => {
    steps.needs('MTC - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(!!fleet.env('CANCEL_POLICY_URL') || !!fleet.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (FLEET_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.mtcBaseQuoteUrl, fleetSections.riskSection, fleetAssignee);
  });

  test('MTC - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('MTC - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('CANCEL_POLICY_URL') || !!fleet.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (FLEET_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.mtcBaseQuoteUrl);
    await quote.takeUp([fleetSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.mtcBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('Fleet MTC Policy', policy.reference, policy.url);
  });

  test('MTC - Confirm Cover', async ({ page }) => {
    steps.needs('MTC - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(!!fleet.env('CANCEL_POLICY_URL') || !!fleet.env('CANCEL_MTA_URL'), 'An existing policy or cancellation MTA is used (FLEET_CANCEL_POLICY_URL / _CANCEL_MTA_URL)');
    test.skip(!chain.mtcBaseConvertedUrl, 'No converted base policy');
    const policyPage = new PolicyPage(page);
    await policyPage.open(chain.mtcBaseConvertedUrl);
    await policyPage.confirmCover();
    chain.mtcBasePolicyUrl = chain.mtcBaseConvertedUrl;
  });

  // ⋮ Mid Term Cancellation on the base policy → Save: the MTA on the policy itself (…P001/MTA00n, no separate quote).
  // FLEET_CANCEL_MTA_URL carries on from an MTA that already exists.
  test('MTA - Mid Term Cancellation Policy', async ({ page }, testInfo) => {
    if (!chain.mtcBasePolicyUrl) steps.needs('MTC - Confirm Cover');
    test.setTimeout(10 * 60_000);
    test.skip(!!fleet.env('CANCEL_MTA_URL'), 'FLEET_CANCEL_MTA_URL is set');
    test.skip(!chain.mtcBasePolicyUrl, 'No Bound base policy');
    chain.mtcBaseMtaUrl = await startMidTermCancellationMta(page, chain.mtcBasePolicyUrl, fleetCancellation);
    testInfo.annotations.push({ type: 'MTA', description: chain.mtcBaseMtaUrl });
  });

  test('MTA - Mid Term Cancellation - Get Pricing', async ({ page }) => {
    if (!chain.mtcBaseMtaUrl) steps.needs('MTA - Mid Term Cancellation Policy');
    test.setTimeout(8 * 60_000);
    test.skip(!chain.mtcBaseMtaUrl, 'No cancellation MTA');
    await priceMta(page, chain.mtcBaseMtaUrl, fleetSections.riskSection);
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
    await docs.expectAllDocumentsCompleted(fleetDocumentWait);
  });

  // ⋮ Reinstate Contract on the cancellation MTA → Save creates the next MTA (…/MTA002); the backend prices and confirms it, so the
  // outcome is checked (policy Bound again, "Reinstate Contract" in the Endorsement grid, the actions of a live policy)
  test('Reinstate Policy', async ({ page }) => {
    steps.needs('MTA - Mid Term Cancellation - Confirm Cancellation');
    test.setTimeout(12 * 60_000);
    test.skip(!chain.mtcBaseConfirmed, 'The cancellation was not confirmed');
    await reinstatePolicy(page, chain.mtcBaseMtaUrl, fleetReinstatement, fleet.env('REINSTATE_MTA_URL'));
  });

});

// Renewal: a Bound New Business policy of its own (a Model copy of the quote made from the submission, taken through the same
// operations), renewed, and the renewal quote taken through the same steps as a new one, one test per operation.
// FLEET_RENEWAL_BASE_POLICY_URL renews an existing Bound policy, FLEET_RENEWAL_QUOTE_URL carries on from an existing renewal quote,
// FLEET_RENEWAL_POLICY_URL from an existing Bound renewal policy.
test.describe('Fleet - Renewal', { tag: ['@flow', '@fleet-flow'] }, () => {
  test.describe.configure({ mode: 'default' });
  const renewalPolicyGiven = !!fleet.env('RENEWAL_POLICY_URL');

  // The renewal's own Bound New Business policy, made the way the main one is: ⋮ → Model copy of the quote made from the submission →
  // Get Price → Issue Quote → Taken Up + Policy Conversion → Confirm Cover, one test each
  test('Renewal - Base - Model Quote', async ({ page }, testInfo) => {
    if (!chain.policyUrl) steps.needs('Confirm Cover'); // no policy from the main chain: no renewal either
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_BASE_POLICY_URL') || !!fleet.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    const copy = await createFleetModelCopy(page);
    chain.renewalBaseQuoteUrl = copy.url;
    testInfo.annotations.push({ type: 'quote', description: copy.reference });
  });

  // Claims experience + pricing inputs (one Save) → Next Stage → ⋮ Experience Call, as on the quote it copies
  test('Renewal - Base - Experience Call', async ({ page }) => {
    steps.needs('Renewal - Base - Model Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_BASE_POLICY_URL') || !!fleet.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    expect(await getExperienceCall(page, chain.renewalBaseQuoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('Renewal - Base - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Base - Experience Call');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_BASE_POLICY_URL') || !!fleet.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await priceQuote(page, chain.renewalBaseQuoteUrl, { experienceCall: false });
  });

  test('Renewal - Base - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Base - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_BASE_POLICY_URL') || !!fleet.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    await issueWithSelfApproval(page, chain.renewalBaseQuoteUrl, fleetSections.riskSection, fleetAssignee);
  });

  test('Renewal - Base - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Base - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_BASE_POLICY_URL') || !!fleet.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
    test.skip(!chain.renewalBaseQuoteUrl, 'No Model copy');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalBaseQuoteUrl);
    await quote.takeUp([fleetSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalBaseConvertedUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('Fleet Renewal Base Policy', policy.reference, policy.url);
  });

  test('Renewal - Base - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Base - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_BASE_POLICY_URL') || !!fleet.env('RENEWAL_QUOTE_URL'), 'An existing base policy or renewal quote is used');
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
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!!fleet.env('RENEWAL_QUOTE_URL'), 'FLEET_RENEWAL_QUOTE_URL is set');
    test.skip(!chain.renewalBasePolicyUrl, 'No Bound policy to renew');
    const policy = new PolicyPage(page);
    await policy.open(chain.renewalBasePolicyUrl);
    await policy.renew();
    const renewal = await policy.saveRenewal();
    chain.renewalQuoteUrl = renewal.url;
    testInfo.annotations.push({ type: 'quote', description: renewal.reference });
    await recordContract('Fleet Renewal Quote', renewal.reference, renewal.url);
  });

  // A renewal quote arrives without the claims experience years and UW Period Choice Get Price insists on (filled by the Experience
  // Call's Details step), and with the CTA whose rationale Issue Quote demands: rationale, then claims + inputs → Next Stage → ⋮ Experience Call
  test('Renewal - Experience Call', async ({ page }) => {
    steps.needs('Renewal - Renew Quote');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await fillCtaRationale(page, chain.renewalQuoteUrl);
    expect(await getExperienceCall(page, chain.renewalQuoteUrl), 'the Experience Call was made').toBe(true);
  });

  test('Renewal - Get Pricing', async ({ page }) => {
    steps.needs('Renewal - Experience Call');
    test.setTimeout(6 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await priceQuote(page, chain.renewalQuoteUrl, { experienceCall: false });
  });

  test('Renewal - Issue Quote', async ({ page }) => {
    steps.needs('Renewal - Get Pricing');
    test.setTimeout(12 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    await issueWithSelfApproval(page, chain.renewalQuoteUrl, fleetSections.riskSection, fleetAssignee);
  });

  // ⋮ → Taken Up (on a renewal: "Quote Taken Up") reaches the unsaved Policy Conversion; nothing is saved yet (see "Quote Taken up")
  test('Renewal - Quote Taken up', async ({ page }) => {
    steps.needs('Renewal - Issue Quote');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([fleetSections.riskSection]);
    await expect(page, 'Taken Up opens the Policy Conversion').toHaveURL(/\/ui\/Policy\/Conversion/);
  });

  test('Renewal - Policy Conversion', async ({ page }, testInfo) => {
    steps.needs('Renewal - Quote Taken up');
    test.setTimeout(10 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
    test.skip(!chain.renewalQuoteUrl, 'No renewal quote');
    const quote = new QuotePage(page);
    await quote.open(chain.renewalQuoteUrl);
    await quote.takeUp([fleetSections.riskSection]);
    const policy = await new PolicyPage(page).saveConversion();
    chain.renewalConvertedPolicyUrl = policy.url;
    testInfo.annotations.push({ type: 'policy', description: policy.reference });
    await recordContract('Fleet Renewal Policy', policy.reference, policy.url);
  });

  test('Renewal - Confirm Cover', async ({ page }) => {
    steps.needs('Renewal - Policy Conversion');
    test.setTimeout(5 * 60_000);
    test.skip(renewalPolicyGiven, 'FLEET_RENEWAL_POLICY_URL is set');
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
    await docs.expectAllDocumentsCompleted(fleetDocumentWait);
  });
});
