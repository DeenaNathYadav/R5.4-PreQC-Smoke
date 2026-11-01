import path from 'path';
import { SubmissionData } from '../../pages/advantagego/NewSubmissionPage';
import { TaskData } from '../../pages/advantagego/QuotePage';
import { UploadData } from '../../pages/advantagego/QuoteDocumentsPage';
import { ConvertToQuoteData, SubmissionDetails } from '../../pages/advantagego/SubmissionPage';
import { pi } from '.';
import { cancellationDate, inceptionDate } from '../../support/dates';
import { PiSectionData } from './PiSectionsPage';

// QC test data for the PI smoke flows.
export const piSubmission = (): SubmissionData => ({
  insured: 'Anjali Insured demo',
  agencyName: 'Anjali,Intermediary',
  agencySearch: 'Anjali',
  agencyNumber: '7401474',
  inceptsOn: inceptionDate(),
  businessDescription: `PI Smoke ${new Date().toISOString().slice(0, 16)}`,
});

export const piSubmissionDetails: SubmissionDetails = {
  transactionType: 'New Business',
  businessCategory: 'SME',
  underwriter: 'Agarwal,Nitin',
};

export const piQuote: ConvertToQuoteData = {
  product: 'Professional Indemnity',
  insuranceType: 'Direct',
  contractStructure: 'Open Market',
  requiredFields: [{ section: 'Claims History', label: 'Number of years claims experience', value: '0' }],
};

// Quote → Sections
export const piSections: PiSectionData = {
  riskSection: 'Accountants',
  trade: 'Accounting and auditing activities',
  activities: [
    { activity: 'Audit / company tax / accountancy - banks / financial', percentage: '100', expectedSplitFactor: '5' },
  ],
  income: [{ incomeType: 'Fees', currentYear: '20000', previousYears: ['18000', '15000'] }],
  limitAndExcess: { coverage: 'Professional Indemnity', limitBasis: 'AGGR', limitAmount: '1000000', excessAmount: '20000' },
};

// Quote → ⋮ → Create Task (Underwriting Referral tasks need a reason and an assignee)
export const piTask: TaskData = {
  taskType: 'Underwriting Referral - PI',
  reason: 'Cover',
  assignee: pi.env('TASK_ASSIGNEE') || 'Deena Yadav',
  subject: `PI smoke task ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, // unique per run: a Model copy carries older tasks
};

// Quote → DOCUMENTS → Attach File
export const piDocument: UploadData = {
  filePath: path.resolve(__dirname, '../../assets/smoke-doc.pdf'),
  documentType: 'Quote',
};

// ⋮ → Declined
export const piDecline = { reason: 'Decline - Other', description: 'PI smoke test: declined by automation' };
// Not Taken Up / Mark as Lost: no fixed reason (the first one the list offers is used and reported); the description is mandatory
export const piNotTakenUp = { description: 'PI smoke test: not taken up by automation' };
export const piLost = { description: 'PI smoke test: marked as lost by automation' };

// Quote → DETAILS → Commission → + (Get Commission isn't available for PI)
export const piCommission = { brokerPercent: '12' };

// Policy → ⋮ → General Endorsement → Endorsement section
export const piEndorsement = {
  endorsementType: 'General',
  /** Effective From = the policy's inception date + this many days (the form leaves it empty; Effective To is pre-filled). */
  effectiveFromDaysAfterInception: 10,
  reasonCode: 'Addition/Deletion of Covers/Coverages/Perils',
  reasonDescription: 'PI SmokeAgent',
};

// Policy → ⋮ → Mid-Term Cancellation → Endorsement section (type "Mid Term Cancellation" and Effective From are pre-set)
/** Reinstate Contract on the cancelled policy: type and reason code are pre-set by the screen. */
export const piReinstatement = {
  reasonDescription: 'PI SmokeAgent',
};

export const piCancellation = {
  reasonCode: 'Insured Request',
  reasonDescription: 'PI SmokeAgent',
  refundBasis: 'Pro-Rata',
  effectiveFrom: cancellationDate(), // mid-term cancellation takes effect today
};
