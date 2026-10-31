import fs from 'fs';
import path from 'path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { color, seconds, stripAnsi, withoutProduct } from './format';

/**
 * Compact console output for the smoke runs, replacing Playwright's "list" reporter:
 *  - tests are grouped under their section (Quote, Policy, Cancellation …), one line each: ✔ / ✘ / ○, number, name, time
 *  - what the tests print with console.log goes to run.log in the report folder instead of cluttering the console
 *    (the contract references are in the Contracts table at the end)
 *  - a summary with the failures (first line of each error) and the command that re-runs only those
 *  - results/last-failed.json remembers, per product, the specs that failed: `npm run smoke -- --products ppp --failed`
 * Options: { outputDir } (the run's report folder; default results/).
 */
export default class ConsoleReporter implements Reporter {
  private total = 0;
  private done = 0;
  private lastGroup = '';
  private counts = { passed: 0, failed: 0, skippedOnPurpose: 0, notRun: 0 };
  private failures: { product: string; group: string; title: string; reason: string; location: string; test: TestCase }[] = [];
  private log?: number;
  private started = Date.now();
  private product = '';
  private passedSpecs = new Set<string>();
  private smokePassed = false;

  constructor(private readonly options: { outputDir?: string } = {}) {}

  private dir(): string {
    return path.resolve(this.options.outputDir ?? 'results');
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    const tests = suite.allTests();
    this.total = tests.length;
    const products = [...new Set(tests.map((t) => t.titlePath()[1]).filter(Boolean))];
    this.product = products.length === 1 ? products[0] : '';
    fs.mkdirSync(this.dir(), { recursive: true });
    this.log = fs.openSync(path.join(this.dir(), 'run.log'), 'a');
    console.log(`\n  ${color.bold(`${this.total} tests`)}${products.length ? color.dim(`  ·  ${products.join(', ')}`) : ''}\n`);
  }

  onStdOut(chunk: string | Buffer): void {
    if (this.log !== undefined) fs.writeSync(this.log, chunk.toString());
  }

