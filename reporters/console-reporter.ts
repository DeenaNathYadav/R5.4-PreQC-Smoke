import fs from 'fs';
import path from 'path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { box, color, progressBar, seconds, stripAnsi, truncate, withoutProduct } from './format';
import { writeFileAtomic } from '../src/config/auth';

type Outcome = 'passed' | 'failed' | 'blocked' | 'skipped' | 'notRun';

interface Ended {
  test: TestCase;
  group: string;
  title: string;
  outcome: Outcome;
  reason: string;
  ms: number;
  artifacts?: string;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Annotations worth showing next to a passed test: the contracts it made, the premium it got, a commission fallback
const SHOWN = ['submission', 'quote', 'policy', 'documents', 'multi quote', 'requote', 'premium', 'commission added by hand', 'commission not rated'];

/**
 * Console output for the smoke runs, replacing Playwright's "list" reporter:
 *  - a header (product, tests, workers, run id), then the tests grouped under their section (Quote, Policy, Cancellation …), one
 *    line each: ✔ passed · ✘ failed (reason right underneath) · ⊘ blocked by a failed blocking step · ○ skipped on purpose
 *  - in a terminal, a live line at the bottom: progress bar, elapsed time, the tests running now and what they last printed
 *  - what the tests print with console.log goes to run.log in the report folder instead of cluttering the console
 *  - a summary: verdict, total time, counts, a table per section, the failures with their trace, the command that re-runs them
 *  - results/last-failed/<product>.json remembers what failed or was blocked: `npm run smoke:failed` (see rememberFailures)
 *  - summary.json in the report folder (counts incl. blocked) for the runner's table
 * Options: { outputDir } (the run's report folder; default results/).
 */
export default class ConsoleReporter implements Reporter {
  private total = 0;
  private done = 0;
  private lastGroup = '';
  private ended: Ended[] = [];
  private log?: number;
  private started = Date.now();
  private product = '';
  private running = new Map<TestCase, { since: number; last: string }>();
  private live = !!process.stdout.isTTY && !process.env.CI;
  private timer?: NodeJS.Timeout;
  private frame = 0;
  /** Several workers interleave the sections: then each line names its section instead of a heading per section. */
  private sectionColumn = 0;

  constructor(private readonly options: { outputDir?: string } = {}) {}

  private dir(): string {
    return path.resolve(this.options.outputDir ?? 'results');
  }

  // ------------------------------------------------------------------ output helpers
  /** Prints a line above the live status line. */
  private print(line = ''): void {
    this.clearLive();
    console.log(line);
    this.renderLive();
  }

  private clearLive(): void {
    if (this.live) process.stdout.write('\r\x1b[2K');
  }

  private renderLive(): void {
    if (!this.live || !this.timer) return;
    // The line must never wrap: "\r" only returns to the start of the last screen row, so a wrapped line leaves a copy behind on
    // every redraw. Some terminals draw box and arrow symbols two columns wide, hence the margin and the plain ASCII markers.
    const width = Math.max(20, Math.min(160, (process.stdout.columns || 100) - 12));
    const spin = color.cyan(SPINNER[this.frame++ % SPINNER.length]);
    const head = `  ${spin} ${progressBar(this.done, this.total, 16, true)} ${color.bold(`${this.done}/${this.total}`)}  ${color.dim(seconds(Date.now() - this.started))}`;
    const now = [...this.running].map(([t, r]) => {
      const last = r.last ? color.dim(` - ${r.last}`) : '';
      return `${color.cyan('>')} ${t.title} ${color.dim(seconds(Date.now() - r.since))}${last}`;
    });
    const line = `${head}   ${now.join('   ') || color.dim('starting…')}`;
    process.stdout.write('\r\x1b[2K' + truncate(line, width));
  }

  // ------------------------------------------------------------------ reporter
  onBegin(config: FullConfig, suite: Suite): void {
    const tests = suite.allTests();
    this.total = tests.length;
    const products = [...new Set(tests.map((t) => t.titlePath()[1]).filter(Boolean))];
    this.product = products.length === 1 ? products[0] : '';
    fs.mkdirSync(this.dir(), { recursive: true });
    this.log = fs.openSync(path.join(this.dir(), 'run.log'), 'a');
    const project = config.projects.find((p) => p.name === this.product);
    const host = (() => {
      try {
        return project?.use?.baseURL ? new URL(project.use.baseURL).host : '';
      } catch {
        return '';
      }
    })();
    const title = this.product ? `${String(project?.metadata?.title ?? this.product)} smoke` : 'Smoke tests';
    this.print();
    this.print(
      box([
        `${color.bold(title)}${host ? color.dim(`  ·  ${host}`) : ''}`,
        color.dim(
          [`${this.total} tests`, products.length > 1 ? products.join(', ') : '', `${config.workers} worker${config.workers === 1 ? '' : 's'}`, process.env.SMOKE_RUN_ID ? `run ${process.env.SMOKE_RUN_ID}` : '']
            .filter(Boolean)
            .join('  ·  '),
        ),
        color.dim(`started ${new Date().toLocaleTimeString()}  ·  ✔ passed  ✘ failed  ⊘ blocked  ○ skipped`),
      ]),
    );
    this.print();
    if (config.workers > 1) this.sectionColumn = Math.min(18, Math.max(0, ...tests.map((t) => groupOf(t).length)));
    if (this.live) {
      this.timer = setInterval(() => this.renderLive(), 250);
      this.timer.unref();
    }
  }

