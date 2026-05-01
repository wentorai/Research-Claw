"""Structural tests for grant-application-cn skill."""
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent

REFERENCES = [
    "grant-types-china.md",
    "grant-types-international.md",
    "nssf-guide.md",
    "moe-humanities.md",
    "nih-r01.md",
    "nsf-broader-impacts.md",
    "erc-cv-and-track-record.md",
    "budget-international.md",
]

PROMPTS = [
    "proposal-outline.md",
    "significance.md",
    "innovation.md",
    "approach.md",
    "pi-bio.md",
    "timeline-budget.md",
]


def test_skill_md_frontmatter_valid():
    skill = ROOT / "SKILL.md"
    assert skill.exists(), "SKILL.md missing"
    text = skill.read_text(encoding="utf-8")
    assert text.startswith("---"), "SKILL.md must start with YAML frontmatter"
    fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    assert fm_match, "SKILL.md frontmatter not closed"
    fm = fm_match.group(1)
    assert re.search(r"^name:\s*grant-application-cn\s*$", fm, re.MULTILINE), \
        "frontmatter must declare name: grant-application-cn"
    assert re.search(r"^description:\s*\S+", fm, re.MULTILINE), \
        "frontmatter must declare a non-empty description"
    assert re.search(r"^version:\s*\S+", fm, re.MULTILINE), \
        "frontmatter must declare version"
    assert re.search(r"^license:\s*Apache-2\.0", fm, re.MULTILINE), \
        "frontmatter must declare Apache-2.0 license"


def test_all_reference_files_exist():
    missing = []
    for fname in REFERENCES:
        p = ROOT / "references" / fname
        if not p.exists():
            missing.append(str(p))
    assert not missing, f"Missing reference files: {missing}"


def test_all_prompt_files_exist():
    missing = []
    for fname in PROMPTS:
        p = ROOT / "prompts" / fname
        if not p.exists():
            missing.append(str(p))
    assert not missing, f"Missing prompt files: {missing}"


def test_each_md_has_minimum_content():
    """Each markdown in references/ and prompts/ must exceed 200 chars."""
    too_short = []
    for sub, files in (("references", REFERENCES), ("prompts", PROMPTS)):
        for fname in files:
            p = ROOT / sub / fname
            text = p.read_text(encoding="utf-8")
            if len(text) <= 200:
                too_short.append((str(p), len(text)))
    assert not too_short, f"Files <= 200 chars: {too_short}"


def test_nih_section_has_key_terms():
    p = ROOT / "references" / "nih-r01.md"
    text = p.read_text(encoding="utf-8").lower()
    for kw in ("specific aims", "significance", "innovation", "approach"):
        assert kw in text, f"nih-r01.md missing key term: {kw!r}"


def test_nsf_section_has_key_terms():
    p = ROOT / "references" / "nsf-broader-impacts.md"
    text = p.read_text(encoding="utf-8").lower()
    for kw in ("broader impacts", "intellectual merit"):
        assert kw in text, f"nsf-broader-impacts.md missing key term: {kw!r}"


def test_erc_section_has_key_terms():
    p = ROOT / "references" / "erc-cv-and-track-record.md"
    text = p.read_text(encoding="utf-8").lower()
    for kw in ("track record", "cv", "ground-breaking"):
        assert kw in text, f"erc-cv-and-track-record.md missing key term: {kw!r}"


def test_china_grants_section_has_key_terms():
    p = ROOT / "references" / "grant-types-china.md"
    text = p.read_text(encoding="utf-8")
    for kw in ("国家社科基金", "教育部", "博士后", "省"):
        assert kw in text, f"grant-types-china.md missing key term: {kw!r}"


def test_budget_international_has_key_terms():
    p = ROOT / "references" / "budget-international.md"
    text = p.read_text(encoding="utf-8").lower()
    for kw in ("direct cost", "indirect cost", "overhead", "nicra"):
        assert kw in text, f"budget-international.md missing key term: {kw!r}"


def test_license_is_apache():
    lic = ROOT / "LICENSE"
    assert lic.exists(), "LICENSE missing"
    text = lic.read_text(encoding="utf-8")
    assert "Apache License" in text, "LICENSE not Apache"
    assert "Version 2.0" in text, "LICENSE not Apache 2.0"


def test_notice_present_and_attributes_sources():
    notice = ROOT / "NOTICE"
    assert notice.exists(), "NOTICE missing"
    text = notice.read_text(encoding="utf-8")
    assert "grant-application-cn" in text, "NOTICE missing skill name"
    assert "Independently developed" in text or "No source code" in text, \
        "NOTICE should clarify no copying"
    for kw in ("NIH", "NSF", "ERC"):
        assert kw in text, f"NOTICE should attribute {kw} as a source"


def test_readme_exists():
    p = ROOT / "README.md"
    assert p.exists(), "README.md missing"
    text = p.read_text(encoding="utf-8")
    assert "grant-application-cn" in text, "README missing skill name"
