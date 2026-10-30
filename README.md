<div align="center">

# 🔥 UI Smoke Tests

### One command to smoke-test **PI · CMBC · PPP · MTP · Fleet** after every deployment

![Playwright](https://img.shields.io/badge/Playwright-1.63-45ba4b?logo=playwright&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-25-5fa04e?logo=node.js&logoColor=white)
![App](https://img.shields.io/badge/AdvantageGo-Underwriting-b8860b)
![PI](https://img.shields.io/badge/PI-full%20flows-2ea44f)
![CMBC](https://img.shields.io/badge/CMBC-full%20flows-2ea44f)
![MTP](https://img.shields.io/badge/MTP-full%20flows-2ea44f)
![PPP](https://img.shields.io/badge/PPP-full%20flows-dbab09)
![Fleet](https://img.shields.io/badge/Fleet-full%20flows-dbab09)

*Developed by **Deena Yadav***

[⚡ Quick start](#quick-start) · [🧭 Which command?](#which-command) · [🔀 Sequential vs parallel](#seq-par) · [🗺️ What is covered](#covered) · [🔁 Resuming](#resume) · [🔐 Sign-in](#signin) · [🩺 Troubleshooting](#troubleshooting) · [🧱 Layout](#layout)

</div>

---

## 📦 What is this?

A **Playwright + TypeScript** suite that replaces the manual post-deployment UI smoke check.
It drives the real AdvantageGo Underwriting screens: it creates quotes, prices, issues, takes up, endorses, renews,
cancels, reverses… and records every contract it creates.

| Product | Status | What runs |
|:--|:--:|:--|
| **PI** | ✅ Full flows | Quote → Policy → Endorsement → Reversal → Renewal → Cancellation |
| **CMBC** | ✅ Full flows | Quote (PDBI + Liability + schedule) → Policy → Endorsement → Renewal → Cancellation |
| **MTP** | ✅ Full flows | Motor Trade: Quote (PDBI + Liability + Road Risks + Legal Expenses + schedule) → Policy → Endorsement → Reversal → Mid-Term & Inception Cancellation → Renewal |
| **PPP** | 🟡 Full flows (reinstatement blocked) | UK Property Investors Protection Plan: Quote (schedule + commission) → Policy → Endorsement → Reversal → Mid-Term Cancellation → Renewal. Reinstate fails on a backend pricing halt |
| **Fleet** | 🟡 Full flows | Fleet: Quote (schedule import + commission + **Experience Call before Get Price**) → Policy → Endorsement → Reversal → Mid-Term Cancellation → Renewal |

> Every product lives in **its own folder** and shares no flow code with the others, so a change to one product can never break another.

---

<a id="quick-start"></a>

## ⚡ Quick start

```mermaid
flowchart LR
  A["1️⃣ npm install"] --> B["2️⃣ copy .env.example → .env<br/>fill the URLs"]
  B --> C["3️⃣ npm run login:cdp<br/>sign in once (SSO + MFA)"]
  C --> D["4️⃣ npm run smoke:select<br/>pick products + mode"]
  D --> E["5️⃣ read results/runs/&lt;stamp&gt;/summary.md"]
  style A fill:#e8f1ff,stroke:#3178c6
  style B fill:#e8f1ff,stroke:#3178c6
  style C fill:#fff4d6,stroke:#b8860b
  style D fill:#e6f6ea,stroke:#2ea44f
  style E fill:#e6f6ea,stroke:#2ea44f
```

```bash
npm install
npx playwright install chromium     # or set BROWSER_CHANNEL=msedge to use the installed Edge
cp .env.example .env                # then fill in the URLs (and credentials if not SSO)
npm run login:cdp                   # a normal Edge window opens: sign in once, MFA included
npm run smoke:select                # interactive: which products? one after another, or together?
```

> 💡 A product with no `<KEY>_URL` in `.env` is **skipped, not failed**.
> Several environments? Create `.env.qa`, `.env.uat`… and run with `TEST_ENV=qa`.

---

<a id="which-command"></a>

## 🧭 Which command do I run?

| I want to… | Run this |
|:--|:--|
| 🎛️ **Be asked** which products and which mode | `npm run smoke:select` |
| 🅿️ Run **PI only** | `npm run smoke:pi` |
| 🏢 Run **CMBC only** | `npm run smoke:cmbc` |
| ➡️ Run **PI then CMBC**, one after another *(safe default)* | `npm run smoke -- --products pi,cmbc` |
| ⚡ Run **PI and CMBC at the same time** | `npm run smoke -- --products pi,cmbc --mode parallel` |
| 🌍 Run **every configured product**, one after another | `npm run smoke` |
| 🌍⚡ Run **every configured product at once** | `npm run smoke:par` |
| 👀 **Watch the browser** (recommended while debugging) | `npm run smoke -- --products pi --headed --workers=1` |
| 🎯 Run **one test** by name | `npm run smoke -- --products pi -g "Get Pricing"` |
| 🔑 Only **check / refresh the saved sign-in** | `npm run auth` |
| 📋 **List** products and whether each is configured | `npm run smoke:list` |
| 🧪 **Preview** what would run, run nothing | `npm run smoke -- --products pi,cmbc --dry-run` |
| 🛑 **Stop at the first failing product** (sequential) | add `--fail-fast` |
| ⏭️ **Skip** the sign-in check | add `--no-auth` *(see the warning in [Troubleshooting](#troubleshooting))* |
| 🧱 Run Playwright directly (all products, shared report) | `npx playwright test` |

Shortcuts for the other products: `npm run smoke:mtp` · `smoke:ppp` · `smoke:fleet`.
Anything the runner doesn't know (`--headed`, `--workers=1`, `-g "…"`, a spec path…) is passed straight to `playwright test`.

<details>
<summary><b>All runner options</b></summary>

| Option | Meaning |
|:--|:--|
| `--products a,b` / `-p` | Product keys (order = run order in sequential mode), or `all` (default = every configured product) |
| `--mode sequential\|parallel` / `-m` | `sequential` (default): one product after another · `parallel`: all at once |
| `--sequential` / `--parallel` | shortcuts for `--mode …` |
| `--interactive` / `-i` | Ask for products and mode |
| `--fail-fast` | Sequential: stop after the first product that fails (default: carry on with the next) |
| `--no-auth` | Skip the sign-in check and use the saved session as it is |
| `--auth-only` | Only run the sign-in check / session refresh, then stop |
| `--list` | Show the products and whether they are configured, then stop |
| `--dry-run` | Show what would run, run nothing |
| `-h`, `--help` | Show the help |

</details>

---

<a id="seq-par"></a>

## 🔀 Sequential vs parallel

```mermaid
flowchart TB
  subgraph SEQ["➡️ Sequential  (default, safest)"]
    direction LR
    S0(["🔑 sign-in check<br/>once per host"]) --> S1["PI"] --> S2["CMBC"] --> S3[("📊 summary")]
  end
  subgraph PAR["⚡ Parallel  (faster, see caveat)"]
    direction LR
    P0(["🔑 sign-in check<br/>once per host"]) --> P1["PI"]
    P0 --> P2["CMBC"]
    P1 --> P3[("📊 summary")]
    P2 --> P3
  end
  style SEQ fill:#f3f8ff,stroke:#3178c6
  style PAR fill:#fff8e6,stroke:#b8860b
```

| | ➡️ Sequential | ⚡ Parallel |
|:--|:--|:--|
| Order | one product after another | all at the same time |
| Speed | slower | faster |
| Risk | lowest | ⚠️ PI and CMBC use the **same account on the same host**, and the app **rotates tokens**, so one can occasionally be signed out |
| Use when | normal runs, CI, anything important | the environment tolerates it |

**How it works**

- 🗂️ Each product is its **own Playwright run** with its own report folder, so one product failing never hides another's report.
  The exit code is non-zero if any selected product failed.
- 🔑 The sign-in is checked **once per login host** (PI and CMBC share one host → one check). A product whose sign-in fails is reported
  as *blocked* instead of failing every test.
- 🧵 A product that needs a single browser (`<KEY>_USE_EDGE_PROFILE=1`, i.e. CMBC today) is held to **one worker**; in parallel mode the
  other products split the remaining CPU. An explicit `--workers=N` wins.

---

## 📊 Where do the results go?

```
results/runs/<timestamp>/
├── summary.md · summary.json        ← start here: one line per product
├── pi/
│   ├── html/                        ← full HTML report
│   ├── junit.xml
│   ├── contracts.md · contracts.csv ← every submission / quote / policy / MTA created, with its id and URL
│   └── artifacts/<test>/            ← screenshot, trace.zip, error-context.md of each FAILURE
└── cmbc/
    └── …same layout
```

| Want to… | Command |
|:--|:--|
| Open a product's HTML report | `npx playwright show-report results/runs/<timestamp>/pi/html` |
| Replay a failure step by step | `npx playwright show-trace results/runs/<timestamp>/pi/artifacts/<test>/trace.zip` |
| Open the last *direct* `npx playwright test` run | `npm run report` |

Failures keep a **trace** (a screenshot of every step), plus any console errors and 5xx API calls the page made.

---

<a id="covered"></a>

## 🗺️ What is covered

Legend: ✅ automated &nbsp;·&nbsp; 🟡 automated, not yet proven end-to-end &nbsp;·&nbsp; ⬜ not written yet &nbsp;·&nbsp; 🔒 backend evidence only (not UI-testable)

### 🅿️ PI — `tests/pi/flows.spec.ts`

```mermaid
flowchart TD
  SUB["📝 Create Submission"] --> CQ["Convert to Quote"]
  TPL["🧬 Model copy of the template quote<br/>(faster, optional)"] -.-> PRC
  CQ --> PRC["💲 Get Pricing"]
  PRC --> COM["Broker Commission 12%"] --> TSK["Task · Documents · History · Search"]
  TSK --> LIC["🪪 License Check<br/>Licence Referral raised"]
  LIC --> ISS["✅ Issue Quote<br/>(referral self-approved)"]
  ISS --> MQ["🔀 MultiQuote → …Q002"]
  ISS --> TU["📥 Taken Up → Bound Policy"]
  TU --> RQ["🔁 Requote → …Q003"]
  TU --> GE["✏️ General Endorsement (MTA)"]
  GE --> REV["↩️ MTA Reversal"]
  TU -.-> REN["🔄 Renewal<br/>(own Bound policy)"] --> RGE["Endorsement on the renewal"]
  TU -.-> CAN["🚫 Mid-Term Cancellation<br/>(own Bound policy)"] --> REI["♻️ Reinstate"]
  classDef done fill:#e6f6ea,stroke:#2ea44f,color:#14532d;
  class SUB,CQ,TPL,PRC,COM,TSK,LIC,ISS,MQ,TU,RQ,GE,REV,REN,RGE,CAN,REI done;
```

| Checklist row | Status | What the test does |
|:--|:--:|:--|
| Create Submission · Convert to Quote · Get Pricing | ✅ | New Submission → details → Convert to Quote → add risk section → Get Price ("Price is returned…") |
| Get Commission | ✅ | PI isn't eligible for ⋮ → Get Commission, so the defaulted Broker Commission row gets its Override % (12%) in DETAILS → Commission (test: Add Broker Commission) |
| Quote create task | ✅ | Creates an *Underwriting Referral – PI* task, then completes it (card ⋮ → Complete) |
| Quote Documents – Generation & Download | ✅ | Automatic Wording terms, PDF upload, download (byte-compared); *Generate Document* only on an issued quote |
| Quote History · Links · Tasks · Licence | ✅ | Timeline, Links, Tasks and Licence tabs |
| Search / Advance Search | ✅ | Keyword search + Risk-Quote advanced filter |
| License Check – Task Generation | ✅ | Next Stage → Issue Quote → Authority Limit warning → Acknowledge → Licence Referral task |
| Issue Quote | ✅ | Referral forwarded to the signed-in user and approved from History → Tasks, then Issue Quote → *Quoted*. `LICENCE_SELF_APPROVE=0` waits for a real approver (`APPROVAL_WAIT_MINUTES`) |
| **MultiQuote** | ✅ | On the **issued** quote: ⋮ → *Convert to Multi Quote* → Save → toast "MultiQuote created from Quote" → next quote of the same risk (**…Q002**, Provisional). The source quote stays Quoted |
| Quote Taken up → Policy | ✅ | Taken Up → Policy Conversion → Save → Confirm Cover (**Bound**), then every policy document must reach *Completed* |
| **Requote** | ✅ | ⋮ → *Requote* is greyed out until the quote is **Taken Up** → "open tasks, continue?" → Ok → Save → new version (**…Q003**) |
| MTA – GE Pricing / endorsement | ✅ | General Endorsement → Save (…Q00n) → Get Price → Next Stage → Issue → Take Up Endorsement → Confirm Endorsement (Bound) → documents Completed |
| **MTA – Reversal** | ✅ | On the endorsed policy: **Endorsement grid → the row's ⋮ → Reverse → Yes**. Checks header = *Reversed*, row *Bound → Reversed*, endorsement 000 (Original) still *Bound* |
| Renewals | ✅ | Own Bound policy → Renew – Quote → Save → price → issue → take up → Bound renewal policy → General Endorsement on it |
| Mid-Term Cancellation + Reinstate | ✅ | Own Bound policy → Cancel → Get Price → Confirm → docs; then Reinstate Contract (backend completes it, outcome checked) |
| Decline / Not Taken Up / Mark as Lost | 🟡 | Decline is automated on its own quote; the others need a dedicated issued quote |
| Inception Cancellation | ⬜ | Not written (cancellations are New Business only) |
| Data Lake – Quote / Pricing / MTA / Schedule / ALS | 🔒 | Backend payload check |

<a id="cmbc"></a>

### 🏢 CMBC — `tests/cmbc/flows.spec.ts`

> [!IMPORTANT]
> **Geocoding + Peril Scoring is mandatory before Get Price** on *every* CMBC transaction (New Business, Renewal, endorsement…).
> Without it Get Price fails with *"The Geocoding for all schedule items have not been done"*.
> Quotes copied with ⋮ → Model and endorsement quotes already carry geocoded items; a **renewal quote's schedule does not**, so the
> flow runs `priceQuote(page, url, { geocodeFirst: true })` first.

```mermaid
flowchart LR
  A["Tick schedule rows"] --> B["Schedule ⋮ →<br/>Geocode and Get Peril Score"]
  B --> C["Wizard opens in a NEW tab"]
  C --> D["Continue → Next → Continue"]
  D --> E["Finish<br/>(tab closes)"]
  E --> F["⏱ wait a few seconds"]
  F --> G["💾 Save in the quote tab<br/>'Schedule Saved Successfully'"]
  G --> H["💲 Get Price"]
  style B fill:#fff4d6,stroke:#b8860b
  style G fill:#fff4d6,stroke:#b8860b
  style H fill:#e6f6ea,stroke:#2ea44f
```

| Checklist row | Status | Notes |
|:--|:--:|:--|
| Submission → Convert to Quote (PDBI + Liability child sections) | ✅ | Reference quote `117365`, offering *Standard CMBC* |
| Create working quote from the reference model | ✅ | ⋮ → Model |
| Insert schedule with geocoding and peril score | ✅ | Imports `CMBC/CMBC_Schedule_Import.xlsx` |
| Get Commission · Get Pricing | ✅ | |
| Quote Terms and document upload / download | ✅ | |
| Search / Advance search Quote | ✅ | |
| Issue Quote · Taken up quote | ✅ | Next Stage first (Get Price only exists in *UW Review & Process*) |
| General endorsement → take-up → MTA pricing | ✅ | |
| Mid-Term Cancellation – Pricing and Reinstate | ✅ | |
| Renewals – Pricing | 🟡 | Includes the geocode step. Last blocked by the backend document service ending *"In Error"* on fresh policies, not by the test |
| Requote · Multi-Quote | ⬜ | Same pattern as PI is expected to work |
| MTA – Reversal · MTA – Inception Cancellation Policy | ⬜ | |
| Documents/datalake payload · Data lake · ALS & server-folder payloads | 🔒 | Backend evidence |

<a id="mtp"></a>

### 🚗 MTP (Motor Trade) — `tests/mtp/flows.spec.ts`

Own folder `src/products/mtp/` (data, `MtpSectionsPage`, `flows/quote.ts`, `flows/policy.ts`); it shares only the low-level pages with the other products.
Env: `MTP_URL`, `MTP_SCHEDULE_IMPORT`, plus the `MTP_*` resume URLs.

| Checklist row | Status | Notes |
|:--|:--:|:--|
| Convert to Quote (PDBI, Liability, Road Risks, Legal Expenses) | ✅ | Product *Motor Trade*. Needs the Risk Validation answer *Yes*, the analysis codes (Section G / 45 / 45.1 / 45.11 / 4511100) and the Claims History fields. The offering (SME) is defaulted, **the risk sections are not**: the test adds them |
| Create working quote from the reference model | ✅ | ⋮ → Model |
| Insert schedule with geocoding and peril score | ✅ | Imports `MTP/MTP_Schedule_Import.xlsx` (the file must be saved by Excel: the app's own export has non-standard cell references and the importer reads it as empty) |
| Get Commission · Get Pricing | ✅ | Every section is listed as *not rated* in the commission dialog; the test accepts it. Next Stage answers with a warnings banner (*Selected Product Hazard*) that is acknowledged. **Get Price is only offered from the 2nd stage, UW Review & Process**, so Next Stage comes first. **Geocoding + Peril Score is mandatory before Get Price**: when the app answers *"The Geocoding for all schedule items have not been done"* the test runs *Geocode and Get Peril Score* and prices again (`getPriceGeocodingIfMissing`). Each product has its own stages and operations, which is why MTP keeps its own flows |
| Quote Terms and document upload / download · Search / Advance search | ✅ | |
| Issue Quote · Multi-Quote · Taken up quote · Requote | ✅ | |
| General endorsement → take-up → MTA pricing · MTA – Reversal | ✅ | |
| Mid-Term Cancellation – Pricing and Reinstate | ✅ | |
| Renewals – Pricing | ✅ | Own Bound policy → Renew – Quote → **CTA rationale** (Details → Premium, mandatory once the renewal inherits a CTA) → price (geocoding done first when missing, as above) → issue → take up → Bound renewal policy |
| MTA – Inception Cancellation Policy – Pricing | ✅ | Own Bound policy → ⋮ Inception Cancellation → Save (Confirm *"Do you wish to confirm the change?"*, then Ok on *"Effective dates of the Child components…"*) → Get Price → Confirm Cancellation → documents |
| Documents/datalake payload · Data lake · ALS & server-folder payloads | 🔒 | Backend evidence |

> The backend document service sometimes ends one policy document **"In Error"**. The *Taken up quote* test reports it; set-up policies (for cancellation / renewal) do not assert documents, so the later policy tests still run. (An Inception Cancellation's documents ended "In Error" in two earlier runs and completed in the latest one, so it is intermittent.)

<a id="ppp"></a>

### 🏘️ PPP (UK Property Investors Protection Plan) — `tests/ppp/flows.spec.ts`

Own folder `src/products/ppp/` (data, `PppSectionsPage`, `flows/quote.ts`, `flows/policy.ts`). Env: `PPP_URL`, `PPP_SCHEDULE_IMPORT`, plus the `PPP_*` resume URLs.

| Checklist row | Status | Notes |
|:--|:--:|:--|
| Convert to Quote | ✅ | Needs Business Type, *All buildings constructed after 01/01/2000?* = Yes and Claims History years = 0 |
| Create working quote · Insert schedule · Get Commission · Get Pricing | ✅ | Working quote = ⋮ → Model copy of the reference quote, which already has the PPP risk section, its covers and a Broker Commission row (the test only updates that row's percentage). The schedule import has an extra *Define Mapping* notice |
| Quote create task · Documents · History · Search | ✅ | Task type *Underwriting Referral - PPP*; the Complete click is repeated because it sometimes has no effect |
| Issue Quote · Multi-Quote · Taken up quote · Requote | ✅ | Taken Up acknowledges the *no Survey Details* warning |
| General endorsement → take-up → MTA pricing · MTA – Reversal | ✅ | |
| Decline · Renewals | ✅ | |
| Mid-Term Cancellation | ✅ | The cancellation itself works |
| Reinstate Policy | ❌ | The reinstatement MTA halts in the backend (*Halted At : PPPV2RECPolicyReview Stage – AutoRunWorkflow : Pricing is Failed*) and Get Price opens no dialog on it. The test reports that message |
| Data lake | 🔒 | Backend evidence |

### 🧩 Fleet

Own folder `src/products/fleet/` (data, `FleetSectionsPage`, `flows/quote.ts`, `flows/policy.ts`). Env: `FLEET_URL`, `FLEET_SCHEDULE_IMPORT`. No fixed reference quote: the quote created from the submission (inception today − 10 days; offering *Vantage Fleet* → FLEET section + covers → schedule import → commission) is the model, and every other Fleet quote is a ⋮ → Model copy of it.

| Checklist row | Status | Notes |
|:--|:--:|:--|
| Get Commission | ✅ | ⋮ → Get Commission (Fleet is eligible) |
| Get Experience Call | ✅ | *Number of years claims experience* (Details → Claims Experience Analysis → Years Claims Experience) is set above 0 (`fleetClaims.years`), then ⋮ → Experience Call. It runs **before Get Price** (and before Next Stage) in every pricing path, and again on endorsement quotes when offered |
| Get Claims · CDL call · schedule add/update/delete + export · party creation | ⬜ | Not written |
| Data lake | 🔒 | Backend evidence |

## 📐 Conventions (all five products)

- **No fixed reference quote** in any product: the quote created from the submission in each product's `<Product> - Quote` chain is the model, and every other quote of that product is a ⋮ → Model copy of it (built first when a worker has none).
- **Inception date** = today − 10 days, for every new submission and every Model-copy quote (`src/support/dates.ts`). A General Endorsement
  (Effective From = inception + 10 days) therefore starts today.
- **Mid-Term Cancellation** takes effect **today** (`effectiveFrom` in each product's cancellation data).
- **Commission:** ⋮ → *Get Commission* for **Fleet, CMBC and MTP**; **PI and PPP** are not eligible, so the *Override %* of the already-defaulted
  Broker Commission row is set by hand (the test fails when that row is not there). Test names: `Get Commission` / `Add Broker Commission`.
- **Warnings:** every product acknowledges any warnings banner (ACKNOWLEDGE) and carries on.
- **Test groups:** `<Product> - Submission and conversion | Quote | Quote lifecycle | Policy | Cancellation | Renewal`, tagged `@flow` and `@<key>-flow`
  (`@smoke` is only for the quick page checks). Same step ⇒ same test name in every product (`MultiQuote`, `Requote`, `Renewals`,
  `Quote Taken up and conversion to Policy`, `MTA - GE Pricing and Confirm Endorsement`, `MTA - Mid Term Cancellation Policy and Reinstate Policy`…).
- **Contract records** are prefixed with the product (`Fleet Endorsement Quote`, `PPP Mid-Term Cancellation (MTA)`…); env variables are `<KEY>_*` (upper case).
- Shared test PDF: `src/assets/smoke-doc.pdf`.

---

<a id="resume"></a>

## 🔁 Resuming a long run (environment variables)

A full PI run takes ~25 minutes and a **session can expire mid-run**. Rather than start over, point a test at records that already exist:

| Variable | Resumes… |
|:--|:--|
| `PI_QUOTE_URL` | quote-level steps alone on an existing quote (e.g. `-g "Get Pricing"`) |
| `PI_POLICY_URL` | the policy rows (endorsement, reversal…) on an existing **Bound** policy |
| `PI_ENDORSEMENT_URL` · `PI_ENDORSED_POLICY_URL` | an endorsement already started / finished (one endorsement per policy at a time) |
| `PI_RENEWAL_BASE_POLICY_URL` · `PI_RENEWAL_QUOTE_URL` · `PI_RENEWAL_POLICY_URL` · `PI_RENEWAL_ENDORSEMENT_URL` | each stage of the renewal |
| `PI_CANCEL_POLICY_URL` · `PI_CANCEL_MTA_URL` · `PI_REINSTATE_MTA_URL` | each stage of cancel / reinstate |
| `CMBC_…` · `MTP_…` | the same idea for CMBC and MTP (`CMBC_QUOTE_URL`, `MTP_POLICY_URL`, `MTP_ENDORSEMENT_URL`, `MTP_ENDORSED_POLICY_URL`, `MTP_CANCEL_*`, …) |

```bash
# example: carry on from a Bound policy, run only the policy rows
PI_POLICY_URL=https://<host>/ui/Policy/Edit/117670 npm run smoke -- --products pi --headed --workers=1 -g "PI - Policy"
```

---

<a id="signin"></a>

## 🔐 Signing in (SSO + MFA)

```mermaid
flowchart LR
  A["npm run login:cdp"] --> B["Normal Edge window opens<br/>profile: .auth/edge-profile"]
  B --> C["You sign in once<br/>(incl. MFA)"]
  C --> D["Session saved"]
  D --> E["Every run: auth:&lt;host&gt; project<br/>refreshes it automatically"]
  E -.->|"Microsoft expires the profile"| A
```

- `npm run login:cdp -- ppp` picks the product whose host to sign in to, when products are on different hosts.
- `npm run auth` runs just the refresh step.
- `npm run login` (Playwright's own browser) gets closed by the SSO redirect on some machines — use `login:cdp` if that happens.
- ⚠️ **Never run two test / explore sessions at once**: the app rotates tokens and the second one gets logged out.

---

<a id="troubleshooting"></a>

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
|:--|:--|:--|
| *"browser has been closed"* at the SSO callback | The exported session file was invalidated (CMBC runs use the live Edge profile and **rotate the token**) | Run **without** `--no-auth` after a CMBC run, or `npm run login:cdp` |
| Tests fail with *"Logging in…"* / Microsoft login pages in the middle of a long run | The SSO session expired | Re-run the remaining tests using the [resume variables](#resume) |
| A page renders blank, or the deep link lands on the Dashboard | Slow host | Handled automatically: the page is opened again up to 3 times |
| *"Profile already in use"* | A login Edge window is still open | Close it (the runner kills only Edge windows using `.auth/edge-profile`) |
| CMBC Get Price: *"The Geocoding … have not been done"* | Schedule not geocoded | See the [CMBC geocoding rule](#cmbc) |
| Policy documents end **"In Error"** | Backend document service, not the test | Check the doc service; the test fails fast instead of waiting |
| Save / Get Price / Issue shows a warnings banner | App wants an acknowledgement | Handled: the **ACKNOWLEDGE** link finishes the action |
| *Issue Quote* waits forever | The Licence Referral needs a Level 2/3 approver | The suite self-approves; `LICENCE_SELF_APPROVE=0` waits for a real person |

---

<a id="layout"></a>

## 🧱 Project layout

```
src/
├── products/
│   ├── index.ts              registry: the list of products (add yours here)
│   ├── types.ts              ProductConfig + defineProduct()  (env-driven: <KEY>_URL, <KEY>_USER, <KEY>_<ANYTHING> via product.env())
│   ├── platforms/advantagego.ts   login, home page and page checks shared by every AdvantageGo product
│   ├── pi/      index.ts · data.ts · PiSectionsPage.ts · flows/quote.ts · flows/policy.ts
│   ├── cmbc/    index.ts · data.ts · CmbcSectionsPage.ts · flows/quote.ts · flows/policy.ts   (own copies: nothing shared with PI)
│   ├── mtp/                  full flows (data, MtpSectionsPage, flows/)
│   └── ppp/ fleet/           config only for now
├── pages/advantagego/        low-level page objects (quote, policy, search, documents, grids…) — the ONLY code products share
├── config/                   env.ts · auth.ts (session files, one login per host)
├── smoke/registerSmokeSuite.ts   the generic checks every product gets
└── fixtures/ · support/      diagnostics fixture · contracts table
tests/<key>/                  smoke.spec.ts + flows.spec.ts for each product
scripts/run-smoke.mjs         the runner · scripts/login-cdp.mjs  SSO sign-in helper
```

```mermaid
flowchart TB
  T["tests/&lt;key&gt;/flows.spec.ts"] --> F["products/&lt;key&gt;/flows/*"]
  F --> PO["pages/advantagego/*<br/>shared page objects"]
  F --> D["products/&lt;key&gt;/data.ts"]
  PO --> UI(["AdvantageGo UI"])
  style PO fill:#fff4d6,stroke:#b8860b
```

<a id="add-product"></a>

### ➕ Adding a product

1. **Config** — `src/products/<key>/index.ts`:
   `export const ppp = defineProduct('ppp', 'PPP', { ...advantageGo, /* overrides */ })` (already scaffolded for ppp, fleet).
2. **Register** it in `src/products/index.ts`.
3. **Enable** it by setting `<KEY>_URL` (and `<KEY>_USER` / `<KEY>_PASSWORD` if it doesn't use SSO) in `.env`.
   That alone turns on the generic page checks, and `npm run smoke:<key>` / `--products <key>` start working.
4. **Flows** — keep them *all inside the product's folder*: test data in `data.ts`, steps in `flows/quote.ts` and `flows/policy.ts`,
   product-specific page objects next to them (extend `QuoteSectionsPage`), specs in `tests/<key>/flows.spec.ts`.
   Copy PI's or CMBC's `flows/` as the starting point and change it freely. Read product settings with `<product>.env('<NAME>')`.

<details>
<summary><b>➕ Adding a page check (no code)</b></summary>

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

</details>

---

<div align="center">

**Quick reminder** &nbsp;·&nbsp; `npm run smoke:select` to choose &nbsp;·&nbsp; `--headed --workers=1` to watch &nbsp;·&nbsp; `results/runs/<timestamp>/summary.md` for the answer

</div>
