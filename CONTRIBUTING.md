# 🛡️ Contributing to the UI smoke suite

This suite is the **preQC → QC gate** for PI, PPP, CMBC, Fleet and MTP. If it is flaky or wrong, a bad build reaches QC, or a good
build gets held back. These rules keep it trustworthy. Please read them before your first change.

*Owner / reviewer: **Deena Yadav***

---

## 1. Workflow

1. Work on a **branch**, never directly on `main`.
2. Make the change, then run **`npm run check`**, which typechecks the code and fails on a leftover `test.only`.
3. Run the **whole product** you changed on preQC: `npm run smoke:<key>`. A single test passing with `-g` is not enough, because
   the tests share a chain of quotes and policies.
4. Open a pull request and fill in its checklist (see the end of this file). Attach the run's `summary.md`.
5. The owner reviews and merges. **Changes to shared code (section 3) are never merged without that review.**

---

## 2. Where a change goes

```
tests/<key>/flows.spec.ts          the tests: one test per checklist row, in chain order
src/products/<key>/data.ts         ALL test data for that product (names, codes, %, dates, files)
src/products/<key>/flows/*.ts      the product's steps (quote.ts, policy.ts)
src/products/<key>/<Key>SectionsPage.ts   the product's own screens
src/pages/advantagego/*            ⚠️ SHARED page objects: used by all five products
src/support/* · src/fixtures/*     ⚠️ SHARED: chain state, blocking, contracts, dates, diagnostics
scripts/* · reporters/* · playwright.config.ts   ⚠️ SHARED: runner, reports, config
```

- **A product change stays in that product's folder.** The products deliberately share no flow code, so fixing PPP can't break PI.
  If PPP needs something slightly different from a shared page object, put a PPP version in `src/products/ppp/` and don't add a
  PPP special case to the shared file.
- **Shared code** (marked ⚠️) changes only when every product needs it. Run **every** product after changing it.

---

## 3. Rules

### Test data
- ✅ All data lives in `src/products/<key>/data.ts`, and anything environment-specific can be overridden with
  `<key>.env('NAME')` (→ `<KEY>_NAME` in `.env`).
- ❌ No names, references, percentages or dates typed inline in a spec or flow.
- ❌ No hosts or URLs in code. They come from `<KEY>_URL` (one `.env.<env>` file per environment).
- ❌ No credentials, `.env`, `.auth/` or `results/` committed. They are already in `.gitignore`.
- Dates come from `src/support/dates.ts` (inception = today − 10 days, cancellation = today), never as fixed dates.

### Locating elements
- ✅ Use visible labels and roles: `fieldContainer`, `selectDropdown`, `selectDate`, `selectDialogDropdown`… in
  `src/pages/advantagego/kendo.ts`, plus `getByRole` / `getByText`.
- ❌ No Kendo-generated ids (`#k-1a2b…`), no long CSS/XPath chains copied from DevTools, no `nth(5)` positions.

### Waiting
- ✅ Wait for something the user would see: a toast, a status, a button becoming enabled (`expect(...).toBeVisible()`,
  `expect(async () => …).toPass()` for a step that sometimes needs repeating).
- ❌ Don't fix a timing problem with `page.waitForTimeout(…)`. Where a short pause really is the only way (the app gives no signal),
  add a comment that says why.
- ❌ Don't raise a timeout to make a test pass without finding out why it was slow.

### Tests
- **One test = one checklist row / one business operation**, named as in the smoke checklist. The same step has the **same name**
  in every product (`Get Pricing`, `Issue Quote`, `Quote Taken up`, `MTA - GE - Get Pricing`, …).
- A test that can't run without an earlier operation declares it with **`steps.needs('Get Pricing')`**, so it reports *Blocked*
  instead of timing out.
- Values that later tests need (quote URL, policy URL…) go in the spec's **`chain`** (`persisted(...)`), not in a module variable,
  so a failed-only re-run can pick them up.
- Every contract created is recorded with **`recordContract('<Product> <What>', reference, url)`**.
- A failure must say **what the app said**: read the error toast or banner and put it in the error message, and don't throw a bare
  timeout.
- Warnings banners are acknowledged, and the flow carries on.
- ❌ No `test.only`, and no commented-out tests. Use `test.fixme('…reason…')` for a row that can't be automated, with the reason.
- ❌ Don't change an existing product's flow without running that product end to end.

### Code style
- TypeScript strict, and `npm run check` must pass with no errors.
- Follow the file around you: same naming, same helper functions, same comment style (a short *why*, not *what*).
- Keep functions small and named after the business step (`issueWithSelfApproval`, `reinstatePolicy`).
- No new npm dependencies without the owner's agreement.

---

## 4. Adding a test (recipe)

1. Add the checklist row's data to `src/products/<key>/data.ts`.
2. Add the step to `src/products/<key>/flows/quote.ts` or `policy.ts`, reusing the shared page objects.
3. Add the test to `tests/<key>/flows.spec.ts` **in chain order**, in the right group (`<Product> - Quote`, `- Policy`,
   `- Cancellation`, `- Renewal`…):

   ```ts
   test('Issue Quote', async ({ page }) => {
     steps.needs('Get Pricing');                 // skipped as Blocked if pricing failed
     await issueWithSelfApproval(page, chain.quoteUrl, pppSections.riskSection, pppAssignee); // data from data.ts
     chain.quoteIssued = true;                   // later tests read it back, even in a new worker
   });
   ```
4. Run the whole product on preQC: `npm run smoke:<key>`.
5. Update the product's table in `README.md` (*What is covered*).

## 5. Fixing a failing test

1. Open the trace first: `npx playwright show-trace results/runs/<stamp>/<key>/artifacts/<test>/trace.zip`.
2. Decide whether it's **the app** (a defect: raise it with the contract ids from `contracts.md`) or **the test**.
   Don't change a test to pass over a real defect.
3. Fix the cause, then re-run with `npm run smoke:<key>:failed`, and run the full product before merging.

---

## ✅ Pull request checklist

```
- [ ] Change is inside src/products/<key>/ and tests/<key>/ (or the owner agreed to a shared-code change)
- [ ] Test data in data.ts; no hosts, ids, credentials or fixed dates in code
- [ ] No new waitForTimeout without a "why" comment; no raised timeouts without a cause
- [ ] New/changed tests use steps.needs, chain, recordContract where relevant
- [ ] npm run check passes
- [ ] Full run of the product on preQC passed — summary.md attached
- [ ] README "What is covered" updated
```
