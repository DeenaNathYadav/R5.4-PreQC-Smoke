// Small console helpers shared by the reporters: colours only when the output is a terminal (or FORCE_COLOR is set).
const enabled = !!process.stdout.isTTY || !!process.env.FORCE_COLOR;
const paint256 = (n: number) => (s: string) => (enabled ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);
const paint = (code: number) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  green: paint256(40), // passed
  orange: paint256(208), // skipped
  red: paint256(196), // failed
  yellow: paint256(208), // kept for older callers: same orange
  cyan: paint(36),
  dim: paint(2),
  bold: paint(1),
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export const seconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`);

/** "PI - Quote lifecycle" → "Quote lifecycle" (the product is already in the header). */
export const withoutProduct = (title: string) => title.replace(/^[A-Za-z]+ - /, '').replace(/^([A-Za-z]+) smoke$/, 'Smoke checks');
