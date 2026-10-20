import { Page, test } from '@playwright/test';

/** One contract (submission, quote, policy, MTA …) created or used by a test, as listed in results/contracts.{md,csv}. */
export interface ContractRecord {
  step: string;
  reference: string;
  contractId: string;
  url: string;
}

export const CONTRACT_ATTACHMENT = 'contract';

/** The numeric id in an entity URL, e.g. /ui/Policy/Edit/120689 → "120689". */
export function contractIdFromUrl(url: string): string {
  return url.match(/\/ui\/\w+\/\w+\/(\d+)/)?.[1] ?? '';
}

/**
 * Notes a contract for the contracts table. Safe to call more than once for the same contract.
 * The attachment is read by `reporters/contracts-reporter.ts`, so it is listed even when the test fails later.
 */
export async function recordContract(step: string, reference: string, url: string): Promise<void> {
  const record: ContractRecord = { step, reference, contractId: contractIdFromUrl(url), url };
  await test.info().attach(CONTRACT_ATTACHMENT, { body: JSON.stringify(record), contentType: 'application/json' });
}

/**
 * Same, reading the reference off the open page: the header shows e.g. RSK0003838501P001/MTA001 (the browser title
 * only has the policy reference), so look there first and fall back to the title.
 */
export async function recordContractFromPage(page: Page, step: string): Promise<void> {
  const pattern = /RSK\d+[PQ]\d+(?:\/MTA\d+)?/;
  const header = await page.getByText(pattern).first().innerText({ timeout: 10_000 }).catch(() => '');
  const reference = header.match(pattern)?.[0] ?? (await page.title()).match(pattern)?.[0] ?? '';
  await recordContract(step, reference, page.url());
}
