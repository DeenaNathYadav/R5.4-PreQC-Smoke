// Smoke runner: pick which products to run and whether they run one after another or at the same time.
//
//   npm run smoke                                   all configured products, one after another
//   npm run smoke:select                            asks which products and which mode
//   npm run smoke -- --products cmbc                CMBC only (same as npm run smoke:cmbc)
//   npm run smoke -- --products pi,cmbc --mode parallel
//   npm run smoke -- --products pi,cmbc --headed --workers=1    anything unknown goes to `playwright test`
//
// Each product is its own Playwright run with its own report folder (results/runs/<stamp>/<product>/), so one
// product failing never hides another's report, and a product that needs a single browser (CMBC with the Edge profile)
// keeps to one worker even when the others run alongside it. The list of products comes from playwright.config.ts
// (which reads src/products), so adding a product there is all it takes to make it selectable here.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const HELP = `Usage: npm run smoke -- [options] [playwright options]

  -p, --products <list>   Comma-separated product keys, or "all" (default: every configured product)
  -m, --mode <mode>       sequential (default) = one product after another, parallel = all at the same time
      --parallel          same as --mode parallel
      --sequential        same as --mode sequential
  -i, --interactive       Ask which products and which mode
      --fail-fast         Sequential: stop after the first product that fails
      --failed            Re-run only the sections that failed last time (results/last-failed.json), per product
      --no-auth           Skip the sign-in check (use the saved session as it is)
      --auth-only         Only run the sign-in check / session refresh, then stop
      --list              Show the products and whether they are configured, then stop
      --dry-run           Show what would run, run nothing
  -h, --help

