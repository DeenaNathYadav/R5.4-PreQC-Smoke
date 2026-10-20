import { Page, expect } from '@playwright/test';
import { field, formatDate, selectAutocomplete, selectDate } from './kendo';

export interface SubmissionData {
  insured: string;
  agencyName: string;
  /** Text typed to find the agency (the full name contains a comma, a prefix searches more reliably). */
  agencySearch?: string;
  /** Auto-filled from the agency; checked when provided. */
  agencyNumber?: string;
  inceptsOn: Date;
  businessDescription: string;
}

export interface CreatedSubmission {
  reference: string;
  /** Internal id used in URLs: /ui/Submission/Edit/<contractId> */
  contractId: number;
}

/** Finds the first positive numeric ContractId anywhere in the SaveSubmission response. */
function findContractId(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  if (typeof obj.ContractId === 'number' && obj.ContractId > 0) return obj.ContractId;
  for (const v of Object.values(obj)) {
    const id = findContractId(v);
    if (id) return id;
  }
  return undefined;
}

export class NewSubmissionPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    // The form occasionally renders blank on first load; a reload fixes it
    await expect(async () => {
      await this.page.goto('/ui/home/newSubmission');
      await expect(this.page.getByText('Entering a New Submission')).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 75_000 });
  }

  async fill(data: SubmissionData): Promise<void> {
    const { page } = this;
    await selectAutocomplete(page, 'Insured', data.insured);
    await selectAutocomplete(page, 'Agency Name', data.agencySearch ?? data.agencyName, data.agencyName);
    if (data.agencyNumber) await expect(field(page, 'Agency Number')).toHaveValue(data.agencyNumber);
    await selectDate(page, 'Incepts On', data.inceptsOn);
    await expect(field(page, 'Incepts On')).toHaveValue(formatDate(data.inceptsOn));
    await field(page, 'Business Description').fill(data.businessDescription);
  }

  /** Saves the submission (SaveSubmission can take ~20s) and returns the RSK reference. */
  async submit(): Promise<CreatedSubmission> {
    const { page } = this;
    const saved = page.waitForResponse((r) => /api\/Submission\/SaveSubmission/i.test(r.url()), { timeout: 90_000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const response = await saved;
    expect(response.ok(), 'SaveSubmission succeeded').toBeTruthy();
    const contractId = findContractId(await response.json().catch(() => undefined));
    expect(contractId, 'ContractId in SaveSubmission response').toBeTruthy();

    await page.waitForURL('**/ui/home/submissionCreated', { timeout: 90_000 });
    await expect(page.getByText('Your new submission has been created')).toBeVisible();
    const reference = (await page.locator('.reference-no').innerText()).trim();
    expect(reference).toMatch(/^RSK\d+$/);
    return { reference, contractId: contractId! };
  }
}
