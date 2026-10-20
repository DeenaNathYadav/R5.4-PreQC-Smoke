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

/** Playwright's storageState covers cookies + localStorage; sessionStorage is saved alongside it. */
export async function saveSession(page: Page, product: ProductConfig): Promise<void> {
  const files = authFiles(product);
  fs.mkdirSync(authDir, { recursive: true });
  await page.context().storageState({ path: files.storageState });
  const session = await page.evaluate(() => JSON.stringify(sessionStorage));
  fs.writeFileSync(files.sessionStorage, session);
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
