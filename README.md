## Statements extraction (v10)

Upload a borrower's financial-statements PDF; LlamaExtract (LlamaCloud) reads quarterly line items with page citations and confidence scores, and our code (`lib/statements.js`) computes every covenant input and tie-out. An analyst confirms each value before the covenant engine runs. Full description in progress; see also `data/statements/`.

### Known limitation: location-only citations

With the pinned LlamaExtract configuration (tier `agentic`, version `2.5`), many citations come back as a page and bounding box with the field's path (for example `quarters.3.capex`) in place of quoted text. In the live run on the synthetic PDFs, **60 of 96 BOR-09 values and 64 of 104 BOR-01 values** had a page location but no quoted text; every extracted number still equalled the generator's to the cent.

- The API marks such a value `citation_kind: "location_only"` with its page and bounding box and lists it before quoted values, so it is reviewed first. The review screen (`/statements`, in progress) shows it as **"Located on page N (no quoted text)"** with the bounding box and a distinct icon, under a count such as "60 of 96 values have a page location but no quoted text".
- It can be confirmed only if it passes at least one tie-out that uses it (balance sheet, liabilities + equity, operating income, printed total debt or EBITDA, or the match against `loan_covenants_extended.csv`); the tie-out is named next to the value. The internal TTM-sum checks do not count, because they compare a figure with the same extracted values. A location-only value that ties to nothing stays unconfirmable (20 for BOR-09 and 22 for BOR-01, none of them used by the covenant row).
- The analyst still confirms every value; nothing is auto-accepted.
- The count is recorded in each `data/statements/*.extracted.json` as `citation_summary`.
- Without a CSV row to match, TTM flow items that are location-only (for example D&A or interest) cannot be confirmed, so statements for a new borrower need quoted citations or another tie-out.

## Institutional monitoring workflow (v13)

The application now follows one path: **monitor → identify → investigate → verify → review**. All changes are in the interface (`public/app.html`). The calculation engine, API and cure planner are unchanged.

