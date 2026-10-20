import { cmbc } from './cmbc';
import { fleet } from './fleet';
import { mtp } from './mtp';
import { pi } from './pi';
import { ppp } from './ppp';
import type { ProductConfig } from './types';

export type { ProductConfig, SmokePage } from './types';

/**
 * Every product the suite knows about. To add one: create `src/products/<key>/index.ts` (defineProduct), list it here,
 * and add `tests/<key>/` (smoke.spec.ts + flows). Products with no `<KEY>_URL` are skipped, not failed.
 */
export const products: ProductConfig[] = [pi, ppp, cmbc, fleet, mtp];

export function getProduct(key: string): ProductConfig {
  const p = products.find((x) => x.key === key);
  if (!p) throw new Error(`Unknown product "${key}". Known: ${products.map((x) => x.key).join(', ')}`);
  return p;
}
