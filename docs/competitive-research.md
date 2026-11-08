# Competitive research: covenant monitoring in private credit

Reviewed 7 November 2026 for the v13 platform upgrade. Sources are each vendor's public product page, plus a web search for Chronograph's private credit product. We did not have accounts, demos or trials for any of these products. **Nothing below was verified hands-on**: it records what each vendor says publicly. No code, screenshots, copy or branding were taken from any vendor. Everything built in v13 is original.

## What vendors say publicly

| Vendor | Page | Public claims relevant to covenant monitoring | How specific the page is |
|---|---|---|---|
| Lumonic (PitchBook) | lumonic.com/private-credit | Proactive alerts for covenant thresholds and cushions; tracing calculations back to source data; handling amendments; portfolio monitoring reports for investment committees, LPs and co-lenders. | Benefit statements. A sample table shows an "In compliance?" column. No review or approval step is described. |
| MightyBot | mightybot.ai/use-cases/covenant-monitoring | AI agents extract DSCR, leverage and liquidity from borrower reports, compute headroom and trend against prior periods, and raise an alert naming the covenant, calculated value, threshold and source documents. Each extracted value keeps a pointer to its page and position. Teams start in an "audit mode" where analysts decide. Claims a 95% time reduction for one customer. | The most specific of the group on alert contents and human review. The time-saving figure is a vendor claim we cannot check. |
| Allvue Portfolio Intelligence | allvuesystems.com/solutions/portfolio-intelligence | AI-powered workspace on top of Allvue's credit front office; KPI tracking; benchmarking deals against private credit market data from its client network; AI-generated borrower commentary; exportable reports. | Positioned around benchmarking and AI commentary rather than covenant testing mechanics. |
| Finley | finleycms.com/platform/overview | Digitises credit agreements, automates debt capital operations, covenant compliance monitoring, reporting and scenario modelling; integrates with banking systems. | Broad platform claims; covenant testing details are not described. |
| Cardo AI | cardoai.com/solutions/by-product/deal-surveillance | Independent trigger and covenant calculations; "time-travel" across reporting dates to compare periods; drill-down from top-line movements to drivers; alerts; an audit trail of what was measured, waived and why. | Feature names with short descriptions. Oriented to asset-based finance. |
| Termgrid | app.termgrid.com/covenants | Portfolio-wide covenant visibility, automated alerts and testing, unified view of the capital structure, reporting. States more than 30,000 users and 1,600 institutions. | Benefit statements; user counts are vendor claims. |
| BankStride | bankstride.com/covenant-tracking-monitoring | Automated borrower document collection, reminders, compliance checks and exception tracking for banks. | Focused on collecting documents and tracking exceptions, not on calculation transparency. |
| Aloan | aloan.ai/solutions/covenant-monitoring | Covenants recorded at approval and tested each period from a cash-flow engine; compliance states (compliant, needs review, overdue, breach, waived); each result shows a trend chart, the period's calculation and a link to the source page; a portfolio manager confirms, waives or records each breach, and a granted waiver never turns a result into a pass. | Detailed workflow description, aimed at commercial banks. |
| Chronograph | chronograph.pe/general-partners/private-credit (via search) | Collects financial statements and compliance certificates in any format, validates borrower-reported figures such as EBITDA add-backs against negotiated caps, tracks bespoke covenant structures, automates reporting. Launched its private credit product in June 2026. | Search excerpts only; we did not open the full page. |

## Principles we took from the review

1. **Alerts should say what, why and how far.** The more specific vendors (MightyBot, Aloan) describe alerts that name the covenant, the value, the threshold and the source. Many pages stop at "real-time alerts". Our attention list gives each borrower one deterministic sentence with the ratio movement, the threshold, and the dollar gap.
2. **Show the calculation and the source next to the result.** Source tracing appears in several claims. We put the formula, inputs, threshold, dollar headroom and the quoted agreement sentence (with character positions and a SHA-256 hash) inside the expandable covenant row, so the evidence is one click from the overview.
3. **Keep a human decision in the loop, and do not overstate it.** Aloan describes confirm, waive or record. We did not build a waiver or default workflow (out of scope, and it would imply legal effect). We added a review status and note that are explicitly browser-only, not shared and not an audit record.
4. **Separate contractual results from internal early-warning rules.** "Cushion alerts" are common, but the pages do not say how they are defined. Our two internal rules (approaching a limit; material deterioration) are configurable, documented in Methodology, labelled "Internal rule" wherever they appear, and never change a covenant result.
5. **Compare periods.** Cardo's "time-travel" and MightyBot's trend comparison both point to period-over-period change. Every row and covenant shows the prior quarter and the change in headroom, and the history table and chart remain on each borrower page.

## What we did not copy or build

- No AI extraction presented as authoritative. Uploaded policies still require human review, and v13 adds an explicit confirmation before the text is used.
- No benchmarking (we have no market data), default prediction, waiver approval, document collection, borrower portal, integrations or enterprise collaboration.
- No vendor terminology was adopted as a product name, and no vendor visual design was referenced.

## Limits of this review

- Product pages are marketing material. Claimed capabilities, user counts and time savings could not be checked.
- Firecrawl page summaries and targeted extraction were used to read the pages. Chronograph was reviewed from search excerpts only.
