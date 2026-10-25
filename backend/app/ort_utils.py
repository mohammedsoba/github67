"""Shared ONNX Runtime helpers: CPU budget, execution-provider selection, session creation.

Provider policy (LaMa, and optionally the portrait model):
    LAMA_PROVIDER=auto  (default)  DirectML if onnxruntime-directml is installed, else CPU
    LAMA_PROVIDER=dml              same as auto, but logs loudly when DirectML is unavailable
    LAMA_PROVIDER=cpu              force the CPU provider
A DirectML session that fails to build - or fails on its first real run - is transparently
replaced by an optimised CPU session, so a missing/odd GPU driver never takes the API down.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import onnxruntime as ort

logger = logging.getLogger("yofilter.ort")

DML = "DmlExecutionProvider"
CPU = "CPUExecutionProvider"
MIN_MODEL_BYTES = 1_000_000   # anything smaller is a truncated download or a git-lfs pointer file


def effective_cpu_count() -> int:
    """CPUs this process can really use (affinity mask + cgroup v2/v1 quota; LAMA_THREADS overrides).

    ``os.cpu_count()`` reports the *host* core count, which inside Docker / Replit / k8s is far
    above the container quota; spawning that many spinning ONNX threads makes inference 2-10x slower.
    """
    override = os.environ.get("LAMA_THREADS", "").strip()
    if override.isdigit() and int(override) > 0:
        return int(override)
    try:
        count = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        count = os.cpu_count() or 1
    quota = None
    try:
        raw = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if raw and raw[0] != "max":
            quota = int(raw[0]) / int(raw[1])
    except (OSError, ValueError, IndexError):
        pass
    if quota is None:
        try:
            q = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
            period = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
            if q > 0 and period > 0:
                quota = q / period
        except (OSError, ValueError):
            pass
    if quota is not None:
        count = min(count, max(1, int(quota + 0.5)))
    return max(1, count)


def check_model_file(path: Path, label: str) -> Path:
    """Fail early with an actionable message instead of an opaque ONNX Runtime error."""
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"{label} model not found: {path}")
    size = path.stat().st_size
    if size < MIN_MODEL_BYTES:
        raise RuntimeError(f"{label} model at {path} is only {size} bytes - truncated download or git-lfs pointer?")
    return path


def provider_preference(env_name: str = "LAMA_PROVIDER") -> str:
    value = os.environ.get(env_name, "auto").strip().lower()
    return value if value in {"auto", "dml", "cpu"} else "auto"


def provider_chain(preference: str = "auto") -> list[Any]:
    """Ordered provider list: DirectML first when allowed and installed, CPU always last."""
    available = ort.get_available_providers()
    chain: list[Any] = []
    if preference != "cpu":
        if DML in available:
            chain.append((DML, {"device_id": int(os.environ.get("LAMA_DML_DEVICE", "0") or 0)}))
        elif preference == "dml":
            logger.warning("DirectML requested but not available (providers: %s); using CPU. "
                           "Install onnxruntime-directml (Windows) instead of onnxruntime.", available)
    chain.append(CPU)
    return chain


def make_options(*, dml: bool, threads: int) -> ort.SessionOptions:
    options = ort.SessionOptions()
    options.log_severity_level = 3                       # silence harmless "unused initializer" warnings
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    if dml:
        # DirectML requirements: no memory-pattern planning, sequential execution.
        options.enable_mem_pattern = False
        options.enable_cpu_mem_arena = False
    else:
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = threads
        options.enable_cpu_mem_arena = True
        options.enable_mem_pattern = True
        # Idle ORT workers busy-wait by default; on a shared/throttled CPU that burns the quota.
        options.add_session_config_entry("session.intra_op.allow_spinning", "1" if threads >= 4 else "0")
        options.add_session_config_entry("session.set_denormal_as_zero", "1")
    return options


def build_session(path: Path, *, label: str, preference: str = "auto", threads: int | None = None) -> tuple[ort.InferenceSession, str]:
    """Create an InferenceSession; returns (session, active provider name). Never raises for GPU problems."""
    threads = threads or effective_cpu_count()
    chain = provider_chain(preference)
    if len(chain) > 1:
        try:
            session = ort.InferenceSession(str(path), sess_options=make_options(dml=True, threads=threads), providers=chain)
            active = session.get_providers()[0]
            logger.debug("%s: session ready on %s", label, active)
            return session, active
        except Exception:
            logger.exception("%s: DirectML session failed to initialise; falling back to CPU", label)
    session = ort.InferenceSession(str(path), sess_options=make_options(dml=False, threads=threads), providers=[CPU])
    logger.debug("%s: session ready on %s (%d threads)", label, CPU, threads)
    return session, CPU
