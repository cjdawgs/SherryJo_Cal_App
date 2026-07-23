from pathlib import Path
from app.tests.test_js_syntax import _strip_comments

text = Path("app/static/calendar.js").read_text(encoding="utf-8")
text = _strip_comments(text)

depth = 0
stack = []

in_single = in_double = in_bt = False
prev = ""

for i, ch in enumerate(text):
    if ch == '"' and not in_single and not in_bt and prev != "\\":
        in_double = not in_double
    elif ch == "'" and not in_double and not in_bt and prev != "\\":
        in_single = not in_single
    elif ch == "`" and not in_single and not in_double:
        in_bt = not in_bt
    elif not in_single and not in_double and not in_bt:
        if ch == "(":
            stack.append(i)
        elif ch == ")":
            if stack:
                stack.pop()

    prev = ch

print("Remaining opens:", len(stack))

if stack:
    pos = stack[-1]

    line = text[:pos].count("\n") + 1
    print("Line:", line)

    start = max(0, pos - 150)
    end = min(len(text), pos + 150)

    print("\n--- CONTEXT ---\n")
    print(text[start:end])