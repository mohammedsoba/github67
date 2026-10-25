"""Static guards for the container build (stdlib only: no model, no Docker daemon needed).

They pin the three deployment decisions: warm-up in readiness, exit on a failed model load, no on-device assets in the image."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
RUNTIME = DOCKERFILE.split("AS runtime", 1)[1]


def _instructions(text: str) -> list[str]:
    """Dockerfile instructions with comments dropped and line continuations joined."""
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    return [part.strip() for part in re.sub(r"\\\s*\n", " ", "\n".join(lines)).split("\n") if part.strip()]


def test_vendor_comes_only_from_the_verified_mediapipe_stage():
    copies = [i for i in _instructions(DOCKERFILE) if i.startswith("COPY") and re.search(r"\bvendor\b", i)]
    assert len(copies) == 1 and "--from=mediapipe" in copies[0] and "/build/vendor/mediapipe ./vendor/mediapipe" in copies[0], copies
    ignored = {line.strip() for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()}
    assert "vendor" in ignored                          # nothing under vendor/ is ever taken from the build context


def test_mediapipe_stage_fails_closed_and_the_final_image_is_rechecked():
    stage = DOCKERFILE.split("AS mediapipe", 1)[1].split("AS builder", 1)[0]
    for step in ("fetch_mediapipe_assets.py --manifest-only", "fetch_mediapipe_assets.py --check", 'test "${ok}" = 1'):
        assert step in stage, step
    assert "MEDIAPIPE.sha256" in stage
    assert "python scripts/fetch_mediapipe_assets.py --check" in RUNTIME            # gate on the FINAL filesystem as well
    assert "scripts/fetch_mediapipe_assets.py scripts/MEDIAPIPE.sha256" in RUNTIME  # ... which needs the script + manifest in the image


def test_runtime_stage_sets_the_probe_and_exit_policy():
    env = " ".join(i for i in _instructions(RUNTIME) if i.startswith("ENV"))
    assert "READY_WAITS_FOR_WARMUP=1" in env
    assert "EXIT_ON_MODEL_LOAD_FAILURE=1" in env
    assert "MODEL_AUTO_DOWNLOAD=0" in env


def test_runtime_image_is_locked_to_the_production_profile():
    env = " ".join(i for i in _instructions(RUNTIME) if i.startswith("ENV"))
    assert re.search(r"\bYOFILTER_ENV=production\b", env)                 # /docs off, /health trimmed, CORS locked, headers on
    assert not re.search(r"\bTRUST_PROXY\b", env)                         # spoofable header: opt-in per deployment, never baked in


def test_healthcheck_stays_liveness_and_railway_uses_readiness():
    assert '"/livez"' in RUNTIME                        # a slow model load must never mark the container unhealthy
    deploy = json.loads((ROOT / "railway.json").read_text(encoding="utf-8"))["deploy"]
    assert deploy["healthcheckPath"] == "/readyz"
    assert deploy["restartPolicyType"] == "ON_FAILURE" and deploy["restartPolicyMaxRetries"] >= 1


def test_config_defaults_match_the_decisions():
    text = (ROOT / "backend" / "app" / "config.py").read_text(encoding="utf-8")
    assert 'READY_WAITS_FOR_WARMUP = _bool_env("READY_WAITS_FOR_WARMUP", "1")' in text
    assert 'EXIT_ON_MODEL_LOAD_FAILURE = _bool_env("EXIT_ON_MODEL_LOAD_FAILURE", "0")' in text   # code default off; the image turns it on
