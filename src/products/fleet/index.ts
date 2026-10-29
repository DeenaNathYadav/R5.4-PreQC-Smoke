import { advantageGo } from '../platforms/advantagego';
import { defineProduct } from '../types';

/** Fleet. Env: FLEET_URL, FLEET_SCHEDULE_IMPORT, FLEET_* resume URLs (FLEET_QUOTE_URL, FLEET_POLICY_URL, …). */
export const fleet = defineProduct('fleet', 'Fleet', advantageGo);
