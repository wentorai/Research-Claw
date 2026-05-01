"""Structural tests for causal-inference-cn skill."""
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
METHODS = ["did", "rdd", "iv", "sc", "psm"]
LANGS = ["overview.md", "stata.md", "r.md", "python.md"]
CASES = ["cn-context.md", "policy-evaluation.md", "robustness-checklist.md"]


def test_skill_md_exists_with_frontmatter():
    skill = ROOT / "SKILL.md"
    assert skill.exists(), "SKILL.md missing"
    text = skill.read_text(encoding="utf-8")
    assert text.startswith("---"), "SKILL.md must start with YAML frontmatter"
    # frontmatter must contain name and description
    fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    assert fm_match, "SKILL.md frontmatter not closed"
    fm = fm_match.group(1)
    assert re.search(r"^name:\s*causal-inference-cn", fm, re.MULTILINE), \
        "frontmatter must declare name: causal-inference-cn"
    assert re.search(r"^description:\s*\S+", fm, re.MULTILINE), \
        "frontmatter must declare description"


def test_all_method_files_exist():
    missing = []
    for m in METHODS:
        for lang in LANGS:
            p = ROOT / "methods" / m / lang
            if not p.exists():
                missing.append(str(p))
    assert not missing, f"Missing method files: {missing}"


def test_all_case_files_exist():
    for c in CASES:
        p = ROOT / "cases" / c
        assert p.exists(), f"Missing case file: {p}"


def test_each_md_has_minimum_content():
    """Every method/*.md should have at least 400 chars of substantive content."""
    too_short = []
    for m in METHODS:
        for lang in LANGS:
            p = ROOT / "methods" / m / lang
            text = p.read_text(encoding="utf-8")
            if len(text) < 400:
                too_short.append((str(p), len(text)))
    assert not too_short, f"Files too short: {too_short}"


def test_code_blocks_have_language_tag():
    """Each stata/r/python.md should contain at least one fenced code block with language tag."""
    missing_fence = []
    expected_tags = {
        "stata.md": ["stata"],
        "r.md": ["r"],
        "python.md": ["python"],
    }
    for m in METHODS:
        for lang_file, tags in expected_tags.items():
            p = ROOT / "methods" / m / lang_file
            text = p.read_text(encoding="utf-8").lower()
            if not any(f"```{t}" in text for t in tags):
                missing_fence.append(str(p))
    assert not missing_fence, f"Missing language-tagged code fences in: {missing_fence}"


def test_license_is_apache():
    lic = ROOT / "LICENSE"
    assert lic.exists(), "LICENSE missing"
    text = lic.read_text(encoding="utf-8")
    assert "Apache License" in text, "LICENSE not Apache"
    assert "Version 2.0" in text, "LICENSE not Apache 2.0"


def test_notice_has_attribution():
    notice = ROOT / "NOTICE"
    assert notice.exists(), "NOTICE missing"
    text = notice.read_text(encoding="utf-8")
    assert "causal-inference-mixtape" in text, "NOTICE missing upstream attribution"
    assert "Mixtape" in text or "mixtape" in text, "NOTICE missing textbook attribution"
    assert "No source code" in text or "Independently" in text, \
        "NOTICE should clarify no copying"
