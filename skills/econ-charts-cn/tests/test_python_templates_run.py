"""Run a subset of Python templates as subprocesses; verify exit 0 + PDF.

Skipped wholesale via conftest.py if matplotlib is not installed.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates" / "python"


def _run_template(template_name: str) -> Path:
    src = TEMPLATES / template_name
    assert src.is_file(), f"template missing: {src}"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        dst = tmp_path / template_name
        dst.write_bytes(src.read_bytes())

        result = subprocess.run(
            [sys.executable, str(dst)],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, (
            f"{template_name} failed (exit {result.returncode}):\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )

        pdf = tmp_path / template_name.replace(".py", ".pdf")
        assert pdf.is_file(), f"expected {pdf.name} not created"
        assert pdf.stat().st_size > 0, f"{pdf.name} is empty"
        return pdf


def test_coefplot_runs():
    _run_template("coefplot.py")


def test_event_study_runs():
    _run_template("event_study.py")


def test_heatmap_clustered_runs():
    _run_template("heatmap_clustered.py")
