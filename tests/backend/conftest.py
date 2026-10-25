"""Shared pytest setup for the backend suites.

* Env is pinned BEFORE any backend module is imported, so results do not depend on the machine:
  CPU providers only (no DirectML), one LaMa thread, no background warm-up.
* Models are session fixtures. A missing model or a git-lfs pointer file is a hard FAILURE when
  REQUIRE_GOLDEN=1 (CI) - never a silent skip - and a skip with an explanation otherwise.
"""
from __future__ import annotations

import os

os.environ.setdefault("LAMA_PROVIDER", "cpu")
os.environ.setdefault("PORTRAIT_PROVIDER", "cpu")
os.environ.setdefault("LAMA_THREADS", "1")
os.environ.setdefault("LAMA_WARMUP_PASSES", "0")
# Production opens the port first and loads the models in the background; the API suites need them loaded when the TestClient
# starts, so they use the blocking start-up (test_lifecycle.py exercises the background path explicitly).
os.environ.setdefault("BLOCK_STARTUP_ON_MODELS", "1")
# The golden portrait numerics were produced with 2 ONNX threads (the old max(2, cpus)); production now follows the container
# CPU quota, so the suites pin the old value to keep their results bit-identical on any machine.
os.environ.setdefault("PORTRAIT_THREADS", "2")
os.environ["YOFILTER_ENV"] = "development"            # the API suites assert the full dev /health + wildcard CORS; production is tested explicitly (test_v25_*)
os.environ.pop("ENV", None)
os.environ.pop("ALLOWED_ORIGINS", None)
os.environ.setdefault("RATE_LIMIT_PER_MIN", "100000")   # the contract suite fires far more than 30 POSTs/min

import pytest  # noqa: E402

STRICT = os.environ.get("REQUIRE_GOLDEN") == "1"


def _model_problem(path) -> str | None:
    from backend.app.ort_utils import MIN_MODEL_BYTES
    if not path.is_file():
        return f"model file missing: {path}"
    if path.stat().st_size < MIN_MODEL_BYTES:
        return f"model file is {path.stat().st_size} bytes (git-lfs pointer / truncated download?): {path}"
    return None


def _require(path) -> None:
    problem = _model_problem(path)
    if problem:
        (pytest.fail if STRICT else pytest.skip)(problem + "  -> run: python scripts/fetch_models.py")


@pytest.fixture(scope="session")
def lama():
    from backend.app.config import MODEL_PATH
    from backend.app.lama import LamaInpainter
    _require(MODEL_PATH)
    return LamaInpainter()


@pytest.fixture(scope="session")
def portrait():
    from backend.app.config import PORTRAIT_MODEL_PATH
    from backend.app.portrait import DepthPortrait
    _require(PORTRAIT_MODEL_PATH)
    return DepthPortrait()


@pytest.fixture(scope="module")
def client():
    """Starlette TestClient used as a context manager => the FastAPI lifespan really runs (models load)."""
    from fastapi.testclient import TestClient
    from backend.app.config import MODEL_PATH, PORTRAIT_MODEL_PATH
    _require(MODEL_PATH)
    _require(PORTRAIT_MODEL_PATH)
    from backend.app.main import app
    with TestClient(app) as c:
        yield c
