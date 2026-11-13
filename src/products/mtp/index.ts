import { advantageGo } from '../platforms/advantagego';
import { defineProduct } from '../types';

/** Motor Trade (MTP). Env: MTP_URL,MTP_* resume URLs. */
export const mtp = defineProduct('mtp', 'MTP', advantageGo);
