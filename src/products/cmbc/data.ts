import path from 'path';
import { SubmissionData } from '../../pages/advantagego/NewSubmissionPage';
import { ConvertToQuoteData, SubmissionDetails } from '../../pages/advantagego/SubmissionPage';
import { UploadData } from '../../pages/advantagego/QuoteDocumentsPage';
import { cmbc } from '.';
import { cancellationDate, inceptionDate } from '../../support/dates';
import { CmbcSectionData } from './CmbcSectionsPage';

export const cmbcSubmission = (): SubmissionData => ({
  insured: 'Anjali Insured demo',
  agencyName: 'Anjali,Intermediary',
  agencySearch: 'Anjali',
  agencyNumber: '7401474',
  inceptsOn: inceptionDate(),
  businessDescription: `CMBC Smoke ${new Date().toISOString().slice(0, 16)}`,
});

export const cmbcSubmissionDetails: SubmissionDetails = {
  transactionType: 'New Business',
  businessCategory: 'SME',
  underwriter: 'Singhai UW,Shenki',
};

export const cmbcQuote: ConvertToQuoteData = {
  product: 'Commercial Combined',
  insuranceType: 'Direct',
  contractStructure: 'Open Market',
  requiredFields: [
    { section: 'Claims History', label: 'Formal CCE required? (Term will be added to quote docs)', value: 'No' },
    { section: 'Claims History', label: 'Number of years claims experience', value: '0' },
  ],
  analysisCodes: [
    { type: 'Trade sector', value: 'Section F' },
    { type: 'SIC Trade Division', value: '41' },
    { type: 'SIC Trade Group', value: '41.1' },
    { type: 'SIC Trade Class', value: '41.10' },
    { type: 'AXA Trade Description', value: '4110000' },
  ],
};

export const cmbcSections: CmbcSectionData = {
  offering: 'Standard CMBC',
  riskSections: ['PDBI', 'LIABILITY'],
  childSections: ['Business Interruption', 'Property Damage', 'Public and Product Liability'],
  // Values as on reference quote 117365
  liabilityExposures: [
    {
      section: 'Public Liability',
      grid: 'PUL Exposure Grid',
      options: {
        Region: 'UK',
        Tradecategory: 'Property developers',
        Hazardouslocation: 'Standard',
        'Exposure Type': 'BFSC',
        Exposure: 'Payments',
      },
      values: { 'Exposure Estimate': '120000' },
    },
    {
      section: 'Product Liability',
      grid: 'PRL Exposure Grid',
      options: {
        Turnoverterritory: 'UK',
        Tradecategory: 'Property developers',
        'Selected Product Hazard': 'VL',
      },
      values: { 'Turnover ': '120000' },
      questions: { 'Do you import any manufactured items from outside of the UK?': 'No' },
    },
  ],
};

// Details → Commissions: the commission connector answers "not rated" for the test agency (error 90063) and leaves the Selected %
// of every section empty, so each empty row is given this value
export const cmbcCommission = { brokerPercent: '12' };

export const cmbcScheduleFile = path.resolve(
  cmbc.env('SCHEDULE_IMPORT') || path.join(__dirname, '../../../CMBC/CMBC_Schedule_Import.xlsx'),
);

export const cmbcDocument: UploadData = {
  filePath: path.resolve(__dirname, '../../assets/smoke-doc.pdf'),
  documentType: 'Quote',
};

export const cmbcEndorsement = {
  endorsementType: 'General',
  effectiveFromDaysAfterInception: 10,
  reasonCode: 'Addition/Deletion of Covers/Coverages/Perils',
  reasonDescription: 'CMBC SmokeAgent',
};

export const cmbcCancellation = {
  reasonCode: 'Insured Request',
  reasonDescription: 'CMBC SmokeAgent',
  refundBasis: 'Pro-Rata',
  effectiveFrom: cancellationDate(), // mid-term cancellation takes effect today
};

export const cmbcReinstatement = { reasonDescription: 'CMBC SmokeAgent' };

export const cmbcAssignee = cmbc.env('TASK_ASSIGNEE') || 'Deena Yadav';
