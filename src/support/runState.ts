import fs from 'fs';
import path from 'path';
import { test, type TestInfo } from '@playwright/test';

// The flow specs hand values down the chain (quote URL → policy URL → endorsed policy …). After a failed test Playwright throws the
// worker away and carries on with the next test in a new one, which re-imports the spec and would lose plain variables. So the chain
// values live in small files, one per value, under results/state/<run id>/: the next test picks up whatever the earlier ones left,
// whichever worker it runs in. SMOKE_RUN_ID is set once per run in playwright.config.ts, so one run never sees another's values.
const stateDir = () => path.resolve(__dirname, '../../results/state', process.env.SMOKE_RUN_ID || 'local');

/**
 * An object whose properties are kept on disk for the run: reading one returns the last value any test of this run wrote for it
 * (or the default), assigning one writes it. `scope` keeps the values of different chains apart (e.g. 'mtp-quote', 'mtp-model').
 */
export function persisted<T extends Record<string, unknown>>(scope: string, defaults: T): T {
  const dir = path.join(stateDir(), scope.replace(/[^\w.-]+/g, '_'));
  const file = (key: string) => path.join(dir, `${key}.json`);
  return new Proxy({ ...defaults }, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || !(key in defaults)) return Reflect.get(target, key, receiver);
      try {
        return JSON.parse(fs.readFileSync(file(key), 'utf8'));
      } catch {
        return target[key];
      }
    },
    set(target, key, value) {
      if (typeof key !== 'string') return Reflect.set(target, key, value);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(key), JSON.stringify(value ?? null));
      return true;
    },
  });
}

/**
 * Blocking operations. Most steps of a chain can fail without hurting the next ones (commission, documents, search …), but some
 * cannot be done without: no Get Price → no Issue Quote → no Taken Up / Confirm Cover → no endorsement. A test lists the steps it
 * cannot do without (`needs`), and is skipped as "Blocked" when one of them failed earlier in this run. A step that did not run,
 * or was skipped (e.g. resumed from a <KEY>_*_URL), blocks nothing; a step skipped as blocked passes the block on to its own dependants.
 * `record` goes in the spec's afterEach.
 */
export function blockingSteps(scope: string) {
  const dir = path.join(stateDir(), scope.replace(/[^\w.-]+/g, '_'), 'blocked');
  const file = (step: string) => path.join(dir, `${step.replace(/[^\w.-]+/g, '_').slice(0, 120)}.txt`);
  const block = (step: string, reason: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(step), reason);
  };
  const reasonFor = (step: string) => {
    try {
      return fs.readFileSync(file(step), 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    record(testInfo: TestInfo): void {
      if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
        block(testInfo.title, (testInfo.error?.message ?? testInfo.status).split('\n')[0].replace(/^Error:\s*/, '').slice(0, 200));
      } else if (testInfo.status === 'passed') {
        fs.rmSync(file(testInfo.title), { force: true }); // passed on a retry: it blocks nothing any more
      }
    },
    needs(...steps: string[]): void {
      for (const step of steps) {
        const reason = reasonFor(step);
        if (reason === undefined) continue;
        block(test.info().title, `blocked by "${step}"`);
        test.skip(true, `Blocked: "${step}" failed (${reason})`);
      }
    },
  };
}
