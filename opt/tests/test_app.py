from fastapi.testclient import TestClient

from opt import app as appmod
from opt.tests.test_cure_model import BOR09

client = TestClient(appmod.app)


def test_health():
    j = client.get("/health").json()
    assert j["ok"] is True and j["gurobi_version"].count(".") == 2


def test_solve_t1_and_validation(monkeypatch, tmp_path):
    real = appmod.solve_cure
    monkeypatch.setattr(appmod, "solve_cure", lambda d, **kw: real(d, out_dir=str(tmp_path), **kw))
    r = client.post("/solve", json=dict(BOR09, case="apitest"))
    assert r.status_code == 200
    p = r.json()["options"]["cheapest"]["plan"]
    assert p["E_cents"] == 6833334 and p["s"] == 1
    assert client.post("/solve", json=dict(BOR09, period="Q3-2026")).status_code == 422
    assert client.post("/solve", json=dict(BOR09, case="../x")).status_code == 422
    assert client.post("/solve", json=dict(BOR09, Lmax=0)).status_code == 400


def test_env_loader_reads_only_wls_keys(tmp_path):
    f = tmp_path / ".env"
    f.write_text("# c\nWLSACCESSID=abc\nLICENSEID=123\nOTHER=x\n", encoding="utf-8")
    assert appmod.load_env_params(str(f)) == {"WLSACCESSID": "abc", "LICENSEID": 123}
    assert appmod.load_env_params(str(tmp_path / "missing")) == {}
