# Cure planner solver (opt/)

A small FastAPI service around a Gurobi MIP. For one borrower-quarter in covenant breach it finds the
cheapest cure the synthetic agreement allows (equity cure, debt paydown, asset sale), or proves none
exists (IIS) and sizes the smallest waiver (FeasRelax on the leverage and DSCR limits only).

The Node app (`lib/cure.js`) calls this service, then re-checks every plan with the exact BigInt-cents
covenant engine before showing it. This service never decides what the user sees as pass or fail.

## Run on Windows (licensed demo)

In PowerShell, from the repository root:

```powershell
py -m pip install -r opt\requirements.txt
py -m uvicorn opt.app:app --host 127.0.0.1 --port 8000
```

Check it: open http://127.0.0.1:8000/health. It should return `{"ok": true, "gurobi_version": "..."}`.

Then point the Node app at it: `$env:OPT_URL="http://127.0.0.1:8000"; npm run dev`.

### Licence

- **Academic or named-user licence:** if `gurobi.lic` is installed in the default location, nothing else is needed.
- **WLS licence:** create `opt\.env` with one `KEY=value` line each for `WLSACCESSID`, `WLSSECRET` and `LICENSEID`.
  This file is git-ignored. Never commit it, and never put licence values anywhere else in the repository.
- Without a licence, gurobipy runs in restricted mode, which is enough for these tiny models.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `ok`, `gurobi_version`, `wls_configured` (true/false only) |
| POST | `/solve` | `solve_cure()` result: three options (`cheapest`, `no_asset_sale`, `equity_cure_only`), each with a plan, or an IIS and waiver, or an explicit error |

The `/solve` body holds `borrower_id`, `period`, an optional `case` label, `D`, `EBITDA`, `DS`, `CF`, `Lmax`, `Dmin`, `cap`,
`cures_remaining`, `cash`, `min_liquidity`, `k`, `premium_bps`, `has_asset`, `proceeds`, `asset_ebitda`, `asset_cf`
and `sale_cost`. Every model is written to `opt/out/<borrower>_<period>_<case>.lp`. When a plan exists, a copy with `y` and `s`
fixed is also written as `..._fixed.lp`. The `opt/out/` folder is git-ignored. Responses carry each file's SHA-256.

## Tests

```
python -m pytest opt/tests
```

This checks the known answers T1 to T5 from `SPEC.md`, the rule that a non-optimal and non-infeasible status never returns a plan,
input validation, and that every clause quote appears verbatim in its policy file.
