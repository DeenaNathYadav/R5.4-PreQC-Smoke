# UI Smoke Tests (PI, PPP, CMBC, Fleet, MTP)
# Developed By : Deena Yadav

Playwright + TypeScript suite that replaces the manual post-deployment UI smoke check.
Today **PI** and **CMBC** have full flows; **PPP, Fleet and MTP** are registered but only get the generic page checks
once their URL is set. Every product lives in its own folder, so the other three can be added one by one.

## Setup

```bash
npm install
npx playwright install chromium   # or set BROWSER_CHANNEL=msedge to use the installed Edge
cp .env.example .env              # fill in URLs + credentials
```

Several environments: create `.env.qa`, `.env.uat`, … and run with `TEST_ENV=qa`.
A product with no `<KEY>_URL` set is skipped, not failed.

## Run - pick the products and how they run

```bash
npm run smoke:select                                 # asks: which products? one after another, or at the same time?

npm run smoke:pi                                     # one product on its own (also smoke:cmbc, smoke:ppp, smoke:fleet, smoke:mtp)
npm run smoke -- --products cmbc                     # same thing
npm run smoke -- --products pi,cmbc                  # both, one after another (default; PI first, then CMBC)
npm run smoke -- --products cmbc,pi --mode parallel  # both at the same time
npm run smoke                                        # every configured product, one after another
npm run smoke:par                                    # every configured product at the same time

npm run smoke -- --products pi,cmbc --headed --workers=1     # anything unknown goes to `playwright test`
npm run smoke -- --products pi -g "Get Pricing"              # one test
npm run smoke:list                                           # products and whether each is configured
npm run smoke -- --products pi,cmbc --dry-run                # show what would run
npm run auth                                                 # only check / refresh the saved sign-in
```

| Option | Meaning |
|---|---|
| `--products a,b` / `-p` | Product keys (order = run order in sequential mode), or `all` (default = every configured product) |
| `--mode sequential\|parallel` / `-m` | `sequential` (default): one product after another. `parallel`: all at once |
| `--fail-fast` | Sequential: stop after the first product that fails (default: carry on with the next one) |
| `--no-auth` | Skip the sign-in check and use the saved session as it is |
| `--interactive` / `-i` | Ask for products and mode |

How the modes work:

- Each product is its **own Playwright run** with its own report folder: `results/runs/<timestamp>/<product>/`
  (`html/`, `junit.xml`, `contracts.md|csv`, traces under `artifacts/`) plus `results/runs/<timestamp>/summary.md|json`.
  One product failing never hides another's report; the exit code is non-zero if any selected product failed.
- The sign-in is checked **once per login** before the products start (PI and CMBC share one host, so one check),
  and a product whose sign-in fails is reported as blocked instead of failing every test.
- A product that needs a single browser (`<KEY>_USE_EDGE_PROFILE=1`, i.e. CMBC today) is held to one worker; in parallel mode
  the other products split the remaining CPU between them. An explicit `--workers=N` wins.
- **Parallel caveat:** PI and CMBC sign in with the same account on the same host, and the app rotates tokens, so a
  parallel run can occasionally sign one of them out. Sequential is the safe default; use parallel when the environment tolerates it.
- `npx playwright test` (or `npm run smoke:raw`) still works directly (all products, shared `playwright-report/` and `results/`);
  the runner is what adds product choice, modes and per-product reports. `npm run report` opens the last direct run; for a runner
  run use `npx playwright show-report results/runs/<timestamp>/<product>/html`.

Failures keep a trace (`npx playwright show-trace <zip>`) with a screenshot of every step,
plus any console errors and 5xx API calls the page made.

## Layout

