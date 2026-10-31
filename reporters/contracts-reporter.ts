import fs from 'fs';
import path from 'path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { CONTRACT_ATTACHMENT, ContractRecord } from '../src/support/contracts';
import { color, withoutProduct } from './format';

interface Row extends ContractRecord {
  test: string;
  status: string;
}

/**
 * Lists every contract the tests created or used (see src/support/contracts.ts) as a table:
 * printed at the end of the run and written to contracts.md and contracts.csv in `outputDir` (default: results/).
 */
export default class ContractsReporter implements Reporter {
  private rows: Row[] = [];

  constructor(private readonly options: { outputDir?: string } = {}) {}

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const a of result.attachments) {
      if (a.name !== CONTRACT_ATTACHMENT || !a.body) continue;
      const record = JSON.parse(a.body.toString()) as ContractRecord;
      const name = test.titlePath().filter(Boolean).slice(-2).join(' › ');
      // A retry or a repeated call records the same contract again
      if (this.rows.some((r) => r.test === name && r.step === record.step && r.reference === record.reference)) continue;
      this.rows.push({ ...record, test: name, status: result.status });
    }
  }

  onEnd(_result: FullResult): void {
    if (!this.rows.length) return;
    const header = ['Test', 'Step', 'Contract Reference', 'Contract Id', 'Test Result', 'URL'];
    const table = this.rows.map((r) => [r.test, r.step, r.reference, r.contractId, r.status, r.url]);

    const dir = path.resolve(this.options.outputDir ?? 'results');
    fs.mkdirSync(dir, { recursive: true });
    const csv = [header, ...table].map((cells) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    fs.writeFileSync(path.join(dir, 'contracts.csv'), csv + '\n');

    const md = [
      `# Contracts - ${new Date().toISOString()}`,
      '',
      `| ${header.join(' | ')} |`,
      `|${header.map(() => '---').join('|')}|`,
      ...table.map((cells) => `| ${cells.join(' | ')} |`),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'contracts.md'), md);

    // Console: grouped by test, one block each (no URL: too wide)
    const stepW = Math.max(...this.rows.map((r) => r.step.length));
    const refW = Math.max(...this.rows.map((r) => r.reference.length));
    // The test's result is shown once on its header; the rows only say the contract exists (a row is not "failed" because a
    // later step of the same test failed)
    console.log(`\n  ${color.bold(`Contracts used or created (${this.rows.length})`)}`);
    let lastTest = '';
    for (const r of this.rows) {
      const group = withoutProduct(r.test.split(' › ')[0]);
      const name = `${group} › ${r.test.split(' › ').slice(1).join(' › ')}`;
      if (name !== lastTest) {
        const icon = r.status === 'passed' ? color.green('✔') : color.red('✘');
        const note = r.status === 'passed' ? 'test passed' : 'test failed at a later step - the contracts below were created';
        console.log(`\n    ${icon} ${color.cyan(name)}  ${color.dim(note)}`);
        lastTest = name;
      }
      console.log(`        ${color.dim('•')} ${r.step.padEnd(stepW)}  ${r.reference.padEnd(refW)}  ${color.dim(r.contractId)}`);
    }
    console.log(`\n  ${color.dim(`Saved: ${path.relative(process.cwd(), path.join(dir, 'contracts.md'))} and contracts.csv`)}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
