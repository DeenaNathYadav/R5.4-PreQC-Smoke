import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from '@playwright/test';
import type { ProductConfig } from '../products/types';

const authDir = path.resolve(__dirname, '../../.auth');

/** Edge profile signed in by `npm run login:cdp`; auth.setup re-exports the session from it when needed. */
export const authProfileDir = () => path.join(authDir, 'edge-profile');

/** Products on the same host share one login: the key is the host (or the product key while it has no URL yet). */
export function authKey(product: ProductConfig): string {
  return product.baseUrl ? new URL(product.baseUrl).host : product.key;
}

/** Groups products by login, in first-seen order. Each group needs one auth setup, however many products share it. */
export function groupByAuth(products: ProductConfig[]): { key: string; products: ProductConfig[] }[] {
  const groups = new Map<string, ProductConfig[]>();
  for (const p of products) groups.set(authKey(p), [...(groups.get(authKey(p)) ?? []), p]);
  return [...groups].map(([key, members]) => ({ key, products: members }));
}

/** Name of the Playwright project that signs in for this product's host. */
export const authProject = (product: ProductConfig) => `auth:${authKey(product)}`;

export function authFiles(product: ProductConfig) {
  // A URL with a port (localhost:4200) would put ":" in the file name, which Windows reads as an alternate data stream
  const file = authKey(product).replace(/[^\w.-]+/g, '_');
  return {
    storageState: path.join(authDir, `${file}.json`),
    sessionStorage: path.join(authDir, `${file}.session.json`),
  };
}

/**
 * Writes `data` so a reader never sees a half-written file: into a temporary file next to it, then renamed over it. Products running
 * side by side share the session files, and a test starting while another saves would otherwise read broken JSON. When the rename is
 * refused (Windows keeps a file locked for a moment while another process reads it), it is retried, then the file is written in place
 * as before.
 */
export function writeFileAtomic(file: string, data: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (e) {
      if (attempt >= 10) {
        fs.rmSync(temp, { force: true });
        fs.writeFileSync(file, data);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // a short synchronous pause before trying again
    }
  }
}

/** Playwright's storageState covers cookies + localStorage; sessionStorage is saved alongside it. */
export async function saveSession(page: Page, product: ProductConfig): Promise<void> {
  const files = authFiles(product);
  fs.mkdirSync(authDir, { recursive: true });
  const state = await page.context().storageState();
  const session = await page.evaluate(() => JSON.stringify(sessionStorage));
  writeFileAtomic(files.storageState, JSON.stringify(state, null, 2));
  writeFileAtomic(files.sessionStorage, session);
}

/**
 * Saves the session a test leaves behind, when it is still signed in on the product's host. The app's tokens last about an hour and
 * a long run outlives the session saved at its start: a fresh page then has to renew them first, and lands on the Dashboard
 * instead of its link, or hangs on "Refreshing Token" with a blank page. Saving after each test keeps the next one's tokens fresh.
 */
export async function refreshSavedSession(page: Page, product: ProductConfig): Promise<void> {
  if (!product.baseUrl || page.isClosed()) return;
  const url = page.url();
  if (!url.startsWith(new URL(product.baseUrl).origin) || /\/ui\/login/i.test(url)) return;
  if (!(await page.locator(product.loggedInIndicator).first().isVisible().catch(() => false))) return;
  await saveSession(page, product);
}

export async function restoreSessionStorage(context: BrowserContext, product: ProductConfig): Promise<void> {
  const file = authFiles(product).sessionStorage;
  if (!product.baseUrl || !fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  await context.addInitScript(
    ({ origin, items }) => {
      if (location.origin !== origin) return;
      for (const [k, v] of Object.entries(items)) {
        if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
      }
    },
    { origin: new URL(product.baseUrl).origin, items },
  );
}