- **Overview figures with explicit units.** Borrowers monitored, borrowers requiring review, applicable covenant test failures (for example *22 of 32 tests* in Q3 2026, broken down by covenant), borrowers with deteriorating headroom, and data issues (only shown when present). Borrower counts, test counts and borrower-quarter observations are labelled separately.
- **Borrowers requiring attention.** A priority-ordered list: (1) applicable covenant failures, (2) missing, invalid or unverified data, (3) approaching a covenant limit, (4) material headroom deterioration. Each borrower appears once, with a sentence built from fixed templates, for example *"DSCR declined from 1.23x to 1.15x and is below the contractual 1.20x minimum. Cash flow of $300,000 is $12,000 short of the $312,000 the minimum requires."* One click opens the investigation. Springing tests that are not triggered are mentioned and never counted.
- **Internal monitoring rules** (priorities 3 and 4) are settings of this tool, not covenant terms: approaching a limit means a passing test has less than **5.0%** headroom; material deterioration means headroom on an applicable test fell **5.0 percentage points** or more since the prior quarter. Both are configurable under *Monitoring rules*, kept in browser storage, labelled "Internal rule" wherever shown, and computed from engine cents with integer/BigInt comparisons, so boundary values classify the same way every time (5.00% is not "approaching"; a fall of exactly 5.00 points is "material").
- **Monitoring table.** Borrower, overall status, leverage, debt-service coverage, other applicable tests, change from the previous quarter, headroom or shortfall (the tightest applicable test, in dollars and as a share of its limit), and review action. Search, filter by attention, choose the quarter, and sort by headroom. Missing values always sort last.
- **Borrower investigation.** The executive summary keeps to what needs review. A *Covenant status* table shows every covenant's result, actual against limit, dollar and percentage headroom, and prior-quarter value. Failing tests open automatically to show the comparison rail, the calculation (formula, inputs, threshold, amount at the limit, headroom) and the quoted agreement sentence with its character positions and hash. *Show it in the full document* highlights the sentence in the evidence panel. From the overview, BOR-01's DSCR agreement text is one click away; the highlighted document is two.
- **Analyst review (browser-only).** Not reviewed / Under review / Reviewed, a note and a timestamp per borrower and quarter. Kept only in this browser's local storage: not shared, not backed up, not an audit record, and it never changes a result. The page says so next to the controls.
- **Export findings.** A CSV for the selected quarter, one row per borrower and covenant, with engine results, headroom, prior-quarter values, citation, attention priority, explanation and any review note from this browser. Synthetic-scenario quarters are labelled in the file name and every row.
- **Setup checklist and policy confirmation.** Data sources opens with the workflow: records, policy, definitions and thresholds (each definition's location, or a flag if it is missing or the threshold does not match), calculations, investigation. An uploaded policy cannot be used until the reviewer confirms they compared it with the signed agreement.
- **Landing page.** Screenshots were recaptured from the new interface and three captions updated; the design is unchanged.
- **Research.** `docs/competitive-research.md` records what nine vendors say publicly, separated from what we could verify (nothing hands-on), and which principles we used.

**Verification.** 64 automated tests pass. Independent Python recomputation of the engine from the raw CSV: 773 values, 0 differences. Independent check of the new display logic against the app's own export for all four quarters: 360 checks, 0 differences. A purpose-built boundary CSV (headroom of 5.00% and 4.99%, falls of 5.00 and 4.99 points, a ratio exactly at its minimum, a one-cent shortfall, a missing report, an unreadable row, zero EBITDA, missing revolver data) classifies as specified. Browser audits: 119 application checks, 49 landing checks, plus upload, policy and edge-case suites; no horizontal overflow at 1440, 1400, 1366, 1280 or 390 px.

**Limitations.** Review notes and monitoring rules live in one browser and are lost if its storage is cleared. There is no shared persistence, authentication or audit log. Q4 2026 remains a synthetic scenario. "Contractual" in explanations means the threshold appears in the cited policy sentence; the policy is fictional.

## Hero preview, quarter-to-quarter movement and synthetic Q4 (v12)

- **Hero preview:** the product page now shows the BOR-01 investigation instead of the dense portfolio table: the title and executive summary, and the "Change since Q2 2026" row (DSCR 1.23x to 1.15x, crossed the 1.20x minimum, $12,000.00 short). Both are screenshots of the working application at close to their native size; the shortfall callout and caption are refreshed from `/api/covenants`. Phones show the BOR-01 DSCR test card.
- **Movement on the dashboard:** Portfolio Overview has a "Moved into exception" panel listing borrowers that passed every applicable covenant last quarter and failed one this quarter, with each covenant's previous and current ratio against its limit and the dollar gap. Borrowers already in exception with a newly failed test are listed separately. Each borrower page has a "Change since" table, and Borrower Monitoring marks the quarter each borrower moved into exception. A springing test that is not triggered is shown for context and never counted as a failure.
- **Q4 2026 is a synthetic scenario.** The data runs to 30 September 2026; the Q4 rows are fictional figures with no forecasting method behind them. Every label, notice, chart, the methodology page and the engine's assumption text now say "synthetic scenario", not "projected". Q4 is never selected by default.
- These are display changes only; the calculation engine's results are unchanged (independent recomputation: 773 values, 0 differences).

## Cure planner (v11)

For every borrower-quarter in breach, the borrower page now shows **Cure options**: the cheapest cure the (synthetic) agreement allows, or, when none exists, proof of why not and the smallest waiver that would work. **Gurobi proposes; the exact engine decides.** Every plan is re-checked by `lib/covenants.js` in BigInt cents against every covenant the monitor applies, with the same covenant terms. A plan is shown only if it passes.

**What it does**

- **Three options per quarter:** cheapest (equity cure, early repayment, asset sale), without an asset sale, and equity cure only. Each shows its actions in plain English ("Sell Division A; sponsor contributes $68,333.34"), total cost, every covenant afterwards, a *Verified by exact engine* badge, the cited policy sentence for each binding limit, and *Show model* (Gurobi version, parameters, SHA-256 of the `.lp` file).
- **No cure:** the panel says *No cure within the agreement*, lists the blocking terms in plain English (from Gurobi's IIS), and gives the smallest waiver, for example *Request a waiver to 3.46x maximum leverage for 2026-Q3*. The waiver is sized by FeasRelax and also verified by the exact engine at the waived limits.
- **What-if inputs** (cure cap, cures remaining, asset sale) re-solve live when a solver is connected. Without one, the panel serves a stored solution labelled *Solved offline with Gurobi 13.0.3 at …* and hides the inputs.
- **API:** `GET /api/cure?borrower=BOR-09&period=2026-Q3`. `POST /api/cure` takes `{borrower, period, overrides?, settings?}`; `settings` is the same object `POST /api/covenants` takes. What-if overrides need the live solver; without it the API returns 503.

**The model** (`opt/`, spec in `opt/SPEC.md`). It's a small MIP in exact integer cents, using the same rounding as the engine.
- **Constraints:** C1 leverage, C2 DSCR, C3 cure cap, C4 cure frequency, C5 minimum liquidity, C6 current ratio and C7 FCCR. C6 and C7 apply only in quarters where the monitor applies those tests.
- **Waivers:** FeasRelax relaxes only covenants that fail before any cure. Cure cap, cure frequency and liquidity are facts and are never relaxed.
- **Citations:** each constraint is cited by character offset and SHA-256 from `data/documents/loan-policy.txt`, `data/documents/cure-policy.txt` or the team addendum.

**Run the solver (Windows, licensed)**

```powershell
py -m pip install -r opt\requirements.txt
py -m uvicorn opt.app:app --host 127.0.0.1 --port 8000
$env:OPT_URL="http://127.0.0.1:8000"; npm run dev      # then open /app#borrower-BOR-09
```

- **Refresh the stored solutions** with `npm run cure:snapshot`, with `OPT_URL` set. This writes `data/cure_snapshot.json` and exits non-zero if any plan fails the exact re-check.
- **Vercel** has no solver, so it serves that snapshot, re-checked on every request.
- **Licence:** WLS credentials, if used, go in `opt/.env`, which is git-ignored. Never commit licence files.

**Known answers (BOR-09 2026-Q3, synthetic terms)**

| Case | Result |
|---|---|
| All levers | Sell Division A + $68,333.34 equity cure, $78,333.34 |
| No asset | $98,333.34 equity cure |
| No cures left | No cure (IIS: leverage, cure cap, cure frequency, current ratio). Waiver: sell Division A, repay $148,514.85, 3.19x max leverage; current ratio exactly 1.25x |
| No cures, no asset | No cure. Waiver: repay $148,514.85, 3.46x max leverage |
| BOR-01 2026-Q3 | $12,000 equity cure, equal to the engine's −$12,000.00 cash-flow headroom |
| BOR-02 2026-Q3 | $16,000. A $12,000 DSCR-only cure would leave FCCR at 1.0846x |
| BOR-07 2026-Q3 | No cure (the current ratio already fails). Waiver to a 1.21x minimum current ratio |

**Real vs synthetic.** Everything the planner uses is synthetic and labelled as such on screen: `data/cure_terms.csv` (cure cap, cures remaining, cash, minimum liquidity, prepayment premium, debt-service relief, the Division A asset), `data/documents/cure-policy.txt`, and the team addendum and extended columns it builds on. Cure costs are cash outlays only: no tax, no fees beyond the stated premium and sale cost, and no time value. A plan is decision support for a credit reviewer, not a legal determination of default or cure. Every assumption is in the API's `assumptions` list.

**Verification.**
- **Tests:** `npm test` 63 pass (44 from main plus 19 for the cure planner); `python -m pytest opt/tests` 16 pass.
- **Snapshot:** all 30 exception rows solved with the licensed Gurobi 13.0.3, and every plan passed the exact re-check.
- **Gurobi Explainer:** it independently confirmed the IIS and the FeasRelax waiver for the earlier continuous model (`opt/SPEC.md`, Verification).
- **Smoke test:** checks that BOR-09 2026-Q3 is served from the snapshot.

**Not verified in this build**

- The Explainer has not re-checked the current integer-cents model with C6 and C7.
- The solver's licence type: the health check reports only the Gurobi version.
- The panel itself: the build agent checked its API responses and script syntax but did not view it in a browser, and it has not been tried on a live Vercel deployment. The PR lists what to look at.
- Snapshot answers are for the default covenant terms. With other terms and no live solver, a stored plan can be rejected by the re-check, and the panel then says so.

**In progress (phase 6):** compliance-certificate check (6a), EBITDA cushion and early warning (6b), and a printable credit memo (6c).


## Product page at `/`, application at `/app` (v10)

- **`/`** (`public/index.html`) is the public product page: an editorial hero with a screenshot of the working Portfolio Overview, the problem and the Detect / Quantify / Verify platform, a three-step BOR-01 walkthrough built from real application screenshots, and the trust and methodology section. Every "Explore Live Demo" and "Open Application" link goes to `/app` with no sign-up.
- **`/app`** (`public/app.html`) is the monitoring application, unchanged in function. `vercel.json` rewrites `/app` to `public/app.html`; `server.js` serves the same routes locally.
- **Old links keep working.** A short script at the top of the product page forwards application hashes (`/#overview`, `/#borrowers`, `/#analysis`, `/#design`, `/#method`, `/#how`, `/#borrower-…`) to `/app#…`. Product-page anchors (`#platform`, `#how-it-works`, `#methodology`) never collide with them.
- **Figures on the product page come from the engine.** BOR-01's numbers are written into the page and then refreshed from `/api/covenants` on load, so they cannot drift. The screenshots in `public/assets/` were captured from the running application (1× and 2× WebP).
- **Shared brand:** the same wordmark, palette (midnight navy, ivory, champagne accent) and type. Newsreader (SIL OFL, `public/fonts/LICENSE-Newsreader.txt`) is used for headings on both pages; Inter for everything else.
- **Inspired by 21st.dev, built without new dependencies.** 21st components are React and Tailwind; this project is plain HTML with no build step and a strict Content-Security-Policy, so three patterns were rebuilt directly: a hero screenshot that settles from a slight tilt as you scroll, a header that condenses with a sliding indicator under the current section, and quarter-trend sparklines on the dashboard's headline figures. All three switch off for reduced motion.
- The Content-Security-Policy now also allows `img-src 'self'` for the screenshots.

## Four covenants in the redesigned interface (v9)

Liam's v7 engine work (below) is merged into the v8 institutional redesign. The backend is his, unchanged; the redesigned page now reads every covenant the engine returns instead of only leverage and DSCR.

- **Portfolio Overview:** the four headline KPIs stay; a *Covenants in force* strip shows each covenant's mode (maintenance, springing at the trigger, not applied) and how many borrowers fail it. The borrower table has a column per covenant; dormant springing tests show as hollow markers with "Not triggered" (or "Not triggered; would fail"). Status labels count failed tests ("2 tests failed").
- **Covenant terms** (header button): portfolio-wide mode per covenant and the springing trigger, with the cited springing provision and a list of borrower-specific overrides. Changes recalculate on the server; a failed change leaves the previous results in place.
- **Borrower page:** a test card per covenant (dormant ones dashed, with "if it applied" wording), a covenant picker for the quarterly chart, all ratios in the history table, a per-borrower terms panel with revolver utilisation, and policy evidence from both documents: the organizer policy and the team addendum, each with highlighted sentences, character positions and SHA-256.
- **Covenant Analysis:** headroom charts for every applied covenant, compliance gaps per covenant, FCCR/current-ratio/springing definitions, and springing data-quality notes (for example missing revolver figures).
- **Covenant Designer** page in the redesign's style, and Methodology sections for FCCR, current ratio, springing covenants and the Designer.

**Verification for this merge:** `npm test` (43 pass); an independent Python `Decimal` recomputation of all four covenants and the springing rule from the raw CSV (773 field comparisons against the API, 0 mismatches); 81 browser checks against the running app (every KPI, filter count, status label and table ratio per quarter, all 36 borrower pages, both demos, terms changes and overrides, the Designer at 25% and 10% cushion); 26 upload and policy checks; edge-case files; no horizontal overflow at 1440, 1280, 1024 or 390 px.

**Demo add-on, adjusted for the redesign.** Pick Q2 2026: the banner says 2 borrowers would fail a springing FCCR test. Open **BOR-02** (status *Springing test would fail*). In *Covenant terms for BOR-02*, set FCCR to *Maintenance*: BOR-02 now fails, $6,000.00 short of the $286,000.00 needed. Then **Covenant Designer → Use sample statements** (leverage ≤ 4.00x) and drag the cushion to 10% (3.25x).

## Four covenants, springing terms and the Covenant Designer (v7)

**New covenants.** Besides leverage and DSCR, the engine now tests **fixed-charge coverage** (FCCR = (TTM EBITDA − unfinanced capex − cash taxes − distributions) ÷ fixed charges) and the **current ratio** (current assets ÷ current liabilities). They apply to any row that has `min_fccr` or `min_current_ratio`; files without those columns behave exactly as before. Every covenant shares one result shape (`numerator_headroom_usd`, `denominator_limit_usd`, …) so the page renders any covenant the same way.

**Springing covenants.** The lender chooses, per covenant, **Maintenance** (tested every quarter), **Springing** (tested only when revolver drawn ÷ commitment is at or above the trigger, default 35%) or **Not applied**. Use **Covenant terms** in the header for the whole portfolio, or the terms panel on a borrower's page for that borrower only. A dormant springing test is shown with what it *would* be, but counts as neither passing nor failing. If revolver figures are missing, the test is run anyway (conservative). Default: FCCR springing, others maintenance. The API takes the same settings: `POST /api/covenants {"settings":{"trigger_pct":"35","modes":{"fccr":"maintenance"},"borrowers":{"BOR-02":{"modes":{"fccr":"off"}}}}}`.

**Covenant Designer** (`#design`). Upload a company's statements as a CSV of `line_item,amount_usd` (or use the sample). The backend (`lib/recommend.js`, `POST /api/recommend`) derives EBITDA, debt, debt service and the four ratios, then recommends which covenants to include, at what level (so results could fall by the chosen cushion, default 25%, before breach), and whether each should be springing. It shows every figure's source line, the rules used, and draft term-sheet language. It is deterministic; no LLM.

**Data.** The default dataset is `data/team/loan_covenants_extended.csv`: the organizer's `loan_covenants.csv` values unchanged, plus team-made **synthetic** capex, tax, distribution, working-capital and revolver columns (`scripts/make-extended-fixture.js`). FCCR, current ratio and springing definitions come from `data/team/covenant-policy-addendum.txt`, a team-written synthetic addendum cited separately from the organizer policy. The organizer files are untouched.

### Demo add-on (1 minute)

1. **Springing (30s).** On Overview (Q2 2026), point to the banner: FCCR is dormant for 5 borrowers, 2 would fail. Open **BOR-02**: within limits, but its springing FCCR would fail at 1.08x. Change FCCR to *Maintenance* in its terms panel: BOR-02 now fails, $6,000.00 short of the $286,000.00 needed.
2. **Designer (30s).** Open **Covenant Designer → Use sample statements**: leverage ≤ 4.00x, FCCR ≥ 1.10x springing at 35%, current ratio ≥ 1.20x, DSCR optional. Drag the cushion to 10% and the leverage maximum tightens to 3.25x.

## Borrower analysis page (v5)

Click **Review** on any borrower (Overview, Borrowers table) to open `#borrower-<ID>`. The page answers five questions: what happened, which requirement failed, how far from compliance, improving or deteriorating, and what data and policy text support it. "Show calculation" and "View policy evidence" expand to formulas, inputs, the cited policy sentences (with offsets and SHA-256) and the raw row.

Every figure is read from `/api/covenants`; the browser never recalculates a covenant. The engine now also returns `max_debt_usd`, `ebitda_required_usd`, `cashflow_required_usd` and `debt_service_max_usd` so the page does not derive them. The page states that a result is a potential covenant breach, not a legal default determination.

## Pre-demo audit (v6)

Fixed after a design, usability and functionality audit:

- **Uploads are all-or-nothing.** An empty file, a file without the required covenant columns, or a header-only CSV is rejected with a clear message and the previous data stays on screen. Before, an empty file silently switched back to the sample data and a rejected file was re-sent with the next policy upload.
- **Duplicate reports are flagged.** Two rows for the same borrower and quarter are both marked as data errors ("the tool cannot tell which one governs") instead of one silently replacing the other.
- **Malformed quarter labels** (for example `Q3-2026`) are listed under Data quality and no longer appear in the quarter selector.
- **Successful CSV uploads are confirmed** with row and borrower counts and the file name.
- **"New this quarter"** marks borrowers that passed both tests last quarter and failed this quarter (derived only from engine statuses).
- Status text colours now meet WCAG AA contrast; one keyboard stop per borrower; phone layout for the borrower table; plain-English definitions of EBITDA, trailing-12-month and debt service; quarters after the reporting date are labelled on the borrower page (now as synthetic scenarios, see v12).

### Two-minute demo

1. **Overview (20s).** "9 borrowers, all 9 need review in Q3 2026, 3 newly flagged." Point to the reporting date chip and the note that a failed test is not a legal default.
2. **Find BOR-01 (10s).** Scroll Needs attention: BOR-01 is *New this quarter*, one test failed, DSCR 1.15x below the 1.20x minimum. Click **Review**.
3. **Explain (40s).** Read the summary: DSCR fell from 1.23x to 1.15x while leverage rose from 2.75x to 2.82x but still passes. Debt and debt service did not change; EBITDA fell $10,000 and cash flow fell $20,000.
4. **Exact shortfall (20s).** It needed $312,000.00 of cash flow and had $300,000.00, so it is $12,000.00 short. Question 3 shows the alternative: debt service would have to fall to $250,000.00.
5. **Evidence (30s).** Open **View policy evidence**: the DSCR sentence from the policy, its character position and SHA-256, and the raw CSV row. Optionally open **Show calculation**.

### Not verified in this build

- Live LlamaParse PDF parsing (tested only against a mocked parser; no API key was used).
- Supabase persistence (the starter-pack Supabase client is not exercised by the covenant feature).
- Browsers other than Chromium/Chrome; screen-reader testing.

## Deploying to Vercel

The repository is Vercel-ready with no build step and no environment variables required.

- `api/index.js` is the Vercel function. It reuses `handleRequest` from `server.js`, so production runs the same routes, validation, covenant engine and citations as `npm run dev`.
- `vercel.json` serves `public/` as the static site, rewrites `/api/*` to the function, bundles `data/` (sample CSV and policy) with it, and sets the same Content-Security-Policy the local server sends.
- Import the repository in Vercel (**Add New → Project → Import**). Framework preset: **Other**; leave build and output settings as detected from `vercel.json`. Deploy.
- **Do not add `LLAMA_CLOUD_API_KEY`** to a public deployment unless you accept that any visitor can spend parser credits. Without it, PDF upload shows a clear "not enabled" message; TXT policies still work.
- After deploying, verify with `npm run smoke -- https://<your-app>.vercel.app`. It checks the live API is byte-for-byte identical to the local engine and exercises CSV upload, bad-file rejection, policy parsing and the dashboard page.

Limits on Vercel: request bodies are capped at 4.5 MB by the platform (the UI limits CSVs to 4 MB and policy files to 3 MB). There is no rate limiting or authentication; this is a public demo on synthetic data, not a production service.

## Institutional redesign (v8)

The frontend in `public/index.html` was rebuilt as an enterprise application shell; the backend calculation engine, API, CSV parsing, uploads and tests are unchanged apart from two read-only additions (`GET /api/policy` for the evidence panel and static serving of the bundled Inter font).

- **Pages:** Portfolio Overview (four borrower-level KPIs and the monitoring table with status filter, search and sorting), Borrower Monitoring (status by borrower and quarter), Covenant Analysis (organised around four questions: who is outside limits, who is deteriorating, how far from compliance, what is driving the change), Methodology, and the borrower investigation view (executive summary, covenant tests, quarterly charts with policy thresholds, and the policy document with the cited sentences highlighted at their exact character positions).
- **Design system:** midnight-navy sidebar, warm-white canvas, Inter (bundled, SIL OFL; see `public/fonts/LICENSE-Inter.txt`) with tabular figures, a serif for page titles only, status colours reserved for pass/fail meaning and checked for WCAG AA contrast.
- **Verification:** `npm test` (35 tests), plus browser checks that every displayed ratio, KPI and dollar figure equals the engine output; see the deployment smoke test with `npm run smoke -- <url>`.
