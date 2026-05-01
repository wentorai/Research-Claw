"""Entry point: ``python -m nsfc_mcp`` or the ``nsfc-mcp`` console script."""

from __future__ import annotations

from nsfc_mcp.server import mcp


def main() -> None:
    # FastMCP's default transport is stdio, which is what Claude Desktop /
    # Claude Code expect when launching MCP servers as subprocesses.
    mcp.run()


if __name__ == "__main__":
    main()
