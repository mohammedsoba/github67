"""Concurrency slots that are released only when the worker thread has REALLY finished.

Why: a Python thread cannot be cancelled. The old code did

    async with semaphore:
        await run_in_threadpool(job)

and wrapped it in asyncio.wait_for(...). On a timeout (or a client disconnect that cancels the request)
the ``async with`` released the slot while the thread kept running, so timed-out jobs piled up beyond the
configured concurrency limit (memory / CPU exhaustion under load).

``run_in_owned_slot`` takes over a slot the caller already acquired and hands it back from the thread's
completion callback instead, no matter whether anybody is still waiting for the result.
"""
from __future__ import annotations

import asyncio
import functools
from typing import Any, Callable


async def run_in_owned_slot(slots: asyncio.Semaphore, func: Callable[..., Any], *args: Any) -> Any:
    """Run ``func(*args)`` in the default thread pool; the caller MUST already hold one slot of ``slots``.

    * The slot is released exactly once, when the thread finishes (success, error or after the awaiting
      request was cancelled / timed out).
    * Cancelling the awaiting coroutine (wait_for timeout, client disconnect) does not cancel the thread
      (it cannot be cancelled) and does not release the slot early.
    """
    loop = asyncio.get_running_loop()
    try:
        future = loop.run_in_executor(None, functools.partial(func, *args))
    except BaseException:
        slots.release()          # the job never started: give the slot back right away
        raise

    def _thread_finished(done: "asyncio.Future[Any]") -> None:
        slots.release()
        if not done.cancelled():
            done.exception()     # mark as retrieved: nobody may be awaiting it any more

    future.add_done_callback(_thread_finished)
    # shield(): cancelling the caller must not cancel the future that owns the slot
    return await asyncio.shield(future)
