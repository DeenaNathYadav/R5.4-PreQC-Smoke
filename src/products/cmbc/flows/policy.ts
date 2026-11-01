// CMBC's own policy-change steps (General Endorsement, Mid-Term and Inception Cancellation, Reinstate, Reversal). Other products have their own copy under src/products/<key>/flows/,
// so a change to one product's steps never touches another's.
import { Page, expect } from '@playwright/test';
import { businessAction, gotoWithMenu, listActions } from '../../../pages/advantagego/entity';
import { CreatedPolicy, PolicyPage } from '../../../pages/advantagego/PolicyPage';
import { QuotePage } from '../../../pages/advantagego/QuotePage';
import { QuoteSectionsPage } from '../../../pages/advantagego/QuoteSectionsPage';
import { recordContract, recordContractFromPage } from '../../../support/contracts';

/** Log lines are tagged with the product. */
const defaultLog = (msg: string) => console.log(`CMBC: ${msg}`);

export interface EndorsementData {
  endorsementType: string;
  effectiveFromDaysAfterInception: number;
  reasonCode: string;
  reasonDescription: string;
}

/** Existing pieces to carry on from, when an earlier attempt got part-way (one endorsement per policy at a time). */
export interface EndorseResume {
  endorsementUrl?: string;
  endorsedPolicyUrl?: string;
}

/**
 * Bound policy → ⋮ General Endorsement (fill the Endorsement section) → Save (endorsement quote …Q002) → Get Price →
 * Next Stage → Issue Quote → Take Up Endorsement → Policy Conversion Save → Confirm Endorsement (its documents are checked by the spec's own Documents - Generation test).
 * Only the steps still on offer are done, so it can resume from `resume`.
 */
export async function endorsePolicy(
  page: Page,
  policyUrl: string,
  riskSection: string,
  data: EndorsementData,
  resume: EndorseResume = {},
  log: (msg: string) => void = defaultLog,
): Promise<{ endorsementUrl: string; endorsedPolicyUrl: string }> {
  return changePolicy(page, policyUrl, riskSection, (policyPage) => policyPage.startGeneralEndorsement(data), resume, log);
}

/**
 * Mid-Term Cancellation: unlike an endorsement this is an MTA on the policy itself (reference …P001/MTA001, no separate
 * quote). Start + Save create it; then ⋮ → Get Price and ⋮ → Confirm Endorsement bind it (its documents are checked by the spec's own Documents - Generation test).
 * `resumeMtaUrl` carries on from an MTA record that already exists (e.g. /ui/Policy/Edit/<id>).
 */
export async function cancelPolicyMidTerm(
  page: Page,
  policyUrl: string,
  riskSection: string,
  data: { reasonCode: string; reasonDescription: string; refundBasis: string; effectiveFrom?: Date },
  resumeMtaUrl = '',
  log: (msg: string) => void = defaultLog,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  let mtaUrl = resumeMtaUrl;
  if (!mtaUrl) {
    await policyPage.open(policyUrl);
    await policyPage.startMidTermCancellation(data);
    await policyPage.saveCancellation();
    mtaUrl = page.url();
    log(`cancellation MTA: ${mtaUrl}`);
  } else {
    await gotoWithMenu(page, mtaUrl);
  }
  await recordContractFromPage(page, 'CMBC Mid-Term Cancellation (MTA)');

  await priceAndConfirmMta(page, mtaUrl, riskSection, log);
  return mtaUrl;
}

/**
 * Reinstate Contract on the cancelled policy: ⋮ → Reinstate Contract on the cancellation record (…P001/MTA001) opens an
 * unsaved reinstatement (Endorsement Type / Reason Code pre-set) → Save creates the next MTA (…/MTA002). Nothing else is
 * done by hand: the backend prices and confirms it, so this only checks the outcome (policy Bound again, MTA002 in the
 * Endorsement grid as "Reinstate Contract", policy actions back to those of a live policy).
 * `resumeMtaUrl` checks an existing reinstatement record instead of creating one.
 */
