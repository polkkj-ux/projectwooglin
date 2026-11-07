"""Covenant cure planner (Gurobi MIP).

For one borrower-quarter in breach of its leverage and/or DSCR covenant, find the cheapest
cure the (synthetic) agreement allows - equity cure, voluntary debt paydown, asset sale - or
prove none exists (IIS) and size the smallest waiver (FeasRelax on C1/C2 only).

Gurobi proposes; the Node exact engine (lib/covenants.js) re-checks every plan in BigInt cents
before it is shown. Nothing here decides pass/fail for display.

Adapted from the Gurobi Modeler output (see opt/SPEC.md): formulation, status handling and the
fixed-model export are unchanged; file naming, waiver fields, input validation and clause
mapping were added during review.
"""

import hashlib
import math
import os

import gurobipy as gp
from gurobipy import GRB

PARAMS = {"Threads": 1, "Seed": 0, "MIPGap": 0.0}

# Each constraint mapped to the exact policy sentence(s) it implements. Node re-cites these by
# character offset with lib/citations.js; tests check every quote occurs verbatim in its file.
CLAUSES = {
    "C1": {"title": "Leverage covenant after cure", "waivable": True, "sources": [
        ("documents/loan-policy.txt", "Leverage is gross debt divided by trailing twelve-month EBITDA, maximum 3.00."),
        ("documents/cure-policy.txt", "Asset sales: net proceeds of a permitted asset sale must repay debt, and the EBITDA and cash flow of the asset sold are removed from the trailing twelve-month figures."),
    ]},
    "C2": {"title": "DSCR covenant after cure", "waivable": True, "sources": [
        ("documents/loan-policy.txt", "DSCR is trailing twelve-month available cash flow divided by trailing twelve-month debt service, minimum 1.20."),
        ("documents/cure-policy.txt", "Prepayment: a voluntary prepayment pays the stated premium and reduces trailing twelve-month debt service by the stated amount per dollar repaid."),
    ]},
    "C3": {"title": "Equity cure cap", "waivable": False, "sources": [
        ("documents/cure-policy.txt", "Equity cure: the sponsor may contribute cash that is added to EBITDA and to available cash flow for the quarter tested, up to the equity cure cap in cure_terms.csv."),
    ]},
    "C4": {"title": "Cure frequency", "waivable": False, "sources": [
        ("documents/cure-policy.txt", "Cure frequency: an equity cure may be used only while cures remaining in the last four fiscal quarters is at least 1."),
    ]},
    "C5": {"title": "Minimum liquidity after prepayment", "waivable": False, "sources": [
        ("documents/cure-policy.txt", "Minimum liquidity: after any voluntary prepayment the borrower must keep cash of at least the minimum liquidity in cure_terms.csv."),
    ]},
}

OPTIONS = {
    "cheapest": {"allow_sale": True, "allow_paydown": True, "suffix": ""},
    "no_asset_sale": {"allow_sale": False, "allow_paydown": True, "suffix": "_no_asset_sale"},
    "equity_cure_only": {"allow_sale": False, "allow_paydown": False, "suffix": "_equity_cure_only"},
}

NUMERIC = ["D", "EBITDA", "DS", "CF", "Lmax", "Dmin", "cap", "cash", "min_liquidity", "k", "premium_bps"]
ASSET_NUMERIC = ["proceeds", "asset_ebitda", "asset_cf", "sale_cost"]


class CureInputError(ValueError):
    pass


def gurobi_version():
    return "{}.{}.{}".format(*gp.gurobi.version())


def _status_name(code):
    for name in ("LOADED", "OPTIMAL", "INFEASIBLE", "INF_OR_UNBD", "UNBOUNDED", "CUTOFF", "ITERATION_LIMIT",
                 "NODE_LIMIT", "TIME_LIMIT", "SOLUTION_LIMIT", "INTERRUPTED", "NUMERIC", "SUBOPTIMAL",
                 "INPROGRESS", "USER_OBJ_LIMIT", "WORK_LIMIT", "MEM_LIMIT"):
        if getattr(GRB, name, None) == code:
            return name
    return "STATUS_{}".format(code)


def _sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _safe(label):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in str(label))


