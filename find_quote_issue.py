from pathlib import Path
from app.tests.test_js_syntax import _strip_comments, _paren_balance

text = Path("app/static/calendar.js").read_text(encoding="utf-8")

stripped = _strip_comments(text)

print("Original length:", len(text))
print("Stripped length:", len(stripped))
print("Balance:", _paren_balance(text))

depth = 0
in_single = in_double = in_bt = False
prev = ""

for i, ch in enumerate(stripped):
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

    if depth < 0:
        line = stripped.count("\n", 0, i) + 1
        print("Negative at line", line)
        break

    prev = ch

print("Final depth:", depth)