  onTestBegin(test: TestCase): void {
    this.running.set(test, { since: Date.now(), last: '' });
    this.renderLive();
  }

  onStdOut(chunk: string | Buffer, test?: TestCase): void {
    this.capture(chunk, test);
  }

  onStdErr(chunk: string | Buffer, test?: TestCase): void {
    this.capture(chunk, test);
  }

  private capture(chunk: string | Buffer, test?: TestCase): void {
    const text = chunk.toString();
    if (this.log !== undefined) fs.writeSync(this.log, text);
    const run = test && this.running.get(test);
    const last = stripAnsi(text).split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (run && last) run.last = last.slice(0, 80);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.running.delete(test);
    const group = groupOf(test);
    const title = test.title;
    const failed = result.status !== 'passed' && result.status !== 'skipped';
    if (failed && result.retry < test.retries) {
      this.print(`    ${color.orange('↻')} ${color.orange(title)}  ${color.dim(`failed, retry ${result.retry + 1} of ${test.retries}…`)}`);
      return;
    }
    this.done++;
    if (!this.sectionColumn && group !== this.lastGroup) {
      if (this.lastGroup) this.print();
      this.print(`  ${color.cyan(color.bold(group))}`);
      this.lastGroup = group;
    }
    const section = this.sectionColumn ? `${color.cyan(truncate(group, this.sectionColumn).padEnd(this.sectionColumn))}  ` : '';
    const n = `${color.dim(String(this.done).padStart(String(this.total).length))}  ${section}`;
    const time = result.duration ? color.dim(seconds(result.duration)) : '';
    // Playwright lists runtime annotations both on the result and on the test: keep each once
    const annotations = [...(result.annotations ?? []), ...test.annotations].filter(
      (a, i, all) => all.findIndex((b) => b.type === a.type && b.description === a.description) === i,
    );
    const entry: Ended = { test, group, title, outcome: 'passed', reason: '', ms: result.duration };

    if (result.status === 'skipped') {
      const skip = annotations.find((a) => a.type === 'skip')?.description ?? '';
      if (skip.startsWith('Blocked:')) {
        entry.outcome = 'blocked';
        entry.reason = skip.replace(/^Blocked:\s*/, '');
        // The blocking step's own line already shows why it failed: name the step only
        const step = entry.reason.match(/^"([^"]+)"/)?.[1] ?? entry.reason;
        this.print(fit(`    ${color.magenta('⊘')} ${n}${color.magenta(title)}  ${color.dim(`blocked by "${step}"`)}`));
      } else if (annotations.some((a) => a.type === 'fixme' || a.type === 'skip')) {
        entry.outcome = 'skipped';
        entry.reason = skip || 'not automated (fixme)';
        this.print(`    ${color.orange('○')} ${n}${color.orange(title)}  ${color.dim(entry.reason)}`);
      } else {
        entry.outcome = 'notRun';
        entry.reason = 'not run (interrupted or an earlier step stopped the run)';
        this.print(`    ${color.orange('○')} ${n}${color.orange(title)}  ${color.dim(entry.reason)}`);
      }
    } else if (result.status === 'passed') {
      const extra = annotations
        .filter((a) => SHOWN.includes(a.type) && a.description)
        .map((a) => `${a.type} ${shortValue(a.type, a.description!)}`)
        .join(' · ');
      this.print(`    ${color.green('✔')} ${n}${title}  ${time}${extra ? color.dim(`  ${truncate(extra, 90)}`) : ''}`);
    } else {
      entry.outcome = 'failed';
      const message = stripAnsi(result.error?.message ?? result.errors?.[0]?.message ?? result.status);
      entry.reason = result.status === 'timedOut' ? `timed out after ${seconds(result.duration)}` : message.split('\n').map((l) => l.trim()).filter(Boolean)[0]?.replace(/^Error:\s*/, '').slice(0, 170) ?? result.status;
      const trace = result.attachments.find((a) => a.name === 'trace' && a.path)?.path;
      entry.artifacts = trace ? path.relative(process.cwd(), trace) : undefined;
      this.print(`    ${color.red('✘')} ${n}${color.red(color.bold(title))}  ${time}`);
      this.print(fit(`         ${color.red('└ ' + entry.reason)}`)); // the full reason is in the Failures list at the end
    }
    this.ended.push(entry);
  }

