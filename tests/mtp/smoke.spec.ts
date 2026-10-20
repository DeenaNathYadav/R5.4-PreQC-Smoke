import { registerSmokeSuite } from '../../src/smoke/registerSmokeSuite';

registerSmokeSuite('mtp');

// Add mtp-specific critical-path tests (create/search/submit flows) in this folder,
// importing { test, expect } from '../../src/fixtures'.
