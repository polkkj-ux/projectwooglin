# Covenant Cure Planner: model specification

This specification was drafted with the Gurobi Modeler (MCP) from the build brief, then reviewed. Review changes are listed at the end.
All terms and data are **synthetic** and apply only to this exercise.

## Purpose

This model works on one borrower-quarter that breaches its leverage and/or DSCR covenant. It finds the cheapest combination of permitted cure
actions that restores compliance with both covenants. When no combination works, it proves infeasibility with an IIS and sizes the smallest
waiver of the leverage and DSCR limits. Gurobi proposes; the Node exact engine (`lib/covenants.js`, BigInt cents) re-checks every
plan before it is shown.

## Decisions

| Symbol | Type | Meaning |
|---|---|---|
| E | continuous ≥ 0 | Equity cure contributed by the sponsor (USD) |
| P | continuous ≥ 0 | Voluntary debt paydown (USD) |
| y | binary | Equity cure right used this quarter |
| s | binary | Sell the permitted asset (fixed at 0 when there is no asset) |

## Objective

Minimize `E + (1 + premium_bps/10000) · P + sale_cost · s`.

## Constraints and the clauses they implement

| Name | Constraint | Policy sentence(s) | Waivable |
|---|---|---|---|
| C1 | `D − P − proceeds·s ≤ Lmax · (EBITDA + E − asset_ebitda·s)` | loan-policy.txt: "Leverage is gross debt divided by trailing twelve-month EBITDA, maximum 3.00." and cure-policy.txt: "Asset sales: …" | yes |
| C2 | `CF + E − asset_cf·s ≥ Dmin · (DS − k·(P + proceeds·s))` | loan-policy.txt: "DSCR is trailing twelve-month available cash flow divided by trailing twelve-month debt service, minimum 1.20." and cure-policy.txt: "Prepayment: …" | yes |
| C3 | `E ≤ cap · y` | cure-policy.txt: "Equity cure: …" | no (fact) |
| C4 | `y ≤ cures_remaining` | cure-policy.txt: "Cure frequency: …" | no (fact) |
| C5 | `P ≤ cash − min_liquidity` | cure-policy.txt: "Minimum liquidity: …" | no (fact) |

The full sentences are listed in `opt/cure_model.py` (`CLAUSES`). The Node app cites them by exact character offset and SHA-256.

## Inputs

These are the borrower-quarter figures: `D` (gross debt), `EBITDA`, `DS` (debt service) and `CF` (available cash flow), all trailing twelve months, plus
`Lmax` and `Dmin`. They come from `data/loan_covenants.csv`. The cure terms come from `data/cure_terms.csv`: `cap`, `cures_remaining`, `cash`, `min_liquidity`,
`k` (debt-service reduction per dollar repaid), `premium_bps`, `has_asset`, `proceeds`, `asset_ebitda`, `asset_cf` and `sale_cost`.

## Options

Each request is solved three times, independently. Any option may be infeasible.

| Option | Restriction |
|---|---|
| `cheapest` | All levers |
| `no_asset_sale` | s = 0 |
| `equity_cure_only` | s = 0, P = 0 |

## Solver settings and status handling

- Params `Threads=1`, `Seed=0`, `MIPGap=0`.
- **OPTIMAL with gap 0:** returns a plan with `E`, `P`, `y`, `s`, cost, pro-forma figures and the binding constraints.
- **INFEASIBLE:** returns the `computeIIS()` constraint names and a waiver. The waiver comes from `feasRelax` with relaxobjtype 0 (minimum total violation) and
  minrelax true. It relaxes only the right-hand sides of C1 and C2, with weight 1 each. It reports the paydown and the pro-forma leverage and DSCR. The waiver thresholds
  are `max(Lmax, pro-forma leverage)` and `min(Dmin, pro-forma DSCR)`; Node rounds leverage up and DSCR down to 0.01x.
- **Any other status:** returns an explicit `error` and never a plan.
- **Artifacts:** each option writes `<borrower>_<period>_<case><suffix>.lp`. The suffix is empty for `cheapest`, `_no_asset_sale` or `_equity_cure_only` otherwise. When a plan exists, a `..._fixed.lp` copy
  with `y` and `s` fixed at their optimal values is also written. Results carry each file's SHA-256, the Gurobi version and the parameters.

## Known answers (synthetic terms from data/cure_terms.csv)

BOR-09 2026-Q3 has D 1,270,000, EBITDA 325,000, DS 260,000, CF 300,000, Lmax 3.00 and Dmin 1.20. Its terms are cap 100,000, 1 cure remaining,
cash 400,000, minimum liquidity 150,000, k 0.18 and premium 100 bps. Its asset, Division A, has proceeds 150,000, EBITDA 20,000, cash flow 25,000 and sale cost 10,000.

| Test | Case | Expected |
|---|---|---|
| T1 | All options | s=1, E=68,333.33, P=0, cost 78,333.33 |
| T2 | No asset | E=98,333.33, cost 98,333.33 |
| T3 | cures_remaining = 0 | s=1, P=205,000, E=0, cost 217,050 |
| T4 | cures_remaining = 0, no asset | INFEASIBLE. IIS {C1, C3, C4, C5}. Waiver: P=250,000, max leverage 1,020,000/325,000 = 3.1385 → 3.14x. DSCR afterwards is 300,000/215,000 = 1.3953 (≈1.40x), which passes, so no DSCR waiver is needed (waiver min DSCR stays 1.20x) |
| T5 | BOR-01 2026-Q3 (D 1,030,000, EBITDA 365,000, no asset) | E=12,000, cost 12,000 |

All five were reproduced by the Modeler's own run, by an independent check model, and by `opt/tests` (tolerance 0.01 before rounding).

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
5. A clause map C1..C5 → exact policy sentences was added. The tests check that each sentence occurs verbatim.
