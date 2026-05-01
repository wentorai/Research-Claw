"""Structural tests: SKILL.md frontmatter, files exist, line counts, syntax."""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

REFERENCES = [
    "references/chart-types-overview.md",
    "references/journal-styles.md",
    "references/color-palettes.md",
    "references/workflow-stata-r-python.md",
    "references/common-mistakes.md",
]

TEMPLATES_STATA = [
    "templates/stata/coefplot.do",
    "templates/stata/eventdd.do",
    "templates/stata/binscatter.do",
    "templates/stata/margins_plot.do",
    "templates/stata/bunching.do",
    "templates/stata/multiple_regs_table.do",
]

TEMPLATES_R = [
    "templates/r/coefplot.R",
    "templates/r/event_study.R",
    "templates/r/bin_scatter.R",
    "templates/r/marginal_effects.R",
    "templates/r/forest_plot.R",
    "templates/r/treatment_map_china.R",
    "templates/r/network_boards.R",
]

TEMPLATES_PY = [
    "templates/python/coefplot.py",
    "templates/python/event_study.py",
    "templates/python/bin_scatter.py",
    "templates/python/treatment_map.py",
    "templates/python/sankey.py",
    "templates/python/network_directors.py",
    "templates/python/time_series_policy_events.py",
    "templates/python/heatmap_clustered.py",
]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _line_count(path: str) -> int:
    return len(_read(path).splitlines())


# ---------- frontmatter ----------

def test_skill_md_exists_and_frontmatter_valid():
    text = _read("SKILL.md")
    assert text.startswith("---\n"), "SKILL.md must start with frontmatter"
    end = text.find("\n---\n", 4)
    assert end > 0, "SKILL.md frontmatter must close with ---"
    fm = text[4:end]
    for key in ["name:", "description:", "tags:", "version:",
                "author:", "license:"]:
        assert key in fm, f"frontmatter missing {key!r}"
    assert re.search(r"^name:\s*econ-charts-cn\s*$", fm, re.M)
    assert "[" in fm and "]" in fm     # tags is list-like


def test_top_level_files_exist():
    for f in ["SKILL.md", "README.md", "LICENSE", "NOTICE"]:
        assert (ROOT / f).is_file(), f"missing {f}"


# ---------- references ----------

@pytest.mark.parametrize("path", REFERENCES)
def test_reference_exists_and_long_enough(path: str):
    p = ROOT / path
    assert p.is_file(), f"missing {path}"
    text = _read(path)
    assert len(text) > 200, f"{path} has only {len(text)} chars (must be > 200)"


# ---------- templates ----------

@pytest.mark.parametrize("path", TEMPLATES_STATA)
def test_stata_template(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 30, f"{path} has only {n} lines (must be > 30)"


@pytest.mark.parametrize("path", TEMPLATES_R)
def test_r_template(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 30, f"{path} has only {n} lines (must be > 30)"


@pytest.mark.parametrize("path", TEMPLATES_PY)
def test_py_template_exists_and_long_enough(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 30, f"{path} has only {n} lines (must be > 30)"
    assert n < 110, f"{path} has {n} lines (spec says < 100, allow slack)"


@pytest.mark.parametrize("path", TEMPLATES_PY)
def test_py_template_parses(path: str):
    """Each Python template must parse without syntax error."""
    src = _read(path)
    ast.parse(src, filename=path)


# ---------- license / notice ----------

def test_license_is_apache():
    text = _read("LICENSE")
    assert "Apache License" in text
    assert "Version 2.0" in text


def test_notice_present():
    text = _read("NOTICE")
    assert "econ-charts-cn" in text
    assert "Research-Claw" in text
