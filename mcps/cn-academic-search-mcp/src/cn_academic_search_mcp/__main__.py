"""CLI entry point: ``python -m cn_academic_search_mcp``."""

from __future__ import annotations

import logging

from .server import mcp


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    mcp.run()


if __name__ == "__main__":
    main()
