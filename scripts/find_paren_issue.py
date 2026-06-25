"""Scan a JS file and report paren balance at each line."""
import sys
from pathlib import Path

path = sys.argv[1] if len(sys.argv) > 1 else "app/static/calendar.ui.js"
text = Path(path).read_text(encoding="utf-8")
lines = text.splitlines()

depth = 0
in_s1 = in_s2 = in_bt = False
prev = ""

for i, line in enumerate(lines, 1):
    line_opens = line_closes = 0
    for ch in line:
        if ch == '"' and not in_s1 and not in_bt and prev != "\\":
            in_s2 = not in_s2
        elif ch == "'" and not in_s2 and not in_bt and prev != "\\":
            in_s1 = not in_s1
        elif ch == "`" and not in_s1 and not in_s2:
            in_bt = not in_bt
        elif not in_s1 and not in_s2 and not in_bt:
            if ch == "(":
                depth += 1
                line_opens += 1
            elif ch == ")":
                depth -= 1
                line_closes += 1
        prev = ch

    if line_opens != line_closes:
        net = line_opens - line_closes
        print(f"L{i:4d} depth={depth:+3d} net={net:+d}  {line[:80]}")

print(f"\nFinal depth: {depth} (0 = balanced)")