def validate_inputs(inputs):
    """Return a normalised copy of inputs or raise CureInputError with a plain message."""
    d = dict(inputs)
    for key in ("borrower_id", "period"):
        if not isinstance(d.get(key), str) or not d[key]:
            raise CureInputError("{} is required".format(key))
    for key in NUMERIC:
        try:
            d[key] = float(d[key])
        except (KeyError, TypeError, ValueError):
            raise CureInputError("{} must be a number".format(key))
        if not math.isfinite(d[key]):
            raise CureInputError("{} must be finite".format(key))
    try:
        d["cures_remaining"] = int(d["cures_remaining"])
    except (KeyError, TypeError, ValueError):
        raise CureInputError("cures_remaining must be a whole number")
    d["has_asset"] = bool(d.get("has_asset", False))
    for key in ASSET_NUMERIC:
        d[key] = float(d.get(key, 0) or 0) if d["has_asset"] else 0.0
        if not math.isfinite(d[key]) or d[key] < 0 and key in ("proceeds", "sale_cost"):
            raise CureInputError("{} must be a non-negative number".format(key))
    for key in ("D", "DS", "cap", "cash", "min_liquidity", "k", "premium_bps", "Lmax", "Dmin"):
        if d[key] < 0:
            raise CureInputError("{} must not be negative".format(key))
    if d["Lmax"] <= 0 or d["Dmin"] <= 0:
        raise CureInputError("covenant thresholds must be positive")
    if d["cures_remaining"] < 0:
        raise CureInputError("cures_remaining must not be negative")
    return d


def _pro_forma(d, E, P, s):
    debt = d["D"] - P - d["proceeds"] * s
    ebitda = d["EBITDA"] + E - d["asset_ebitda"] * s
    cf = d["CF"] + E - d["asset_cf"] * s
    ds = d["DS"] - d["k"] * (P + d["proceeds"] * s)
    return {
        "debt": debt, "ebitda": ebitda, "cashflow": cf, "debt_service": ds,
        "leverage": debt / ebitda if ebitda > 0 else None,
        "dscr": cf / ds if ds > 0 else None,
    }


def build_model(d, env, name, allow_sale=True, allow_paydown=True):
    m = gp.Model(name=name, env=env)
    E = m.addVar(lb=0.0, name="E")
    P = m.addVar(lb=0.0, ub=GRB.INFINITY if allow_paydown else 0.0, name="P")
    y = m.addVar(vtype=GRB.BINARY, name="y")
    s = m.addVar(vtype=GRB.BINARY, ub=1.0 if (allow_sale and d["has_asset"]) else 0.0, name="s")
    m.setObjective(E + (1.0 + d["premium_bps"] / 10000.0) * P + d["sale_cost"] * s, GRB.MINIMIZE)
    m.addConstr(d["D"] - P - d["proceeds"] * s <= d["Lmax"] * (d["EBITDA"] + E - d["asset_ebitda"] * s), name="C1")
    m.addConstr(d["CF"] + E - d["asset_cf"] * s >= d["Dmin"] * (d["DS"] - d["k"] * (P + d["proceeds"] * s)), name="C2")
    m.addConstr(E <= d["cap"] * y, name="C3")
    m.addConstr(y <= d["cures_remaining"], name="C4")
    m.addConstr(P <= d["cash"] - d["min_liquidity"], name="C5")
    for k, v in PARAMS.items():
        m.setParam(k, v)
    m.update()
    return m


