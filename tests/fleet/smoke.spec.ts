import { registerSmokeSuite } from '../../src/smoke/registerSmokeSuite';

registerSmokeSuite('fleet');

// Add fleet-specific critical-path tests (create/search/submit flows) in this folder,
// importing { test, expect } from '../../src/fixtures'.