  onEnd(result: FullResult): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearLive();
    if (this.log !== undefined) fs.closeSync(this.log);
    const count = (o: Outcome) => this.ended.filter((e) => e.outcome === o).length;
    const [passed, failed, blocked, skipped, notRun] = (['passed', 'failed', 'blocked', 'skipped', 'notRun'] as Outcome[]).map(count);
    const elapsed = Date.now() - this.started;
    const ok = !failed && result.status === 'passed';

    // Verdict + counts
    const verdict = ok ? color.green(color.bold(' ✔ PASSED ')) : color.red(color.bold(result.status === 'interrupted' ? ' ✘ INTERRUPTED ' : ' ✘ FAILED '));
    const pill = (n: number, label: string, paint: (s: string) => string) => (n ? paint(color.bold(`${label} ${n}`)) : color.dim(`${label} 0`));
    console.log();
    console.log(
      box([
        `${verdict}   ${color.bold(`Total time ${seconds(elapsed)}`)}${color.dim(`   ·   ${this.ended.length} tests   ·   finished ${new Date().toLocaleTimeString()}`)}`,
        [pill(passed, '✔ passed', color.green), pill(failed, '✘ failed', color.red), pill(blocked, '⊘ blocked', color.magenta), pill(skipped + notRun, '○ skipped', color.orange)].join('    '),
      ]),
    );

    // Per section
    const groups = [...new Set(this.ended.map((e) => e.group))];
    if (groups.length > 1) {
      const width = Math.max(...groups.map((g) => g.length), 7);
      console.log(`\n  ${color.dim('Section'.padEnd(width))}   ${color.dim('  ✔    ✘    ⊘    ○     time')}`);
      for (const g of groups) {
        const rows = this.ended.filter((e) => e.group === g);
        const c = (o: Outcome[]) => String(rows.filter((r) => o.includes(r.outcome)).length).padStart(3);
        const f = rows.some((r) => r.outcome === 'failed');
        const name = f ? color.red(g.padEnd(width)) : g.padEnd(width);
        const ms = rows.reduce((s, r) => s + r.ms, 0);
        console.log(`  ${name}   ${color.green(c(['passed']))}  ${color.red(c(['failed']))}  ${color.magenta(c(['blocked']))}  ${color.orange(c(['skipped', 'notRun']))}  ${color.dim(seconds(ms).padStart(8))}`);
      }
    }

