"""Start-up model downloader (backend/app/models_bootstrap.py): pure tests against a throw-away local HTTP server.

No internet, no real models: tiny fake 'models' with min_bytes lowered. Covers the Railway cold start (download +
verify + atomic publish), warm start (no network), LFS-pointer replacement, corruption, outages and the kill switch.
"""
from __future__ import annotations

import hashlib
import http.server
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from backend.app import models_bootstrap as mb

GOOD = b"A" * 5000
OTHER = b"B" * 5000
POINTER = b"version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _Handler(http.server.BaseHTTPRequestHandler):
    files: dict[str, bytes] = {}
    hits: list[str] = []

    def do_GET(self):                                   # noqa: N802 - stdlib naming
        type(self).hits.append(self.path)
        body = type(self).files.get(self.path.lstrip("/"))
        if body is None:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):                       # keep test output quiet
        pass


class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        _Handler.files = {"m.onnx": GOOD}
        _Handler.hits = []
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name) / "sub" / "m.onnx"      # parent does not exist yet
        self.addCleanup(self.tmp.cleanup)
        self.env = {"MODEL_DOWNLOAD_ATTEMPTS": "1"}

    def run_ensure(self, **kw):
        import os
        old = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        try:
            kw.setdefault("manifest", {"m.onnx": _sha(GOOD)})
            return mb.ensure_models({"m.onnx": self.dest}, base_url=self.base, min_bytes=100, **kw)
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def test_cold_start_downloads_verifies_and_leaves_no_part_file(self):
        self.assertEqual(self.run_ensure(), {"m.onnx": mb.DOWNLOADED})
        self.assertEqual(self.dest.read_bytes(), GOOD)
        self.assertEqual(list(self.dest.parent.glob("*.part")), [])

    def test_warm_start_makes_no_network_request(self):
        self.dest.parent.mkdir(parents=True); self.dest.write_bytes(GOOD)
        self.assertEqual(self.run_ensure(), {"m.onnx": mb.PRESENT})
        self.assertEqual(_Handler.hits, [])

    def test_lfs_pointer_file_is_replaced(self):
        self.dest.parent.mkdir(parents=True); self.dest.write_bytes(POINTER)
        self.assertEqual(self.run_ensure(), {"m.onnx": mb.DOWNLOADED})
        self.assertEqual(self.dest.read_bytes(), GOOD)

    def test_wrong_content_is_rejected_and_nothing_is_published(self):
        _Handler.files = {"m.onnx": OTHER}                       # same size, different bytes
        status = self.run_ensure()["m.onnx"]
        self.assertTrue(status.startswith("failed") and "SHA-256" in status, status)
        self.assertFalse(self.dest.exists())
        self.assertEqual(list(self.dest.parent.glob("*")), [])

    def test_verify_on_start_redownloads_a_corrupt_but_large_file(self):
        self.dest.parent.mkdir(parents=True); self.dest.write_bytes(OTHER)
        self.assertEqual(self.run_ensure(verify=False), {"m.onnx": mb.PRESENT})     # size-only check trusts it
        self.assertEqual(self.run_ensure(verify=True), {"m.onnx": mb.DOWNLOADED})   # full hash catches it
        self.assertEqual(self.dest.read_bytes(), GOOD)

    def test_http_404_does_not_raise(self):
        _Handler.files = {}
        status = self.run_ensure()["m.onnx"]
        self.assertTrue(status.startswith("failed"), status)
        self.assertFalse(self.dest.exists())

    def test_unreachable_host_does_not_raise(self):
        with mock.patch.object(mb.time, "sleep"):                # skip the retry back-off
            status = mb.ensure_models({"m.onnx": self.dest}, base_url="http://127.0.0.1:9", manifest={}, min_bytes=100)
        self.assertTrue(status["m.onnx"].startswith("failed"), status)

    def test_kill_switch_never_touches_the_network(self):
        self.assertEqual(self.run_ensure(enabled=False), {"m.onnx": mb.DISABLED})
        self.assertEqual(_Handler.hits, [])
        self.assertFalse(self.dest.exists())

    def test_without_manifest_entry_download_is_size_checked_only(self):
        self.assertEqual(self.run_ensure(manifest={}), {"m.onnx": mb.DOWNLOADED})

    def test_manifest_parser_and_real_manifest(self):
        table = mb.read_manifest()
        self.assertEqual(set(table), {"inpainting_lama.onnx", "portrait_depth.onnx"})
        self.assertTrue(all(len(v) == 64 for v in table.values()))
        self.assertEqual(set(mb.DEFAULT_TARGETS), set(table))


if __name__ == "__main__":
    unittest.main()