export async function reinstatePolicy(
  page: Page,
  cancelledUrl: string,
  data: { reasonDescription: string },
  resumeMtaUrl = '',
  log: (msg: string) => void = defaultLog,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  let mtaUrl = resumeMtaUrl;
  if (!mtaUrl) {
    await policyPage.open(cancelledUrl);
    await policyPage.startReinstatement(data);
    await policyPage.saveReinstatement();
    mtaUrl = page.url();
    log(`reinstatement MTA: ${mtaUrl}`);
  } else {
    await page.goto(mtaUrl);
  }
  await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
  await recordContractFromPage(page, 'CMBC Reinstatement (MTA)');
  await policyPage.expectReinstated();
  // The reinstatement must price and confirm by itself, with no validation error left on the record
  await expect(page.getByText('Error(s)'), 'validation errors on the reinstatement').toHaveCount(0);
  await expect(page.getByText(/Halted At/), 'the reinstatement workflow halted').toHaveCount(0);
  const actions = await listActions(page);
  log(`reinstated policy actions: ${actions.join(' | ')}`);
  expect(actions, 'a reinstated policy can be cancelled again').toContain('Mid-Term Cancellation');
  return mtaUrl;
}

/**
 * Inception Cancellation: ⋮ → Inception Cancellation on the Bound policy → Save (Confirm "Do you wish to confirm the change?", then Ok on
 * "Effective dates of the Child components…") creates the MTA (…P001/MTA001); ⋮ → Get Price and ⋮ → Confirm Cancellation bind it.
 * `resumeMtaUrl` carries on from an MTA record that already exists.
 */
export async function cancelPolicyAtInception(
  page: Page,
  policyUrl: string,
  riskSection: string,
  data: { reasonCode: string; reasonDescription: string; refundBasis?: string },
  resumeMtaUrl = '',
  log: (msg: string) => void = defaultLog,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  let mtaUrl = resumeMtaUrl;
  if (!mtaUrl) {
    await policyPage.open(policyUrl);
    await policyPage.startInceptionCancellation(data);
    await policyPage.saveInceptionCancellation();
    mtaUrl = page.url();
    log(`inception cancellation MTA: ${mtaUrl}`);
  } else {
    await gotoWithMenu(page, mtaUrl);
  }
  await recordContractFromPage(page, 'CMBC Inception Cancellation (MTA)');

  await priceAndConfirmMta(page, mtaUrl, riskSection, log);
  return mtaUrl;
}

/**
 * MTA - Reversal: on a policy that has a Bound endorsement, Endorsement grid → the endorsement row's ⋮ → Reverse → Yes.
 * `reasonDescription` identifies the endorsement row (the endorsement's Reason Description).
 */
export async function reverseEndorsement(
  page: Page,
  endorsedPolicyUrl: string,
  reasonDescription: string,
  log: (msg: string) => void = defaultLog,
): Promise<void> {
  const policyPage = new PolicyPage(page);
  await policyPage.open(endorsedPolicyUrl);
  await policyPage.reverseEndorsement(reasonDescription);
  log('endorsement reversed - checking the outcome');
  await policyPage.expectEndorsementReversed(reasonDescription);
  await recordContractFromPage(page, 'CMBC Reversed Endorsement (policy)');
}

// ------------------------------------------------------------------ cancellation MTA, one step at a time (the spec's tests)

/** Mid-Term Cancellation: Bound policy → ⋮ Mid-Term Cancellation → Save: the MTA on the policy itself (…P001/MTA00n). Returns its URL. */
export async function startMidTermCancellationMta(
  page: Page,
  policyUrl: string,
  data: Parameters<typeof cancelPolicyMidTerm>[3],
  log: (msg: string) => void = defaultLog,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  await policyPage.open(policyUrl);
  await policyPage.startMidTermCancellation(data);
  await policyPage.saveCancellation();
  const mtaUrl = page.url();
  log(`mid-term cancellation MTA: ${mtaUrl}`);
  await recordContractFromPage(page, 'CMBC Mid-Term Cancellation (MTA)');
  return mtaUrl;
}

/** Inception Cancellation: Bound policy → ⋮ Inception Cancellation → Save: the MTA on the policy itself (…P001/MTA00n). Returns its URL. */
export async function startInceptionCancellationMta(
  page: Page,
  policyUrl: string,
  data: Parameters<typeof cancelPolicyAtInception>[3],
  log: (msg: string) => void = defaultLog,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  await policyPage.open(policyUrl);
  await policyPage.startInceptionCancellation(data);
  await policyPage.saveInceptionCancellation();
  const mtaUrl = page.url();
  log(`inception cancellation MTA: ${mtaUrl}`);
  await recordContractFromPage(page, 'CMBC Inception Cancellation (MTA)');
  return mtaUrl;
}

