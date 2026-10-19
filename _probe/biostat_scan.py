"""生物统计（英文课件）结构探针。

回答：
  1. 英文/中文混合比例，符号与公式密度
  2. 讲义 / 作业 / 测验答案 / 复习提纲 四类文件的结构差异
  3. 统计特有的东西：表格（ANOVA 表、t 表）、图（直方图/散点图）、公式
"""

import re
import json
from pathlib import Path

import pymupdf

SRC = Path(r"C:\Users\ZHENG\xwechat_files\wxid_eqttvcqeft5q22_c3b7\msg\file\2026-10")
FILES = [
    "2. DescriptiveStatistics.pdf",
    "2. DescriptiveStatistics(1).pdf",
    "3. ProbabilityDistribution.pdf",
    "4. IntroToStatInfer.pdf",
    "5. TestForPopMean.pdf",
    "7. Two-wayANOVA-Updated.pdf",
    "8. TestForCateData.pdf",
    "9. SimpleLinearReg.pdf",
    "10. ExpDesign.pdf",
    "HW1.pdf",
    "HW3.pdf",
    "HW3-Answer.pdf",
    "HW4.pdf",
    "Exercise.pdf",
    "Review.pdf",
    "Quiz2-Answer.pdf",
]

MATH = set("≈≤≥±×÷∑√∝∞∈∉⊂∪∩→←↔αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΘΛΞΠΣΦΨΩ")


def stats(path: Path):
    doc = pymupdf.open(path)
    n = len(doc)
    chars = 0
    latin = 0
    cjk = 0
    sup_pages = 0
    math_pages = 0
    table_pages = 0
    img_pages = 0
    ans_pages = 0
    text_all = []
    for pno in range(n):
        page = doc[pno]
        d = page.get_text("dict")
        t = page.get_text("text")
        text_all.append(t)
        chars += len(t.replace("\n", ""))
        latin += len(re.findall(r"[A-Za-z]", t))
        cjk += len(re.findall(r"[\u4e00-\u9fff]", t))
        sup = 0
        mathh = 0
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                for s in line.get("spans", []):
                    if s.get("flags", 0) & 1:
                        sup += 1
                    mathh += sum(1 for ch in s.get("text", "") if ch in MATH)
        if sup:
            sup_pages += 1
        if mathh:
            math_pages += 1
        if len(page.get_drawings()) > 60:
            table_pages += 1
        if page.get_images(full=True):
            img_pages += 1
        low = t.lower()
        if ("answer" in low) or ("solution" in low):
            ans_pages += 1
    full = "\n".join(text_all)
    doc.close()
    return {
        "pages": n,
        "chars": chars,
        "chars_per_page": round(chars / max(n, 1)),
        "latin_ratio": round(latin / max(latin + cjk, 1), 2),
        "sup_pages": sup_pages,
        "math_pages": math_pages,
        "table_pages": table_pages,
        "img_pages": img_pages,
        "ans_pages": ans_pages,
        "head": full[:600],
        "full_len": len(full),
    }


out = []
for f in FILES:
    p = SRC / f
    if not p.exists():
        out.append({"file": f, "error": "missing"})
        continue
    r = stats(p)
    r["file"] = f
    r["size"] = p.stat().st_size
    out.append(r)

Path("_probe").mkdir(exist_ok=True)
Path("_probe/biostat_scan.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

print(f"{'file':36} {'pg':>4} {'chr/pg':>7} {'latin':>6} {'sup':>5} {'math':>5} {'table':>6} {'img':>4} {'ans':>4}")
for r in out:
    if "error" in r:
        print(f"{r['file']:36} MISSING")
        continue
    print(f"{r['file'][:36]:36} {r['pages']:4} {r['chars_per_page']:7} {r['latin_ratio']:6} "
          f"{r['sup_pages']:5} {r['math_pages']:5} {r['table_pages']:6} {r['img_pages']:4} {r['ans_pages']:4}")
