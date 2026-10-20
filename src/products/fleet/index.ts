import { defineProduct } from '../types';

// TODO: Fleet is not wired up yet. Set FLEET_URL; if it runs on AdvantageGo spread `advantageGo` from '../platforms/advantagego'
// (then confirm its pages), otherwise give it its own login selectors and pages. Product flows go in tests/fleet/.
export const fleet = defineProduct('fleet', 'Fleet');