def extract_result(m, d, lp_path, fixed_lp_path):
    """Turn a solved model into a result dict. Only OPTIMAL (with MIPGap 0) yields a plan."""
    status = m.Status
    res = {"status": _status_name(status), "plan": None, "infeasibility": None, "error": None,
           "artifacts": {"lp_file": os.path.basename(lp_path), "lp_sha256": None, "fixed_lp_file": None,
                         "fixed_lp_sha256": None, "gurobi_version": gurobi_version(), "params": dict(PARAMS)}}
    m.write(lp_path)
    res["artifacts"]["lp_sha256"] = _sha256(lp_path)

    if status == GRB.OPTIMAL and (not m.IsMIP or m.MIPGap == 0):
        E, P = m.getVarByName("E").X, m.getVarByName("P").X
        y, s = int(round(m.getVarByName("y").X)), int(round(m.getVarByName("s").X))
        res["plan"] = {"E": E, "P": P, "y": y, "s": s, "cost": m.ObjVal, "pro_forma": _pro_forma(d, E, P, s),
                       "binding": [c.ConstrName for c in m.getConstrs() if abs(c.Slack) <= 1e-6]}
        fixed = m.copy()
        for name, val in (("y", y), ("s", s)):
            v = fixed.getVarByName(name)
            v.LB = v.UB = val
        fixed.update()
        fixed.write(fixed_lp_path)
        fixed.dispose()
        res["artifacts"]["fixed_lp_file"] = os.path.basename(fixed_lp_path)
        res["artifacts"]["fixed_lp_sha256"] = _sha256(fixed_lp_path)
    elif status == GRB.OPTIMAL:
        res["status"] = "OPTIMAL_WITH_GAP"
        res["error"] = "Solver reported a non-zero MIP gap ({}); no plan is returned.".format(m.MIPGap)
    elif status == GRB.INFEASIBLE:
        m.computeIIS()
        iis = sorted(c.ConstrName for c in m.getConstrs() if c.IISConstr)
        res["infeasibility"] = {"iis": iis, "waiver": None, "waiver_error": None}
        r = m.copy()
        for k, v in PARAMS.items():
            r.setParam(k, v)
        # Minimum total violation, relaxing only the right-hand sides of C1 and C2.
        # C3, C4 and C5 are facts of the agreement and stay hard.
        r.feasRelax(0, True, [], [], [], [r.getConstrByName("C1"), r.getConstrByName("C2")], [1.0, 1.0])
        r.optimize()
        if r.Status == GRB.OPTIMAL:
            E, P = r.getVarByName("E").X, r.getVarByName("P").X
            s = int(round(r.getVarByName("s").X))
            pf = _pro_forma(d, E, P, s)
            res["infeasibility"]["waiver"] = {
                "E": E, "P": P, "s": s, "pro_forma": pf,
                # Thresholds the lender would have to accept; Node rounds leverage UP and DSCR DOWN to 0.01x.
                "waiver_max_leverage": max(d["Lmax"], pf["leverage"]) if pf["leverage"] is not None else None,
                "waiver_min_dscr": min(d["Dmin"], pf["dscr"]) if pf["dscr"] is not None else None,
                "leverage_waived": pf["leverage"] is not None and pf["leverage"] > d["Lmax"] + 1e-9,
                "dscr_waived": pf["dscr"] is not None and pf["dscr"] < d["Dmin"] - 1e-9,
            }
        else:
            res["infeasibility"]["waiver_error"] = "FeasRelax on C1/C2 ended with status {}; no waiver sized.".format(_status_name(r.Status))
        r.dispose()
    else:
        res["error"] = "Solver stopped with status {}, which is neither OPTIMAL nor INFEASIBLE; no plan is returned.".format(_status_name(status))
    return res


def solve_cure(inputs, out_dir=None, case="live", env_params=None):
    """Pure function: solve the three options for one borrower-quarter and return a dict.

    env_params: optional Gurobi environment parameters (e.g. WLS licence fields loaded by app.py).
    """
    d = validate_inputs(inputs)
    out_dir = out_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out_dir, exist_ok=True)
    stem = "{}_{}_{}".format(_safe(d["borrower_id"]), _safe(d["period"]), _safe(case))
    options = {}
    with gp.Env(empty=True) as env:
        env.setParam("OutputFlag", 0)
        for k, v in (env_params or {}).items():
            env.setParam(k, v)
        env.start()
        for name, o in OPTIONS.items():
            base = os.path.join(out_dir, stem + o["suffix"])
            m = build_model(d, env, stem + o["suffix"], o["allow_sale"], o["allow_paydown"])
            try:
                m.optimize()
                options[name] = extract_result(m, d, base + ".lp", base + "_fixed.lp")
            finally:
                m.dispose()
    return {"borrower_id": d["borrower_id"], "period": d["period"], "case": case,
            "gurobi_version": gurobi_version(), "params": dict(PARAMS),
            "clauses": {k: {"title": v["title"], "waivable": v["waivable"],
                            "sources": [{"source_document": s, "quote": q} for s, q in v["sources"]]}
                        for k, v in CLAUSES.items()},
            "options": options}
