import { advantageGo } from '../platforms/advantagego';
import { defineProduct } from '../types';

/** PPP. Env: PPP_URL, PPP_* resume URLs (PPP_QUOTE_URL, PPP_POLICY_URL, …). */
export const ppp = defineProduct('ppp', 'PPP', advantageGo);
