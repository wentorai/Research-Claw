"""Light Mermaid syntax sanity checks (no full parser)."""
from __future__ import annotations
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent
MMD_DIR = ROOT / "templates" / "mermaid"

VALID_HEADERS = (
    "flowchart", "graph", "sequenceDiagram", "classDiagram",
    "stateDiagram", "stateDiagram-v2", "gitGraph", "journey",
    "gantt", "erDiagram", "pie", "mindmap",
)


def _first_directive(text: str) -> str:
    """Return the first non-comment, non-blank line."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%"):
            continue
        return line
    return ""


@pytest.mark.parametrize("path", sorted(MMD_DIR.glob("*.mmd")))
def test_mmd_starts_with_valid_header(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    assert text.strip(), f"{path.name} is empty"
    first = _first_directive(text)
    assert first.startswith(VALID_HEADERS), (
        f"{path.name}: first directive '{first[:60]}' not a Mermaid graph type"
    )


@pytest.mark.parametrize("path", sorted(MMD_DIR.glob("*.mmd")))
def test_mmd_balanced_brackets(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    # strip strings (anything inside double-quotes) so bracket chars in
    # quoted labels do not affect counts
    cleaned = []
    in_str = False
    for ch in text:
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        cleaned.append(ch)
    s = "".join(cleaned)
    pairs = [("(", ")"), ("[", "]"), ("{", "}")]
    for op, cl in pairs:
        assert s.count(op) == s.count(cl), (
            f"{path.name}: unbalanced '{op}{cl}' "
            f"({s.count(op)} vs {s.count(cl)})"
        )


@pytest.mark.parametrize("path", sorted(MMD_DIR.glob("*.mmd")))
def test_mmd_utf8_valid(path: Path) -> None:
    raw = path.read_bytes()
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        pytest.fail(f"{path.name} is not valid UTF-8: {exc}")


def test_mermaid_dir_has_expected_count() -> None:
    files = list(MMD_DIR.glob("*.mmd"))
    assert len(files) >= 5, f"expected >=5 mermaid templates, got {len(files)}"
