import type { Page } from '@playwright/test';
import { FoundParty, PartyPage } from '../pages/advantagego/PartyPage';
import { PartyData, smokeContact, smokeInsured, smokeIntermediary, smokeUnderwriter } from './data';

let smokePartiesChecked = false;

/**
 * Before a submission: Smoke Insured, Smoke,Intermediary and Smoke,Underwriter exist (each created if missing). Done once per worker;
 * existing parties are used as they are (the party tests are the ones that also complete their role data).
 */
export async function ensureSmokeParties(page: Page): Promise<void> {
  if (smokePartiesChecked) return;
  const parties = new PartyPage(page);
  for (const party of [smokeInsured, smokeIntermediary, smokeUnderwriter]) {
    if (!(await parties.find(party.displayName))) await ensureParty(page, party);
  }
  smokePartiesChecked = true;
}

export interface EnsuredParty extends FoundParty {
  created: boolean;
  /** Role "Additional Data" fields an existing party was missing and got (e.g. after a run that stopped half-way) */
  completed: string[];
}

/**
 * The party with `party.displayName`: found by the header search, or created from `party` when it doesn't exist yet (the parties it
 * links to first). Safe to call from every run and every product: an existing party is used as it is, except that a role's
 * Additional Data it lacks (the intermediary's Agency Number, say, which the submission needs) is added.
 */
export async function ensureParty(page: Page, party: PartyData): Promise<EnsuredParty> {
  const parties = new PartyPage(page);
  const found = await parties.find(party.displayName);
  if (found) {
    if (!party.role.additional) return { ...found, created: false, completed: [] };
    await parties.open(found);
    const completed = await parties.fillRoleData(party.role);
    if (completed.length) await parties.expectSaved(party, found);
    return { ...found, created: false, completed };
  }

  // A link needs the other party to exist (only Smoke,Contact is linked to)
  for (const link of party.links ?? []) if (link.party === smokeContact.displayName) await ensureParty(page, smokeContact);

  await parties.startNew(party.kind);
  await parties.fillName(party);
  await parties.fillAddress(party.address);
  for (const contact of party.contacts) await parties.addContact(contact);
  await parties.addRole(party.role);
  for (const link of party.links ?? []) await parties.addLink(link);
  const reference = await parties.save();
  await parties.fillRoleData(party.role);
  await parties.expectSaved(party, { reference, displayName: party.displayName });
  return { reference, displayName: party.displayName, created: true, completed: [] };
}
