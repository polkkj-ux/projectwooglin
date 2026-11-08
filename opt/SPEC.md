# Covenant Cure Planner: model specification

This specification was drafted with the Gurobi Modeler (MCP) from the build brief, then reviewed and extended. Review changes are listed at the end.
All terms and data are **synthetic** and apply only to this exercise.

## Purpose

This model works on one borrower-quarter that breaches its leverage and/or DSCR covenant. It finds the cheapest combination of permitted cure
actions that restores compliance. When no combination works, it proves infeasibility with an IIS and sizes the smallest waiver of the covenants
that fail before any cure. Gurobi proposes; the Node exact engine (`lib/covenants.js`, BigInt cents) re-checks every plan against every covenant
the monitor applies (leverage, DSCR, FCCR, current ratio, with the same settings) before it is shown.

## Units: exact integer cents

Every money variable is an integer number of cents, and every coefficient is an integer. Ratios are x100 integers (3.00 → 300) and `k` is x10,000 (0.18 → 1,800).
Inputs arrive as decimal strings and are converted exactly; anything finer than a cent is rejected. The premium and debt-service relief are integer variables that reproduce the exact engine's
rounding. So no rounding step can push a binding limit past its threshold. Every solution is also re-checked in Python integer arithmetic (`check_exact`) before it is
returned. A solution that fails that check is reported as an error, never as a plan. Params: `Threads=1`, `Seed=0`, `MIPGap=0`, `IntFeasTol=1e-9`, `FeasibilityTol=1e-9`.

## Decisions

| Symbol | Type | Meaning |
|---|---|---|
| E | integer ≥ 0 | Equity cure contributed by the sponsor (cents) |
| P | integer ≥ 0 | Voluntary debt paydown (cents) |
| Q | integer ≥ 0 | Prepayment premium (cents): `PREMIUM: 10000·Q ≥ bps·P`. Q is in the objective, so it equals `ceil(P·bps/10000)` |
| R | integer ≥ 0 | Debt-service relief (cents): `RELIEF: 10000·R ≤ k·(P + proceeds·s)`, so at most `floor(k·repaid)` |
| y | binary | Equity cure right used this quarter |
| s | binary | Sell the permitted asset (fixed at 0 when there is no asset) |

## Objective

Minimize `E + P + Q + sale_cost · s` (cents).

## Constraints and the clauses they implement

| Name | Constraint (integer cents, ratios x100) | Policy sentence(s) | Relaxable in FeasRelax |
|---|---|---|---|
| C1 | `100·(D − P − proceeds·s) ≤ Lmax·(EBITDA + E − asset_ebitda·s)` | loan-policy.txt: "Leverage is gross debt divided by trailing twelve-month EBITDA, maximum 3.00." and cure-policy.txt: "Asset sales: …" | only if leverage fails before any cure |
| C2 | `100·(CF + E − asset_cf·s) ≥ Dmin·(DS − R)` | loan-policy.txt: "DSCR is trailing twelve-month available cash flow divided by trailing twelve-month debt service, minimum 1.20." and cure-policy.txt: "Prepayment: …" | only if DSCR fails before any cure |
| C3 | `E ≤ cap · y` | cure-policy.txt: "Equity cure: …" | no (fact) |
| C4 | `y ≤ cures_remaining` | cure-policy.txt: "Cure frequency: …" | no (fact) |
| C5 | `P ≤ cash − min_liquidity` | cure-policy.txt: "Minimum liquidity: …" | no (fact) |
| C6 | `100·(current_assets − P − Q) ≥ min_current_ratio · current_liabilities` | team/covenant-policy-addendum.txt: "Current Ratio is current assets divided by current liabilities at quarter end, minimum 1.25." and cure-policy.txt: "Cure cash: a voluntary prepayment and its premium are paid from cash and reduce current assets, equity cure cash is not added to current assets, and the sale cost of a permitted asset sale is paid from its gross proceeds." | only if the current ratio fails before any cure |
| C7 | `100·(EBITDA + E − asset_ebitda·s − capex − cash_taxes − distributions) ≥ min_fccr·(DS − R)` | team/covenant-policy-addendum.txt: "Fixed Charge Coverage Ratio is trailing twelve-month EBITDA less unfinanced capital expenditures, cash taxes and distributions, divided by trailing twelve-month fixed charges (scheduled interest and principal), minimum 1.10." and cure-policy.txt: "Equity cure: …" | only if FCCR fails before any cure |

C6 and C7 are included **only when the monitor's engine applies that test** to that borrower and quarter under the current settings: not off, and not dormant (a springing FCCR applies when triggered, or when revolver data is missing). Node decides this and sends the current-ratio fields (`current_assets`, `current_liabilities`, `min_current_ratio`) or the FCCR fields (`capex`, `cash_taxes`, `distributions`, `min_fccr`) only in that case. Capex, cash taxes and distributions don't change with a cure, including after an asset sale.
The full sentences are listed in `opt/cure_model.py` (`CLAUSES`). The Node app cites them by exact character offset and SHA-256.

