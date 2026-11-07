"""Known answers T1-T5 from the build brief, plus status guard rails. Tolerance 0.01 before rounding."""
import os

import gurobipy as gp
import pytest
from gurobipy import GRB

from opt.cure_model import CLAUSES, CureInputError, extract_result, solve_cure, validate_inputs

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOL = 0.01
BOR09 = dict(borrower_id="BOR-09", period="2026-Q3", D=1270000, EBITDA=325000, DS=260000, CF=300000,
             Lmax=3.00, Dmin=1.20, cap=100000, cures_remaining=1, cash=400000, min_liquidity=150000,
             k=0.18, premium_bps=100, has_asset=True, proceeds=150000, asset_ebitda=20000, asset_cf=25000,
             sale_cost=10000)
BOR01 = dict(BOR09, borrower_id="BOR-01", D=1030000, EBITDA=365000, has_asset=False,
             proceeds=0, asset_ebitda=0, asset_cf=0, sale_cost=0)
approx = lambda v: pytest.approx(v, abs=TOL)


def test_T1_all_options(tmp_path):
    r = solve_cure(BOR09, out_dir=str(tmp_path), case="T1")
    p = r["options"]["cheapest"]["plan"]
    assert (p["s"], p["y"]) == (1, 1)
    assert p["E"] == approx(68333.33) and p["P"] == approx(0) and p["cost"] == approx(78333.33)
    a = r["options"]["cheapest"]["artifacts"]
    assert a["lp_file"] == "BOR-09_2026-Q3_T1.lp" and a["fixed_lp_file"] == "BOR-09_2026-Q3_T1_fixed.lp"
    assert len(a["lp_sha256"]) == 64 and a["params"] == {"Threads": 1, "Seed": 0, "MIPGap": 0.0}
    assert (tmp_path / "BOR-09_2026-Q3_T1_fixed.lp").exists()
    # equity-cure-only option: E alone must cover leverage: 1270000 <= 3*(325000+E)
    assert r["options"]["equity_cure_only"]["plan"]["E"] == approx(98333.33)


def test_T2_no_asset(tmp_path):
    p = solve_cure(dict(BOR09, has_asset=False), out_dir=str(tmp_path), case="T2")["options"]["cheapest"]["plan"]
    assert p["s"] == 0 and p["E"] == approx(98333.33) and p["cost"] == approx(98333.33)
    # the "no asset sale" option of T1 is the same plan
    p2 = solve_cure(BOR09, out_dir=str(tmp_path), case="T1")["options"]["no_asset_sale"]["plan"]
    assert p2["E"] == approx(98333.33) and p2["cost"] == approx(98333.33)


def test_T3_no_cures_remaining(tmp_path):
    r = solve_cure(dict(BOR09, cures_remaining=0), out_dir=str(tmp_path), case="T3")
    p = r["options"]["cheapest"]["plan"]
    assert p["s"] == 1 and p["P"] == approx(205000) and p["E"] == approx(0) and p["cost"] == approx(217050)
    assert r["options"]["equity_cure_only"]["status"] == "INFEASIBLE"


def test_T4_infeasible_iis_and_waiver(tmp_path):
    r = solve_cure(dict(BOR09, cures_remaining=0, has_asset=False), out_dir=str(tmp_path), case="T4")
    o = r["options"]["cheapest"]
    assert o["status"] == "INFEASIBLE" and o["plan"] is None and o["error"] is None
    assert o["artifacts"]["lp_file"] == "BOR-09_2026-Q3_T4.lp" and o["artifacts"]["fixed_lp_file"] is None
    assert set(o["infeasibility"]["iis"]) == {"C1", "C3", "C4", "C5"}
    w = o["infeasibility"]["waiver"]
    assert w["P"] == approx(250000) and w["E"] == approx(0) and w["s"] == 0
    assert w["waiver_max_leverage"] == approx(1020000 / 325000)
    assert w["pro_forma"]["dscr"] == approx(1.40)  # 300000 / 215000 = 1.3953
    assert w["leverage_waived"] is True and w["dscr_waived"] is False
    assert w["waiver_min_dscr"] == approx(1.20)  # DSCR passes after paydown; no DSCR waiver needed


def test_T5_bor01(tmp_path):
    p = solve_cure(BOR01, out_dir=str(tmp_path), case="T5")["options"]["cheapest"]["plan"]
    assert p["E"] == approx(12000) and p["cost"] == approx(12000) and p["P"] == approx(0) and p["s"] == 0


def test_other_status_never_returns_plan(tmp_path):
    """A NODE_LIMIT stop (neither OPTIMAL nor INFEASIBLE) gives an explicit error and no plan."""
    with gp.Env(empty=True) as env:
        env.setParam("OutputFlag", 0)
        env.start()
        m = gp.Model(env=env)
        x = m.addVar(vtype=GRB.BINARY, name="x")
        y = m.addVar(vtype=GRB.BINARY, name="y")
        m.setObjective(x + y, GRB.MAXIMIZE)
        m.addConstr(x + y <= 1.5, name="c0")
        for k, v in {"NodeLimit": 0, "Presolve": 0, "Heuristics": 0, "Cuts": 0}.items():
            m.setParam(k, v)
        m.optimize()
        assert m.Status == GRB.NODE_LIMIT
        r = extract_result(m, {}, str(tmp_path / "g.lp"), str(tmp_path / "g_fixed.lp"))
        m.dispose()
    assert r["status"] == "NODE_LIMIT" and r["plan"] is None and r["infeasibility"] is None
    assert "NODE_LIMIT" in r["error"]


def test_bad_inputs_rejected():
    with pytest.raises(CureInputError):
        validate_inputs(dict(BOR09, D="abc"))
    with pytest.raises(CureInputError):
        validate_inputs(dict(BOR09, Lmax=0))
    with pytest.raises(CureInputError):
        validate_inputs({k: v for k, v in BOR09.items() if k != "period"})


def test_every_clause_quote_is_verbatim_in_its_policy_file():
    assert set(CLAUSES) == {"C1", "C2", "C3", "C4", "C5"}
    for c in CLAUSES.values():
        for doc, quote in c["sources"]:
            with open(os.path.join(ROOT, "data", doc), encoding="utf-8") as f:
                assert quote in f.read(), (doc, quote)
    assert [k for k, v in CLAUSES.items() if v["waivable"]] == ["C1", "C2"]
