// Small console helpers shared by the reporters and the runner: colours only when the output is a terminal (or FORCE_COLOR is set).
const enabled = (!!process.stdout.isTTY || !!process.env.FORCE_COLOR) && process.env.FORCE_COLOR !== '0' && !process.env.NO_COLOR;
const paint256 = (n: number) => (s: string) => (enabled ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);
const paint = (code: number) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  green: paint256(40), // passed
  orange: paint256(208), // skipped
  red: paint256(196), // failed
  magenta: paint256(170), // blocked by a failed blocking step
  yellow: paint256(208), // kept for older callers: same orange
  cyan: paint(36),
  dim: paint(2),
  bold: paint(1),
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export const seconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`);

/** "PI - Quote lifecycle" → "Quote lifecycle" (the product is already in the header). */
export const withoutProduct = (title: string) => title.replace(/^[A-Za-z]+ - /, '').replace(/^([A-Za-z]+) smoke$/, 'Smoke checks');

/** Cuts a (coloured) line to `width` visible characters, ending it with "…". */
export function truncate(s: string, width: number): string {
  if (stripAnsi(s).length <= width) return s;
  let out = '';
  let visible = 0;
  for (let i = 0; i < s.length && visible < width - 1; i++) {
    const esc = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (esc) {
      out += esc[0];
      i += esc[0].length - 1;
      continue;
    }
    out += s[i];
    visible++;
  }
  return out + '…' + (enabled ? '\x1b[0m' : '');
}

/** ━━━━━━──────  (done of total); `ascii` draws #####----- for lines that must keep an exact width (the live status line). */
export function progressBar(done: number, total: number, width = 20, ascii = false): string {
  const filled = total ? Math.round((done / total) * width) : 0;
  const [on, off] = ascii ? ['#', '-'] : ['━', '─'];
  return color.green(on.repeat(filled)) + color.dim(off.repeat(width - filled));
}

/** Lines in a rounded box, as wide as the longest line (and no wider than the terminal). */
export function box(lines: string[]): string {
  const max = (process.stdout.columns || 120) - 6;
  const shown = lines.map((l) => truncate(l, max));
  const width = Math.max(...shown.map((l) => stripAnsi(l).length));
  const edge = (l: string, r: string) => color.dim(`  ${l}${'─'.repeat(width + 2)}${r}`);
  return [
    edge('╭', '╮'),
    ...shown.map((l) => `${color.dim('  │')} ${l}${' '.repeat(width - stripAnsi(l).length)} ${color.dim('│')}`),
    edge('╰', '╯'),
  ].join('\n');
}
