"""Cure planner solver service.

    py -m uvicorn opt.app:app --host 127.0.0.1 --port 8000

GET  /health -> {"ok": true, "gurobi_version": "..."}
POST /solve  -> solve_cure() result for one borrower-quarter (see opt/SPEC.md)

WLS licence fields are read from opt/.env when present (WLSACCESSID, WLSSECRET, LICENSEID).
That file is git-ignored; its values are never logged or returned.
"""
import os
import re

from fastapi import FastAPI, HTTPException
from typing import Optional, Union

from pydantic import BaseModel, Field, StrictFloat, StrictInt, StrictStr

from opt.cure_model import CureInputError, gurobi_version, solve_cure

HERE = os.path.dirname(os.path.abspath(__file__))
WLS_KEYS = {"WLSACCESSID": str, "WLSSECRET": str, "LICENSEID": int}


def load_env_params(path=os.path.join(HERE, ".env")):
    params = {}
    if not os.path.exists(path):
        return params
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k in WLS_KEYS and v:
                params[k] = WLS_KEYS[k](v)
    return params


ENV_PARAMS = load_env_params()
app = FastAPI(title="Covenant Monitor cure planner", version="1.0")


Num = Union[StrictStr, StrictInt, StrictFloat]  # decimal strings preferred; converted exactly to cents


class SolveRequest(BaseModel):
    borrower_id: str = Field(pattern=r"^BOR-\d{1,4}$")
    period: str = Field(pattern=r"^\d{4}-Q[1-4]$")
    case: str = Field(default="live", pattern=r"^[A-Za-z0-9_-]{1,24}$")
    D: Num
    EBITDA: Num
    DS: Num
    CF: Num
    Lmax: Num
    Dmin: Num
    cap: Num
    cures_remaining: Num
    cash: Num
    min_liquidity: Num
    k: Num
    premium_bps: Num
    has_asset: bool = False
    proceeds: Num = 0
    asset_ebitda: Num = 0
    asset_cf: Num = 0
    sale_cost: Num = 0
    # Current ratio (C6): sent only when the monitor applies the current-ratio test this quarter.
    current_assets: Optional[Num] = None
    current_liabilities: Optional[Num] = None
    min_current_ratio: Optional[Num] = None
    # FCCR (C7): sent only when the monitor applies the FCCR test this quarter.
    capex: Optional[Num] = None
    cash_taxes: Optional[Num] = None
    distributions: Optional[Num] = None
    min_fccr: Optional[Num] = None


@app.get("/health")
def health():
    return {"ok": True, "gurobi_version": gurobi_version(), "wls_configured": bool(ENV_PARAMS)}


@app.post("/solve")
def solve(req: SolveRequest):
    data = req.model_dump()
    case = data.pop("case")
    try:
        return solve_cure(data, case=case, env_params=ENV_PARAMS)
    except CureInputError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # licence or solver failure: explicit error, never a plan
        msg = re.sub(r"(WLSSECRET|WLSACCESSID)\S*", "[redacted]", str(e))
        raise HTTPException(status_code=503, detail="Solver unavailable: " + msg)
