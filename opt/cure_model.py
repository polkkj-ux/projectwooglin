"""Covenant cure planner (Gurobi MIP), exact integer cents.

For one borrower-quarter in breach of its leverage and/or DSCR covenant, find the cheapest cure the
(synthetic) agreement allows - equity cure, voluntary debt paydown, asset sale - or prove none exists
(IIS) and size the smallest waiver (FeasRelax on the covenants that fail before any cure only).

Every money variable is an integer number of cents and every coefficient is an integer, so the model
uses the same rounding as the Node exact engine:
  premium Q = ceil(P * bps / 10000)            (PREMIUM: 10000 Q >= bps P, Q is minimised)
  relief  R = floor(k * (P + proceeds s))      (RELIEF: 10000 R <= k_e4 (P + proceeds s))
Ratios are compared as x100 integers (3.00 -> 300). Every solution is re-checked in Python integer
arithmetic before it is returned; Node (lib/covenants.js) then re-checks it again before it is shown.

Adapted from the Gurobi Modeler output (see opt/SPEC.md).
"""

import hashlib
import os
from decimal import Decimal, InvalidOperation

import gurobipy as gp
from gurobipy import GRB

PARAMS = {"Threads": 1, "Seed": 0, "MIPGap": 0.0, "IntFeasTol": 1e-9, "FeasibilityTol": 1e-9}

# Each constraint mapped to the exact policy sentence(s) it implements. Node re-cites these by
# character offset with lib/citations.js; tests check every quote occurs verbatim in its file.
CLAUSES = {
    "C1": {"title": "Leverage covenant after cure", "sources": [
        ("documents/loan-policy.txt", "Leverage is gross debt divided by trailing twelve-month EBITDA, maximum 3.00."),
        ("documents/cure-policy.txt", "Asset sales: net proceeds of a permitted asset sale must repay debt, and the EBITDA and cash flow of the asset sold are removed from the trailing twelve-month figures."),
    ]},
    "C2": {"title": "DSCR covenant after cure", "sources": [
        ("documents/loan-policy.txt", "DSCR is trailing twelve-month available cash flow divided by trailing twelve-month debt service, minimum 1.20."),
        ("documents/cure-policy.txt", "Prepayment: a voluntary prepayment pays the stated premium and reduces trailing twelve-month debt service by the stated amount per dollar repaid."),
    ]},
    "C3": {"title": "Equity cure cap", "sources": [
        ("documents/cure-policy.txt", "Equity cure: the sponsor may contribute cash that is added to EBITDA and to available cash flow for the quarter tested, up to the equity cure cap in cure_terms.csv."),
    ]},
    "C4": {"title": "Cure frequency", "sources": [
        ("documents/cure-policy.txt", "Cure frequency: an equity cure may be used only while cures remaining in the last four fiscal quarters is at least 1."),
    ]},
    "C5": {"title": "Minimum liquidity after prepayment", "sources": [
        ("documents/cure-policy.txt", "Minimum liquidity: after any voluntary prepayment the borrower must keep cash of at least the minimum liquidity in cure_terms.csv."),
    ]},
    "C6": {"title": "Current ratio after cure", "sources": [
        ("team/covenant-policy-addendum.txt", "Current Ratio is current assets divided by current liabilities at quarter end, minimum 1.25."),
        ("documents/cure-policy.txt", "Cure cash: a voluntary prepayment and its premium are paid from cash and reduce current assets, equity cure cash is not added to current assets, and the sale cost of a permitted asset sale is paid from its gross proceeds."),
    ]},
    "C7": {"title": "Fixed-charge coverage after cure", "sources": [
        ("team/covenant-policy-addendum.txt", "Fixed Charge Coverage Ratio is trailing twelve-month EBITDA less unfinanced capital expenditures, cash taxes and distributions, divided by trailing twelve-month fixed charges (scheduled interest and principal), minimum 1.10."),
        ("documents/cure-policy.txt", "Equity cure: the sponsor may contribute cash that is added to EBITDA and to available cash flow for the quarter tested, up to the equity cure cap in cure_terms.csv."),
    ]},
}
# Only covenant thresholds can be waived, and only those that fail before any cure (see waivable()).
# C3 (cure cap), C4 (cure frequency) and C5 (liquidity) are facts and are never relaxed.
COVENANT_CONSTRAINTS = ("C1", "C2", "C6", "C7")

