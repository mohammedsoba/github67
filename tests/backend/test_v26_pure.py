"""V26 - S1 / S3 checks that need NEITHER FastAPI NOR the ONNX models (stdlib + backend.app.security / scripts only)."""
from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
from pathlib import Path

import pytest

from backend.app.config import PROJECT_DIR
from backend.app.security import PORTRAIT_UNAVAILABLE_MESSAGE, public_model_error

LEAK = "FileNotFoundError: Portrait model not found: /srv/yofilter/backend/models/portrait_depth.onnx"


# ------------------------------------------------------------------------------------------------ S1
def test_production_503_text_is_generic_and_never_carries_the_reason():
    text = public_model_error(True, PORTRAIT_UNAVAILABLE_MESSAGE, LEAK)
    assert text == "Portrait background model failed to load"
    for secret in ("/srv", "FileNotFoundError", ".onnx", "backend/models"):
        assert secret not in text


def test_production_503_text_without_a_reason_is_the_same_generic_message():
    assert public_model_error(True, PORTRAIT_UNAVAILABLE_MESSAGE, None) == PORTRAIT_UNAVAILABLE_MESSAGE
    assert public_model_error(True, PORTRAIT_UNAVAILABLE_MESSAGE, "") == PORTRAIT_UNAVAILABLE_MESSAGE


def test_development_503_text_keeps_the_reason_for_the_developer():
    text = public_model_error(False, PORTRAIT_UNAVAILABLE_MESSAGE, LEAK)
    assert text.startswith(PORTRAIT_UNAVAILABLE_MESSAGE) and LEAK in text
    assert public_model_error(False, PORTRAIT_UNAVAILABLE_MESSAGE, None) == PORTRAIT_UNAVAILABLE_MESSAGE


# ------------------------------------------------------------------------------------------------ S3
def _load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_version_v26", PROJECT_DIR / "scripts" / "sync_version.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _scratch(module) -> Path:
    scratch = Path(tempfile.mkdtemp(prefix="yofilter-s3-"))
    for rel in ("version.json", "config.xml", "index.html", "js/i18n/i18n.js", "js/config/app-config.js"):
        (scratch / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PROJECT_DIR / rel, scratch / rel)
    module.ROOT = scratch
    return scratch


def test_shipped_files_follow_version_json_and_carry_no_placeholder_host():
    module = _load_sync_module()
    assert module.run(check=True) == 0
    for rel in ("config.xml", "index.html", "js/config/app-config.js", "version.json"):
        text = (PROJECT_DIR / rel).read_text(encoding="utf-8")
        assert "api.yofilter.example" not in text and "PLACEHOLDER HOST" not in text, rel


@pytest.mark.parametrize("bad", [
    "http://api.real.com", "https://api.real.com/v1", "https://*.real.com", "https://api.yofilter.example",
    "https://localhost", "https://api.real.com?x=1", "ftp://api.real.com", "api.real.com", 12345,
])
def test_native_api_base_validation_rejects_unsafe_values(bad):
    module = _load_sync_module()
    with pytest.raises(SystemExit):
        module.validate_native_base(bad)


def test_native_api_base_validation_normalises_good_values():
    module = _load_sync_module()
    assert module.validate_native_base("https://api.real-host.com/") == "https://api.real-host.com"
    assert module.validate_native_base("  https://api.real-host.com:8443 ") == "https://api.real-host.com:8443"
    assert module.validate_native_base("") == "" and module.validate_native_base(None) == ""


def test_native_api_base_is_stamped_everywhere_checked_for_drift_and_gates_release():
    module = _load_sync_module()
    scratch = _scratch(module)
    try:
        module.set_native_base("")                                              # the scratch copy starts unconfigured, whatever the repo itself is stamped with
        assert module.run(check=False) == 0
        assert module.run(check=False, release=True) == 1                       # unconfigured: release gate fails
        module.set_native_base("https://api.real-host.com")
        assert module.run(check=True) == 1                                      # version.json changed, copies not yet
        assert module.run(check=False) == 0                                     # stamped
        assert module.run(check=True) == 0 and module.run(check=False, release=True) == 0
        assert 'NATIVE_API_BASE = "https://api.real-host.com";' in (scratch / "js/config/app-config.js").read_text(encoding="utf-8")
        assert "data: https://api.real-host.com https://*.aws.cdn.hf.co " in (scratch / "index.html").read_text(encoding="utf-8")
        assert '<access origin="https://api.real-host.com" />' in (scratch / "config.xml").read_text(encoding="utf-8")
        config = (scratch / "config.xml")
        config.write_text(config.read_text(encoding="utf-8").replace("api.real-host.com", "other.example.net"), encoding="utf-8")
        assert module.run(check=True) == 1                                      # a hand edit is drift
        module.set_native_base("")
        assert module.run(check=False) == 0
        combined = "".join((scratch / rel).read_text(encoding="utf-8") for rel in ("config.xml", "index.html", "js/config/app-config.js"))
        assert "real-host" not in combined and "NOT CONFIGURED" in combined
        assert json.loads((scratch / "version.json").read_text(encoding="utf-8"))["native_api_base"] == ""
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