    // Failures, with what to open
    const failures = this.ended.filter((e) => e.outcome === 'failed');
    if (failures.length) {
      console.log(`\n  ${color.red(color.bold('Failures'))}`);
      failures.forEach((f, i) => {
        console.log(`   ${color.red(`${i + 1}.`)} ${color.bold(`${f.group} › ${f.title}`)}  ${color.dim(seconds(f.ms))}`);
        console.log(`      ${color.red(f.reason)}`);
        console.log(`      ${color.dim(location(f.test))}`);
        if (f.artifacts) console.log(`      ${color.dim('trace: npx playwright show-trace ' + f.artifacts)}`);
      });
      if (blocked) {
        const byStep = new Map<string, number>();
        for (const b of this.ended.filter((e) => e.outcome === 'blocked')) {
          const step = b.reason.match(/^"([^"]+)"/)?.[1] ?? b.reason;
          byStep.set(step, (byStep.get(step) ?? 0) + 1);
        }
        console.log(`   ${color.magenta('⊘')} ${color.dim([...byStep].map(([s, k]) => `${k} test${k > 1 ? 's' : ''} blocked by "${s}"`).join('  ·  '))}`);
      }
    }

    console.log(`\n  ${color.dim('Test console output: ' + path.relative(process.cwd(), path.join(this.dir(), 'run.log')))}`);
    // A run that did not get through all its tests (stopped, timed out) never takes anything off the record
    const toRerun = this.rememberFailures(result.status !== 'passed' && result.status !== 'failed' || this.ended.length < this.total);
    if (toRerun && this.product) {
      console.log(`  ${color.dim('Re-run only the failed and blocked tests:')} ${color.cyan(`npm run smoke:failed -- --products ${this.product}`)}`);
    }
    fs.writeFileSync(
      path.join(this.dir(), 'summary.json'),
      JSON.stringify({ product: this.product, status: result.status, ms: elapsed, tests: this.ended.length, passed, failed, blocked, skipped: skipped + notRun }, null, 2),
    );
    console.log();
  }

  /**
   * results/last-failed/<product>.json (one file per product, so products running side by side never share one):
   *  - `tests`: the failed and blocked tests alone, with the run id whose chain values (quote, policy …) they carry on from
   *  - `sections`: every test of each section that had one, for when that run's values are gone (a chain needs its earlier steps)
   * Returns how many tests are remembered for this run's product(s).
   */
  private rememberFailures(interrupted = false): number {
    const redo = this.ended.filter((e) => e.outcome === 'failed' || e.outcome === 'blocked');
    const products = new Set<string>(this.product ? [this.product] : redo.map((f) => f.test.titlePath()[1]));
    if (!products.size) return 0;
    // One file per product (results/last-failed/<key>.json): products running side by side never write the same file. Records from
    // before that are in the shared results/last-failed.json, read as a fallback and taken out of it as each product is updated.
    type Record_ = { updated: string; runId?: string; tests?: string[]; specs?: string[]; sections?: string[] };
    const dir = path.resolve('results', 'last-failed');
    const legacyFile = path.resolve('results', 'last-failed.json');
    const readJson = <T>(f: string): T | undefined => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
      } catch {
        return undefined;
      }
    };
    const legacy = readJson<Record<string, Record_>>(legacyFile);
    const all: Record<string, Record_ | undefined> = {};
    for (const product of products) all[product] = readJson<Record_>(path.join(dir, `${product}.json`)) ?? legacy?.[product];
    const runId = process.env.SMOKE_RUN_ID ?? '';
    const passedNow = new Set(this.ended.filter((e) => e.outcome === 'passed').map((e) => location(e.test)));
    let remembered = 0;
    for (const product of products) {
      const tests = new Set<string>();
      const sections = new Set<string>();
      for (const f of redo.filter((x) => x.test.titlePath()[1] === product)) {
        const rel = location(f.test);
        if (rel.startsWith('src/')) {
          tests.add(`tests/${product}/smoke.spec.ts`); // the shared smoke checks are registered from src/smoke
          sections.add(`tests/${product}/smoke.spec.ts`);
          continue;
        }
        tests.add(rel);
        for (const t of f.test.parent.allTests()) sections.add(location(t));
      }
      // A re-run of the same chain (same run id) keeps what it was asked to redo and did not get to now
      const old = all[product];
      if (old && old.runId === runId) {
        for (const t of old.tests ?? []) if (!passedNow.has(t) && !this.ended.some((e) => location(e.test) === t)) tests.add(t);
        for (const s of old.sections ?? []) if (!passedNow.has(s)) sections.add(s);
      }
      const file = path.join(dir, `${product}.json`);
      if (tests.size) {
        fs.mkdirSync(dir, { recursive: true });
        writeFileAtomic(file, JSON.stringify({ updated: new Date().toISOString(), runId, tests: [...tests], sections: [...sections] }, null, 2));
      } else if (!interrupted) fs.rmSync(file, { force: true }); // a stopped run never got to the rest: what was recorded before stays
      remembered += tests.size;
    }
    // This run's products are recorded in their own files now: take them out of the shared file from before (removed once empty)
    if (!interrupted && legacy && [...products].some((p) => p in legacy)) {
      for (const p of products) delete legacy[p];
      if (Object.keys(legacy).length) writeFileAtomic(legacyFile, JSON.stringify(legacy, null, 2));
      else fs.rmSync(legacyFile, { force: true });
    }
    return remembered;
  }

  printsToStdio(): boolean {
    return true;
  }
}

/** One screen row: a wrapped line breaks the layout (the full text is in the Failures list and the report). */
const fit = (line: string) => (process.stdout.isTTY ? truncate(line, (process.stdout.columns || 120) - 4) : line);

const location = (test: TestCase) => `${path.relative(process.cwd(), test.location.file).replace(/\\/g, '/')}:${test.location.line}`;

/** Premium annotations are JSON ({"policyPeriodGross": 1234.5, …}): show the gross amount. */
function shortValue(type: string, value: string): string {
  if (type !== 'premium') return value;
  try {
    const p = JSON.parse(value) as Record<string, number>;
    const gross = Object.entries(p).find(([k]) => /gross/i.test(k))?.[1] ?? Object.values(p)[0];
    return typeof gross === 'number' ? gross.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : value;
  } catch {
    return value;
  }
}

/** The section a test belongs to: "PI - Quote lifecycle" → "Quote lifecycle". */
function groupOf(test: TestCase): string {
  const parts = test.titlePath().filter(Boolean).slice(2); // [file, describe…, test]
  return withoutProduct(parts.length > 2 ? parts[parts.length - 2] : parts[0] ?? '');
}
