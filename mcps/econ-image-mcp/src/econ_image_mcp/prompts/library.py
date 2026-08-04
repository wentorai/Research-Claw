"""Prompt-template library for economics & management image generation.

The templates live in :mod:`econ_image_mcp.prompts.templates` (JSON file shipped
with the package). At import time we load them into ``TEMPLATES``.

Each template entry has shape::

    {
      "title":   "...",
      "category": "mechanism" | "game" | "concept" | "graphical-abstract"
                  | "poster" | "policy-brief",
      "template": "... {PARAM_A} ... {PARAM_B} ...",
      "params":   ["PARAM_A", "PARAM_B", ...],
      "example":  "..."
    }

Substitution uses :py:meth:`str.format_map` so missing keys raise a
``TemplateParameterError``.
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

from econ_image_mcp.exceptions import TemplateNotFoundError, TemplateParameterError
from econ_image_mcp.models import TemplateInfo


def _load_templates() -> dict[str, dict[str, Any]]:
    """Load ``templates.json`` shipped inside the package."""

    pkg = resources.files("econ_image_mcp.prompts")
    raw = (pkg / "templates.json").read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise RuntimeError("templates.json must be a JSON object")
    return data


TEMPLATES: dict[str, dict[str, Any]] = _load_templates()


def get_template(template_id: str) -> dict[str, Any]:
    """Return the raw template dict for ``template_id`` or raise."""

    try:
        return TEMPLATES[template_id]
    except KeyError as exc:
        raise TemplateNotFoundError(
            f"unknown template id {template_id!r}; "
            f"available: {sorted(TEMPLATES)}"
        ) from exc


class _SafeDict(dict):  # pragma: no cover - trivial
    def __missing__(self, key: str) -> str:  # type: ignore[override]
        raise KeyError(key)


def fill_template(template_id: str, params: dict[str, str]) -> str:
    """Fill ``template_id``'s template string with ``params``.

    Raises :class:`TemplateParameterError` if any required parameter is missing.
    Extra parameters are ignored (we only use the declared ones).
    """

    tpl = get_template(template_id)
    required = tpl["params"]
    missing = [k for k in required if k not in params]
    if missing:
        raise TemplateParameterError(
            f"template {template_id!r} missing required params: {missing}"
        )
    # Only forward declared params, in case the template literal uses {} for
    # other purposes; format_map then doesn't see undeclared keys.
    safe = {k: params[k] for k in required}
    try:
        return tpl["template"].format_map(_SafeDict(safe))
    except KeyError as exc:  # pragma: no cover - guarded by `missing` check
        raise TemplateParameterError(
            f"template {template_id!r} references undeclared param {exc.args[0]!r}"
        ) from exc


def list_template_infos() -> list[TemplateInfo]:
    """All templates as ``TemplateInfo`` rows, sorted by id."""

    return [
        TemplateInfo(
            id=tid,
            title=tpl["title"],
            template=tpl["template"],
            params=list(tpl["params"]),
            example=tpl.get("example"),
            category=tpl.get("category"),
        )
        for tid, tpl in sorted(TEMPLATES.items())
    ]
