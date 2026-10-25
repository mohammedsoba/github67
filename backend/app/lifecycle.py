"""Process lifecycle states for the probes (pure functions: no FastAPI import, unit-testable in isolation).

Three questions, three endpoints - they must never be mixed up, or a slow model load looks like a crash (or the reverse):

* ``/livez``   LIVENESS. "Is the process up and answering?" Always 200 while the event loop runs. Never looks at models,
               disk or the network, so a cold start or a missing model can never get a healthy process killed / restarted.
* ``/readyz``  READINESS. "May traffic be sent here?" 200 only when start-up is finished, BOTH required models are loaded and
               (by default) the LaMa warm-up pass is done; 503 + ``Retry-After`` otherwise. Point the platform health check here.
* ``/health``  Human / monitoring summary of the models. 503 as soon as ANY required model is missing, never 200 "degraded".

Status values of ``/readyz``:  ``starting`` (models still loading) -> ``warming_up`` (loaded, first LaMa pass running)
-> ``ready``;  ``unavailable`` = start-up finished but a required model is missing / failed to load (terminal until fixed).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

STARTING, WARMING_UP, UNAVAILABLE, READY = "starting", "warming_up", "unavailable", "ready"

# Answer for API calls that arrive before the models are loaded (instead of a confusing "model is not loaded").
STARTING_MESSAGE = "The server is starting; please retry in a few seconds"
RETRY_AFTER_S = "5"
NO_STORE = {"Cache-Control": "no-store"}          # probes must never be cached by a proxy / CDN


@dataclass(frozen=True)
class Readiness:
    status: str
    lama_loaded: bool
    portrait_loaded: bool

    @property
    def ready(self) -> bool:
        return self.status == READY

    @property
    def http_status(self) -> int:
        return 200 if self.ready else 503


def evaluate_readiness(*, boot_finished: bool, lama_loaded: bool, portrait_loaded: bool,
                       warmup_pending: bool = False) -> Readiness:
    """Order matters: not finished -> starting; finished with a model missing -> unavailable; then warm-up; then ready."""
    if not boot_finished:
        status = STARTING
    elif not (lama_loaded and portrait_loaded):
        status = UNAVAILABLE
    elif warmup_pending:
        status = WARMING_UP
    else:
        status = READY
    return Readiness(status, bool(lama_loaded), bool(portrait_loaded))


EXIT_CODE_MODEL_LOAD_FAILURE = 1                    # non-zero on purpose: Railway's ON_FAILURE restart policy ignores exit code 0


def missing_models(*, lama_loaded: bool, portrait_loaded: bool) -> list[str]:
    """Names of the required models that are not loaded (empty list = start-up succeeded)."""
    missing = []
    if not lama_loaded:
        missing.append("LaMa eraser")
    if not portrait_loaded:
        missing.append("portrait depth")
    return missing


def liveness_body() -> dict[str, str]:
    return {"status": "alive"}


def readiness_body(readiness: Readiness, production: bool, detailed: Callable[[], dict] | None = None) -> dict[str, object]:
    """``/readyz`` JSON. Production: status + three booleans only (no paths, providers or error text, like ``/health``);
    ``detailed`` is only called outside production."""
    body: dict[str, object] = {"status": readiness.status, "ready": readiness.ready,
                               "model_loaded": readiness.lama_loaded, "portrait_model_loaded": readiness.portrait_loaded}
    if not production and detailed is not None:
        body.update(detailed())
    return body


def health_http_status(lama_loaded: bool, portrait_loaded: bool) -> int:
    """``/health``: 200 only when EVERY required model is loaded, else 503 (a monitor must not read "degraded" as fine)."""
    return 200 if (lama_loaded and portrait_loaded) else 503
