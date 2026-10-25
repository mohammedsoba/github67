"""scripts/verify_models.py - the fail-closed model gate the Dockerfile runs (pure stdlib tests, no models needed)."""
from __future__ import annotations

import hashlib
import importlib.util
import pathlib

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "verify_models.py"
_spec = importlib.util.spec_from_file_location("verify_models", SCRIPT)
vm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vm)

LAMA, DEPTH = "inpainting_lama.onnx", "portrait_depth.onnx"


def _setup(folder: pathlib.Path, *, manifest: bool = True) -> dict[str, bytes]:
    blobs = {LAMA: b"L" * 400, DEPTH: b"D" * 500}
    for name, blob in blobs.items():
        (folder / name).write_bytes(blob)
    if manifest:
        (folder / "MODELS.sha256").write_text("".join(f"{hashlib.sha256(b).hexdigest()}  {n}\n" for n, b in blobs.items()))
    return blobs


def _check(folder, **kw):
    return vm.verify(folder, folder / "MODELS.sha256", min_bytes=100, **kw)


def test_good_models_pass(tmp_path):
    _setup(tmp_path)
    assert _check(tmp_path) == []
    assert vm.main(["--dir", str(tmp_path), "--min-bytes", "100"]) == 0


def test_missing_manifest_fails_closed(tmp_path):
    _setup(tmp_path, manifest=False)
    assert any("manifest unreadable" in p for p in _check(tmp_path))
    assert vm.main(["--dir", str(tmp_path), "--min-bytes", "100"]) == 1


def test_empty_or_malformed_manifest_fails_closed(tmp_path):
    _setup(tmp_path)
    (tmp_path / "MODELS.sha256").write_text("")
    assert any("empty" in p for p in _check(tmp_path))
    (tmp_path / "MODELS.sha256").write_text("not a hash line\n")
    assert any("not '<64 hex>" in p for p in _check(tmp_path))


def test_manifest_without_a_required_model_fails(tmp_path):
    blobs = _setup(tmp_path)
    (tmp_path / "MODELS.sha256").write_text(f"{hashlib.sha256(blobs[LAMA]).hexdigest()}  {LAMA}\n")
    assert any(DEPTH in p and "no entry" in p for p in _check(tmp_path))
    assert any(DEPTH in p and "no entry" in p for p in _check(tmp_path, manifest_only=True))


def test_duplicate_manifest_entry_fails(tmp_path):
    _setup(tmp_path)
    with open(tmp_path / "MODELS.sha256", "a") as fh:
        fh.write(f"{'0' * 64}  {LAMA}\n")
    assert any("duplicate" in p for p in _check(tmp_path))


def test_missing_model_file_fails(tmp_path):
    _setup(tmp_path)
    (tmp_path / DEPTH).unlink()
    assert any(DEPTH in p and "missing" in p for p in _check(tmp_path))


def test_corrupt_model_fails(tmp_path):
    _setup(tmp_path)
    (tmp_path / LAMA).write_bytes(b"X" * 400)                       # right size, wrong content
    assert any(LAMA in p and "mismatch" in p for p in _check(tmp_path))


def test_lfs_pointer_or_truncated_file_fails(tmp_path):
    _setup(tmp_path)
    (tmp_path / LAMA).write_bytes(b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 92600000\n")
    problems = vm.verify(tmp_path, tmp_path / "MODELS.sha256", min_bytes=200)
    assert any(LAMA in p and "bytes" in p for p in problems)


def test_unlisted_onnx_and_leftover_part_files_fail(tmp_path):
    _setup(tmp_path)
    (tmp_path / "sneaky.onnx").write_bytes(b"S" * 400)
    (tmp_path / "x.onnx.part").write_bytes(b"P")
    problems = _check(tmp_path)
    assert any("sneaky.onnx" in p and "does not list" in p for p in problems)
    assert any("x.onnx.part" in p for p in problems)


def test_manifest_only_mode_ignores_the_model_files(tmp_path):
    _setup(tmp_path)
    (tmp_path / LAMA).unlink()
    assert _check(tmp_path, manifest_only=True) == []


def test_required_names_match_what_the_server_loads():
    from backend.app.models_bootstrap import DEFAULT_TARGETS
    assert set(vm.REQUIRED) == set(DEFAULT_TARGETS)


def test_the_committed_manifest_is_valid_and_lists_both_models():
    table, problems = vm.read_manifest(vm.DEFAULT_DIR / "MODELS.sha256")
    assert problems == [] and set(vm.REQUIRED) <= set(table)
    assert all(len(d) == 64 for d in table.values())


def test_dockerfile_gates_are_in_place():
    text = (SCRIPT.parents[1] / "Dockerfile").read_text(encoding="utf-8")
    assert text.count("scripts/verify_models.py") >= 4                       # copied, manifest-only, models stage, final stage
    assert "MODEL_AUTO_DOWNLOAD=0" in text and "USER yofilter" in text
    assert "--only-binary=:all:" in text
    assert "--mount=type=cache" not in text                                   # Railway rejects un-prefixed cache mount ids
