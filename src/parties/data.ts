// The smoke suite's own parties, shared by every product on a host: copied from preQC's reference parties (Anjali Insured
// PTY00841599, Anjali,Intermediary PTY00840654, Agarwal,Nitin PTY00840433, Anjali,contact PTY00840655) with Smoke names and the
// suite's email address. They are found by display name and created only when missing (src/parties/ensure.ts).

export const SMOKE_EMAIL = 'deena.yadav@sapiens.com';

export interface ContactRow {
  type: string; // Email, Telephone
  category?: string; // Work, Mobile …
  description: string;
  value: string;
  primary?: boolean;
}

export interface AddressData {
  line1: string;
  line2?: string;
  town?: string;
  county?: string;
  postcode: string;
  country?: string;
}

export interface RoleData {
  role: string;
  /** "Additional Data" rows under the role, by name: text, a date (dd/mm/yyyy), true for a ticked box, or a list for a multi-select */
  additional?: Record<string, string | boolean | string[]>;
}

export interface LinkData {
  /** Display name of the other party (it must exist first) */
  party: string;
  relationship: string;
  from: Date;
  to: Date;
}

export type PartyData = {
  key: 'insured' | 'intermediary' | 'underwriter' | 'contact';
  /** Name the app shows (and the search finds): "Smoke Insured", or Surname,First for an individual */
  displayName: string;
  address: AddressData;
  contacts: ContactRow[];
  role: RoleData;
  links?: LinkData[];
  countryOfDomicile?: string;
} & ({ kind: 'Organisation'; fullName: string } | { kind: 'Individual'; firstName: string; surname: string });

const linkFrom = new Date(2026, 3, 1); // 01/04/2026, as on the reference insured's contact link
const linkTo = new Date(2029, 11, 31); // 31/12/2029

/** Copy of Anjali,contact: the insured's Main Contact and a child contact of the intermediary. */
export const smokeContact: PartyData = {
  key: 'contact',
  kind: 'Individual',
  firstName: 'Contact',
  surname: 'Smoke',
  displayName: 'Smoke,Contact',
  address: { line1: 'wewew', postcode: '3423' },
  contacts: [], // the reference has no contact details
  role: { role: 'Intermediary Contact' },
};

/** Copy of Anjali Insured (an Organisation). */
export const smokeInsured: PartyData = {
  key: 'insured',
  kind: 'Organisation',
  fullName: 'Smoke Insured',
  displayName: 'Smoke Insured',
  countryOfDomicile: 'UNITED KINGDOM',
  address: { line1: 'Shahdara delhi1', postcode: 'KT82JD', country: 'UNITED KINGDOM' },
  contacts: [
    { type: 'Email', category: 'Work', description: 'Test', value: SMOKE_EMAIL, primary: true },
    { type: 'Telephone', category: 'Mobile', description: 'Home', value: '4334' },
  ],
  role: {
    role: 'Insured',
    additional: {
      'Exempt from ERN Reference': true,
      'ERN Reference': '23232323',
      'Date Established': '01/04/2026',
      'Countries Trading With': ['UNITED KINGDOM'],
      'Countries Operated In': ['UNITED KINGDOM'],
      'Reason why ERN not entered': 'Exempt (below threshold)',
      'Company House Reference': 'C12345',
    },
  },
  links: [{ party: 'Smoke,Contact', relationship: 'Main Contact', from: linkFrom, to: linkTo }],
};

/** Copy of Anjali,Intermediary: the submission's agency (Agency Number 7401474, as the reference). */
export const smokeIntermediary: PartyData = {
  key: 'intermediary',
  kind: 'Individual',
  firstName: 'Intermediary',
  surname: 'Smoke',
  displayName: 'Smoke,Intermediary',
  address: { line1: '10', line2: 'Downing Street', town: 'London', county: 'City of London', postcode: 'SW1A 2AA', country: 'UNITED KINGDOM' },
  contacts: [{ type: 'Email', category: 'Work', description: 'Email', value: SMOKE_EMAIL, primary: true }],
  role: { role: 'Intermediary', additional: { 'Agency Number': '7401474', Branch: 'London Commercial' } },
  links: [{ party: 'Smoke,Contact', relationship: 'Child', from: linkFrom, to: linkTo }],
};

/**
 * What every product's submission is made with: the insured, the agency (typed "Smoke" to search, Agency Number filled in from the
 * intermediary's role) and the underwriter. NewSubmissionPage.open makes sure the parties exist first.
 */
export const smokeSubmissionParties = {
  insured: 'Smoke Insured',
  agencyName: 'Smoke,Intermediary',
  agencySearch: 'Smoke',
  agencyNumber: '7401474',
  underwriter: 'Smoke,Underwriter',
};

/** Copy of Agarwal,Nitin. */
export const smokeUnderwriter: PartyData = {
  key: 'underwriter',
  kind: 'Individual',
  firstName: 'Underwriter',
  surname: 'Smoke',
  displayName: 'Smoke,Underwriter',
  address: { line1: 'AXA', line2: 'Civic Drive', town: 'Ipswich', postcode: 'IP1 2AN' },
  contacts: [{ type: 'Email', category: 'Work', description: 'Email', value: SMOKE_EMAIL, primary: true }],
  role: { role: 'Underwriter', additional: { Branch: 'Birmingham', 'Business Title': 'Underwriter' } },
};
