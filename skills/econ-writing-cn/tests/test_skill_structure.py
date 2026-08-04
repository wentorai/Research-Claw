"""Structural tests for the econ-writing-cn Skill.

Validates that the skill is well-formed:
  1. SKILL.md exists with valid YAML frontmatter (name, description)
  2. All required reference and prompt files exist
  3. Each markdown file is > 200 chars (sanity, not empty/stub)
  4. LICENSE contains "Apache License"
  5. NOTICE contains attribution to the inspiring project
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

REQUIRED_REFERENCES = [
    "references/journals.md",
    "references/citation-gbt7714.md",
    "references/abstract-templates.md",
    "references/identification-strategies.md",
    "references/common-mistakes.md",
]

REQUIRED_PROMPTS = [
    "prompts/outline.md",
    "prompts/intro.md",
    "prompts/results.md",
    "prompts/referee-response.md",
]

REQUIRED_TOP_LEVEL = [
    "SKILL.md",
    "LICENSE",
    "NOTICE",
    "README.md",
]

ALL_MARKDOWN = REQUIRED_REFERENCES + REQUIRED_PROMPTS + ["SKILL.md", "README.md"]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_top_level_files_exist() -> None:
    for rel in REQUIRED_TOP_LEVEL:
        p = ROOT / rel
        assert p.exists(), f"missing top-level file: {rel}"
        assert p.is_file(), f"not a file: {rel}"


def test_required_references_exist() -> None:
    for rel in REQUIRED_REFERENCES:
        p = ROOT / rel
        assert p.exists(), f"missing reference file: {rel}"


def test_required_prompts_exist() -> None:
    for rel in REQUIRED_PROMPTS:
        p = ROOT / rel
        assert p.exists(), f"missing prompt file: {rel}"


def test_skill_md_has_frontmatter() -> None:
    skill = _read(ROOT / "SKILL.md")
    # Must start with --- frontmatter delimiter
    assert skill.startswith("---\n"), "SKILL.md must start with YAML frontmatter '---'"
    # Find closing delimiter
    m = re.match(r"^---\n(.*?)\n---\n", skill, flags=re.DOTALL)
    assert m, "SKILL.md missing closing '---' for frontmatter"
    fm = m.group(1)
    # Required fields
    assert re.search(r"^name:\s*\S+", fm, flags=re.MULTILINE), "frontmatter missing 'name'"
    assert re.search(r"^description:\s*\S+", fm, flags=re.MULTILINE), "frontmatter missing 'description'"
    # name must equal 'econ-writing-cn'
    name_m = re.search(r"^name:\s*(\S+)", fm, flags=re.MULTILINE)
    assert name_m and name_m.group(1) == "econ-writing-cn", "frontmatter 'name' must be 'econ-writing-cn'"


@pytest.mark.parametrize("rel", ALL_MARKDOWN)
def test_markdown_file_word_count_sanity(rel: str) -> None:
    p = ROOT / rel
    content = _read(p)
    assert len(content) > 200, f"{rel} too short ({len(content)} chars), looks empty/stub"


def test_license_is_apache() -> None:
    txt = _read(ROOT / "LICENSE")
    assert "Apache License" in txt, "LICENSE must contain 'Apache License'"
    assert "Version 2.0" in txt, "LICENSE must reference Version 2.0"


def test_notice_has_attribution() -> None:
    txt = _read(ROOT / "NOTICE")
    assert "hanlulong/econ-writing-skill" in txt, "NOTICE must attribute hanlulong/econ-writing-skill"
    assert "independently" in txt.lower() or "from scratch" in txt.lower(), (
        "NOTICE should clarify that this work was developed independently / from scratch"
    )