/** On a saved MTA: ⋮ Get Price when offered ("Price is returned back from the rating engine"); nothing to do otherwise. */
export async function priceMta(page: Page, mtaUrl: string, riskSection: string, log: (msg: string) => void = defaultLog): Promise<void> {
  await gotoWithMenu(page, mtaUrl);
  const actions = await listActions(page);
  expect(actions.length, 'the ⋮ menu lists actions').toBeGreaterThan(0);
  log(`MTA actions: ${actions.join(' | ')}`);
  if (actions.includes('Get Price')) await new QuoteSectionsPage(page).getPrice([riskSection]);
}

/** On a priced MTA: ⋮ Confirm Endorsement / Cancellation / Reinstate → Bound or Cancelled. Already confirmed only when resuming. */
export async function confirmMta(page: Page, mtaUrl: string, log: (msg: string) => void = defaultLog): Promise<void> {
  const policyPage = new PolicyPage(page);
  await gotoWithMenu(page, mtaUrl);
  const confirm = (await listActions(page)).find((a) => /^Confirm (Endorsement|Cancellation|Reinstate)/.test(a));
  if (confirm) await policyPage.confirmChange(confirm);
  else {
    // Nothing left to confirm: only acceptable when resuming from an MTA that is already confirmed
    log('MTA already confirmed - skipping Confirm');
    await policyPage.expectConfirmed(30_000);
  }
}

/** On a saved MTA record: ⋮ Get Price (when offered) → ⋮ Confirm … → status Bound/Cancelled (documents: see the spec). */
async function priceAndConfirmMta(page: Page, mtaUrl: string, riskSection: string, log: (msg: string) => void): Promise<void> {
  const policyPage = new PolicyPage(page);
  let actions = await listActions(page);
  expect(actions.length, 'the ⋮ menu lists actions').toBeGreaterThan(0);
  log(`MTA actions: ${actions.join(' | ')}`);
  if (actions.includes('Get Price')) {
    await new QuoteSectionsPage(page).getPrice([riskSection]); // "Price is returned back from the rating engine"
    await gotoWithMenu(page, mtaUrl);
    actions = await listActions(page);
  }
  const confirm = actions.find((a) => /^Confirm (Endorsement|Cancellation|Reinstate)/.test(a));
  if (confirm) await policyPage.confirmChange(confirm);
  else {
    // Nothing left to confirm: only acceptable when resuming from an MTA that is already confirmed
    log('MTA already confirmed - skipping Confirm');
    await policyPage.expectConfirmed(30_000);
  }

}

// ------------------------------------------------------------------ General Endorsement, one step at a time
// endorsePolicy (below) runs them all; the spec runs them as separate tests.

/** General Endorsement, step 1: Bound policy → ⋮ General Endorsement (fill the Endorsement section) → Save: the endorsement quote. */
export async function startEndorsement(
  page: Page,
  policyUrl: string,
  data: EndorsementData,
  log: (msg: string) => void = defaultLog,
): Promise<{ reference: string; url: string }> {
  const start = (policyPage: PolicyPage) => policyPage.startGeneralEndorsement(data);
  let endorsementUrl = '';
  const policyPage = new PolicyPage(page);
  await policyPage.open(policyUrl);
  await start(policyPage);
  const endorsement = await policyPage.saveEndorsement();
  endorsementUrl = endorsement.url;
  await recordContract('CMBC Endorsement Quote', endorsement.reference, endorsement.url);
  log(`endorsement created: ${endorsement.reference} → ${endorsement.url}`);
  return { reference: endorsement.reference, url: endorsementUrl };
}

/** General Endorsement, step 2: Get Price on the endorsement quote (moved on from Risk Details first where the product needs it). */
export async function priceEndorsement(
  page: Page,
  endorsementUrl: string,
  riskSection: string,
  log: (msg: string) => void = defaultLog,
): Promise<void> {
  const endorsementQuote = new QuotePage(page);
  await endorsementQuote.open(endorsementUrl);
  // CMBC only offers Get Price from UW Review & Process, so move on from Risk Details first
  if ((await listActions(page)).includes('Next Stage')) await endorsementQuote.nextStage();
  await new QuoteSectionsPage(page).getPrice([riskSection]); // "Price is returned back from the rating engine"
}

