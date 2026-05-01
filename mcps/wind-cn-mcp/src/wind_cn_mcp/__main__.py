"""Module entry point: ``python -m wind_cn_mcp``."""

from __future__ import annotations

from wind_cn_mcp.server import main


def main_cli() -> None:  # pragma: no cover - thin wrapper
    main()


if __name__ == "__main__":  # pragma: no cover
    main_cli()


# Re-export for ``[project.scripts]`` entry point.
main = main_cli
