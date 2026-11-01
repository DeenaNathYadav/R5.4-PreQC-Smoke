import path from 'path';
import { SubmissionData } from '../../pages/advantagego/NewSubmissionPage';
import { ConvertToQuoteData, SubmissionDetails } from '../../pages/advantagego/SubmissionPage';
import { TaskData } from '../../pages/advantagego/QuotePage';
import { UploadData } from '../../pages/advantagego/QuoteDocumentsPage';
import { fleet } from '.';
import { cancellationDate, inceptionDate } from '../../support/dates';

// QC test data for the Fleet smoke flows.
export const fleetSubmission = (): SubmissionData => ({
  insured: 'Anjali Insured demo',
  agencyName: 'Anjali,Intermediary',
  agencySearch: 'Anjali',
  agencyNumber: '7401474',
  inceptsOn: inceptionDate(),
  businessDescription: `Fleet Smoke ${new Date().toISOString().slice(0, 16)}`,
});

export const fleetSubmissionDetails: SubmissionDetails = {
  transactionType: 'New Business',
  businessCategory: 'SME',
  underwriter: 'Agarwal,Nitin',
};

// The product defaults Insurance Type / Contract Structure. Conversion needs the three Risk Validation questions answered
// (the values the Fleet reference quote carries).
export const fleetQuote: ConvertToQuoteData = {
  product: 'Fleet',
  insuranceType: 'Direct',
  contractStructure: 'Open Market',
  analysisCodes: [
    { type: 'Trade sector', value: 'Section N' },
    { type: 'SIC Trade Division', value: '79' },
    { type: 'SIC Trade Group', value: '79.1' },
    { type: 'SIC Trade Class', value: '79.11' },
    { type: 'AXA Trade Description', value: '7911000' },
  ],
  requiredQuestions: [
    { section: 'Risk Validation', question: '1. Haulage Fact Finder received', value: 'No' },
    { section: 'Risk Validation', question: '2. What is the risk classification', value: 'Green - Preferred' },
    { section: 'Risk Validation', question: '3. Has this risk been referred to a Level 7 licence holder', value: 'Yes' },
  ],
};

// Details → Claims Experience Analysis → Years Claims Experience → "Number of years claims experience". A value above 0 makes the
// quote eligible for ⋮ → Experience Call, which Fleet runs before Next Stage / Get Price ("An Experience Call is required to proceed").
// Each year of experience also needs its row in that section's table filled ("VehicleYearsEarned is required for each year of
// claims experience"): Vehicle Years Earned, and the number of claims (Claim Count: All) in the most recent year.
export const fleetClaims = { years: '1', vehicleYearsEarned: '10', claimCount: '1' };

// Quote → Sections. Choosing the offering creates the FLEET risk section with its covers (COMP, TPFT, TPO, Laid Up); Main Cover Type
// and Fleet Type Reason are defaulted, the other Risk Details are answered with these values. The quote created from the submission
// is the model every other Fleet quote is a ⋮ → Model copy of (there is no fixed reference quote).
export const fleetSections = {
  riskSection: 'FLEET',
  offering: 'Vantage Fleet',
  riskDetails: {
    'Declaration Basis': 'Immediate',
    'Survey Required': 'Yes',
    'Does the risk utilise an existing telematics system?': 'Yes',
    'Will that telematics data be shared with us upon request?': 'Yes',
    'Driving Restriction - Minimum Age': '21',
    'Driving Restriction - Minimum Years Licence Held': 'One',
    'Valet Parking': 'Yes',
  } as Record<string, string>,
  // Excess tab: "Sel Excess" is required for each excess type when Main Cover Type is COMP
  selectedExcess: '250',
};

// Details → Submission Information → Risk Postcode ("Risk Post Code is required to Get Price")
export const fleetRiskPostcode = 'KT82JD';

// Details → Underwriter Picks → UW ACCPV Pick (£): required when "UW Pick" is the UW Period Choice
export const fleetUwAccpvPick = '10000';

// Details → Underwriter Picks → UW Period Choice ("UW Period Choice is required to Get Price")
export const fleetUwPeriodChoice = 'UW Pick';

// Details → Commission: the Broker Commission row is updated (or added when missing) with this Override %
export const fleetCommission = { brokerPercent: '12' };

export const fleetScheduleFile = path.resolve(
  fleet.env('SCHEDULE_IMPORT') || path.join(__dirname, '../../../FLEET/FLEET_Schedule_Import.xlsx'),
);

export const fleetAssignee = fleet.env('TASK_ASSIGNEE') || 'Deena Yadav';

// Quote → ⋮ → Create Task. Fleet has its own referral type (FLEET_TASK_TYPE overrides).
export const fleetTask: TaskData = {
  taskType: fleet.env('TASK_TYPE') || 'Underwriting Referral - FLE',
  reason: 'Data Validation',
  assignee: fleetAssignee,
  subject: `Fleet smoke task ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, // unique per run: a Model copy carries older tasks
};

export const fleetDocument: UploadData = {
  filePath: path.resolve(__dirname, '../../assets/smoke-doc.pdf'),
  documentType: 'Quote',
};

export const fleetDecline = { reason: 'Decline - Other', description: 'Fleet smoke test: declined by automation' };
// Not Taken Up / Mark as Lost: no fixed reason (the first one the list offers is used and reported); the description is mandatory
export const fleetNotTakenUp = { description: 'Fleet smoke test: not taken up by automation' };
// Vehicle added, then changed, then deleted by hand on the schedule grid of a Model copy
export const fleetManualVehicle = { registration: 'SM24AUT', updatedRegistration: 'SM24AUU' };
export const fleetLost = { description: 'Fleet smoke test: marked as lost by automation' };

export const fleetEndorsement = {
  endorsementType: 'General',
  effectiveFromDaysAfterInception: 10,
  reasonCode: 'Addition/Deletion of Covers/Coverages/Perils',
  reasonDescription: 'Fleet SmokeAgent',
  declaration: 'No Declaration', // mandatory on Fleet
};

export const fleetCancellation = {
  reasonCode: 'Insured Request',
  reasonDescription: 'Fleet SmokeAgent',
  refundBasis: 'Pro-Rata',
  // Fleet's cancellation form has Effective From fixed (the term start) and Effective To empty and mandatory
  effectiveToDaysAfterInception: 10,
  declaration: 'No Declaration',
};

export const fleetReinstatement = { reasonDescription: 'Fleet SmokeAgent' };