/** General Endorsement, step 3: Issue Quote, then wait for its documents to be generated (the quote is view-only meanwhile). */
export async function issueEndorsement(page: Page, endorsementUrl: string, riskSection: string, log: (msg: string) => void = defaultLog): Promise<void> {
  const endorsementQuote = new QuotePage(page);
  await endorsementQuote.open(endorsementUrl);
  const outcome = await endorsementQuote.issueQuote([riskSection]);
  log(`endorsement issue outcome: ${outcome}`);
  await endorsementQuote.waitUntilEditable(endorsementUrl); // documents are generated after issuing
}

/** General Endorsement, step 4: re-price (take-up asks for it) → ⋮ Take Up Endorsement → Policy Conversion Save: the endorsed policy. */
export async function takeUpEndorsement(
  page: Page,
  endorsementUrl: string,
  riskSection: string,
  log: (msg: string) => void = defaultLog,
): Promise<CreatedPolicy> {
  const endorsementQuote = new QuotePage(page);
  let endorsedPolicyUrl = '';

  // A renewal's endorsement quote has no Quote Expiry Date, which take-up requires
  await endorsementQuote.open(endorsementUrl);
  await endorsementQuote.ensureQuoteExpiryDate();
  await new QuoteSectionsPage(page).getPrice([riskSection]); // take-up asks for a re-price after any change to the quote

  // A fresh load each attempt: the ⋮ button can come back without its "More" title
  const takeUpLabel = ((await listActions(page)).find((a) => /^Take Up/.test(a))) ?? 'Take Up Endorsement';
  log(`take-up action: ${takeUpLabel}`);
  await expect(async () => {
    await page.goto(endorsementUrl);
    await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 20_000 });
    await businessAction(page, takeUpLabel);
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  const endorsedPolicy = await new PolicyPage(page).saveConversion(); // same Policy Conversion page as Taken Up
  endorsedPolicyUrl = endorsedPolicy.url;
  await recordContract('CMBC Endorsed Policy', endorsedPolicy.reference, endorsedPolicy.url);
  log(`endorsed policy: ${endorsedPolicy.reference} → ${endorsedPolicy.url}`);
  return endorsedPolicy;
}

/** General Endorsement, step 5: ⋮ Confirm Endorsement on the endorsed policy → Bound. */
export async function confirmEndorsement(page: Page, endorsedPolicyUrl: string, log: (msg: string) => void = defaultLog): Promise<void> {
  const endorsedPolicyPage = new PolicyPage(page);
  await endorsedPolicyPage.open(endorsedPolicyUrl);
  const confirmLabel = (await listActions(page)).find((a) => /^Confirm (Endorsement|Cancellation)/.test(a)) ?? 'Confirm Endorsement';
  log(`confirm action: ${confirmLabel}`);
  await endorsedPolicyPage.confirmChange(confirmLabel);
}

async function changePolicy(
  page: Page,
  policyUrl: string,
  riskSection: string,
  start: (policyPage: PolicyPage) => Promise<void>,
  resume: EndorseResume,
  log: (msg: string) => void,
): Promise<{ endorsementUrl: string; endorsedPolicyUrl: string }> {
  let endorsementUrl = resume.endorsementUrl ?? '';
  if (!endorsementUrl && !resume.endorsedPolicyUrl) {
    const policyPage = new PolicyPage(page);
    await policyPage.open(policyUrl);
    await start(policyPage);
    const endorsement = await policyPage.saveEndorsement();
    endorsementUrl = endorsement.url;
    await recordContract('CMBC Endorsement Quote', endorsement.reference, endorsement.url);
    log(`endorsement created: ${endorsement.reference} → ${endorsement.url}`);
  }

  let endorsedPolicyUrl = resume.endorsedPolicyUrl ?? '';
  if (!endorsedPolicyUrl) {
    const endorsementQuote = new QuotePage(page);
    await endorsementQuote.open(endorsementUrl);
    if (!(await listActions(page)).some((a) => /^Take Up/.test(a))) {
      await priceEndorsement(page, endorsementUrl, riskSection, log);
      await issueEndorsement(page, endorsementUrl, riskSection, log);
    } else {
      await endorsementQuote.waitUntilEditable(endorsementUrl); // documents are generated after issuing
    }
    endorsedPolicyUrl = (await takeUpEndorsement(page, endorsementUrl, riskSection, log)).url;
  }

  await confirmEndorsement(page, endorsedPolicyUrl, log);
  return { endorsementUrl, endorsedPolicyUrl };
}
