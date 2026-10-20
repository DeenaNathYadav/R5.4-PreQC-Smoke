import { advantageGo } from '../platforms/advantagego';
import { defineProduct } from '../types';

/** Professional Indemnity. Env: PI_URL, PI_TEMPLATE_QUOTE_URL, PI_* resume URLs (see README). */
export const pi = defineProduct('pi', 'PI', advantageGo);
