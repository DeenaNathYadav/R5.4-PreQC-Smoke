import { advantageGo } from '../platforms/advantagego';
import { defineProduct } from '../types';

/** Commercial Combined (PDBI + Liability). Env: CMBC_URL, CMBC_TEMPLATE_QUOTE_URL, CMBC_USE_EDGE_PROFILE, CMBC_* resume URLs. */
export const cmbc = defineProduct('cmbc', 'CMBC', advantageGo);
