"""pytest configuration: skip Python template-run tests if matplotlib missing."""
import importlib.util

import pytest


def pytest_collection_modifyitems(config, items):
    if importlib.util.find_spec("matplotlib") is None:
        skip_marker = pytest.mark.skip(reason="matplotlib not installed")
        for item in items:
            if "test_python_templates_run" in item.nodeid:
                item.add_marker(skip_marker)
