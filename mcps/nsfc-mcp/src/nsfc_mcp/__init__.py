"""nsfc-mcp: MCP server for querying NSFC (国家自然科学基金) public project data."""

__version__ = "0.1.0"

from nsfc_mcp.exceptions import (
    NsfcAuthError,
    NsfcError,
    NsfcRateLimitError,
)
from nsfc_mcp.models import (
    Discipline,
    Project,
    ProjectDetail,
    ProjectListResult,
    ProjectQuery,
    TrendsResult,
)

__all__ = [
    "__version__",
    "NsfcError",
    "NsfcAuthError",
    "NsfcRateLimitError",
    "Discipline",
    "Project",
    "ProjectDetail",
    "ProjectListResult",
    "ProjectQuery",
    "TrendsResult",
]
