import fs from 'fs';
import path from 'path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { CONTRACT_ATTACHMENT, ContractRecord } from '../src/support/contracts';

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
    const header = ['Test', 'Step', 'Contract Reference', 'Contract Id', 'Test Status', 'URL'];
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

    // Plain console table (no URL: too wide)
    const shown = [header.slice(0, 5), ...table.map((c) => c.slice(0, 5))];
    const widths = shown[0].map((_, i) => Math.max(...shown.map((r) => r[i].length)));
    const line = (r: string[]) => '  ' + r.map((c, i) => c.padEnd(widths[i])).join('  ');
    console.log('\nContracts:\n' + [line(shown[0]), line(widths.map((w) => '-'.repeat(w))), ...shown.slice(1).map(line)].join('\n'));
    console.log(`\n  Saved: ${path.join(dir, 'contracts.md')} and contracts.csv`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
