"""Railway / PaaS entry point:  ``uvicorn app:app --host 0.0.0.0 --port $PORT``  (see Procfile).

The real application lives in ``backend/app/main.py`` (``backend.app.main:app``). This module only re-exports it so
the conventional ``app:app`` target works from the project root. It adds no behaviour of its own: configuration
(``TRUST_PROXY``, ``YOFILTER_ENV``, rate limits, CORS ...) is read by ``backend/app/config.py``.
"""

from backend.app.main import app

__all__ = ["app"]


if __name__ == "__main__":      # local convenience: `python app.py` honours PORT exactly like the Procfile does
    import os

    import uvicorn

    uvicorn.run("app:app", host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8000")))
