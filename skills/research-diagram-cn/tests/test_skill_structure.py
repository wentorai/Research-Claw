"""Verify research-diagram-cn skill structure and required files."""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

REFERENCES = [
    "mermaid-cheatsheet.md",
    "causal-dag-rules.md",
    "prisma-2020.md",
    "hypothesis-tree.md",
    "graphml-export.md",
]

MERMAID_TEMPLATES = [
    "research-workflow.mmd",
    "theoretical-framework.mmd",
    "prisma-flow.mmd",
    "did-design.mmd",
    "empirical-pipeline.mmd",
]

PYTHON_TEMPLATES = [
    "causal_dag_dagitty.py",
    "prisma_flow_matplotlib.py",
    "hypothesis_tree.py",
    "graphml_export.py",
]

TIKZ_TEMPLATES = ["causal_dag.tex"]


def test_top_level_files_exist() -> None:
    for name in ["SKILL.md", "LICENSE", "NOTICE", "README.md"]:
        assert (ROOT / name).exists(), f"missing {name}"


def test_skill_md_frontmatter() -> None:
    text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\n"), "SKILL.md must start with YAML frontmatter"
    fm_match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    assert fm_match is not None, "SKILL.md frontmatter not closed"
    fm = fm_match.group(1)
    for key in ["name:", "description:", "tags:", "version:", "author:", "license:"]:
        assert key in fm, f"frontmatter missing {key}"
    assert "research-diagram-cn" in fm
    assert "Apache-2.0" in fm


def test_references_exist_and_long() -> None:
    refs_dir = ROOT / "references"
    assert refs_dir.is_dir()
    for name in REFERENCES:
        p = refs_dir / name
        assert p.exists(), f"missing reference {name}"
        body = p.read_text(encoding="utf-8")
        assert len(body) > 200, f"reference {name} too short ({len(body)} chars)"


def test_mermaid_templates_exist_and_long() -> None:
    d = ROOT / "templates" / "mermaid"
    assert d.is_dir()
    for name in MERMAID_TEMPLATES:
        p = d / name
        assert p.exists(), f"missing mermaid template {name}"
        lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        assert len(lines) > 5, f"mermaid template {name} too short ({len(lines)} lines)"


def test_python_templates_exist_and_long() -> None:
    d = ROOT / "templates" / "python"
    assert d.is_dir()
    for name in PYTHON_TEMPLATES:
        p = d / name
        assert p.exists(), f"missing python template {name}"
        lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        assert len(lines) > 30, f"python template {name} too short ({len(lines)} lines)"


def test_tikz_templates_exist() -> None:
    d = ROOT / "templates" / "tikz"
    assert d.is_dir()
    for name in TIKZ_TEMPLATES:
        p = d / name
        assert p.exists(), f"missing tikz template {name}"
        text = p.read_text(encoding="utf-8")
        assert "\\documentclass" in text and "tikzpicture" in text


def test_license_apache() -> None:
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert "Apache License" in license_text


def test_notice_mentions_sources() -> None:
    notice = (ROOT / "NOTICE").read_text(encoding="utf-8")
    for keyword in ["Mermaid", "DAGitty", "PRISMA", "NetworkX"]:
        assert keyword in notice, f"NOTICE missing mention of {keyword}"
