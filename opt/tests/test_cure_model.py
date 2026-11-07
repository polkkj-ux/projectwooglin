"""Known answers T1-T5 (BOR-09 / BOR-01 2026-Q3, synthetic terms), status guard rails, exactness."""
import os

import gurobipy as gp
import pytest
from gurobipy import GRB

from opt.cure_model import (CLAUSES, CureInputError, check_exact, extract_result, pro_forma, solve_cure,
                            validate_inputs, waivable)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOL = 0.01
# BOR-09 2026-Q3 from data/team/loan_covenants_extended.csv and data/cure_terms.csv. The monitor applies
# the current ratio (maintenance) to this quarter, so C6 is included.
BOR09 = dict(borrower_id="BOR-09", period="2026-Q3", D="1270000.00", EBITDA="325000.00", DS="260000.00", CF="300000.00",
             Lmax="3.00", Dmin="1.20", cap="100000.00", cures_remaining=1, cash="400000.00", min_liquidity="150000.00",
             k="0.18", premium_bps=100, has_asset=True, proceeds="150000.00", asset_ebitda="20000.00",
             asset_cf="25000.00", sale_cost="10000.00",
             current_assets="900000.00", current_liabilities="600000.00", min_current_ratio="1.25")
BOR01 = dict(BOR09, borrower_id="BOR-01", D="1030000.00", EBITDA="365000.00", has_asset=False, proceeds=0,
             asset_ebitda=0, asset_cf=0, sale_cost=0, current_assets="860000.00", current_liabilities="610000.00")
NO_CR = {k: v for k, v in BOR09.items() if k not in ("current_assets", "current_liabilities", "min_current_ratio")}
approx = lambda v: pytest.approx(v, abs=TOL)
plan = lambda r, o="cheapest": r["options"][o]["plan"]


def test_T1_all_options(tmp_path):
    r = solve_cure(BOR09, out_dir=str(tmp_path), case="T1")
    p = plan(r)
    assert (p["s"], p["y"]) == (1, 1)
    assert p["E"] == approx(68333.33) and p["P"] == approx(0) and p["cost"] == approx(78333.33)
    assert p["E_cents"] == 6833334  # rounded up to the cent inside the model
    assert p["binding"] == ["C1", "C4"]  # leverage has less than one cent of room; the last cure is used
    assert "C6" in r["constraints"] and r["waivable"] == ["C1", "C2"]
    a = r["options"]["cheapest"]["artifacts"]
    assert a["lp_file"] == "BOR-09_2026-Q3_T1.lp" and a["fixed_lp_file"] == "BOR-09_2026-Q3_T1_fixed.lp"
    assert len(a["lp_sha256"]) == 64 and a["params"]["MIPGap"] == 0.0 and a["params"]["Threads"] == 1
    assert plan(r, "equity_cure_only")["E"] == approx(98333.33)


def test_T2_no_asset(tmp_path):
    p = plan(solve_cure(dict(BOR09, has_asset=False), out_dir=str(tmp_path), case="T2"))
    assert p["s"] == 0 and p["E"] == approx(98333.33) and p["cost"] == approx(98333.33)
    p2 = plan(solve_cure(BOR09, out_dir=str(tmp_path), case="T1"), "no_asset_sale")
    assert p2["E"] == approx(98333.33) and p2["cost"] == approx(98333.33)


def test_T3_no_cures_remaining_infeasible_with_current_ratio(tmp_path):
    o = solve_cure(dict(BOR09, cures_remaining=0), out_dir=str(tmp_path), case="T3")["options"]["cheapest"]
    assert o["status"] == "INFEASIBLE" and o["plan"] is None
    assert {"C1", "C3", "C4", "C6"} <= set(o["infeasibility"]["iis"])
    assert o["infeasibility"]["relaxed"] == ["C1", "C2"]
    w = o["infeasibility"]["waiver"]
    assert w["s"] == 1 and w["E_cents"] == 0 and w["P_cents"] == 14851485
    assert w["waiver_max_leverage_x100"] == 319                      # 971,485.15 / 305,000 = 3.1852
    assert (100 * w["pro_forma"]["debt_cents"]) / w["pro_forma"]["ebitda_cents"] == pytest.approx(318.52, abs=0.01)
    assert w["pro_forma"]["current_ratio"] == 1.25 and w["leverage_waived"] and not w["dscr_waived"]


