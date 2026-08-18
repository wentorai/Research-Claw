"""Structural tests for csmar-cleaning-cn skill."""
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent

REFERENCES = [
    "csmar-tables.md",
    "cleaning-rules.md",
    "winsorize-standard.md",
    "id-tracking.md",
    "industry-codes.md",
    "time-alignment.md",
    "pitfalls.md",
]

CODE_FILES = [
    Path("code/stata/basic_cleaning.do"),
    Path("code/stata/winsor_industry.do"),
    Path("code/r/basic_cleaning.R"),
    Path("code/python/basic_cleaning.py"),
]


def test_skill_md_exists_with_frontmatter():
    skill = ROOT / "SKILL.md"
    assert skill.exists(), "SKILL.md missing"
    text = skill.read_text(encoding="utf-8")
    assert text.startswith("---"), "SKILL.md must start with YAML frontmatter"
    fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    assert fm_match, "SKILL.md frontmatter not closed"
    fm = fm_match.group(1)
    assert re.search(r"^name:\s*csmar-cleaning-cn", fm, re.MULTILINE), \
        "frontmatter must declare name: csmar-cleaning-cn"
    assert re.search(r"^description:\s*\S+", fm, re.MULTILINE), \
        "frontmatter must declare description"
    assert re.search(r"^version:\s*\S+", fm, re.MULTILINE), \
        "frontmatter must declare version"
    assert re.search(r"^license:\s*Apache-2\.0", fm, re.MULTILINE), \
        "frontmatter must declare license: Apache-2.0"


def test_all_reference_files_exist():
    missing = []
    for ref in REFERENCES:
        p = ROOT / "references" / ref
        if not p.exists():
            missing.append(str(p))
    assert not missing, f"Missing reference files: {missing}"


def test_all_code_files_exist():
    missing = []
    for cf in CODE_FILES:
        p = ROOT / cf
        if not p.exists():
            missing.append(str(p))
    assert not missing, f"Missing code files: {missing}"


def test_each_reference_md_minimum_length():
    """Each markdown in references/ should exceed 200 chars."""
    too_short = []
    for ref in REFERENCES:
        p = ROOT / "references" / ref
        text = p.read_text(encoding="utf-8")
        if len(text) <= 200:
            too_short.append((str(p), len(text)))
    assert not too_short, f"Reference files too short: {too_short}"


def test_each_code_file_min_lines():
    """Each .do/.R/.py should exceed 30 lines (i.e., > 30, so at least 31)."""
    too_short = []
    for cf in CODE_FILES:
        p = ROOT / cf
        n_lines = sum(1 for _ in p.read_text(encoding="utf-8").splitlines())
        if n_lines <= 30:
            too_short.append((str(p), n_lines))
    assert not too_short, f"Code files too short (need > 30 lines): {too_short}"


def test_license_is_apache_2():
    lic = ROOT / "LICENSE"
    assert lic.exists(), "LICENSE missing"
    text = lic.read_text(encoding="utf-8")
    assert "Apache License" in text, "LICENSE not Apache"
    assert "Version 2.0" in text, "LICENSE not Apache 2.0"


def test_notice_has_csmar_and_research_claw_attribution():
    notice = ROOT / "NOTICE"
    assert notice.exists(), "NOTICE missing"
    text = notice.read_text(encoding="utf-8")
    assert "CSMAR" in text, "NOTICE must mention CSMAR"
    assert "Research-Claw" in text, "NOTICE must mention Research-Claw"
    assert "Independently" in text or "No source code" in text, \
        "NOTICE should clarify independent development"


def test_python_code_is_valid_syntax():
    """Python code should at least parse."""
    import ast
    p = ROOT / "code/python/basic_cleaning.py"
    text = p.read_text(encoding="utf-8")
    ast.parse(text)


def test_stata_code_uses_winsor2():
    """Stata winsor template should reference winsor2."""
    p = ROOT / "code/stata/winsor_industry.do"
    text = p.read_text(encoding="utf-8").lower()
    assert "winsor2" in text, "winsor_industry.do should use winsor2"


def test_r_code_uses_desctools_winsorize():
    """R template should use DescTools::Winsorize."""
    p = ROOT / "code/r/basic_cleaning.R"
    text = p.read_text(encoding="utf-8")
    assert "DescTools" in text, "R template should reference DescTools"
    assert "Winsorize" in text, "R template should call Winsorize"
