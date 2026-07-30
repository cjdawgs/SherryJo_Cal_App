"""
JS syntax smoke tests.
Checks that key static JS files have balanced parentheses and backticks,
and uses Node's parser to catch broader syntax corruption in production assets.
"""
from pathlib import Path
import shutil
import subprocess

import pytest

STATIC_DIR = Path(__file__).resolve().parents[2] / "app" / "static"
JS_FILES = [
    "calendar.ui.js",
    "calendar.js",
    "calendar.fullcalendar.js",
    "calendar.colors.js",
    "api.js",
    "core.js",
    "account_connections.js",
    "tv_dashboard.js",
]

HEURISTIC_BALANCE_FILES = [
    name for name in JS_FILES
    if name != "tv_dashboard.js"
]


def _strip_comments(text: str) -> str:
    """Remove // line comments and /* block comments */ while preserving newlines."""
    result = []
    i = 0
    n = len(text)
    in_single = in_double = in_bt = False
    while i < n:
        ch = text[i]
        # Track string state
        if ch == '"' and not in_single and not in_bt and (i == 0 or text[i - 1] != "\\"):
            in_double = not in_double
        elif ch == "'" and not in_double and not in_bt and (i == 0 or text[i - 1] != "\\"):
            in_single = not in_single
        elif ch == "`" and not in_single and not in_double:
            in_bt = not in_bt

        if not in_single and not in_double and not in_bt:
            # Line comment
            if ch == "/" and i + 1 < n and text[i + 1] == "/":
                while i < n and text[i] != "\n":
                    i += 1
                continue
            # Block comment
            if ch == "/" and i + 1 < n and text[i + 1] == "*":
                i += 2
                while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                    if text[i] == "\n":
                        result.append("\n")
                    i += 1
                i += 2  # skip */
                continue

        result.append(ch)
        i += 1
    return "".join(result)


def _paren_balance(text: str) -> int:
    """Return net open-paren count (0 = balanced). Strips comments first."""
    text = _strip_comments(text)
    depth = 0
    in_single = in_double = in_bt = False
    prev = ""
    for ch in text:
        if ch == '"' and not in_single and not in_bt and prev != "\\":
            in_double = not in_double
        elif ch == "'" and not in_double and not in_bt and prev != "\\":
            in_single = not in_single
        elif ch == "`" and not in_single and not in_double:
            in_bt = not in_bt
        elif not in_single and not in_double and not in_bt:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
        prev = ch
    return depth


def _backtick_balance(text: str) -> bool:
    """Return True if backtick count is even (all template literals closed)."""
    text = _strip_comments(text)
    in_single = in_double = False
    prev = ""
    bt_depth = 0
    for ch in text:
        if ch == '"' and not in_single and prev != "\\":
            in_double = not in_double
        elif ch == "'" and not in_double and prev != "\\":
            in_single = not in_single
        elif ch == "`" and not in_single and not in_double:
            bt_depth += 1
        prev = ch
    return bt_depth % 2 == 0


def test_js_parentheses_balanced():
    errors = []
    for name in HEURISTIC_BALANCE_FILES:
        path = STATIC_DIR / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        balance = _paren_balance(text)
        if balance != 0:
            errors.append(f"{name}: unmatched parentheses (net={balance:+d})")
    assert not errors, "\n".join(errors)


def test_js_backticks_balanced():
    errors = []
    for name in HEURISTIC_BALANCE_FILES:
        path = STATIC_DIR / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if not _backtick_balance(text):
            errors.append(f"{name}: odd number of backticks (unclosed template literal)")
    assert not errors, "\n".join(errors)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_js_files_parse_with_node():
    errors = []
    for name in JS_FILES:
        path = STATIC_DIR / name
        if not path.exists():
            continue
        result = subprocess.run(
            ["node", "--check", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            details = (result.stderr or result.stdout or "parse failure").strip()
            errors.append(f"{name}: {details}")
    assert not errors, "\n\n".join(errors)