def test_T4_no_cures_no_asset_infeasible_with_current_ratio(tmp_path):
    o = solve_cure(dict(BOR09, cures_remaining=0, has_asset=False), out_dir=str(tmp_path), case="T4")["options"]["cheapest"]
    assert o["status"] == "INFEASIBLE" and o["plan"] is None and o["error"] is None
    assert o["artifacts"]["lp_file"] == "BOR-09_2026-Q3_T4.lp" and o["artifacts"]["fixed_lp_file"] is None
    assert {"C1", "C3", "C4", "C6"} <= set(o["infeasibility"]["iis"])
    w = o["infeasibility"]["waiver"]
    assert w["s"] == 0 and w["P_cents"] == 14851485 and w["waiver_max_leverage_x100"] == 346   # 3.4507
    assert w["pro_forma"]["leverage"] == 3.4507 and w["pro_forma"]["current_ratio"] == 1.25
    assert w["waiver_min_dscr_x100"] == 120 and not w["dscr_waived"]


def test_T5_bor01(tmp_path):
    p = plan(solve_cure(BOR01, out_dir=str(tmp_path), case="T5"))
    assert p["E"] == approx(12000) and p["cost"] == approx(12000) and p["P"] == approx(0) and p["s"] == 0
    assert p["binding"] == ["C2", "C4"]


def test_paydown_148514_85_is_exactly_the_current_ratio_limit():
    d = validate_inputs(dict(BOR09, cures_remaining=0, has_asset=False))
    pf = pro_forma(d, 0, 14851485, 0)
    assert pf["premium_cents"] == 148515                                      # ceil(14,851,485 * 100 / 10,000)
    assert pf["current_assets_cents"] * 100 == 125 * 60000000                 # 750,000.00 = 1.25 x 600,000.00
    assert "C6" not in check_exact(d, 0, 14851485, 0, 0, skip=("C1", "C2"))
    assert "C6" in check_exact(d, 0, 14851486, 0, 0, skip=("C1", "C2"))      # one more cent fails


def test_C6_only_when_current_ratio_supplied(tmp_path):
    r = solve_cure(dict(NO_CR, cures_remaining=0), out_dir=str(tmp_path), case="noCR3")
    assert "C6" not in r["constraints"]
    p = plan(r)
    assert p["s"] == 1 and p["P"] == approx(205000) and p["cost"] == approx(217050)
    w = solve_cure(dict(NO_CR, cures_remaining=0, has_asset=False), out_dir=str(tmp_path), case="noCR4")["options"]["cheapest"]["infeasibility"]
    assert set(w["iis"]) >= {"C1", "C3", "C4", "C5"} and w["waiver"]["P_cents"] == 25000000 and w["waiver"]["waiver_max_leverage_x100"] == 314
    with pytest.raises(CureInputError):
        validate_inputs(dict(NO_CR, current_assets="1.00"))


def test_feasrelax_relaxes_only_covenants_failing_in_base_case(tmp_path):
    # BOR-01 passes leverage before any cure and fails only DSCR; with no cure and $50,000 of repayment
    # capacity it cannot reach 1.20x, so only C2 may be relaxed.
    inp = dict(BOR01, cures_remaining=0, cash="200000.00")
    assert waivable(validate_inputs(inp)) == ["C2"]
    o = solve_cure(inp, out_dir=str(tmp_path), case="relax")["options"]["cheapest"]
    w = o["infeasibility"]["waiver"]
    assert o["infeasibility"]["relaxed"] == ["C2"] and w["P_cents"] == 5000000
    assert not w["leverage_waived"] and w["dscr_waived"] and w["waiver_min_dscr_x100"] == 119


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
    for bad in (dict(BOR09, D="abc"), dict(BOR09, Lmax=0), dict(BOR09, D="1.001"), dict(BOR09, cures_remaining="1.5"),
                {k: v for k, v in BOR09.items() if k != "period"}):
        with pytest.raises(CureInputError):
            validate_inputs(bad)


def test_every_clause_quote_is_verbatim_in_its_policy_file():
    assert set(CLAUSES) == {"C1", "C2", "C3", "C4", "C5", "C6"}
    for c in CLAUSES.values():
        for doc, quote in c["sources"]:
            with open(os.path.join(ROOT, "data", doc), encoding="utf-8") as f:
                assert quote in f.read(), (doc, quote)
