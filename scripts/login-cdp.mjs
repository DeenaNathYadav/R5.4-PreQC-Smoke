// `npm run login:cdp`: for SSO setups where the Playwright-launched browser gets closed at the end of login.
// Starts a plain Edge (own profile in .auth/edge-profile, remote-debugging port), lets you sign in,
// then attaches over CDP and saves the session in the same files auth.setup.ts / the tests use.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

// Products on one host share a login, so any product's URL will do: `npm run login:cdp` uses the first one set,
// `npm run login:cdp -- ppp` picks a product (needed when products live on different hosts).
const keys = process.argv[2] ? [process.argv[2].toLowerCase()] : ['pi', 'cmbc', 'ppp', 'fleet', 'mtp'];
const baseUrl = keys.map((k) => process.env[`${k.toUpperCase()}_URL`]).find(Boolean);
if (!baseUrl) throw new Error(`Set ${keys.map((k) => `${k.toUpperCase()}_URL`).join(' or ')} in .env`);
const { host, origin } = new URL(baseUrl);
const authDir = path.join(root, '.auth');
const fileKey = host.replace(/[^\w.-]+/g, '_'); // same naming as src/config/auth.ts
const storageFile = path.join(authDir, `${fileKey}.json`);
const sessionFile = path.join(authDir, `${fileKey}.session.json`);
const profileDir = path.join(authDir, 'edge-profile');
const port = 9222;

const edge = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!edge) throw new Error('msedge.exe not found');

fs.mkdirSync(profileDir, { recursive: true });
spawn(
  edge,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--new-window', `${origin}/ui/home/dashboard`],
  { detached: true, stdio: 'ignore' },
).unref();
console.log('>>> Edge opened. Sign in to AdvantageGo there (incl. MFA); the session is saved as soon as the dashboard loads.');

let browser;
for (let i = 0; i < 60 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  if (!browser) await new Promise((r) => setTimeout(r, 500));
}
if (!browser) throw new Error('Could not attach to Edge on the debugging port');

const context = browser.contexts()[0];
const deadline = Date.now() + 10 * 60_000;
let last = '';
let lastNote = 0;
while (Date.now() < deadline) {
  for (const page of context.pages()) {
    let u;
    try { u = new URL(page.url()); } catch { continue; }
    const key = u.origin + u.pathname;
    if (key !== last) { last = key; console.log(`    at ${key}`); }
    if (u.host === host && u.pathname.startsWith('/ui/') && !u.pathname.startsWith('/ui/login')) {
      // Signed in = user button visible (the dashboard shell alone also loads when signed out)
      const signedIn = await page
        .locator('#dropdownMenu2, button:has-text("Axa Commercial")')
        .first()
        .isVisible()
        .catch(() => false);
      if (!signedIn) {
        if (Date.now() - lastNote > 15_000) { lastNote = Date.now(); console.log('    (dashboard shell loaded, but no signed-in user button yet)'); }
        continue;
      }
      try {
        await context.storageState({ path: storageFile });
        fs.writeFileSync(sessionFile, await page.evaluate(() => JSON.stringify(sessionStorage)));
        console.log(`>>> Session saved for ${host} (${storageFile}).`);
        await browser.close().catch(() => {});
        process.exit(0);
      } catch (e) {
        console.log(`    save attempt failed: ${e.message.split('\n')[0]}`);
      }
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
throw new Error('Timed out waiting for sign-in');