  onStdErr(chunk: string | Buffer): void {
    if (this.log !== undefined) fs.writeSync(this.log, chunk.toString());
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.done++;
    const parts = test.titlePath().filter(Boolean).slice(2); // [file, describe…, test]
    const group = withoutProduct(parts.length > 2 ? parts[parts.length - 2] : parts[0] ?? '');
    const title = parts[parts.length - 1];
    if (group !== this.lastGroup) {
      console.log(`  ${color.cyan(color.bold(group))}`);
      this.lastGroup = group;
    }
    const n = String(this.done).padStart(String(this.total).length);
    const time = result.duration ? color.dim(seconds(result.duration)) : '';
    if (result.status === 'skipped') {
      // Skipped on purpose (test.fixme / test.skip: backend-only evidence, a setting that is not set) or never run because an
      // earlier step of the same chain failed
      const onPurpose = test.annotations.some((a) => a.type === 'fixme' || a.type === 'skip');
      if (onPurpose) this.counts.skippedOnPurpose++;
      else this.counts.notRun++;
      const why = onPurpose ? test.annotations.find((a) => a.type === 'skip')?.description ?? 'skipped on purpose' : 'not run: an earlier step failed';
      console.log(`    ${color.orange('○')} ${color.orange(`${n}  ${title}`)}  ${color.dim(why)}`);
      return;
    }
    if (result.status === 'passed') {
      this.counts.passed++;
      const rel = path.relative(process.cwd(), test.location.file).replace(/\\/g, '/');
      if (rel.startsWith('tests/')) this.passedSpecs.add(`${rel}:${test.location.line}`);
      else this.smokePassed = true;
      console.log(`    ${color.green('✔')} ${color.green(`${n}  ${title}`)}  ${time}`);
      return;
    }
    this.counts.failed++;
    const message = stripAnsi(result.error?.message ?? result.errors?.[0]?.message ?? result.status);
    const reason = message.split('\n').map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 170) ?? result.status;
    console.log(`    ${color.red('✘')} ${color.red(color.bold(`${n}  ${title}`))}  ${time}`);
    this.failures.push({
      product: test.titlePath()[1] ?? this.product,
      group,
      title,
      reason,
      location: `${path.relative(process.cwd(), test.location.file).replace(/\\/g, '/')}:${test.location.line}`,
      test,
    });
  }

  onEnd(result: FullResult): void {
    if (this.log !== undefined) fs.closeSync(this.log);
    const { passed, failed, skippedOnPurpose, notRun } = this.counts;
    const skipped = skippedOnPurpose + notRun;
    const bar = '─'.repeat(64);
    console.log(`\n  ${bar}`);
    const verdict = failed ? color.red(color.bold('✘ FAILED')) : color.green(color.bold('✔ PASSED'));
    console.log(`  RESULT   ${verdict}   ${color.dim(`${seconds(Date.now() - this.started)}  ·  ${this.total} tests`)}`);
    console.log(
      `  ${color.green(color.bold(`✔ ${passed} passed`))}      ${failed ? color.red(color.bold(`✘ ${failed} failed`)) : color.dim('✘ 0 failed')}      ` +
        `${skipped ? color.orange(color.bold(`○ ${skipped} skipped`)) : color.dim('○ 0 skipped')}`,
    );
    if (skipped) {
      const parts: string[] = [];
      if (notRun) parts.push(color.orange(`${notRun} not run because an earlier step failed`));
      if (skippedOnPurpose) parts.push(color.orange(`${skippedOnPurpose} skipped on purpose (fixme / setting not set)`));
      console.log(`  ${color.dim('└')} ${parts.join(color.dim('  ·  '))}`);
    }
    if (this.failures.length) {
      console.log(`\n  ${color.red('Failures')}`);
      this.failures.forEach((f, i) => {
        console.log(`   ${i + 1}. ${color.bold(`${f.group} › ${f.title}`)}`);
        console.log(`      ${color.red(f.reason)}`);
        console.log(`      ${color.dim(f.location)}`);
      });
    }
    console.log(`\n  ${color.dim('Console output of the tests: ' + path.relative(process.cwd(), path.join(this.dir(), 'run.log')))}`);
    this.rememberFailures();
    if (this.failures.length && this.product) {
      console.log(`  ${color.dim('Re-run only the failed sections:')} npm run smoke -- --products ${this.product} --failed --headed --workers=1`);
    }
    void result;
  }

  /** results/last-failed.json: per product the `file:line` of every test in each failed section (a chain needs its earlier steps). */
  private rememberFailures(): void {
    const products = new Set<string>(this.product ? [this.product] : this.failures.map((f) => f.product));
    if (!products.size) return;
    const file = path.resolve('results', 'last-failed.json');
    let all: Record<string, { updated: string; specs: string[] }> = {};
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
    for (const product of products) {
      const specs = new Set<string>();
      for (const f of this.failures.filter((x) => x.product === product)) {
        const rel = path.relative(process.cwd(), f.test.location.file).replace(/\\/g, '/');
        if (!rel.startsWith('tests/')) {
          specs.add(`tests/${product}/smoke.spec.ts`); // the shared smoke checks are registered from src/smoke
          continue;
        }
        for (const t of f.test.parent.allTests()) specs.add(`${path.relative(process.cwd(), t.location.file).replace(/\\/g, '/')}:${t.location.line}`);
      }
      // Keep what failed earlier and did not run (or fail) now; drop what passed in this run
      const smoke = `tests/${product}/smoke.spec.ts`;
      for (const old of all[product]?.specs ?? []) {
        if (this.passedSpecs.has(old) || (old === smoke && this.smokePassed)) continue;
        specs.add(old);
      }
      if (specs.size) all[product] = { updated: new Date().toISOString(), specs: [...specs] };
      else delete all[product];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  }

  printsToStdio(): boolean {
    return true;
  }
}
