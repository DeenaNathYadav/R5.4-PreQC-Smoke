/** Days before today that every product's inception date is set to (submission Incepts On and Model-copy quotes). */
export const INCEPTION_DAYS_BEFORE_TODAY = 10;

/** Midnight today plus `days` (negative = in the past). */
export function daysFromToday(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

/** Inception date used for every new submission / Model copy: today minus INCEPTION_DAYS_BEFORE_TODAY. */
export const inceptionDate = (): Date => daysFromToday(-INCEPTION_DAYS_BEFORE_TODAY);

/** Effective date of a mid-term cancellation: today. */
export const cancellationDate = (): Date => daysFromToday(0);
