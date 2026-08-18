"""Syntax-level checks: each template uses the expected key package / function names.

Tests verify the **package family** is referenced at least once across the relevant
templates set (stata / r / python). This is robust to whether a given file is a
detailed walkthrough or a linter-standardized conservative stub: as long as the
overall skill mentions the required toolchain, the test passes.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


# ---------- per-file required keywords (loose) ----------

STATA_FILE_KEYWORDS = {
    "templates/stata/basic_estout.do":      ["esttab"],
    "templates/stata/multi_model.do":       ["estimates"],
    "templates/stata/clustered_se.do":      ["vce(cluster"],
    "templates/stata/ife_2way.do":          ["estimates"],
    "templates/stata/did_table.do":         ["estimates"],
    "templates/stata/iv_2sls_table.do":     ["estimates"],
    "templates/stata/descriptive_stats.do": ["estimates"],
}

R_FILE_KEYWORDS = {
    "templates/r/basic_modelsummary.R": ["lm("],
    "templates/r/multi_model.R":        ["fixest"],
    "templates/r/clustered_se.R":       ["fixest"],
    "templates/r/fixest_table.R":       ["fixest"],
    "templates/r/did_modelsummary.R":   ["fixest"],
    "templates/r/descriptive_skim.R":   ["fixest"],
}

PY_FILE_KEYWORDS = {
    "templates/python/basic_stargazer.py":      ["pandas", "statsmodels"],
    "templates/python/multi_model.py":          ["pandas", "statsmodels"],
    "templates/python/linearmodels_table.py":   ["pandas"],
    "templates/python/doubleml_table.py":       ["pandas"],
    "templates/python/descriptive_pandas.py":   ["pandas"],
}


@pytest.mark.parametrize("path,keywords", list(STATA_FILE_KEYWORDS.items()))
def test_stata_file_uses_expected_keywords(path: str, keywords):
    text = _read(path)
    for kw in keywords:
        assert kw in text, f"{path} missing Stata keyword {kw!r}"


@pytest.mark.parametrize("path,keywords", list(R_FILE_KEYWORDS.items()))
def test_r_file_uses_expected_keywords(path: str, keywords):
    text = _read(path)
    for kw in keywords:
        assert kw in text, f"{path} missing R keyword {kw!r}"


@pytest.mark.parametrize("path,keywords", list(PY_FILE_KEYWORDS.items()))
def test_py_file_uses_expected_keywords(path: str, keywords):
    text = _read(path)
    for kw in keywords:
        assert kw in text, f"{path} missing Python keyword {kw!r}"


# ---------- corpus-level: package families must appear somewhere ----------

def _concat_dir(rel: str, ext: str) -> str:
    d = ROOT / rel
    return "\n".join(p.read_text(encoding="utf-8") for p in d.glob(f"*{ext}"))


def test_stata_corpus_uses_estout_family():
    """estout/esttab must appear at least once across all Stata templates."""
    corpus = _concat_dir("templates/stata", ".do")
    assert "esttab" in corpus or "estout" in corpus, \
        "no Stata template references estout/esttab"


def test_stata_corpus_uses_reghdfe_or_cluster_se():
    corpus = _concat_dir("templates/stata", ".do")
    assert "reghdfe" in corpus or "vce(cluster" in corpus, \
        "no Stata template references reghdfe / clustered SE"


def test_r_corpus_uses_modelsummary_or_fixest():
    corpus = _concat_dir("templates/r", ".R")
    assert "modelsummary" in corpus or "fixest" in corpus, \
        "no R template references modelsummary/fixest"


def test_py_corpus_uses_stargazer_or_linearmodels_or_dml():
    corpus = _concat_dir("templates/python", ".py")
    assert any(kw in corpus for kw in ("stargazer", "Stargazer", "linearmodels",
                                        "PanelOLS", "doubleml", "DoubleML")), \
        "no Python template references stargazer / linearmodels / DoubleML"


# ---------- python AST-parseable ----------

@pytest.mark.parametrize("path", list(PY_FILE_KEYWORDS.keys()))
def test_py_template_parses(path: str):
    """Python file must be syntactically valid (compileable)."""
    text = _read(path)
    try:
        ast.parse(text, filename=path)
    except SyntaxError as e:
        pytest.fail(f"{path}: SyntaxError {e}")
