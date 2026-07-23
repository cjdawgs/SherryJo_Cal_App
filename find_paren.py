from pathlib import Path

text = Path("app/static/calendar.js").read_text(encoding="utf-8")

stack = []

for i, ch in enumerate(text):
    if ch == "(":
        stack.append(i)
    elif ch == ")":
        if stack:
            stack.pop()

print("Unmatched opens:", len(stack))

for pos in stack[-10:]:
    line = text.count("\n", 0, pos) + 1
    col = pos - text.rfind("\n", 0, pos)
    print(f"line={line}, col={col}")