Anything else (--headed, --workers=1, -g "Get Pricing", a spec path ...) is passed to "playwright test".`;

// ------------------------------------------------------------------ arguments
function parseArgs(argv) {
  const opts = { products: undefined, mode: undefined, interactive: false, failFast: false, failed: false, auth: true, authOnly: false, list: false, dryRun: false, pass: [] };
  const value = (i, flag) => {
    const eq = argv[i].indexOf('=');
    if (eq > 0 && argv[i].startsWith('--')) return [argv[i].slice(eq + 1), i];
    if (i + 1 >= argv.length) usage(`${flag} needs a value`);
    return [argv[i + 1], i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.split('=')[0];
    if (a === '--') { opts.pass.push(...argv.slice(i + 1)); break; }
    else if (flag === '--products' || flag === '-p') [opts.products, i] = value(i, flag);
    else if (flag === '--mode' || flag === '-m') [opts.mode, i] = value(i, flag);
    else if (a === '--parallel') opts.mode = 'parallel';
    else if (a === '--sequential' || a === '--serial') opts.mode = 'sequential';
    else if (a === '--interactive' || a === '-i') opts.interactive = true;
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--failed' || a === '--rerun-failed') opts.failed = true;
    else if (a === '--no-auth') opts.auth = false;
    else if (a === '--auth-only') opts.authOnly = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else opts.pass.push(a);
  }
  if (opts.mode && !['sequential', 'parallel'].includes(opts.mode)) usage(`unknown mode "${opts.mode}" (sequential or parallel)`);
  return opts;
}

function usage(message) {
  console.error(`${message}\n\n${HELP}`);
  process.exit(2);
}

// ------------------------------------------------------------------ process helpers
const children = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(130);
  });
}

/** Runs `playwright test <args>`. With `prefix` the output is tagged line by line (parallel runs share one console). */
function playwright(args, { env = {}, prefix = '', capture = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [playwrightCli, 'test', ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: capture || prefix ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    children.add(child);
    let stdout = '';
    const tag = (stream, out) => {
      stream.setEncoding('utf8');
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) out.write(`${prefix} ${line}\n`);
      });
      stream.on('end', () => buffer && out.write(`${prefix} ${buffer}\n`));
    };
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.resume();
    } else if (prefix) {
      tag(child.stdout, process.stdout);
      tag(child.stderr, process.stderr);
    }
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code: code ?? 1, ms: Date.now() - started, stdout });
    });
  });
}

/** Closes only the Edge started by `login:cdp` (its command line names the .auth/edge-profile folder), never the user's other Edge windows. */
function closeProfileEdge() {
  if (process.platform !== 'win32') return;
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2",
    ],
    { stdio: 'ignore' },
  );
}

// ------------------------------------------------------------------ catalog (from playwright.config.ts)
async function loadCatalog() {
  const { code, stdout } = await playwright(['--list', '--reporter=json'], { capture: true, env: { SMOKE_REPORT_DIR: '' } });
  const start = stdout.indexOf('{');
  if (code !== 0 || start < 0) throw new Error('Could not read the project list from playwright.config.ts (run "npx playwright test --list" to see why)');
  const { config } = JSON.parse(stdout.slice(start));
  const products = config.projects
    .filter((p) => p.metadata?.role === 'product')
    .map((p) => ({ key: p.name, ...p.metadata }));
  if (!products.length) throw new Error('No products found in playwright.config.ts');
  return products;
}

// ------------------------------------------------------------------ choosing products and mode
async function ask(rl, question, fallback) {
  const answer = (await rl.question(`${question} `)).trim();
  return answer || fallback;
}

async function chooseInteractively(catalog, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nProducts:');
    catalog.forEach((p, i) =>
      console.log(`  ${i + 1}. ${p.title.padEnd(6)} (${p.key})${p.configured ? '' : `   - not configured: set ${p.key.toUpperCase()}_URL`}`),
    );
    const configured = catalog.filter((p) => p.configured);
    const answer = await ask(rl, `\nWhich products? numbers or keys separated by commas, or "all" [all configured: ${configured.map((p) => p.key).join(',')}]:`, 'all');
    const picked = resolveProducts(catalog, answer, true);
    opts.products = picked.map((p) => p.key).join(','); // menu numbers → keys, so the later lookup sees keys only
    if (picked.length > 1 && !opts.mode) {
      const mode = await ask(rl, '\nRun them 1) one after another (safest, shared sign-in)  2) at the same time [1]:', '1');
      opts.mode = mode.startsWith('2') || /^p/i.test(mode) ? 'parallel' : 'sequential';
    }
  } finally {
    rl.close();
  }
}

/** Keys or 1-based menu numbers → products, in the order given. */
function resolveProducts(catalog, selection, byNumber = false) {
  const wanted = (selection ?? 'all').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length || wanted.includes('all')) return catalog.filter((p) => p.configured);
  const picked = [];
  for (const w of wanted) {
    const p = byNumber && /^\d+$/.test(w) ? catalog[Number(w) - 1] : catalog.find((c) => c.key === w);
    if (!p) usage(`Unknown product "${w}". Known: ${catalog.map((c) => c.key).join(', ')}`);
    if (!picked.includes(p)) picked.push(p);
  }
  return picked;
}

// ------------------------------------------------------------------ results
function readJunit(file) {
  if (!fs.existsSync(file)) return undefined;
  const head = fs.readFileSync(file, 'utf8').slice(0, 600);
  const attr = (name) => Number(head.match(new RegExp(`<testsuites[^>]*\\s${name}="(\\d+)`))?.[1] ?? 0);
  const tests = attr('tests'), failed = attr('failures') + attr('errors'), skipped = attr('skipped');
  return { tests, failed, skipped, passed: tests - failed - skipped };
}

