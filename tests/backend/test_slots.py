"""R21: a concurrency slot is released only when the worker thread has really finished."""
import asyncio
import importlib.util
import pathlib
import threading
import time

_spec = importlib.util.spec_from_file_location("slots", pathlib.Path(__file__).parents[2] / "backend" / "app" / "slots.py")
slots_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(slots_mod)
run_in_owned_slot = slots_mod.run_in_owned_slot


def test_slot_released_after_normal_completion():
    async def main():
        sem = asyncio.Semaphore(1)
        await sem.acquire()
        assert await run_in_owned_slot(sem, lambda a, b: a + b, 2, 3) == 5
        await asyncio.sleep(0.05)
        assert not sem.locked()
    asyncio.run(main())


def test_slot_released_after_worker_error():
    async def main():
        sem = asyncio.Semaphore(1)
        await sem.acquire()

        def boom():
            raise ValueError("bad input")

        try:
            await run_in_owned_slot(sem, boom)
            raise AssertionError("expected ValueError")
        except ValueError:
            pass
        await asyncio.sleep(0.05)
        assert not sem.locked()
    asyncio.run(main())


def test_timeout_does_not_free_the_slot_until_the_thread_ends():
    async def main():
        sem = asyncio.Semaphore(1)
        gate = threading.Event()
        started = threading.Event()

        def slow():
            started.set()
            gate.wait(5)
            return "late"

        await sem.acquire()
        try:
            await asyncio.wait_for(run_in_owned_slot(sem, slow), timeout=0.15)
            raise AssertionError("expected a timeout")
        except asyncio.TimeoutError:
            pass
        assert started.is_set()
        # the request timed out, but the thread is still running -> slot must still be taken
        assert sem.locked(), "slot leaked: released while the worker thread was still running"
        # a second job must NOT be able to start yet
        got = False
        try:
            await asyncio.wait_for(sem.acquire(), timeout=0.1)
            got = True
        except asyncio.TimeoutError:
            pass
        assert not got
        gate.set()                                   # thread finishes
        await asyncio.wait_for(sem.acquire(), timeout=2)   # now the slot comes back
        sem.release()
    asyncio.run(main())


def test_never_more_than_limit_run_at_once_even_with_timeouts():
    async def main():
        limit = 2
        sem = asyncio.Semaphore(limit)
        running = 0
        peak = 0
        lock = threading.Lock()

        def work():
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.2)
            with lock:
                running -= 1

        async def job():
            await sem.acquire()
            return await run_in_owned_slot(sem, work)

        results = await asyncio.gather(
            *[asyncio.wait_for(job(), timeout=0.05) for _ in range(6)], return_exceptions=True)
        await asyncio.sleep(1.5)                     # let every started thread finish
        assert peak <= limit, f"peak concurrency {peak} exceeded limit {limit}"
        assert not sem.locked()
        assert any(isinstance(r, asyncio.TimeoutError) for r in results)
    asyncio.run(main())