```
src/
  products/
    index.ts              registry: the list of products (add yours here)
    types.ts              ProductConfig + defineProduct() (env-driven: <KEY>_URL, <KEY>_USER, <KEY>_<ANYTHING> via product.env())
    platforms/advantagego.ts   login, home page and page checks shared by every AdvantageGo product
    pi/    index.ts (config) · data.ts (QC test data) · flows.ts (quote creation, lifecycle) · PiSectionsPage.ts
    cmbc/  index.ts · data.ts · flows.ts · CmbcSectionsPage.ts (PDBI/Liability structure, exposure grids, schedule import)
    ppp/ fleet/ mtp/      config only for now (TODO: URLs, pages, flows)
  pages/advantagego/      page objects for the shared AdvantageGo UI (quote, policy, search, documents, grids ...)
  flows/                  shared multi-step flows: quoteToPolicy.ts (issue, take up, createBoundPolicy), endorsePolicy.ts (MTA)
  config/                 env.ts, auth.ts (session files, one login per host)
  smoke/registerSmokeSuite.ts   the generic checks every product gets
  fixtures/  support/     diagnostics fixture, contracts table
tests/<key>/              smoke.spec.ts + flows.spec.ts for each product
scripts/run-smoke.mjs     the runner above · scripts/login-cdp.mjs  SSO sign-in helper
```

### Adding a product (PPP, MTP, Fleet …)

1. `src/products/<key>/index.ts`: `export const ppp = defineProduct('ppp', 'PPP', { ...advantageGo, /* overrides */ })`
   (or its own login selectors / pages when it is not on AdvantageGo). Already scaffolded for ppp, mtp and fleet.
2. Make sure it is listed in `src/products/index.ts`.
3. Set `<KEY>_URL` (and `<KEY>_USER` / `<KEY>_PASSWORD` if it does not use SSO) in `.env`. That alone enables the generic
   page checks in `tests/<key>/smoke.spec.ts`, and `npm run smoke:<key>` / `--products <key>` start working.
4. Add the product's flows the way PI/CMBC do: test data in `data.ts`, helpers in `flows.ts` (a `QuoteLifecycle` makes the
   shared `createBoundPolicy` / `issueWithSelfApproval` / `takeUpAndBind` / `endorsePolicy` work for it), product-specific
   page objects next to them (extend `QuoteSectionsPage`), and the specs in `tests/<key>/flows.spec.ts`.
   Read product-scoped settings with `<product>.env('TEMPLATE_QUOTE_URL')` instead of `process.env.<KEY>_...`.

### Adding a page check (no code)

```ts
// src/products/fleet/index.ts
export const fleet = defineProduct('fleet', 'Fleet', {
  loggedInIndicator: '#user-menu',
  buildVersion: '.footer-version',
  pages: [
    { name: 'Dashboard', path: '/dashboard', expect: 'role=heading[name="Dashboard"]' },
    { name: 'Vehicles',  path: '/vehicles',  expect: 'table' },
  ],
});
```

Use `npm run codegen -- https://fleet-qa.example.com` to record clicks and get reliable selectors.

## Signing in (SSO + MFA)

`npm run login:cdp` opens a normal Edge window (profile kept in `.auth/edge-profile`), you sign in once incl. MFA, and the
session is saved (`npm run login:cdp -- ppp` picks the product whose host to sign in to, when products are on different hosts).
The `auth:<host>` Playwright project refreshes the saved session from that profile before every run (`npm run auth` runs just that),
so you only repeat the sign-in when Microsoft expires the profile. (`npm run login` — Playwright's own browser — gets closed by the
SSO redirect on some machines; use `login:cdp` if that happens.) Don't run two test/explore sessions at once: the app
rotates tokens and the second one gets logged out.

## PI flow coverage (`tests/pi/flows.spec.ts`, sheet "PI")

