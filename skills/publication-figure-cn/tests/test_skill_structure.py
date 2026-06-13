"""Structural tests: SKILL.md frontmatter, files exist, line counts, rc parses."""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

REFERENCES = [
    "references/chinese-journal-conventions.md",
    "references/three-line-table.md",
    "references/colorblind-bw.md",
    "references/figure-types.md",
    "references/common-mistakes.md",
]
TEMPLATES_PY = [
    "templates/line_chart.py",
    "templates/bar_chart.py",
    "templates/coefficient_plot.py",
    "templates/scatter_with_fit.py",
    "templates/box_plot.py",
    "templates/heatmap.py",
]
TEMPLATES_OTHER = [
    "templates/matplotlibrc",
    "templates/three_line_table_latex.tex",
]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _line_count(path: str) -> int:
    return len(_read(path).splitlines())


# ---------- frontmatter ----------

def test_skill_md_exists_and_frontmatter_valid():
    text = _read("SKILL.md")
    assert text.startswith("---\n"), "SKILL.md must start with frontmatter ---"
    end = text.find("\n---\n", 4)
    assert end > 0, "SKILL.md frontmatter must close with ---"
    fm = text[4:end]
    required = ["name:", "description:", "tags:", "version:", "author:", "license:"]
    for key in required:
        assert key in fm, f"frontmatter missing {key!r}"
    # name must match
    assert re.search(r"^name:\s*publication-figure-cn\s*$", fm, re.M)
    # tags is a list-like
    assert "[" in fm and "]" in fm


def test_top_level_files_exist():
    for f in ["SKILL.md", "README.md", "LICENSE", "NOTICE"]:
        assert (ROOT / f).is_file(), f"missing {f}"


# ---------- references ----------

@pytest.mark.parametrize("path", REFERENCES)
def test_reference_exists_and_long_enough(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 30, f"{path} has only {n} lines (must be > 30)"


# ---------- templates ----------

@pytest.mark.parametrize("path", TEMPLATES_PY)
def test_template_py_exists_and_long_enough(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 30, f"{path} has only {n} lines (must be > 30)"
    assert n < 80, f"{path} has {n} lines (spec says < 80)"


@pytest.mark.parametrize("path", TEMPLATES_OTHER)
def test_template_other_exists_and_long_enough(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 30, f"{path} has only {n} lines (must be > 30)"


def test_matplotlibrc_parses():
    """rc file is plain key:value with optional whitespace; ignore comments and blanks."""
    text = _read("templates/matplotlibrc")
    pairs = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # strip trailing comment
        if "#" in line:
            line = line.split("#", 1)[0].strip()
        # matplotlib accepts both 'key : value' and 'key: value'
        m = re.match(r"^([A-Za-z0-9_.\-]+)\s*[:=]\s*(.+)$", line)
        assert m, f"unparseable rc line: {raw!r}"
        pairs += 1
    assert pairs >= 10, f"matplotlibrc has too few settings: {pairs}"


def test_three_line_table_latex_has_booktabs_rules():
    text = _read("templates/three_line_table_latex.tex")
    for cmd in [r"\toprule", r"\midrule", r"\bottomrule"]:
        assert cmd in text, f"missing {cmd}"
    assert r"\usepackage{booktabs}" in text
    assert r"\usepackage{threeparttable}" in text
    # no vertical rules in tabular spec
    assert "tabular}{|" not in text, "three-line table must not use vertical rules"


# ---------- license / notice ----------

def test_license_is_apache():
    text = _read("LICENSE")
    assert "Apache License" in text
    assert "Version 2.0" in text


def test_notice_present():
    text = _read("NOTICE")
    assert "publication-figure-cn" in text
    assert "Research-Claw" in text
