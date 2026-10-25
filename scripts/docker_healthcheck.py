#!/usr/bin/env python3
"""Container HEALTHCHECK probe (standard library only): exit 0 if GET <path> answers 200, else 1.

    python scripts/docker_healthcheck.py            # /livez  (default): "is the process alive?"
    python scripts/docker_healthcheck.py /readyz    # "is it ready for traffic?"

The Dockerfile uses /livez: a slow model load must not make the container "unhealthy" (and get it restarted).
"""
from __future__ import annotations

import os
import sys
import urllib.request


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "/livez"
    url = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}{path}"
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            return 0 if response.status == 200 else 1
    except Exception:                                    # noqa: BLE001 - any failure (refused, 503, timeout) = unhealthy
        return 1


if __name__ == "__main__":
    sys.exit(main())