## Inputs

These are the borrower-quarter figures from `data/team/loan_covenants_extended.csv` (the monitor's default data): `D`, `EBITDA`, `DS`, `CF`, `Lmax`, `Dmin`, and, when applied,
`current_assets`, `current_liabilities` and `min_current_ratio`. The cure terms come from `data/cure_terms.csv`: `cap`, `cures_remaining`, `cash`, `min_liquidity`, `k`, `premium_bps`,
`has_asset`, `proceeds` (net), `asset_ebitda`, `asset_cf` and `sale_cost`.

## Options

Each request is solved three times, independently. Any option may be infeasible.

| Option | Restriction |
|---|---|
| `cheapest` | All levers |
| `no_asset_sale` | s = 0 |
| `equity_cure_only` | s = 0, P = 0 |

## Status handling

- **OPTIMAL with gap 0 that passes `check_exact`:** returns a plan with `E`, `P` (USD and `*_cents`), the premium, `y`, `s`, cost, exact pro-forma figures and the binding constraints. A constraint is binding when its slack is smaller than one cent's step for any money variable in that row.
- **INFEASIBLE:** returns the `computeIIS()` row names, which can include the auxiliary `PREMIUM` row; Node shows only C1 to C6. It also returns a waiver. The waiver comes from `feasRelax` with relaxobjtype 0 (minimum total violation) and minrelax true.
  It relaxes only the covenants (C1, C2, C6, C7) that fail with no cure at all. C3, C4 and C5 (cure cap, cure frequency, minimum liquidity) are facts and stay hard. The relaxed solution is re-checked exactly on every constraint that wasn't relaxed.
  The waiver thresholds are `max(Lmax, ceil(pro-forma leverage))` for leverage and `min(limit, floor(pro-forma ratio))` for DSCR, FCCR and the current ratio, all at 0.01x. A threshold changes only for a covenant that may be relaxed.
- **Any other status:** returns an explicit `error` and never a plan.
- **Artifacts:** each option writes `<borrower>_<period>_<case><suffix>.lp`. The suffix is empty for `cheapest`, or `_no_asset_sale` / `_equity_cure_only`. When a plan exists, a `..._fixed.lp` copy with
  `y` and `s` fixed is also written. Results carry each file's SHA-256, the Gurobi version and the parameters.

## Known answers (synthetic terms from data/cure_terms.csv)

BOR-09 2026-Q3 has D 1,270,000, EBITDA 325,000, DS 260,000, CF 300,000, Lmax 3.00 and Dmin 1.20. Current assets are 900,000 and current liabilities 600,000, with a minimum current ratio of 1.25 (applied).
Its terms are cap 100,000, 1 cure remaining, cash 400,000, minimum liquidity 150,000, k 0.18 and premium 100 bps. Its asset, Division A, has net proceeds 150,000, EBITDA 20,000, cash flow 25,000 and
sale cost 10,000. Its FCCR inputs are capex 35,000, cash taxes 15,000, distributions 0 and a 1.10 minimum; the springing FCCR is tested because revolver data is missing. Before any cure, BOR-09 fails leverage (3.9076x), DSCR (1.1538x) and FCCR (1.0577x), so FeasRelax may relax C1, C2 and C7. Its current ratio (1.50x) passes, so C6 stays hard.

| Test | Case | Expected |
|---|---|---|
| T1 | All options | s=1, E=68,333.33 (model: 68,333.34, already rounded up), P=0, cost 78,333.33 (78,333.34). Binding: C1, C4 |
| T2 | No asset | E=98,333.33 (98,333.34), cost 98,333.33 |
| T3 | cures_remaining = 0 | INFEASIBLE. IIS includes C1, C3, C4, C6. Waiver: sell Division A, pay down 148,514.85 (premium 1,485.15), max leverage 971,485.15 / 305,000 = 3.1852 → **3.19x**, current ratio 750,000 / 600,000 = exactly 1.25x |
| T4 | cures_remaining = 0, no asset | INFEASIBLE. IIS includes C1, C3, C4, C6. Waiver: pay down 148,514.85, max leverage 1,121,485.15 / 325,000 = 3.4507 → **3.46x**, current ratio exactly 1.25x. DSCR 1.2860 passes, so no DSCR waiver is needed |
| T5 | BOR-01 2026-Q3 (D 1,030,000, EBITDA 365,000, no asset; FCCR dormant, so no C7) | E=12,000, cost 12,000. Binding: C2, C4 |
| C7 check | BOR-02 2026-Q3 (revolver 45% drawn, so FCCR applies) | E=16,000. A $12,000 DSCR cure would leave FCCR at 1.0846x. Binding: C7 |
| Relax check | BOR-07 2026-Q3 (current ratio 1.2187x already fails) | INFEASIBLE, IIS {C6}. Waiver: current ratio to 1.21x, with an equity cure fixing leverage, DSCR and FCCR |

The 148,514.85 paydown is the exact limit. Its premium is ceil(14,851,485 × 100 / 10,000) = 148,515 cents, which leaves current assets at exactly 750,000.00. One more cent of paydown gives 749,999.99, which fails.
Both the Python and the Node exact engines test this. Without current-ratio inputs (current ratio off or dormant), C6 is omitted and the earlier answers return: T3 gives P=205,000 at cost 217,050, and
T4's waiver gives P=250,000 at 3.14x. These are kept as regression tests. All answers are checked by `opt/tests` (tolerance 0.01 before rounding) and by `tests/cure.test.js` through the exact engine.

## Out of scope

- Multi-quarter or portfolio optimization.
- Sourcing or verifying financial statements.
- Tax effects.
- Negotiating terms.

## Review changes to the Modeler output

1. File names match the brief. The `cheapest` option writes `<borrower>_<period>_<case>.lp`; the other options add a suffix.
2. In the Modeler's version, the waiver's `waiver_min_dscr` was the pro-forma DSCR (1.3953 in T4), which is above the covenant and so isn't a waiver. Pro-forma figures
   and waiver thresholds are now reported separately, with `leverage_waived` / `dscr_waived` flags.
3. Artifact paths are returned as bare file names. A failed FeasRelax now returns an explicit `waiver_error`. Input validation was added.
4. An OPTIMAL status with a non-zero MIP gap is treated as an error, not a plan.
5. A clause map C1..C6 → exact policy sentences was added. The tests check that each sentence occurs verbatim.
6. After main brought the four-covenant engine (v7/v9), these changes were made at the credit lead's direction: C6 (current ratio, with the "Cure cash" sentence added to cure-policy.txt); exact integer-cents
   modelling with PREMIUM and RELIEF rows; FeasRelax restricted to the covenants failing before any cure; and the re-check against every applied covenant.
7. C7 (FCCR) was added after the snapshot dry run found BOR-02 2026-Q3 plans that cured DSCR but failed FCCR. The relax rule was generalised to C6 and C7 after BOR-07 showed a current ratio already failing before any cure.

## Verification (Gurobi Explainer cross-check)

> **This section applies to the earlier continuous model, before integer cents and C6.** Its T4 answer (3.14x) is what the current model gives when the current ratio is not
> applied. The current integer-cents model, including T3 and T4 with C6, has not yet been re-checked by the Explainer.

The Explainer (Gurobi MCP) was run on the model files written by `opt/cure_model.py`. It was given this context: C1 and C2 are covenant thresholds the lender can waive, and C3, C4 and C5 are facts.

**T4 infeasibility (`BOR-09_2026-Q3_T4.lp`).** The Explainer computed the IIS independently and got {C1, C3, C4, C5}, the same as ours. It reduced the four constraints to `0 <= -45000`.
In plain terms, the borrower has no cures left (C4), so the equity cure must be zero (C3). Minimum liquidity caps repayment at $250,000 (C5). Leverage
needs at least $295,000 of repayment (C1). That leaves the borrower $45,000 short. C2 (DSCR) plays no part in the conflict. With FeasRelax restricted to the C1 and C2 right-hand
sides and minimum total violation, only C1 moves, by exactly 45,000. C2 is untouched. Repayment is $250,000, no equity cure is used, and the leverage limit becomes
1,020,000 / 325,000 = 3.1385, which rounds up to **3.14x**. That matches our waiver and the brief's T4. The Explainer re-solved the repaired model and found it optimal.

**T1 sensitivity (`BOR-09_2026-Q3_T1_fixed.lp`, binaries fixed at y=1, s=1, solved as an LP).** The Explainer found that the equity cure cap (C3) and the
minimum-liquidity paydown cap (C5) are both slack, with a shadow price of $0.
- **C3:** the cheapest plan uses $68,333.33 of the $100,000 cap. Raising the cap saves nothing, and the cap could fall to $68,333.33 before it starts to cost money.
- **C5:** the plan repays nothing, so the $250,000 paydown capacity has no value at any level from $0 upward. In this plan, repayment costs $1.01 per dollar and is worth only $0.33 of equity, so it loses to equity.
- **C1:** this is the only binding constraint. Each $1 of relief on the leverage test's right-hand side saves about $0.33 of cure cost, valid for right-hand-side values from −390,000 to −103,800.
- **Our own check:** we confirmed these figures with the shadow prices (Pi) and right-hand-side ranges (SARHS) on the same file.

The Explainer's reports and repaired models were saved to `gurobi_generated/`, which is git-ignored and not committed.