const fmt = (ms) => `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// ------------------------------------------------------------------ main
const opts = parseArgs(process.argv.slice(2));
let catalog;
try {
  catalog = await loadCatalog();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

if (opts.list) {
  console.log('\nProducts (npm run smoke -- --products <key,key>):');
  for (const p of catalog) {
    const notes = [p.configured ? 'configured' : `not configured (set ${p.key.toUpperCase()}_URL)`, `login: ${p.authProject.replace('auth:', '')}`];
    if (p.maxWorkers) notes.push(`max ${p.maxWorkers} worker`);
    console.log(`  ${p.key.padEnd(7)} ${p.title.padEnd(6)} ${notes.join(' | ')}`);
  }
  process.exit(0);
}

if (opts.interactive) {
  if (!process.stdin.isTTY) usage('--interactive needs a terminal');
  await chooseInteractively(catalog, opts);
}

const explicit = opts.products && opts.products.toLowerCase() !== 'all';
const selected = resolveProducts(catalog, opts.products);
const skipped = selected.filter((p) => !p.configured);
const runnable = selected.filter((p) => p.configured);
for (const p of skipped) console.log(`Skipping ${p.title}: ${p.key.toUpperCase()}_URL is not set.`);
if (!runnable.length) {
  console.error('Nothing to run: no selected product is configured (see .env.example).');
  process.exit(explicit ? 2 : 0);
}

const mode = runnable.length > 1 ? opts.mode ?? 'sequential' : 'sequential';
const runId = stamp();
const runDir = path.join(root, 'results', 'runs', runId);
const authProjects = [...new Set(runnable.map((p) => p.authProject))];
const passHas = (...flags) => opts.pass.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
const baseWorkers = process.env.CI ? 4 : Math.max(1, Math.floor(os.cpus().length / 2));

function workersFor(p) {
  if (passHas('--workers', '-j')) return [];
  const share = mode === 'parallel' ? Math.max(1, Math.floor(baseWorkers / runnable.length)) : baseWorkers;
  const n = p.maxWorkers ? Math.min(p.maxWorkers, share) : share;
  return p.maxWorkers || mode === 'parallel' ? [`--workers=${n}`] : [];
}

console.log(`\nSmoke run ${runId}`);
console.log(`  Products : ${runnable.map((p) => p.title).join(mode === 'parallel' ? ' + ' : ' → ')}`);
console.log(`  Mode     : ${mode}${runnable.length === 1 ? ' (single product)' : ''}`);
console.log(`  Sign-in  : ${opts.auth ? authProjects.join(', ') : 'skipped (--no-auth)'}`);
console.log(`  Reports  : ${path.relative(root, runDir)}${path.sep}<product>${path.sep}`);
if (mode === 'parallel') {
  const shared = authProjects.filter((a) => runnable.filter((p) => p.authProject === a).length > 1);
  for (const a of shared) {
    const names = runnable.filter((p) => p.authProject === a).map((p) => p.title).join(' and ');
    console.log(`  Note     : ${names} share one sign-in (${a.replace('auth:', '')}). If the app rotates tokens and one run is signed out, use sequential mode.`);
  }
}

if (opts.dryRun) {
  for (const a of opts.auth ? authProjects : []) console.log(`  would run: playwright test --project=${a}`);
  if (!opts.authOnly) {
    for (const p of runnable) console.log(`  would run: playwright test --project=${p.key} --no-deps ${[...workersFor(p), ...opts.pass].join(' ')}`.trimEnd());
  }
  process.exit(0);
}

fs.mkdirSync(runDir, { recursive: true });
const summary = new Map(runnable.map((p) => [p.key, { product: p, status: 'not run', counts: undefined, ms: 0 }]));

// 1. Sign in once per login (products on one host share it): running these per product in parallel would race on the session file
const blocked = new Set();
if (opts.auth) {
  for (const authProject of authProjects) {
    console.log(`\n=== sign-in: ${authProject} ===`);
    console.log('Checking the saved sign-in in the background (no window opens unless you choose to sign in below; can take ~1 minute)...');
    const dir = path.join(runDir, `auth-${authProject.replace(/[^\w.-]+/g, '_')}`);
    const check = () => playwright([`--project=${authProject}`, '--reporter=list'], { env: { SMOKE_REPORT_DIR: dir } });
    let { code } = await check();
    if (code !== 0 && process.stdin.isTTY) {
      // The saved session expired: offer to open Edge for the SSO + MFA sign-in, then check again
      const loginKey = runnable.find((x) => x.authProject === authProject).key;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`\nThe saved sign-in for ${authProject.replace('auth:', '')} has expired. Open Edge now to sign in? [Y/n] `)).trim();
      rl.close();
      if (!/^n/i.test(answer)) {
        const login = spawn(process.execPath, [path.join(root, 'scripts', 'login-cdp.mjs'), loginKey], { cwd: root, stdio: 'inherit' });
        children.add(login);
        const loginCode = await new Promise((resolve) => login.on('close', (c) => resolve(c ?? 1)));
        children.delete(login);
        closeProfileEdge(); // the sign-in window keeps the profile locked; the session export needs it
        if (loginCode === 0) ({ code } = await check());
      }
    }
    if (code !== 0) {
      console.error(`Sign-in failed for ${authProject}. Run "npm run login:cdp", then try again.`);
      for (const p of runnable.filter((x) => x.authProject === authProject)) {
        blocked.add(p.key);
        summary.get(p.key).status = 'blocked (sign-in failed)';
      }
    }
  }
}

// 2. Products
async function runProduct(p, { prefix = '' } = {}) {
  const entry = summary.get(p.key);
  const dir = path.join(runDir, p.key);
  console.log(`\n=== ${p.title} ===`);
  let rerun = [];
  if (opts.failed) {
    // The specs (file:line of every test in each failed section) the last run of this product recorded
    let remembered = {};
    try {
      remembered = JSON.parse(fs.readFileSync(path.join(root, 'results', 'last-failed.json'), 'utf8'));
    } catch {
      /* nothing recorded yet */
    }
    rerun = remembered[p.key]?.specs ?? [];
    if (!rerun.length) {
      console.log(`Nothing failed last time for ${p.title}: nothing to re-run.`);
      entry.status = 'nothing to re-run';
      return 0;
    }
    console.log(`Re-running ${rerun.length} test(s) from the sections that failed (${remembered[p.key].updated.slice(0, 16).replace('T', ' ')}):`);
    for (const spec of rerun) console.log(`  ${spec}`);
  }
  const args = [`--project=${p.key}`, '--no-deps', ...workersFor(p), ...rerun, ...opts.pass];
  const { code, ms } = await playwright(args, { env: { SMOKE_REPORT_DIR: dir }, prefix });
  entry.ms = ms;
  entry.counts = readJunit(path.join(dir, 'junit.xml'));
  entry.status = code === 0 ? 'passed' : entry.counts ? 'failed' : 'error (no report)';
  entry.dir = dir;
  return code;
}

if (!opts.authOnly) {
  const todo = runnable.filter((p) => !blocked.has(p.key));
  if (mode === 'parallel') {
    await Promise.all(todo.map((p) => runProduct(p, { prefix: `[${p.key}]` })));
  } else {
    for (const p of todo) {
      const code = await runProduct(p);
      if (code !== 0 && opts.failFast) {
        for (const rest of todo.slice(todo.indexOf(p) + 1)) summary.get(rest.key).status = 'not run (--fail-fast)';
        break;
      }
    }
  }
}

// 3. Summary
const rows = [...summary.values()];
const lines = [
  `# Smoke run ${runId} (${mode})`,
  '',
  '| Product | Result | Passed | Failed | Skipped | Time | Report |',
  '|---|---|---|---|---|---|---|',
  ...rows.map(({ product, status, counts, ms, dir }) =>
    `| ${product.title} | ${status} | ${counts?.passed ?? '-'} | ${counts?.failed ?? '-'} | ${counts?.skipped ?? '-'} | ${ms ? fmt(ms) : '-'} | ${dir ? path.relative(root, path.join(dir, 'html', 'index.html')) : '-'} |`,
  ),
  '',
];
fs.writeFileSync(path.join(runDir, 'summary.md'), lines.join('\n'));
fs.writeFileSync(
  path.join(runDir, 'summary.json'),
  JSON.stringify({ runId, mode, products: rows.map(({ product, status, counts, ms }) => ({ key: product.key, status, ...counts, ms })) }, null, 2),
);

if (!opts.authOnly) {
  console.log(`\n${'='.repeat(60)}\nSmoke summary (${mode})\n${'='.repeat(60)}`);
  for (const { product, status, counts, ms } of rows) {
    const c = counts ? `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped` : '';
    console.log(`  ${product.title.padEnd(7)} ${status.padEnd(26)} ${c}${ms ? `  (${fmt(ms)})` : ''}`);
  }
  console.log(`\n  Summary: ${path.relative(root, path.join(runDir, 'summary.md'))}`);
  console.log(`  Reports: npx playwright show-report ${path.relative(root, path.join(runDir, '<product>', 'html'))}`);
}

process.exit(rows.every((r) => r.status === 'passed' || r.status === 'nothing to re-run') || opts.authOnly && blocked.size === 0 ? 0 : 1);
