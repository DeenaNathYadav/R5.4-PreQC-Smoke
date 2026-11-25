import { Locator, Page, expect } from '@playwright/test';
import { clickSave, waitForIdle } from './entity';
import { dialogField, field, fieldContainer, selectDateIn, selectDialogDropdown, selectDropdown } from './kendo';
import type { AddressData, ContactRow, LinkData, PartyData, RoleData } from '../../parties/data';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface FoundParty {
  reference: string;
  displayName: string;
}

/**
 * Parties (Create New → Individual / Organisation, and the header search's Party category). The details page has collapsible
 * sections whose "+" (title "Add New") opens a dialog: Contact Information → "Add New Contact", Assigned Roles → "Add New Role",
 * Linked Parties → "Add Link". A role's "Additional Data" (e.g. an intermediary's Agency Number) opens under its row's chevron.
 */
export class PartyPage {
  constructor(private readonly page: Page) {}

  /** Header search, category Party: the reference of the party whose Display Name is exactly `displayName`, or null. */
  async find(displayName: string): Promise<FoundParty | null> {
    // The app now and then draws the search before its labels or the result grid's columns have loaded (raw "COMMON.SEARCH…" keys, a
    // grid with no headers): search again from a fresh Dashboard, up to 3 times, before giving up
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.searchOnce(displayName);
      } catch (e) {
        if (attempt >= 3) throw e;
        await this.page.waitForTimeout(5_000);
      }
    }
  }

  private async searchOnce(displayName: string): Promise<FoundParty | null> {
    const { page } = this;
    await page.goto('/ui/home/dashboard');
    const keyword = page.getByPlaceholder('Enter keyword to search');
    await expect(keyword).toBeVisible({ timeout: 60_000 });
    await page.getByText('All', { exact: true }).first().click();
    await page.getByText('Party', { exact: true }).click();
    await keyword.fill(displayName);
    await keyword.press('Enter');
    // "No Results Found for …" or a collapsed group "Business organisations/ individuals (n)"
    const group = page.getByText(/Business organisations\/ individuals/).first();
    const none = page.getByText(/No Results Found/i).first();
    await expect(group.or(none).first()).toBeVisible({ timeout: 60_000 });
    if (await none.isVisible()) return null;
    // The group heading shows first and its "(n)" a moment later; opened before that, it stays closed and empty
    const panel = group.locator('xpath=ancestor::*[contains(normalize-space(.), "(")][1]');
    await expect(panel).toContainText(/individuals\s*\(\d+\)/, { timeout: 60_000 });
    const count = Number((await panel.innerText()).match(/individuals\s*\((\d+)\)/)![1]);
    if (!count) return null;
    // The party results grid (the dashboard's task grid stays on the page behind it)
    const grid = page.locator('.ag-root-wrapper').filter({ has: page.getByText('Party Reference', { exact: true }) }).first();
    await expect(async () => {
      if (!(await grid.isVisible())) await group.click();
      await expect(grid).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000, intervals: [2_000] });
    // A row is this party only when one of its cells is exactly the name ("Smoke Insured", not "Smoke Insured Test 2210"). The
    // reference is in the grid's pinned-left part, a separate row element with the same row-index, so cells are collected by row-index.
    const read = () =>
      grid.locator('.ag-row[row-index]').evaluateAll((els) => {
        const byIndex: Record<string, string[]> = {};
        for (const el of els) {
          const i = el.getAttribute('row-index')!;
          for (const cell of el.querySelectorAll('.ag-cell')) (byIndex[i] ??= []).push((cell.textContent ?? '').replace(/\s+/g, ' ').trim());
        }
        return Object.values(byIndex);
      });
    // The rows arrive a while after the group opens. Deciding too early that the party isn't there would create it a second time, so
    // keep reading for up to 30 s before answering "not found".
    for (const end = Date.now() + 30_000; ; await page.waitForTimeout(1_500)) {
      const matches = (await read().catch(() => [] as string[][])).filter((cells) => cells.includes(displayName));
      const references = matches.map((cells) => cells.find((c) => /^PTY\d+$/.test(c))).filter((r): r is string => !!r);
      // Several parties with this name (made before the search was fixed): use the oldest, the one the others were copied from
      if (references.length) return { reference: references.sort()[0], displayName };
      if (Date.now() > end) {
        if (matches.length) throw new Error(`Found "${displayName}" in the search but not its reference: the result grid has changed`);
        return null;
      }
    }
  }

  /** Opens a party from the search by its reference (a direct editParty link lands on the Dashboard). */
  async open(found: FoundParty): Promise<void> {
    const { page } = this;
    const link = page.getByText(found.reference, { exact: true }).first();
    // Right after find() the results are still on screen; otherwise search again
    if (!(await link.isVisible())) expect(await this.find(found.displayName), `${found.displayName} is found again`).not.toBeNull();
    await link.click();
    await expect(page.getByText('Assigned Roles', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  }

  /** Create New → Individual / Organisation: an empty party form. */
  async startNew(kind: 'Individual' | 'Organisation'): Promise<void> {
    const { page } = this;
    await page.goto('/ui/home/createNew');
    const label = page.getByText(kind, { exact: true }).first();
    await expect(label).toBeVisible({ timeout: 90_000 });
    // The tile (icon box) above the label opens the form; the label alone only highlights it
    const box = (await label.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y - 110);
    await page.waitForURL(`**/ui/party/createParty/${kind}`, { timeout: 60_000 });
    await expect(page.getByText(kind === 'Individual' ? 'First Name' : 'Full Name').first()).toBeVisible({ timeout: 60_000 });
  }

  async fillName(party: PartyData): Promise<void> {
    if (party.kind === 'Individual') {
      await field(this.page, 'First Name').fill(party.firstName);
      await field(this.page, 'Surname').fill(party.surname);
    } else {
      await field(this.page, 'Full Name').fill(party.fullName);
    }
    if (party.countryOfDomicile) await selectDropdown(this.page, 'Country of Domicile', party.countryOfDomicile);
  }

  async fillAddress(address: AddressData): Promise<void> {
    const { page } = this;
    await this.openSection('Primary Contact and Address Information', 'Address Line 1');
    await field(page, 'Address Line 1').fill(address.line1);
    if (address.line2) await field(page, 'Address Line 2').fill(address.line2);
    if (address.town) await field(page, 'Town/City').fill(address.town);
    if (address.county) await field(page, 'County/State').fill(address.county);
    await field(page, 'Zip/PostCode').fill(address.postcode);
    if (address.country) await selectDropdown(page, 'Country', address.country);
  }

  /** Contact Information → + → Add New Contact. */
  async addContact(contact: ContactRow): Promise<void> {
    const { page } = this;
    const dialog = await this.addNew('Contact Information', 'Add New Contact');
    await selectDialogDropdown(page, dialog, 'Type', contact.type);
    if (contact.category) await selectDialogDropdown(page, dialog, 'Category', contact.category);
    await this.fillDialogValue(dialog, 'Description', contact.description);
    await this.fillDialogValue(dialog, 'Value', contact.value);
    if (contact.primary) await dialogField(dialog, 'Primary').locator('input[type=checkbox]').first().check();
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(this.sectionBody('Contact Information').getByText(contact.value, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  }

  /** Assigned Roles → + → Add New Role (set active). The role's Additional Data is filled after the party is saved. */
  async addRole(role: RoleData): Promise<void> {
    const { page } = this;
    const dialog = await this.addNew('Assigned Roles', 'Add New Role');
    await selectDialogDropdown(page, dialog, 'Role Type', role.role);
    const active = dialog.getByText('Set as Active', { exact: true }).locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]').locator('input[type=checkbox]').first();
    if ((await active.count()) && !(await active.isChecked())) await active.check({ force: true });
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(this.roleRow(role.role)).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Assigned Roles → the role's chevron → Additional Data. A new role has no rows: "+" opens "Add Additional Fields", where the fields
   * are chosen, then each row's value is set in the grid and the grid is saved with its own save icon. Fields already there are
   * kept as they are. Returns the fields that were added.
   */
  async fillRoleData(role: RoleData): Promise<string[]> {
    if (!role.additional) return [];
    const { page } = this;
    await this.openSection('Assigned Roles');
    const additional = page.getByText('Additional Data', { exact: true }).first();
    // The role row's arrow opens it. The page redraws a moment after it opens (the sanction check updates its status) and right after
    // a save, which closes the row again: so open it, and open it again whenever it has closed.
    const expand = () =>
      expect(async () => {
        if (await additional.isVisible()) return;
        const arrow = this.roleRow(role.role).locator('.ag-group-contracted:not(.ag-hidden)').first();
        await arrow.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await arrow.click({ timeout: 5_000 });
        await expect(additional).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000, intervals: [2_000] });
    await waitForIdle(page);
    await expand();
    const tools = additional.locator('xpath=ancestor::*[.//button[@title="Add New"]][1]');
    const grid = additional.locator('xpath=following::div[contains(@class,"ag-root-wrapper")][1]');
    // The row whose name cell is the field ("Branch*" for a mandatory one); the value cell can share its line ("1 item(s) selected")
    const dataRow = (name: string) =>
      grid
        .locator('.ag-center-cols-container .ag-row')
        .filter({ has: page.locator('.ag-cell').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*\\*?\\s*$`) }) })
        .first();

    // Which fields are missing: only trusted when Additional Data stayed open while reading and two readings 3 s apart agree, so a row
    // that closed (or rows still filling in) is never taken for missing fields, which would add them a second time.
    const readMissing = async () => {
      await expand();
      await grid.locator('.ag-center-cols-container .ag-row').first().waitFor({ timeout: 5_000 }).catch(() => {});
      const names: string[] = [];
      for (const name of Object.keys(role.additional!)) if (!(await dataRow(name).isVisible())) names.push(name);
      return (await additional.isVisible()) ? names.join('|') : null;
    };
    let missingKey: string | null = null;
    await expect(async () => {
      const first = await readMissing();
      await page.waitForTimeout(3_000);
      const second = await readMissing();
      expect(first !== null && first === second, 'Additional Data read twice the same, with the role row open').toBe(true);
      missingKey = first;
    }).toPass({ timeout: 90_000, intervals: [2_000] });
    const missing = missingKey ? (missingKey as string).split('|') : [];
    if (!missing.length || this.checkOnly) return missing;

    await expand();
    await tools.locator('button[title="Add New"]').first().click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Add Additional Fields' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    for (const name of missing) {
      await dialogField(dialog, 'Additional Fields').locator('input').first().click();
      await page.getByRole('option').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }).first().click();
    }
    // Click the dialog's top-left corner to close the list (Escape would close the whole dialog)
    await dialog.click({ position: { x: 4, y: 4 } });
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    for (const name of missing) {
      const value = role.additional[name];
      const row = dataRow(name);
      await expect(row, `Additional Data row "${name}"`).toBeVisible({ timeout: 30_000 });
      await row.scrollIntoViewIfNeeded();
      if (value === true) {
        const box = row.locator('input[type=checkbox]').first();
        if (!(await box.isChecked())) await box.check({ force: true });
      } else if (value === false) {
        continue;
      } else if (Array.isArray(value)) {
        for (const item of value) {
          await row.locator('kendo-multiselect input, .k-multiselect input').first().click();
          await page.getByRole('option', { name: item, exact: true }).first().click();
          await page.keyboard.press('Tab');
        }
      } else if (await row.locator('kendo-combobox, kendo-dropdownlist').count()) {
        await row.locator('.k-input-button').first().click();
        await page.getByRole('option').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`) }).first().click();
      } else if (await row.locator('kendo-datepicker, kendo-dateinput').count()) {
        const input = row.locator('input').first();
        await input.click();
        await input.pressSequentially(value.replace(/\D/g, ''), { delay: 50 }); // dd/mm/yyyy, typed as digits into the segments
        await expect(input).toHaveValue(value);
      } else {
        await row.locator('input').first().fill(value);
      }
    }
    // The grid's save icon asks "All additional data fields with null/blank values will be removed": Ok. Then the party's own Save
    // stores it.
    await tools.locator('button[title="Save"]').first().click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'null/blank values will be removed' });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole('button', { name: 'Ok', exact: true }).click();
    await expect(confirm).toBeHidden({ timeout: 30_000 });
    await clickSave(page);
    await waitForIdle(page);
    return missing;
  }

  /** Linked Parties → + → Add Link to an existing party. */
  async addLink(link: LinkData): Promise<void> {
    const { page } = this;
    const dialog = await this.addNew('Linked Parties', 'Add Link');
    const name = dialogField(dialog, 'Party Name').locator('input').first();
    const suggestion = page.getByRole('option').filter({ hasText: new RegExp(escapeRegExp(link.party)) }).first();
    await expect(async () => {
      await name.fill('');
      await name.pressSequentially(link.party.split(',')[0], { delay: 50 });
      await expect(suggestion).toBeVisible({ timeout: 12_000 });
    }).toPass({ timeout: 90_000, intervals: [2_000] });
    await suggestion.click();
    await selectDialogDropdown(page, dialog, 'Relationship', link.relationship);
    await selectDateIn(page, dialogField(dialog, 'Effective From'), link.from);
    await selectDateIn(page, dialogField(dialog, 'Effective To'), link.to);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  }

  /** Saves the party; returns its new reference (shown in the header once saved). */
  async save(): Promise<string> {
    const { page } = this;
    await clickSave(page);
    // The header's "Party Reference" (other PTY… references show in the Linked Parties grid)
    const reference = page.locator('xpath=//label[normalize-space()="Party Reference"]/following-sibling::div[1]').first();
    // "A duplicate party was found … Do you want to review them?": stop rather than answer it. "No" saves the party anyway, and a
    // second copy of a smoke party is never wanted (find() decides whether one exists).
    const duplicate = page.getByRole('dialog').filter({ hasText: 'A duplicate party was found' });
    for (const end = Date.now() + 120_000; ; await page.waitForTimeout(1_000)) {
      if (await duplicate.isVisible()) {
        throw new Error('The app reports a possible duplicate party: not saved. Check the party search before creating it again.');
      }
      if (/PTY\d+/.test((await reference.textContent().catch(() => '')) ?? '')) break;
      if (Date.now() > end) throw new Error('The party was not saved: no Party Reference after 2 minutes');
    }
    return (await reference.innerText()).match(/PTY\d+/)![0];
  }

  /** The party's sections as they are now, for a check that the saved party has what was entered. */
  /** Opened fresh from the search: the party has its role, every Additional Data field, contact detail and link. */
  async expectSaved(party: PartyData, found: FoundParty): Promise<void> {
    await this.open(found);
    await this.openSection('Assigned Roles');
    await expect(this.roleRow(party.role.role), `role ${party.role.role}`).toBeVisible({ timeout: 30_000 });
    this.checkOnly = true;
    try {
      expect(await this.fillRoleData(party.role), `${party.displayName}: Additional Data fields missing after saving`).toEqual([]);
    } finally {
      this.checkOnly = false;
    }
    for (const contact of party.contacts) {
      await this.openSection('Contact Information');
      await expect(this.sectionBody('Contact Information').getByText(contact.value).first(), `contact ${contact.value}`).toBeVisible({ timeout: 30_000 });
    }
    for (const link of party.links ?? []) {
      await this.openSection('Linked Parties');
      // The grid shows the linked party as "Smoke,Contact-(PTY…)"
      await expect(this.sectionBody('Linked Parties').getByText(link.party).first(), `link to ${link.party}`).toBeVisible({ timeout: 30_000 });
    }
  }

  /** fillRoleData only reports the missing fields (expectSaved) */
  private checkOnly = false;

  // ---- helpers

  /** A section's header is an accordion button ("Contact Information", "Assigned Roles" …). */
  private header(section: string): Locator {
    return this.page.locator('button.accordion-button').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(section)}\\s*$`) }).first();
  }

  /** The section: the div.panel that holds its header, its "+" (title "Add New") and its grid. */
  private sectionBody(section: string): Locator {
    return this.header(section).locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," panel ")][1]');
  }

  /** Opens a collapsed section; `probe` is a label inside it (default: its grid) to tell open from closed. */
  private async openSection(section: string, probe?: string): Promise<void> {
    const inside = probe ? fieldContainer(this.page, probe) : this.sectionBody(section).locator('.ag-root-wrapper').first();
    if (await inside.isVisible().catch(() => false)) return;
    await this.header(section).scrollIntoViewIfNeeded();
    await this.header(section).click();
    await expect(inside).toBeVisible({ timeout: 30_000 });
  }

  /** Opens the section, presses its "+" (title "Add New") and returns the dialog that opens. */
  private async addNew(section: string, dialogTitle: string): Promise<Locator> {
    const { page } = this;
    await this.openSection(section);
    await this.sectionBody(section).locator('button[title="Add New"]').first().click();
    const dialog = page.getByRole('dialog').filter({ hasText: dialogTitle });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    return dialog;
  }

  /** A dialog field that is either free text or a list. */
  private async fillDialogValue(dialog: Locator, label: string, value: string): Promise<void> {
    const container = dialogField(dialog, label);
    if (await container.locator('kendo-combobox, kendo-dropdownlist').count()) await selectDialogDropdown(this.page, dialog, label, value);
    else await container.locator('input, textarea').first().fill(value);
  }

  private roleRow(role: string): Locator {
    return this.sectionBody('Assigned Roles').locator('.ag-row').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(role)}\\s*$`, 'm') }).first();
  }
}
