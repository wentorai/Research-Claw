"""Module entry point: ``python -m econ_image_mcp``."""

from __future__ import annotations

from econ_image_mcp.server import main


def main_cli() -> None:  # pragma: no cover - thin wrapper
    main()


if __name__ == "__main__":  # pragma: no cover
    main_cli()


# Re-export for ``[project.scripts]`` entry point.
main = main_cli
