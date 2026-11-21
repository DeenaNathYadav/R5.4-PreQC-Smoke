import { test, expect } from '../fixtures';
import { getProduct } from '../products';
import { PartyData, smokeInsured, smokeIntermediary, smokeUnderwriter } from './data';
import { ensureParty } from './ensure';

/**
 * The suite's own parties (src/parties/data.ts), one test each: found by name, or created when the environment doesn't have them yet
 * (with Smoke,Contact, which the insured and the intermediary are linked to). The same parties serve every product on the host.
 */
export function registerPartyTests(key: string): void {
  const product = getProduct(key);

  test.describe(`${product.name} - Parties`, { tag: ['@parties'] }, () => {
    test.describe.configure({ mode: 'default' });
    test.skip(!product.baseUrl, `${key.toUpperCase()}_URL is not set`);

    const ensure = (title: string, party: PartyData) =>
      test(title, async ({ page }, testInfo) => {
        test.setTimeout(10 * 60_000);
        const result = await ensureParty(page, party);
        expect(result.reference).toMatch(/^PTY\d+$/);
        const how = result.created ? 'created' : result.completed.length ? `exists, added ${result.completed.join(', ')}` : 'exists';
        testInfo.annotations.push({ type: 'party', description: `${result.displayName} ${result.reference} (${how})` });
      });

    ensure('Party - Smoke Insured', smokeInsured);
    ensure('Party - Smoke Intermediary', smokeIntermediary);
    ensure('Party - Smoke Underwriter', smokeUnderwriter);
  });
}
