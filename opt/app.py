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
from pydantic import BaseModel, Field

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


class SolveRequest(BaseModel):
    borrower_id: str = Field(pattern=r"^BOR-\d{1,4}$")
    period: str = Field(pattern=r"^\d{4}-Q[1-4]$")
    case: str = Field(default="live", pattern=r"^[A-Za-z0-9_-]{1,24}$")
    D: float
    EBITDA: float
    DS: float
    CF: float
    Lmax: float
    Dmin: float
    cap: float
    cures_remaining: int
    cash: float
    min_liquidity: float
    k: float
    premium_bps: float
    has_asset: bool = False
    proceeds: float = 0
    asset_ebitda: float = 0
    asset_cf: float = 0
    sale_cost: float = 0


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
