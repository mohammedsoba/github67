"""V26 / S1 - HTTP behaviour: the portrait 503 must not leak paths or exception text in production.
Needs FastAPI + both ONNX models (same fixtures as the other API suites); the production flag is flipped with monkeypatch."""
from __future__ import annotations

from backend.app.config import MODEL_PATH, PORTRAIT_MODEL_PATH
from tests.backend.test_api_contract import _assert_json_error, _portrait_post

LEAK = f"Portrait model not found: {PORTRAIT_MODEL_PATH}"


def _break_portrait(client, monkeypatch):
    import backend.app.main as main

    def cannot_load(*_a, **_k):
        raise FileNotFoundError(LEAK)

    saved = client.app.state.portrait
    client.app.state.portrait = None
    monkeypatch.setattr(main, "DepthPortrait", cannot_load)
    return main, saved


def test_production_portrait_503_is_generic_and_leaks_no_path_or_exception_text(client, monkeypatch):
    main, saved = _break_portrait(client, monkeypatch)
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    try:
        response = _portrait_post(client, {"blur_level": "5"})
        detail = _assert_json_error(response, 503)
        assert detail == "Portrait background model failed to load"
        for secret in (str(PORTRAIT_MODEL_PATH), str(MODEL_PATH), "FileNotFoundError", "not found", ".onnx", "models"):
            assert secret not in response.text, f"production 503 leaks {secret!r}"
        assert "content-security-policy" in response.headers                    # the hardening headers still apply to it
    finally:
        monkeypatch.undo()
        client.app.state.portrait = saved
        client.app.state.portrait_error = None


def test_development_portrait_503_still_names_the_reason(client, monkeypatch):
    main, saved = _break_portrait(client, monkeypatch)
    monkeypatch.setattr(main, "IS_PRODUCTION", False)
    try:
        detail = _assert_json_error(_portrait_post(client, {"blur_level": "5"}), 503)
        assert "failed to load" in detail and "Portrait model not found" in detail
    finally:
        monkeypatch.undo()
        client.app.state.portrait = saved
        client.app.state.portrait_error = None


def test_production_health_stays_free_of_the_load_error_after_a_failed_load(client, monkeypatch):
    main, saved = _break_portrait(client, monkeypatch)
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    try:
        _portrait_post(client, {"blur_level": "5"})                              # records portrait_error server-side
        body = client.get("/health").json()
        assert set(body) == {"status", "model_loaded", "portrait_model_loaded"} and body["portrait_model_loaded"] is False
        assert "model not found" not in client.get("/health").text
    finally:
        monkeypatch.undo()
        client.app.state.portrait = saved
        client.app.state.portrait_error = None
