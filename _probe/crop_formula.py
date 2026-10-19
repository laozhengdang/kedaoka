"""公式区域检测 + 裁切。

思路：
  1. 找出"像公式"的 span：含数学字符 / 上下标 / 数学字体
  2. 按行聚合，再把相邻行合并成块（分式会跨行）
  3. 裁切、放大、存 PNG

输出：_probe/crops/*.png
"""

import re
from pathlib import Path

import pymupdf

OUT = Path("_probe/crops")
OUT.mkdir(parents=True, exist_ok=True)

MATH = set("≈≤≥±×÷∑√∝∞∈∪∩→←↔αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΘΛΞΠΣΦΨΩ−–—·∙")
MATH_FONT = ("symbol", "cambria", "stix", "math", "euclid", "mt extra")


def is_math_span(span):
    txt = span.get("text", "")
    if not txt.strip():
        return False
    if span.get("flags", 0) & 1:  # superscript
        return True
    font = span.get("font", "").lower()
    if any(h in font for h in MATH_FONT):
        return True
    if any(ch in MATH for ch in txt):
        return True
    # 大量单个字母/数字的短 span（公式碎片）
    if len(txt.strip()) <= 3 and re.fullmatch(r"[A-Za-z0-9\-+/=()\s·.]+", txt):
        return True
    return False


def clusters(page):
    d = page.get_text("dict")
    rows = []
    for block in d.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if is_math_span(s)]
            if not spans:
                continue
            x0 = min(s["bbox"][0] for s in spans)
            y0 = min(s["bbox"][1] for s in spans)
            x1 = max(s["bbox"][2] for s in spans)
            y1 = max(s["bbox"][3] for s in spans)
            rows.append([x0, y0, x1, y1])
    if not rows:
        return []
    rows.sort(key=lambda r: (r[1], r[0]))
    # 合并：纵向间距 < 1.6 倍行高 且 横向有重叠
    merged = []
    for r in rows:
        placed = False
        for m in merged:
            h = max(m[3] - m[1], r[3] - r[1], 8)
            if r[1] < m[3] + h * 0.9 and r[0] < m[2] + 40 and r[2] > m[0] - 40:
                m[0] = min(m[0], r[0])
                m[1] = min(m[1], r[1])
                m[2] = max(m[2], r[2])
                m[3] = max(m[3], r[3])
                placed = True
                break
        if not placed:
            merged.append(list(r))
    # 面积过滤：太小的是噪声
    merged = [m for m in merged if (m[2] - m[0]) > 60 and (m[3] - m[1]) > 12]
    merged.sort(key=lambda m: -((m[2] - m[0]) * (m[3] - m[1])))
    return merged[:4]


def crop(pdf, pno, tag):
    doc = pymupdf.open(pdf)
    page = doc[pno]
    boxes = clusters(page)
    names = []
    for i, b in enumerate(boxes):
        pad = 6
        rect = pymupdf.Rect(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad) & page.rect
        if rect.is_empty:
            continue
        pix = page.get_pixmap(dpi=220, clip=rect)
        name = OUT / f"{tag}_{pno + 1}_{i}.png"
        pix.save(name)
        names.append((name.name, round(rect.width), round(rect.height)))
    doc.close()
    return names


TARGETS = [
    (r"data\source_pdfs_chem\第1章 分散系-2学时.pdf", 24, "chem1p25"),
    (r"data\source_pdfs_chem\第2章 化学热力学基础-4学时.pdf", 23, "chem2p24"),
    (r"data\source_pdfs_chem\第2章 化学热力学基础-4学时.pdf", 24, "chem2p25"),
    (r"C:\Users\ZHENG\xwechat_files\wxid_eqttvcqeft5q22_c3b7\msg\file\2026-10\HW3-Answer.pdf", 0, "hw3ans"),
]

for rel, pno, tag in TARGETS:
    got = crop(rel, pno, tag)
    print(tag, "->", got)
