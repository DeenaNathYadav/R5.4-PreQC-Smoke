import { defineProduct } from '../types';

// TODO: PPP is not wired up yet. Set PPP_URL; if it runs on AdvantageGo spread `advantageGo` from '../platforms/advantagego'
// (then confirm its pages), otherwise give it its own login selectors and pages. Product flows go in tests/ppp/.
export const ppp = defineProduct('ppp', 'PPP');
