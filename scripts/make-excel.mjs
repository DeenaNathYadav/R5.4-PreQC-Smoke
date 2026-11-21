// Writes one Excel workbook per smoke run: Summary, Tests (every product) and Contracts, built from each product's
// junit.xml and contracts.csv. Called by run-smoke.mjs after every run; `node scripts/make-excel.mjs <runDir>` rebuilds one.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

function readTests(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const tests = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (n) => decode(m[1].match(new RegExp(`(?:^|\\s)${n}="([^"]*)"`))?.[1] ?? '');
    const body = m[3] ?? '';
    const failure = body.match(/<(?:failure|error)\b[^>]*?(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/(?:failure|error)>/);
    const skipped = /<skipped\b/.test(body);
    const props = [...body.matchAll(/<property name="([^"]*)" value="([^"]*)"/g)].map((p) => `${decode(p[1])}=${decode(p[2])}`).join('; ');
    const [suite, ...rest] = attr('name').split(' › ');
    tests.push({
      suite: rest.length ? suite : '',
      test: rest.length ? rest.join(' › ') : suite,
      result: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      seconds: Math.round(Number(attr('time')) * 10) / 10,
      details: failure ? decode((failure[1] || failure[2] || '').replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 600) : '',
      props,
    });
  }
  return tests;
}

function readCsv(file) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const FILL = { passed: 'FFC6EFCE', failed: 'FFFFC7CE', skipped: 'FFFFEB9C' };

export async function writeRunExcel(runDir) {
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet('Summary');
  const tests = wb.addWorksheet('Tests');
  const contracts = wb.addWorksheet('Contracts');
  sum.addRow(['Product', 'Result', 'Total', 'Passed', 'Failed', 'Blocked', 'Skipped', 'Time (min)']);
  tests.addRow(['Product', '#', 'Suite', 'Test', 'Result', 'Time (s)', 'Details', 'Properties']);
  let contractsHeader = false;
  for (const p of summary.products) {
    sum.addRow([p.key.toUpperCase(), p.status, p.tests ?? '', p.passed ?? '', p.failed ?? '', p.blocked ?? '', p.skipped ?? '', p.ms ? Math.round(p.ms / 600) / 100 : '']);
    const dir = path.join(runDir, p.key);
    if (fs.existsSync(path.join(dir, 'junit.xml'))) {
      readTests(path.join(dir, 'junit.xml')).forEach((t, i) => {
        const r = tests.addRow([p.key.toUpperCase(), i + 1, t.suite, t.test, t.result, t.seconds, t.details, t.props]);
        r.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[t.result] } };
      });
    }
    if (fs.existsSync(path.join(dir, 'contracts.csv'))) {
      const [head, ...body] = readCsv(path.join(dir, 'contracts.csv'));
      if (!contractsHeader) { contracts.addRow(['Product', ...head]); contractsHeader = true; }
      for (const row of body.filter((r) => r.some(Boolean))) contracts.addRow([p.key.toUpperCase(), ...row]);
    }
  }
  sum.addRow([]);
  sum.addRow(['Run', summary.runId]);
  sum.addRow(['Mode', summary.mode]);
  sum.addRow(['Total time (min)', Math.round(summary.ms / 600) / 100]);
  for (const ws of wb.worksheets) {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns.forEach((col) => {
      let w = 8;
      col.eachCell({ includeEmpty: false }, (cell) => (w = Math.max(w, String(cell.value ?? '').length + 2)));
      col.width = Math.min(w, 70);
    });
  }
  const file = path.join(runDir, `smoke-results-${summary.runId}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  console.log(await writeRunExcel(path.resolve(process.argv[2])));
}
