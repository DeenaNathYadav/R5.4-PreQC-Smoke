import { defineProduct } from '../types';

// TODO: MTP is not wired up yet. Set MTP_URL; if it runs on AdvantageGo spread `advantageGo` from '../platforms/advantagego'
// (then confirm its pages), otherwise give it its own login selectors and pages. Product flows go in tests/mtp/.
export const mtp = defineProduct('mtp', 'MTP');
