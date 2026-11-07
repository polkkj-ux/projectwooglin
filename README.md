
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
- Status text colours now meet WCAG AA contrast; one keyboard stop per borrower; phone layout for the borrower table; plain-English definitions of EBITDA, trailing-12-month and debt service; projected quarters are worded as projected on the borrower page.

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