OPTIONS = {
    "cheapest": {"allow_sale": True, "allow_paydown": True, "suffix": ""},
    "no_asset_sale": {"allow_sale": False, "allow_paydown": True, "suffix": "_no_asset_sale"},
    "equity_cure_only": {"allow_sale": False, "allow_paydown": False, "suffix": "_equity_cure_only"},
}
MONEY = ["D", "EBITDA", "DS", "CF", "cap", "cash", "min_liquidity"]
ASSET_MONEY = ["proceeds", "asset_ebitda", "asset_cf", "sale_cost"]
CR_FIELDS = ["current_assets", "current_liabilities", "min_current_ratio"]
FCCR_FIELDS = ["capex", "cash_taxes", "distributions", "min_fccr"]


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


def _scaled(value, scale, name, signed=False):
    """Decimal string or number -> exact integer value * 10**scale. Rejects anything finer."""
    if isinstance(value, bool) or value is None or value == "":
        raise CureInputError("{} must be a number".format(name))
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise CureInputError("{} must be a number".format(name))
    if not d.is_finite():
        raise CureInputError("{} must be finite".format(name))
    n = d.scaleb(scale)
    if n != n.to_integral_value():
        raise CureInputError("{} has more than {} decimal places".format(name, scale))
    n = int(n)
    if n < 0 and not signed:
        raise CureInputError("{} must not be negative".format(name))
    return n


def validate_inputs(inputs):
    """Return exact integers: money in cents, ratios x100, k x10000, premium in bps."""
    d = {}
    for key in ("borrower_id", "period"):
        if not isinstance(inputs.get(key), str) or not inputs[key]:
            raise CureInputError("{} is required".format(key))
        d[key] = inputs[key]
    for key in MONEY:
        d[key] = _scaled(inputs.get(key), 2, key, signed=key in ("EBITDA", "CF"))
    d["Lmax"] = _scaled(inputs.get("Lmax"), 2, "Lmax")
    d["Dmin"] = _scaled(inputs.get("Dmin"), 2, "Dmin")
    if d["Lmax"] <= 0 or d["Dmin"] <= 0:
        raise CureInputError("covenant thresholds must be positive")
    d["k"] = _scaled(inputs.get("k"), 4, "k")
    if d["k"] > 10000:
        raise CureInputError("k above 1.00 is not plausible")
    d["premium_bps"] = _scaled(inputs.get("premium_bps"), 0, "premium_bps")
    d["cures_remaining"] = _scaled(inputs.get("cures_remaining"), 0, "cures_remaining")
    d["has_asset"] = bool(inputs.get("has_asset", False))
    for key in ASSET_MONEY:
        d[key] = _scaled(inputs.get(key, 0) or 0, 2, key, signed=key in ("asset_ebitda", "asset_cf")) if d["has_asset"] else 0
    present = [inputs.get(k) not in (None, "") for k in CR_FIELDS]
    if any(present) and not all(present):
        raise CureInputError("current_assets, current_liabilities and min_current_ratio must be given together")
    d["has_cr"] = all(present)
    if d["has_cr"]:
        d["current_assets"] = _scaled(inputs["current_assets"], 2, "current_assets")
        d["current_liabilities"] = _scaled(inputs["current_liabilities"], 2, "current_liabilities")
        d["min_current_ratio"] = _scaled(inputs["min_current_ratio"], 2, "min_current_ratio")
        if d["current_liabilities"] <= 0 or d["min_current_ratio"] <= 0:
            raise CureInputError("current liabilities and min_current_ratio must be positive")
    present = [inputs.get(k) not in (None, "") for k in FCCR_FIELDS]
    if any(present) and not all(present):
        raise CureInputError("capex, cash_taxes, distributions and min_fccr must be given together")
    d["has_fccr"] = all(present)
    if d["has_fccr"]:
        for k in ("capex", "cash_taxes", "distributions"):
            d[k] = _scaled(inputs[k], 2, k)
        d["min_fccr"] = _scaled(inputs["min_fccr"], 2, "min_fccr")
        if d["min_fccr"] <= 0:
            raise CureInputError("min_fccr must be positive")
    return d


