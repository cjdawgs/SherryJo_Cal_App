#!/usr/bin/env python3
import sys
sys.path.append('.')
from app.tests.test_js_syntax import _paren_balance, _strip_comments
from pathlib import Path

path = Path('app/static/calendar.js')
text = path.read_text(encoding='utf-8')
balance = _paren_balance(text)
print(f'Balance: {balance}')

if balance != 0:
    # Find where the imbalance is
    stripped = _strip_comments(text)
    depth = 0
    in_single = in_double = in_bt = False
    prev = ''
    line_num = 1
    for i, ch in enumerate(stripped):
        if ch == '\n':
            line_num += 1
        
        if ch == '"' and not in_single and not in_bt and prev != '\\':
            in_double = not in_double
        elif ch == "'" and not in_double and not in_bt and prev != '\\':
            in_single = not in_single
        elif ch == '`' and not in_single and not in_double:
            in_bt = not in_bt
        elif not in_single and not in_double and not in_bt:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth < 0:
                    print(f'Extra closing paren at line {line_num}')
                    break
        prev = ch
    
    if depth > 0:
        print(f'Missing {depth} closing parens')