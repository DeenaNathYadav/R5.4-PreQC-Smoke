import path from 'path';
import { SubmissionData } from '../../pages/advantagego/NewSubmissionPage';
import { ConvertToQuoteData, SubmissionDetails } from '../../pages/advantagego/SubmissionPage';
import { TaskData } from '../../pages/advantagego/QuotePage';
import { UploadData } from '../../pages/advantagego/QuoteDocumentsPage';
import { ppp } from '.';
import { cancellationDate, inceptionDate } from '../../support/dates';

// QC test data for the PPP (UK Property Investors Protection Plan) smoke flows.
export const pppSubmission = (): SubmissionData => ({
  insured: 'Anjali Insured demo',
  agencyName: 'Anjali,Intermediary',
  agencySearch: 'Anjali',
  agencyNumber: '7401474',
  inceptsOn: inceptionDate(),
  businessDescription: `PPP Smoke ${new Date().toISOString().slice(0, 16)}`,
});

export const pppSubmissionDetails: SubmissionDetails = {
  transactionType: 'New Business',
  businessCategory: 'SME',
  underwriter: 'Agarwal,Nitin',
};

// The product defaults Insurance Type / Contract Structure; Business Type, the construction question and the claims
// experience are mandatory before the quote can be saved.
export const pppQuote: ConvertToQuoteData = {
  product: 'UK Property Investors Protection Plan',
  insuranceType: 'Direct',
  contractStructure: 'Open Market',
  requiredFields: [
    { section: 'Submission Information', label: 'Business Type', value: 'Standalone Risks 1-3 locations' },
    { section: 'Submission Information', label: 'All buildings constructed after 01/01/2000?', value: 'Yes' },
    { section: 'Claims History', label: 'Number of years claims experience', value: '0' },
  ],
};

// Quote → Sections. A Model copy of the reference quote (PPP_TEMPLATE_QUOTE_URL) already carries the PPP risk section,
// its covers and the Broker Commission row, so none of that is added by the tests.
export const pppSections = { riskSection: 'PPP' };

// Details → Commission: the Broker Commission row is updated (or added when missing) with this Override %
export const pppCommission = { brokerPercent: '12' };

export const pppScheduleFile = path.resolve(
  ppp.env('SCHEDULE_IMPORT') || path.join(__dirname, '../../../PPP/PPP_Schedule_Import.xlsx'),
);

export const pppAssignee = ppp.env('TASK_ASSIGNEE') || 'Deena Yadav';

// Quote → ⋮ → Create Task. PPP has its own referral type (PPP_TASK_TYPE overrides).
export const pppTask: TaskData = {
  taskType: ppp.env('TASK_TYPE') || 'Underwriting Referral - PPP',
  reason: 'Cover',
  assignee: pppAssignee,
  subject: `PPP smoke task ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, // unique per run: a Model copy carries older tasks
};

export const pppDocument: UploadData = {
  filePath: path.resolve(__dirname, '../../assets/smoke-doc.pdf'),
  documentType: 'Quote',
};

export const pppDecline = { reason: 'Decline - Other', description: 'PPP smoke test: declined by automation' };

export const pppEndorsement = {
  endorsementType: 'General',
  effectiveFromDaysAfterInception: 10,
  reasonCode: 'Addition/Deletion of Covers/Coverages/Perils',
  reasonDescription: 'PPP SmokeAgent',
};

export const pppCancellation = {
  reasonCode: 'Insured Request',
  reasonDescription: 'PPP SmokeAgent',
  refundBasis: 'Pro-Rata',
  effectiveFrom: cancellationDate(), // mid-term cancellation takes effect today
};

export const pppReinstatement = { reasonDescription: 'PPP SmokeAgent' };