def _ceil_div(n, m):
    return -((-n) // m)


def premium_of(d, P):
    return _ceil_div(P * d["premium_bps"], 10000)


def relief_of(d, P, s):
    return (d["k"] * (P + d["proceeds"] * s)) // 10000


def pro_forma(d, E, P, s):
    """Exact integer pro-forma figures (cents); ratios rounded down to 4 decimals for display only."""
    Q, R = premium_of(d, P), relief_of(d, P, s)
    debt = d["D"] - P - d["proceeds"] * s
    ebitda = d["EBITDA"] + E - d["asset_ebitda"] * s
    cf = d["CF"] + E - d["asset_cf"] * s
    ds = d["DS"] - R
    out = {"debt_cents": debt, "ebitda_cents": ebitda, "cashflow_cents": cf, "debt_service_cents": ds,
           "premium_cents": Q, "relief_cents": R,
           "leverage": (debt * 10000 // ebitda) / 10000 if ebitda > 0 else None,
           "dscr": (cf * 10000 // ds) / 10000 if ds > 0 else None}
    if d["has_cr"]:
        ca = d["current_assets"] - P - Q
        out["current_assets_cents"] = ca
        out["current_ratio"] = (ca * 10000 // d["current_liabilities"]) / 10000
    if d["has_fccr"]:
        num = ebitda - d["capex"] - d["cash_taxes"] - d["distributions"]
        out["fccr_numerator_cents"] = num
        out["fccr"] = (num * 10000 // ds) / 10000 if ds > 0 else None
    return out


def check_exact(d, E, P, y, s, skip=()):
    """Names of C1..C7 violated by an integer solution (exact arithmetic). Empty list = all hold."""
    pf = pro_forma(d, E, P, s)
    bad = []
    if "C1" not in skip and not (100 * pf["debt_cents"] <= d["Lmax"] * pf["ebitda_cents"]):
        bad.append("C1")
    if "C2" not in skip and not (100 * pf["cashflow_cents"] >= d["Dmin"] * pf["debt_service_cents"]):
        bad.append("C2")
    if not (0 <= E <= d["cap"] * y):
        bad.append("C3")
    if not (y <= d["cures_remaining"]):
        bad.append("C4")
    if not (0 <= P <= d["cash"] - d["min_liquidity"]):
        bad.append("C5")
    if "C6" not in skip and d["has_cr"] and not (100 * pf["current_assets_cents"] >= d["min_current_ratio"] * d["current_liabilities"]):
        bad.append("C6")
    if "C7" not in skip and d["has_fccr"] and not (100 * pf["fccr_numerator_cents"] >= d["min_fccr"] * pf["debt_service_cents"]):
        bad.append("C7")
    return bad


def waivable(d):
    """Covenant constraints that fail with no cure at all; only these may be relaxed by FeasRelax."""
    return [c for c in check_exact(d, 0, 0, 0, 0) if c in COVENANT_CONSTRAINTS]


def build_model(d, env, name, allow_sale=True, allow_paydown=True):
    m = gp.Model(name=name, env=env)
    E = m.addVar(vtype=GRB.INTEGER, lb=0, name="E")                       # equity cure, cents
    P = m.addVar(vtype=GRB.INTEGER, lb=0, ub=GRB.INFINITY if allow_paydown else 0, name="P")  # paydown, cents
    Q = m.addVar(vtype=GRB.INTEGER, lb=0, name="Q")                       # prepayment premium, cents
    R = m.addVar(vtype=GRB.INTEGER, lb=0, name="R")                       # debt-service relief, cents
    y = m.addVar(vtype=GRB.BINARY, name="y")
    s = m.addVar(vtype=GRB.BINARY, ub=1 if (allow_sale and d["has_asset"]) else 0, name="s")
    m.setObjective(E + P + Q + d["sale_cost"] * s, GRB.MINIMIZE)
    m.addConstr(100 * (d["D"] - P - d["proceeds"] * s) <= d["Lmax"] * (d["EBITDA"] + E - d["asset_ebitda"] * s), name="C1")
    m.addConstr(100 * (d["CF"] + E - d["asset_cf"] * s) >= d["Dmin"] * (d["DS"] - R), name="C2")
    m.addConstr(E <= d["cap"] * y, name="C3")
    m.addConstr(y <= d["cures_remaining"], name="C4")
    m.addConstr(P <= d["cash"] - d["min_liquidity"], name="C5")
    if d["has_cr"]:
        m.addConstr(100 * (d["current_assets"] - P - Q) >= d["min_current_ratio"] * d["current_liabilities"], name="C6")
    if d["has_fccr"]:
        m.addConstr(100 * (d["EBITDA"] + E - d["asset_ebitda"] * s - d["capex"] - d["cash_taxes"] - d["distributions"])
                    >= d["min_fccr"] * (d["DS"] - R), name="C7")
    m.addConstr(10000 * Q >= d["premium_bps"] * P, name="PREMIUM")
    m.addConstr(10000 * R <= d["k"] * (P + d["proceeds"] * s), name="RELIEF")
    for k, v in PARAMS.items():
        m.setParam(k, v)
    m.update()
    return m


def binding(m):
    """C-constraints with no room for one more cent: slack below the step one cent of any money variable
    (E, P, Q, R) moves the row. Binaries are fixed at the optimum and ignored. Display only."""
    out = []
    for c in m.getConstrs():
        if not c.ConstrName.startswith("C"):
            continue
        row = m.getRow(c)
        steps = [abs(row.getCoeff(i)) for i in range(row.size()) if row.getVar(i).VType == GRB.INTEGER]
        if abs(c.Slack) < (max(steps) if steps else 0.5):
            out.append(c.ConstrName)
    return out


def _ints(m, names=("E", "P", "y", "s")):
    return {n: int(round(m.getVarByName(n).X)) for n in names}


def _usd(c):
    return c / 100.0


def extract_result(m, d, lp_path, fixed_lp_path):
    """Turn a solved model into a result dict. Only OPTIMAL (MIPGap 0) and exact-checked yields a plan."""
    status = m.Status
    res = {"status": _status_name(status), "plan": None, "infeasibility": None, "error": None,
           "artifacts": {"lp_file": os.path.basename(lp_path), "lp_sha256": None, "fixed_lp_file": None,
                         "fixed_lp_sha256": None, "gurobi_version": gurobi_version(), "params": dict(PARAMS)}}
    m.write(lp_path)
    res["artifacts"]["lp_sha256"] = _sha256(lp_path)

    if status == GRB.OPTIMAL and (not m.IsMIP or m.MIPGap == 0):
        v = _ints(m)
        bad = check_exact(d, v["E"], v["P"], v["y"], v["s"])
        if bad:
            res["status"] = "OPTIMAL_NOT_EXACT"
            res["error"] = "Rounded solution violates {} in exact arithmetic; no plan is returned.".format(", ".join(bad))
            return res
        pf = pro_forma(d, v["E"], v["P"], v["s"])
        cost = v["E"] + v["P"] + pf["premium_cents"] + d["sale_cost"] * v["s"]
        res["plan"] = {"E": _usd(v["E"]), "P": _usd(v["P"]), "E_cents": v["E"], "P_cents": v["P"],
                       "premium_cents": pf["premium_cents"], "y": v["y"], "s": v["s"],
                       "cost": _usd(cost), "cost_cents": cost, "pro_forma": pf,
                       "binding": binding(m)}
        fixed = m.copy()
        fixed.ModelName = m.ModelName + "_fixed"
        for name in ("y", "s"):
            var = fixed.getVarByName(name)
            var.LB = var.UB = v[name]
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
        relax = waivable(d)
        res["infeasibility"] = {"iis": iis, "relaxed": relax, "waiver": None, "waiver_error": None}
        if not relax:
            res["infeasibility"]["waiver_error"] = "No covenant fails before a cure, so there is nothing to waive."
            return res
        r = m.copy()
        for k, v in PARAMS.items():
            r.setParam(k, v)
        # Minimum total violation, relaxing only the covenants (C1, C2, C6, C7) that fail before any cure.
        # C3 (cure cap), C4 (cure frequency) and C5 (liquidity) are facts and stay hard.
        r.feasRelax(0, True, [], [], [], [r.getConstrByName(c) for c in relax], [1.0] * len(relax))
        r.optimize()
        if r.Status == GRB.OPTIMAL:
            v = _ints(r)
            bad = check_exact(d, v["E"], v["P"], v["y"], v["s"], skip=relax)
            if bad:
                res["infeasibility"]["waiver_error"] = "Relaxed solution violates {} in exact arithmetic; no waiver sized.".format(", ".join(bad))
            else:
                pf = pro_forma(d, v["E"], v["P"], v["s"])
                lev_x100 = _ceil_div(100 * pf["debt_cents"], pf["ebitda_cents"]) if pf["ebitda_cents"] > 0 else None
                dscr_x100 = (100 * pf["cashflow_cents"]) // pf["debt_service_cents"] if pf["debt_service_cents"] > 0 else None
                res["infeasibility"]["waiver"] = {
                    "E": _usd(v["E"]), "P": _usd(v["P"]), "E_cents": v["E"], "P_cents": v["P"], "s": v["s"], "pro_forma": pf,
                    # Lender-facing thresholds: leverage rounded UP, DSCR rounded DOWN, to 0.01x.
                    "waiver_max_leverage_x100": max(d["Lmax"], lev_x100) if lev_x100 is not None else None,
                    "waiver_min_dscr_x100": min(d["Dmin"], dscr_x100) if dscr_x100 is not None else None,
                    "leverage_waived": lev_x100 is not None and lev_x100 > d["Lmax"],
                    "dscr_waived": dscr_x100 is not None and dscr_x100 < d["Dmin"],
                }
                w = res["infeasibility"]["waiver"]
                if d["has_cr"]:
                    cr_x100 = (100 * pf["current_assets_cents"]) // d["current_liabilities"]
                    w["waiver_min_current_ratio_x100"] = min(d["min_current_ratio"], cr_x100)
                    w["current_ratio_waived"] = cr_x100 < d["min_current_ratio"]
                if d["has_fccr"] and pf["debt_service_cents"] > 0:
                    f_x100 = (100 * pf["fccr_numerator_cents"]) // pf["debt_service_cents"]
                    w["waiver_min_fccr_x100"] = min(d["min_fccr"], f_x100)
                    w["fccr_waived"] = f_x100 < d["min_fccr"]
        else:
            res["infeasibility"]["waiver_error"] = "FeasRelax ended with status {}; no waiver sized.".format(_status_name(r.Status))
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
    used = [c for c in CLAUSES if (c != "C6" or d["has_cr"]) and (c != "C7" or d["has_fccr"])]
    relax = waivable(d)
    return {"borrower_id": d["borrower_id"], "period": d["period"], "case": case,
            "gurobi_version": gurobi_version(), "params": dict(PARAMS), "units": "integer cents",
            "constraints": used, "waivable": relax,
            "clauses": {k: {"title": CLAUSES[k]["title"], "waivable": k in relax,
                            "sources": [{"source_document": s, "quote": q} for s, q in CLAUSES[k]["sources"]]}
                        for k in used},
            "options": options}
