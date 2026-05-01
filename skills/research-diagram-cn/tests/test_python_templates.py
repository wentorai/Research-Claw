"""Run each python template in a temp dir and verify it produces output."""
from __future__ import annotations
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PY_DIR = ROOT / "templates" / "python"

# (filename, expected output filenames)
CASES = [
    ("causal_dag_dagitty.py",     ["causal_dag.pdf", "causal_dag.png"]),
    ("prisma_flow_matplotlib.py", ["prisma_flow.pdf", "prisma_flow.png"]),
    ("hypothesis_tree.py",        ["hypothesis_tree.pdf", "hypothesis_tree.png"]),
    ("graphml_export.py",         ["coauthor_network.graphml", "coauthor_preview.png"]),
]


def _missing_dep() -> str | None:
    try:
        import networkx  # noqa: F401
        import matplotlib  # noqa: F401
    except ImportError as exc:
        return str(exc)
    return None


@pytest.mark.parametrize("py_name,outputs", CASES)
def test_template_runs(py_name: str, outputs: list[str], tmp_path: Path) -> None:
    miss = _missing_dep()
    if miss:
        pytest.skip(f"missing dep: {miss}")
    src = PY_DIR / py_name
    assert src.exists(), f"missing template {py_name}"
    dst = tmp_path / py_name
    shutil.copyfile(src, dst)
    proc = subprocess.run(
        [sys.executable, str(dst)],
        cwd=tmp_path,
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, (
        f"{py_name} failed (rc={proc.returncode}):\n"
        f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    for out in outputs:
        produced = tmp_path / out
        assert produced.exists() and produced.stat().st_size > 0, (
            f"{py_name} did not produce non-empty {out}"
        )
