#!/usr/bin/env python3
"""src/data/cp949-table.js 생성기.

Node 내장 TextDecoder('euc-kr') 는 ICU 의 EUC-KR(KS X 1001) 컨버터라
CP949(=MSWIN949=UHC) 확장 음절('똠', '펲', '믜' 등)을 디코딩하지 못한다.
그래서 Python 의 cp949 코덱(=Microsoft codepage 949)을 기준으로
정확한 매핑 테이블을 뽑아 커밋해 둔다. 런타임 의존성은 0 이 된다.

    python3 tools/gen-cp949-table.py > src/data/cp949-table.js
"""

import sys

LEAD_RANGE = range(0x81, 0xFF)
TRAIL_RANGE = range(0x41, 0xFF)

rows = {}
for lead in LEAD_RANGE:
    runs = []
    run_start = None
    buf = []
    for trail in TRAIL_RANGE:
        try:
            ch = bytes([lead, trail]).decode("cp949")
        except UnicodeDecodeError:
            ch = None
        if ch is None or len(ch) != 1:
            if buf:
                runs.append((run_start, "".join(buf)))
                buf, run_start = [], None
            continue
        if run_start is None:
            run_start = trail
        buf.append(ch)
    if buf:
        runs.append((run_start, "".join(buf)))
    if runs:
        rows[lead] = runs

def js_string(s: str) -> str:
    out = ["'"]
    for ch in s:
        if ch in ("'", "\\"):
            out.append("\\" + ch)
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append("'")
    return "".join(out)

total = sum(len(text) for runs in rows.values() for _, text in runs)

w = sys.stdout.write
w("/**\n")
w(" * CP949(MSWIN949 / UHC) 매핑 테이블 - 자동 생성 파일. 직접 수정하지 마세요.\n")
w(" *   생성: python3 tools/gen-cp949-table.py > src/data/cp949-table.js\n")
w(" *\n")
w(" * 구조: ROWS[선두바이트] = [[후행바이트 시작, '연속된 문자들'], ...]\n")
w(" * 즉 ROWS[0x81][0] = [0x41, '갂갃...'] 이면 0x81 0x41 -> '갂', 0x81 0x42 -> '갃'.\n")
w(f" * 총 {total}개 2바이트 문자.\n")
w(" */\n\n")
w("export const ROWS = {\n")
for lead in sorted(rows):
    parts = ", ".join(f"[0x{start:02x}, {js_string(text)}]" for start, text in rows[lead])
    w(f"  0x{lead:02x}: [{parts}],\n")
w("};\n\n")
w(f"export const TOTAL_DOUBLE_BYTE_CHARS = {total};\n")
