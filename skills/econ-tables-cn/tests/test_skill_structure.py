"""Structural tests: SKILL.md frontmatter, files exist, line counts, LICENSE/NOTICE."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

REFERENCES = [
    "references/table-anatomy.md",
    "references/se-types.md",
    "references/significance-conventions.md",
    "references/journal-formats.md",
    "references/multi-column-design.md",
    "references/common-mistakes.md",
]
# Required core templates per the deliverable spec. Linter / hooks may add
# additional standardized stubs alongside these — those are tolerated.
TEMPLATES_STATA = [
    "templates/stata/basic_estout.do",
    "templates/stata/multi_model.do",
    "templates/stata/clustered_se.do",
    "templates/stata/ife_2way.do",
    "templates/stata/did_table.do",
    "templates/stata/iv_2sls_table.do",
    "templates/stata/descriptive_stats.do",
]
TEMPLATES_R = [
    "templates/r/basic_modelsummary.R",
    "templates/r/multi_model.R",
    "templates/r/clustered_se.R",
    "templates/r/fixest_table.R",
    "templates/r/did_modelsummary.R",
    "templates/r/descriptive_skim.R",
]
TEMPLATES_PY = [
    "templates/python/basic_stargazer.py",
    "templates/python/multi_model.py",
    "templates/python/linearmodels_table.py",
    "templates/python/doubleml_table.py",
    "templates/python/descriptive_pandas.py",
]
ALL_TEMPLATES = TEMPLATES_STATA + TEMPLATES_R + TEMPLATES_PY


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
    assert re.search(r"^name:\s*econ-tables-cn\s*$", fm, re.M)
    assert "[" in fm and "]" in fm  # tags list


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

@pytest.mark.parametrize("path", ALL_TEMPLATES)
def test_template_exists_and_long_enough(path: str):
    assert (ROOT / path).is_file(), f"missing {path}"
    n = _line_count(path)
    assert n > 20, f"{path} has only {n} lines (must be > 20)"


# ---------- license / notice ----------

def test_license_is_apache():
    text = _read("LICENSE")
    assert "Apache License" in text
    assert "Version 2.0" in text


def test_notice_present():
    text = _read("NOTICE")
    assert "econ-tables-cn" in text
    assert "Research-Claw" in text


# ---------- references content checks ----------

def test_journal_formats_has_four_journals():
    """journal-formats.md must reference all 4 target journals."""
    text = _read("references/journal-formats.md")
    for kw in ["经济研究", "管理世界", "Journal of Finance", "Management Science"]:
        assert kw in text, f"journal-formats.md missing keyword {kw!r}"


def test_se_types_covers_clustered_and_dk():
    """se-types.md must cover the main SE families used in econ/finance."""
    text = _read("references/se-types.md").lower()
    for kw in ["robust", "cluster", "driscoll-kraay", "newey-west", "two-way"]:
        assert kw in text, f"se-types.md missing {kw!r}"


def test_significance_conventions_has_three_tier():
    """significance conventions doc must define the 3-tier *, **, *** system."""
    text = _read("references/significance-conventions.md")
    for kw in ["0.10", "0.05", "0.01"]:
        assert kw in text, f"significance-conventions.md missing {kw!r}"
    assert "***" in text and "**" in text and "*" in text


def test_skill_md_mentions_three_languages_and_four_journals():
    text = _read("SKILL.md")
    for kw in ["Stata", "R", "Python", "estout", "modelsummary", "stargazer"]:
        assert kw in text, f"SKILL.md missing {kw!r}"
    for kw in ["经济研究", "管理世界", "Journal of Finance", "Management Science"]:
        assert kw in text, f"SKILL.md missing journal {kw!r}"
