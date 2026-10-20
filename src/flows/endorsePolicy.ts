import { Page, expect } from '@playwright/test';
import { businessAction, listActions } from '../pages/advantagego/entity';
import { PolicyPage } from '../pages/advantagego/PolicyPage';
import { QuoteDocumentsPage } from '../pages/advantagego/QuoteDocumentsPage';
import { QuotePage } from '../pages/advantagego/QuotePage';
import { QuoteSectionsPage } from '../pages/advantagego/QuoteSectionsPage';
import { recordContract, recordContractFromPage } from '../support/contracts';

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
 * Next Stage → Issue Quote → Take Up Endorsement → Policy Conversion Save → Confirm Endorsement, then all documents Completed.
 * Only the steps still on offer are done, so it can resume from `resume`.
 */
export async function endorsePolicy(
  page: Page,
  policyUrl: string,
  riskSection: string,
  data: EndorsementData,
  resume: EndorseResume = {},
  log: (msg: string) => void = console.log,
): Promise<{ endorsementUrl: string; endorsedPolicyUrl: string }> {
  return changePolicy(page, policyUrl, riskSection, (policyPage) => policyPage.startGeneralEndorsement(data), resume, log);
}

/**
 * Mid-Term Cancellation: unlike an endorsement this is an MTA on the policy itself (reference …P001/MTA001, no separate
 * quote). Start + Save create it; then ⋮ → Get Price and ⋮ → Confirm Endorsement bind it, and its documents complete.
 * `resumeMtaUrl` carries on from an MTA record that already exists (e.g. /ui/Policy/Edit/<id>).
 */
export async function cancelPolicyMidTerm(
  page: Page,
  policyUrl: string,
  riskSection: string,
  data: { reasonCode: string; reasonDescription: string; refundBasis: string },
  resumeMtaUrl = '',
  log: (msg: string) => void = console.log,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  let mtaUrl = resumeMtaUrl;
  if (!mtaUrl) {
    await policyPage.open(policyUrl);
    await policyPage.startMidTermCancellation(data);
    await policyPage.saveCancellation();
    mtaUrl = page.url();
    log(`PI cancellation MTA: ${mtaUrl}`);
  } else {
    await page.goto(mtaUrl);
    await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
  }
  await recordContractFromPage(page, 'Mid-Term Cancellation (MTA)');

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
  log: (msg: string) => void = console.log,
): Promise<string> {
  const policyPage = new PolicyPage(page);
  let mtaUrl = resumeMtaUrl;
  if (!mtaUrl) {
    await policyPage.open(cancelledUrl);
    await policyPage.startReinstatement(data);
    await policyPage.saveReinstatement();
    mtaUrl = page.url();
    log(`PI reinstatement MTA: ${mtaUrl}`);
  } else {
    await page.goto(mtaUrl);
  }
  await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
  await recordContractFromPage(page, 'Reinstatement (MTA)');
  await policyPage.expectReinstated();
  const actions = await listActions(page);
  log(`PI reinstated policy actions: ${actions.join(' | ')}`);
  expect(actions, 'a reinstated policy can be cancelled again').toContain('Mid-Term Cancellation');
  return mtaUrl;
}

/** On a saved MTA record: ⋮ Get Price (when offered) → ⋮ Confirm … → status Bound/Cancelled, then all documents Completed. */
async function priceAndConfirmMta(page: Page, mtaUrl: string, riskSection: string, log: (msg: string) => void): Promise<void> {
  const policyPage = new PolicyPage(page);
  let actions = await listActions(page);
  expect(actions.length, 'the ⋮ menu lists actions').toBeGreaterThan(0);
  log(`PI MTA actions: ${actions.join(' | ')}`);
  if (actions.includes('Get Price')) {
    await new QuoteSectionsPage(page).getPrice([riskSection]); // "Price is returned back from the rating engine"
    await page.goto(mtaUrl);
    await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 60_000 });
    actions = await listActions(page);
  }
  const confirm = actions.find((a) => /^Confirm (Endorsement|Cancellation|Reinstate)/.test(a));
  if (confirm) await policyPage.confirmChange(confirm);
  else {
    // Nothing left to confirm: only acceptable when resuming from an MTA that is already confirmed
    log('PI MTA already confirmed - skipping Confirm');
    await policyPage.expectConfirmed(30_000);
  }

  const docs = new QuoteDocumentsPage(page, 'Policy');
  await docs.open(mtaUrl);
  await docs.expectAllDocumentsCompleted();
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
    await recordContract('Endorsement Quote', endorsement.reference, endorsement.url);
    log(`PI endorsement created: ${endorsement.reference} → ${endorsement.url}`);
  }

  let endorsedPolicyUrl = resume.endorsedPolicyUrl ?? '';
  if (!endorsedPolicyUrl) {
    const endorsementQuote = new QuotePage(page);
    await endorsementQuote.open(endorsementUrl);
    if (!(await listActions(page)).some((a) => /^Take Up/.test(a))) {
      await new QuoteSectionsPage(page).getPrice([riskSection]); // "Price is returned back from the rating engine"
      if ((await listActions(page)).includes('Next Stage')) await endorsementQuote.nextStage();
      const outcome = await endorsementQuote.issueQuote([riskSection]);
      log(`PI endorsement issue outcome: ${outcome}`);
    }
    await endorsementQuote.waitUntilEditable(endorsementUrl); // documents are generated after issuing

    // A renewal's endorsement quote has no Quote Expiry Date, which take-up requires
    await endorsementQuote.open(endorsementUrl);
    await endorsementQuote.ensureQuoteExpiryDate();
    await new QuoteSectionsPage(page).getPrice([riskSection]); // take-up asks for a re-price after any change to the quote

    // A fresh load each attempt: the ⋮ button can come back without its "More" title
    const takeUpLabel = ((await listActions(page)).find((a) => /^Take Up/.test(a))) ?? 'Take Up Endorsement';
    log(`PI take-up action: ${takeUpLabel}`);
    await expect(async () => {
      await page.goto(endorsementUrl);
      await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 20_000 });
      await businessAction(page, takeUpLabel);
    }).toPass({ timeout: 120_000, intervals: [3_000] });
    const endorsedPolicy = await new PolicyPage(page).saveConversion(); // same Policy Conversion page as Taken Up
    endorsedPolicyUrl = endorsedPolicy.url;
    await recordContract('Endorsed Policy', endorsedPolicy.reference, endorsedPolicy.url);
    log(`PI endorsed policy: ${endorsedPolicy.reference} → ${endorsedPolicy.url}`);
  }

  const endorsedPolicyPage = new PolicyPage(page);
  await endorsedPolicyPage.open(endorsedPolicyUrl);
  const confirmLabel = (await listActions(page)).find((a) => /^Confirm (Endorsement|Cancellation)/.test(a)) ?? 'Confirm Endorsement';
  log(`PI confirm action: ${confirmLabel}`);
  await endorsedPolicyPage.confirmChange(confirmLabel);
  const docs = new QuoteDocumentsPage(page, 'Policy');
  await docs.open(endorsedPolicyUrl);
  await docs.expectAllDocumentsCompleted(); // the endorsement documents are generated in the background
  return { endorsementUrl, endorsedPolicyUrl };
}
