import path from 'path';
import { SubmissionData } from '../../pages/advantagego/NewSubmissionPage';
import { ConvertToQuoteData, SubmissionDetails } from '../../pages/advantagego/SubmissionPage';
import { UploadData } from '../../pages/advantagego/QuoteDocumentsPage';
import { mtp } from '.';
import { cancellationDate, inceptionDate } from '../../support/dates';
import { MtpSectionData } from './MtpSectionsPage';

// QC test data for the MTP (Motor Trade) smoke flows.
export const mtpSubmission = (): SubmissionData => ({
  insured: 'Anjali Insured demo',
  agencyName: 'Anjali,Intermediary',
  agencySearch: 'Anjali',
  agencyNumber: '7401474',
  inceptsOn: inceptionDate(),
  businessDescription: `MTP Smoke ${new Date().toISOString().slice(0, 16)}`,
});

export const mtpSubmissionDetails: SubmissionDetails = {
  transactionType: 'New Business',
  businessCategory: 'SME',
  underwriter: 'Singhai UW,Shenki',
};

export const mtpQuote: ConvertToQuoteData = {
  product: 'Motor Trade',
  insuranceType: 'Direct',
  contractStructure: 'Open Market',
  requiredQuestions: [{ section: 'Risk Validation', question: '1. Has the broker visited the client', value: 'Yes' }],
  requiredFields: [
    { section: 'Claims History', label: 'Formal CCE required? (Term will be added to quote docs)', value: 'No' },
    { section: 'Claims History', label: 'Number of years claims experience', value: '0' },
  ],
  analysisCodes: [
    { type: 'Trade sector', value: 'Section G' },
    { type: 'SIC Trade Division', value: '45' },
    { type: 'SIC Trade Group', value: '45.1' },
    { type: 'SIC Trade Class', value: '45.11' },
    { type: 'AXA Trade Description', value: '4511100' },
  ],
};

// Quote → Sections (reference quote RSK0003740201Q001). The offering (SME) is defaulted by the product, the risk sections are not.
export const mtpSections: MtpSectionData = {
  offering: 'SME',
  riskSections: ['PDBI', 'LIABILITY', 'ROAD RISKS', 'LEGAL EXPENSES'],
  childSections: ['Business Interruption', 'Property Damage'],
};

export const mtpScheduleFile = path.resolve(
  mtp.env('SCHEDULE_IMPORT') || path.join(__dirname, '../../../MTP/MTP_Schedule_Import.xlsx'),
);

export const mtpDocument: UploadData = {
  filePath: path.resolve(__dirname, '../../assets/smoke-doc.pdf'),
  documentType: 'Quote',
};

export const mtpEndorsement = {
  endorsementType: 'General',
  effectiveFromDaysAfterInception: 10,
  reasonCode: 'Addition/Deletion of Covers/Coverages/Perils',
  reasonDescription: 'MTP SmokeAgent',
};

export const mtpCancellation = {
  reasonCode: 'Insured Request',
  reasonDescription: 'MTP SmokeAgent',
  refundBasis: 'Pro-Rata',
  effectiveFrom: cancellationDate(), // mid-term cancellation takes effect today
};

export const mtpInceptionCancellation = {
  reasonCode: 'Insured Request',
  reasonDescription: 'MTP SmokeAgent',
};

export const mtpReinstatement = { reasonDescription: 'MTP SmokeAgent' };

export const mtpAssignee = mtp.env('TASK_ASSIGNEE') || 'Deena Yadav';
