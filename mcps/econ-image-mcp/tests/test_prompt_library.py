"""Prompt template library: catalogue + parameter substitution."""

from __future__ import annotations

import pytest

from econ_image_mcp.exceptions import TemplateNotFoundError, TemplateParameterError
from econ_image_mcp.models import TemplateInfo
from econ_image_mcp.prompts import (
    TEMPLATES,
    fill_template,
    get_template,
    list_template_infos,
)

REQUIRED_KEYS = {"title", "category", "template", "params", "example"}


def test_at_least_ten_templates() -> None:
    assert len(TEMPLATES) >= 10, "spec requires 10+ templates"


def test_every_template_has_required_keys() -> None:
    for tid, tpl in TEMPLATES.items():
        missing = REQUIRED_KEYS - set(tpl)
        assert not missing, f"template {tid!r} missing keys: {missing}"
        assert isinstance(tpl["params"], list)
        assert tpl["title"]
        assert tpl["template"]


def test_required_econ_scenarios_present() -> None:
    """Spec calls out specific scenarios — make sure each is in the library."""

    must_have = {
        "policy-mechanism",
        "game-theory-payoff",
        "concept-illustration",
        "graphical-abstract",
        "poster-background",
        "policy-brief-cover",
    }
    assert must_have.issubset(TEMPLATES.keys())


def test_template_categories_well_formed() -> None:
    valid = {
        "mechanism",
        "game",
        "concept",
        "graphical-abstract",
        "poster",
        "policy-brief",
    }
    for tid, tpl in TEMPLATES.items():
        assert tpl["category"] in valid, f"{tid!r} has unknown category {tpl['category']!r}"


def test_template_placeholders_match_params() -> None:
    """Every {PARAM} in the template literal must be in the declared params list,
    and vice versa."""

    import re

    placeholder_re = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
    for tid, tpl in TEMPLATES.items():
        placeholders = set(placeholder_re.findall(tpl["template"]))
        declared = set(tpl["params"])
        assert placeholders == declared, (
            f"template {tid!r}: placeholders={placeholders} declared={declared}"
        )


def test_get_template_unknown_raises() -> None:
    with pytest.raises(TemplateNotFoundError):
        get_template("does-not-exist")


def test_fill_template_substitutes_params() -> None:
    out = fill_template(
        "policy-mechanism",
        {
            "POLICY": "央行降准",
            "CHANNEL": "银行间流动性",
            "OUTCOME": "企业信贷成本下降",
            "labels": "降准 -> 流动性 -> 信贷成本",
        },
    )
    assert "央行降准" in out
    assert "银行间流动性" in out
    assert "企业信贷成本下降" in out
    assert "降准 -> 流动性 -> 信贷成本" in out
    # No raw placeholder should leak through.
    assert "{POLICY}" not in out


def test_fill_template_missing_param_raises() -> None:
    with pytest.raises(TemplateParameterError) as exc:
        fill_template(
            "policy-mechanism",
            {"POLICY": "X", "CHANNEL": "Y"},  # missing OUTCOME, labels
        )
    msg = str(exc.value)
    assert "OUTCOME" in msg
    assert "labels" in msg


def test_fill_template_extra_params_ignored() -> None:
    """Extra keys are forgiving — useful for callers passing in a superset."""

    out = fill_template(
        "concept-illustration",
        {
            "CONCEPT": "网络效应",
            "ANNOTATION": "用户翻倍, 价值四倍",
            "extra_unused": "ignored",
        },
    )
    assert "网络效应" in out


def test_fill_template_unknown_id_raises() -> None:
    with pytest.raises(TemplateNotFoundError):
        fill_template("nope", {})


def test_list_template_infos_returns_pydantic_rows() -> None:
    rows = list_template_infos()
    assert len(rows) == len(TEMPLATES)
    assert all(isinstance(r, TemplateInfo) for r in rows)
    ids = {r.id for r in rows}
    assert ids == set(TEMPLATES.keys())


def test_list_template_infos_sorted_by_id() -> None:
    rows = list_template_infos()
    assert [r.id for r in rows] == sorted(TEMPLATES.keys())
