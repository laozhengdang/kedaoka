from pathlib import Path

import pymupdf

SRC = Path(r"C:\Users\ZHENG\xwechat_files\wxid_eqttvcqeft5q22_c3b7\msg\file\2026-10")
PICKS = {
    "2. DescriptiveStatistics.pdf": [0, 1, 2],
    "5. TestForPopMean.pdf": [0, 1, 2],
    "Review.pdf": [0, 1, 2],
    "HW3-Answer.pdf": [0],
    "Quiz2-Answer.pdf": [0],
    "Exercise.pdf": [0],
}
lines = []
for f, pages in PICKS.items():
    doc = pymupdf.open(SRC / f)
    for pno in pages:
        if pno >= len(doc):
            continue
        t = doc[pno].get_text("text")
        lines.append("=" * 72)
        lines.append(f"{f}  p{pno + 1}  chars={len(t.replace(chr(10),''))}")
        lines.append("-" * 72)
        lines.append(t[:1500])
    doc.close()
Path("_probe/biostat_pages.txt").write_text("\n".join(lines), encoding="utf-8")
print("ok")
