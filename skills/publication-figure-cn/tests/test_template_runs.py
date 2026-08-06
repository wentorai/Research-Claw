"""Run a subset of matplotlib templates as subprocesses; verify exit 0 + PDF generated.

Skipped wholesale via conftest.py if matplotlib is not installed.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates"


def _run_template(template_name: str) -> Path:
    """Copy the template to a tmp dir, run it, return the produced PDF path."""
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
        # copy out (so we keep something? not required) — return path is just a sanity value
        return pdf


def test_line_chart_runs():
    _run_template("line_chart.py")


def test_coefficient_plot_runs():
    _run_template("coefficient_plot.py")


def test_heatmap_runs():
    _run_template("heatmap.py")
