#!/usr/bin/env python3
"""Mutation check for the golden pipeline tests (Definition of Done: 'altering one pixel in lama.py must fail').

Patches backend/app/lama.py in place (a backup is restored in `finally`, even on Ctrl+C), runs the golden
erase tests with REQUIRE_GOLDEN=1 and demands that they FAIL. Two mutants:
  far_pixel   - flips 1 LSB of pixel (0,0), far away from every hole (output-integrity check + hash)
  hole_pixel  - flips 1 LSB of ONE pixel inside the repaired hole (only the golden hash can see this)
Exit 0 = every mutant was caught. Exit 1 = a mutant survived (the safety net has a hole).

    python scripts/mutation_check.py            # uses `python -m pytest`; override with MUTATION_TEST_CMD
"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "backend" / "app" / "lama.py"
ANCHOR = "        self._blend(image, patch, crop_mask, ct, cl, grow)\n"
MUTANTS = {
    "far_pixel": ANCHOR + "        image[0, 0, 0] ^= 1  # MUTANT\n",
    "hole_pixel": ANCHOR + "        image[235, 320, 0] ^= 1  # MUTANT\n",
}


def run_tests() -> subprocess.CompletedProcess:
    cmd = shlex.split(os.environ.get("MUTATION_TEST_CMD", "")) or [
        sys.executable, "-m", "pytest", "tests/backend/test_pipeline_golden.py", "-k", "erase", "-q", "-x", "-p", "no:cacheprovider"]
    env = {**os.environ, "REQUIRE_GOLDEN": "1"}
    env.pop("UPDATE_GOLDEN", None)                       # a mutant must never be 'accepted' as the new golden
    return subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)


def main() -> int:
    original = TARGET.read_text(encoding="utf-8")
    if ANCHOR not in original or "# MUTANT" in original:
        print("mutation anchor not found (or file already mutated) - update scripts/mutation_check.py", file=sys.stderr)
        return 2
    backup = TARGET.with_suffix(".py.mutbak")
    shutil.copy2(TARGET, backup)
    survived = []
    try:
        base = run_tests()
        if base.returncode != 0:
            print("baseline (unmutated) tests FAIL - fix them before mutation checking:\n" + base.stdout[-2000:] + base.stderr[-1000:])
            return 2
        for name, patch in MUTANTS.items():
            TARGET.write_text(original.replace(ANCHOR, patch, 1), encoding="utf-8")
            result = run_tests()
            caught = result.returncode != 0
            print(f"mutant {name:<11} -> {'CAUGHT' if caught else 'SURVIVED  <-- safety net failed'}")
            if not caught:
                survived.append(name)
    finally:
        shutil.copy2(backup, TARGET)
        backup.unlink(missing_ok=True)
    assert TARGET.read_text(encoding="utf-8") == original, "lama.py was not restored!"
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