| Sheet row | Status |
|---|---|
| Create Submission, Convert to Quote, Get Pricing | automated |
| Quote create task | automated: creates an Underwriting Referral - PI task, then completes it (card ⋮ → Complete) |
| Quote Documents - Generation and Download | automated: Automatic Wording terms, PDF upload, download (byte-compared); "Generate Document" runs only on an issued quote |
| Quote History Check and Link Tasks & License | automated: Timeline, Links, Tasks, Licence tabs |
| Search / Advance Search | automated: keyword search + Risk-Quote advanced filter |
| Decline | automated on its own quote (Not Taken Up / Mark as Lost need an issued quote: `test.fixme`) |
| Get Commission | automated the PI way: ⋮ → Get Commission isn't eligible for PI, so Broker Commission is added with + in DETAILS → Commission (12%). Runs after Get Pricing: the row is dropped on a quote that has no risk sections yet |
| License Check - Task Generation | automated: Next Stage → Issue Quote → Authority Limit warning → Acknowledge → Licence Referral task |
| Issue Quote | automated: the Licence Referral is forwarded to the signed-in user (card ⋮ → Forward) and approved (card ⋮ → Approve) from the quote's History → Tasks; then Issue Quote → Quoted, waiting for document generation. `LICENCE_SELF_APPROVE=0` instead waits for a real approver (`APPROVAL_WAIT_MINUTES`) |
| Quote Taken up and conversion to Policy | automated: Taken Up (re-prices / accepts the open-tasks prompt if asked) → Policy Conversion → Save → Confirm Cover (Bound), then checks every policy document reaches Completed (Terms → Documents refresh, 20s apart, up to 2 retries). Keeps the policy URL for the policy rows |
| Requote / MultiQuote | `test.fixme` - the issued quote is now available; not written yet |
| MTA - GE Pricing / endorsement | automated on the Bound policy: ⋮ → General Endorsement → Endorsement section (type General, effective from today+10d, reason code, description) → Save (endorsement quote …Q002) → Get Price → Next Stage → Issue Quote → Take Up Endorsement → Policy Conversion Save → Confirm Endorsement (Bound), then all endorsement documents Completed. One endorsement per policy at a time; `PI_POLICY_URL` / `PI_ENDORSEMENT_URL` / `PI_ENDORSED_POLICY_URL` resume from an existing one |
| Renewals - Pricing/License/Task | automated (`PI - Renewal`): Model copy of the template quote → price → issue (self-approved) → take up → its own Bound policy → ⋮ Renew - Quote (all sections, schedules → RENEW, accept the product-offerings prompt) → Save renewal quote → Get Price → issue → "Quote Taken Up" → Bound renewal policy → General Endorsement on that renewal policy (effective from = its inception + 10 days; Quote Expiry Date is filled before take-up). Resume with `PI_RENEWAL_BASE_POLICY_URL` / `PI_RENEWAL_QUOTE_URL` / `PI_RENEWAL_POLICY_URL` / `PI_RENEWAL_ENDORSEMENT_URL` |
| Mid-Term Cancellation + Reinstate | Automated on a fresh New Business policy (quote → policy → cancel: Get Price, Confirm Endorsement, docs; then Reinstate Contract, which the backend completes, so only the outcome is checked). Not run on the renewal |
| Inception Cancellation, MTA Reversal | `test.fixme` - not written yet (cancellations are New Business only, not on the renewal) |
| Data Lake | not UI-testable (backend payload/ALS check) |

## CMBC flow coverage (`tests/cmbc/flows.spec.ts`, sheet "CMBC")

CMBC uses quote `117365` as the model/reference data and the `Standard CMBC` offering. The suite creates a
submission, converts it to Commercial Combined, verifies PDBI and Liability child sections, and imports
`CMBC/CMBC_Schedule_Import.xlsx` with geocoding and peril-score mode. Quote pricing, commission, terms/documents,
search, issue/take-up, renewal, general endorsement, mid-term cancellation, and reinstatement use separate CMBC
tests and environment variables. Run it visibly with:

```bash
npm run smoke:cmbc -- --headed
```

Requote, Multi-Quote, inception cancellation, MTA reversal, Data Lake, and server-folder/ALS checks remain explicit
`test.fixme` cases because their UI workflows or backend evidence are not yet implemented.

## Faster runs with a template quote

Set `PI_TEMPLATE_QUOTE_URL` (an issued quote, e.g. in `.env`). The chain then makes its quote with ⋮ → Model → Save (a copy that already has sections, income and the 12% Broker Commission) instead of New Submission → Convert. Unset it to exercise Create Submission / Convert to Quote / Get Pricing / Get Commission from scratch.
