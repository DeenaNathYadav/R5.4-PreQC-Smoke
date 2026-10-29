import { Locator, Page, expect } from '@playwright/test';

// Helpers for the Kendo UI widgets used across AdvantageGo screens.
// Kendo generates random input ids, so fields are located by their visible label.

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The form field (label + widget) container for a label, e.g. "Insured". */
export function fieldContainer(page: Page, label: string): Locator {
  // Some labels use &nbsp; between words ("Business&nbsp;Description"), so normalise it to a space.
  const text = `normalize-space(translate(., ' ', ' '))`;
  return page.locator(`xpath=//main//label[${text}="${label}"]/ancestor::div[.//input][1]`).first();
}

export function field(page: Page, label: string): Locator {
  return fieldContainer(page, label).locator('input').first();
}

/** Types into a Kendo autocomplete and picks the suggestion whose text ends with `option`. */
export async function selectAutocomplete(page: Page, label: string, search: string, option = search): Promise<void> {
  const input = field(page, label);
  await input.click();
  await input.fill('');
  await input.pressSequentially(search, { delay: 50 });
  await page
    .getByRole('option')
    .filter({ hasText: new RegExp(`${escapeRegExp(option)}\\s*$`) })
    .first()
    .click();
  await expect(input).toHaveValue(new RegExp(escapeRegExp(option)));
}

/** Kendo dropdown/combobox: only the ▼ button opens the list (clicking the text just focuses it). */
export async function selectDropdown(page: Page, label: string, option: string): Promise<void> {
  const container = fieldContainer(page, label);
  const match = page
    .getByRole('option')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(option)}\\s*$`) })
    .first();
  // The list sometimes doesn't open on the first click, so open it until the option shows
  await expect(async () => {
    if (!(await match.isVisible())) await container.locator('.k-input-button').click();
    await expect(match).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 40_000 });
  await match.click();
  await expect(container.locator('input').first()).toHaveValue(option);
}

/** Expands a collapsible form section (e.g. "Underwriter Details") if the field inside isn't visible yet. */
export async function expandSectionFor(page: Page, section: string, label: string): Promise<void> {
  if (await fieldContainer(page, label).isVisible()) return;
  const header = page.getByRole('button', { name: section, exact: true });
  const field = fieldContainer(page, label);
  // A section that is open but still rendering looks closed, and clicking it would collapse it: click again only after a
  // generous wait. (aria-expanded can't be trusted here: some sections report "true" while their content is hidden.)
  for (let attempt = 0; attempt < 2; attempt++) {
    await header.click();
    if (await field.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false)) return;
  }
  await expect(field).toBeVisible();
}

/**
 * Picks a date through the Kendo calendar popup (typing into the segmented date input is unreliable).
 * The calendar opens on the month of the field's current value (or the current month when it is empty).
 */
export async function selectDate(page: Page, label: string, date: Date): Promise<void> {
  await fieldContainer(page, label).getByRole('button', { name: 'Toggle calendar' }).click();
  const calendar = page.locator('.k-calendar').last();

  const shown = (await field(page, label).inputValue().catch(() => '')).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const today = shown ? new Date(Number(shown[3]), Number(shown[2]) - 1, Number(shown[1])) : new Date();
  const monthDiff = (date.getFullYear() - today.getFullYear()) * 12 + (date.getMonth() - today.getMonth());
  const nav = calendar.locator(monthDiff > 0 ? '.k-calendar-nav-next' : '.k-calendar-nav-prev');
  for (let i = 0; i < Math.abs(monthDiff); i++) await nav.click();

  // Day cells carry a full-date title, e.g. "Friday, October 2, 2026"
  const title = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  await calendar.locator(`td[title="${title}"]`).click();
}

/** dd/mm/yyyy, as displayed by AdvantageGo date fields. */
export function formatDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

// ---- Dialog-scoped variants (dialogs render outside <main>, so fieldContainer() can't find their labels) ----

/** The field (label + widget) container for a label inside a dialog. */
export function dialogField(dialog: Locator, label: string): Locator {
  return dialog
    .locator(
      `xpath=.//label[contains(normalize-space(),"${label}")]/ancestor::div[.//kendo-combobox or .//kendo-multiselect or .//kendo-dropdownlist or .//input][1]`,
    )
    .first();
}

/**
 * Single-select Kendo combobox in a dialog. Some lists show "Name" plus a short code (e.g. "Underwriting
 * Referral - PI" + "PI"), which are adjacent in the DOM text, so `option` matches the start of the option text.
 */
export async function selectDialogDropdown(page: Page, dialog: Locator, label: string, option: string): Promise<void> {
  // Some lists (e.g. Enter Name) are loaded from the API after the field is opened - and after the field before it is set
  // (the assignee list follows Task Type). Opened too early the list stays "NOT FOUND", so close it and open it again.
  const match = page.getByRole('option').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(option)}`) }).first();
  for (let attempt = 0; attempt < 5; attempt++) {
    await dialogField(dialog, label).locator('.k-input-button').first().click();
    if (await match.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true, () => false)) break;
    // Click the dialog's top-left corner to close the list (Escape would close the whole dialog)
    await dialog.click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(5_000);
  }
  await expect(match).toBeVisible({ timeout: 30_000 });
  await match.click();
  await expect(dialogField(dialog, label).locator('input').first()).toHaveValue(new RegExp(escapeRegExp(option)));
}

/** Kendo multiselect in a dialog: opens the list by clicking the input and picks one option. */
export async function selectDialogMulti(page: Page, dialog: Locator, label: string, option: string): Promise<void> {
  await dialogField(dialog, label).locator('input').first().click();
  await page.getByRole('option', { name: option, exact: true }).click();
  // Click the dialog's top-left corner to close the list and keep the chip (Escape would close the whole dialog)
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole('option', { name: option, exact: true })).toHaveCount(0);
  await expect(dialog.getByText(option, { exact: true }).first()).toBeVisible();
}
