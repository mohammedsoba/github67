"""scripts/fetch_mediapipe_assets.py - pin / verify / refuse, entirely offline (a fake npm tarball + fake model; no network)."""
from __future__ import annotations

import importlib.util
import io
import os
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "fetch_mediapipe_assets.py"

BUNDLE = b"export const FilesetResolver = {};\n" * 3000                 # > 50 000 bytes
WASM = b"\x00asm\x01\x00\x00\x00" + b"w" * 4096
WASM_JS = b"// loader\n" * 50
MODEL = b"TFL3" + b"m" * 2_000_000                                       # > 1 000 000 bytes


def _tarball() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in {"package/vision_bundle.mjs": BUNDLE, "package/wasm/vision_wasm_internal.wasm": WASM,
                           "package/wasm/vision_wasm_internal.js": WASM_JS, "package/package.json": b"{}",
                           "package/vision.d.ts": b"// types"}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


@pytest.fixture()
def mp(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("fetch_mediapipe_assets", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "scripts").mkdir()
    monkeypatch.setattr(module, "OUT", tmp_path / "vendor" / "mediapipe")
    monkeypatch.setattr(module, "MANIFEST", tmp_path / "scripts" / "MEDIAPIPE.sha256")
    served = {module.TARBALL_URL: _tarball(), module.MODEL_URL: MODEL}
    requested: list[str] = []

    def fake_get(url):
        requested.append(url)
        if url not in served:
            raise OSError(f"unexpected URL {url}")
        return served[url]

    monkeypatch.setattr(module, "http_get", fake_get)
    module.served, module.requested = served, requested
    return module


def test_urls_are_pinned_never_latest(mp):
    assert "/latest" not in mp.TARBALL_URL and "/latest" not in mp.MODEL_URL
    assert f"tasks-vision-{mp.VERSION}.tgz" in mp.TARBALL_URL
    assert f"/float32/{mp.MODEL_VERSION}/" in mp.MODEL_URL and mp.MODEL_VERSION.isdigit()
    assert "jsdelivr" not in mp.TARBALL_URL                              # the build does not depend on a CDN either


def test_pin_then_verify_roundtrip(mp):
    assert mp.main(["--pin"]) == 0
    table = mp.read_manifest()
    assert set(table) == {"vision_bundle.mjs", "wasm/vision_wasm_internal.wasm", "wasm/vision_wasm_internal.js", mp.MODEL_NAME}   # no package.json / .d.ts
    assert mp.main(["--check"]) == 0 and mp.main(["--manifest-only"]) == 0
    mp.requested.clear()
    assert mp.main([]) == 0 and mp.requested == []                      # everything verified on disk: nothing is downloaded again


def test_missing_files_are_downloaded_and_verified_against_the_manifest(mp):
    assert mp.main(["--pin"]) == 0
    (mp.OUT / "vision_bundle.mjs").unlink()
    (mp.OUT / mp.MODEL_NAME).unlink()
    assert mp.main(["--check"]) == 1                                     # --check never downloads
    assert mp.main([]) == 0 and (mp.OUT / "vision_bundle.mjs").is_file() and mp.main(["--check"]) == 0


def test_a_tampered_download_is_refused_and_not_written(mp):
    assert mp.main(["--pin"]) == 0
    (mp.OUT / "vision_bundle.mjs").unlink()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in {"package/vision_bundle.mjs": BUNDLE + b"// evil", "package/wasm/vision_wasm_internal.wasm": WASM,
                           "package/wasm/vision_wasm_internal.js": WASM_JS}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    mp.served[mp.TARBALL_URL] = buffer.getvalue()
    assert mp.main([]) == 1
    assert not (mp.OUT / "vision_bundle.mjs").exists()


def test_corrupt_or_unlisted_files_fail_the_check(mp):
    assert mp.main(["--pin"]) == 0
    (mp.OUT / "wasm" / "vision_wasm_internal.wasm").write_bytes(b"corrupt")
    assert mp.main(["--check"]) == 1
    assert mp.main([]) == 0                                              # re-downloaded from the (good) tarball
    (mp.OUT / "extra.js").write_text("alert(1)")
    assert mp.main(["--check"]) == 1                                     # an unlisted file never ships
    (mp.OUT / "extra.js").unlink()
    (mp.OUT / "vision_bundle.mjs.part").write_bytes(b"half")
    assert mp.main(["--check"]) == 1                                     # a half-downloaded file never ships


def test_without_a_manifest_nothing_is_trusted(mp):
    mp.requested.clear()
    assert mp.main([]) == 1 and mp.requested == []                       # refuses before touching the network
    mp.MANIFEST.write_text("# comment only\n", encoding="utf-8")
    assert mp.main([]) == 1 and mp.main(["--manifest-only"]) == 1 and mp.requested == []


def test_a_manifest_with_unsafe_or_malformed_lines_is_rejected(mp):
    for bad in ("nothex  vision_bundle.mjs\n", f"{'a' * 64}  ../escape.mjs\n", f"{'a' * 64}  /abs/path\n"):
        mp.MANIFEST.write_text(bad, encoding="utf-8")
        with pytest.raises(ValueError):
            mp.read_manifest()


def test_tarball_paths_cannot_escape_the_output_folder(mp):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name in ("package/../../evil.mjs", "package/wasm/../../evil.wasm", "package/wasm/sub/deep.wasm", "package/vision_bundle.mjs"):
            info = tarfile.TarInfo(name)
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
    assert set(mp.tarball_files(buffer.getvalue())) == {"vision_bundle.mjs"}   # only the exact, flat layout is ever extracted


def test_the_committed_manifest_is_complete_once_pinned():
    spec = importlib.util.spec_from_file_location("fma_real", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        table = module.read_manifest()
    except ValueError as exc:
        (pytest.fail if os.environ.get("REQUIRE_GOLDEN") == "1" else pytest.skip)(f"MEDIAPIPE.sha256 is not pinned yet: {exc}")
    assert module.BUNDLE in table and module.MODEL_NAME in table and any(n.endswith(".wasm") for n in table)
