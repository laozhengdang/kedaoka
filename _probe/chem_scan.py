"""无机及分析化学课件的结构探针。

目的：回答三个问题
  1. 公式在 PDF 里是"文字"还是"图片"？
  2. 计算/例题占比多少，能不能被程序识别？
  3. 有没有颜色/着重号这类"重点信号"（兽医学课件里那套是否还成立）？

输出：控制台摘要 + _probe/chem_scan.json
"""

import json
import re
import sys
from pathlib import Path

import pymupdf

BASE = Path(r"C:\Users\ZHENG\.dsh\attachments\v1\files")

FILES = {
    "ch0_绪论": r"f0\f0fbf9b7cf6d581bebe5019a72eab326767512f729d5183285f49067e5ec9b79\第0章 绪论-1学时.pdf",
    "ch1_分散系": r"09\0906deb1de6f94d499de2d2a8be645f81e8fabd0f59c1efb5ea1cc6c4ce3c8bd\第1章 分散系-2学时.pdf",
    "ch2_热力学": r"a5\a59bcf038bd44212931a554900ef67c0205e904b5352d1ab4608b50a507bc1c2\第2章 化学热力学基础-4学时.pdf",
    "ch3_平衡": r"ce\cee3b486d0e312ebc9680be3cf2f323066486deec2ad4590552f55ee4533837f\第3章 化学平衡-4学时.pdf",
    "ch4_动力学": r"2d\2d6a76512c8cc9b348df90b0920123e4ca473f1e15ab8f21de5c2d53a3162acb\第4章 化学动力学-2学时.pdf",
    "ch1_课后答案": r"70\7030d48a8fb0965bed9c07ed0a1c0d70c0095816bb0c9b836a19107167725d65\第一章课后题答案.pdf",
}

KW = ["例", "解", "练习", "思考", "计算", "答", "公式", "推导", "已知", "求"]

# 数学相关的字体名片段（PPT 里公式常由 MathType / Cambria Math 渲染）
MATH_FONT_HINTS = ("cambria math", "symbol", "mt extra", "mathtype", "euclid", "times new roman")


def span_is_script(flags: int) -> bool:
    """PyMuPDF flags: bit0=superscript, bit1=italic."""
    return bool(flags & 1)


def scan(path: Path):
    doc = pymupdf.open(path)
    pages = []
    fonts = {}
    sup_sub = 0
    colors = {}
    for pno in range(len(doc)):
        page = doc[pno]
        text = page.get_text("text")
        d = page.get_text("dict")
        n_img = len(page.get_images(full=True))
        n_draw = len(page.get_drawings())
        page_chars = len(text.replace("\n", ""))
        page_colors = set()
        page_fonts = set()
        page_sup = 0
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    col = span.get("color", 0)
                    page_colors.add(f"#{col:06x}")
                    page_fonts.add(span.get("font", "?"))
                    fonts[span.get("font", "?")] = fonts.get(span.get("font", "?"), 0) + len(span.get("text", ""))
                    if span_is_script(span.get("flags", 0)):
                        page_sup += 1
                        sup_sub += 1
        for c in page_colors:
            colors[c] = colors.get(c, 0) + 1
        hits = {k: text.count(k) for k in KW if k in text}
        pages.append({
            "p": pno + 1,
            "chars": page_chars,
            "imgs": n_img,
            "draws": n_draw,
            "sup": page_sup,
            "colors": sorted(page_colors)[:6],
            "fonts": sorted(page_fonts)[:4],
            "kw": hits,
            "text": text,
        })
    doc.close()
    return {
        "pages": len(pages),
        "total_chars": sum(p["chars"] for p in pages),
        "empty_pages": sum(1 for p in pages if p["chars"] < 10),
        "img_pages": sum(1 for p in pages if p["imgs"] > 0),
        "sup_sub_spans": sup_sub,
        "fonts": dict(sorted(fonts.items(), key=lambda x: -x[1])[:15]),
        "colors": dict(sorted(colors.items(), key=lambda x: -x[1])[:10]),
        "detail": pages,
    }


def main():
    out = {}
    for key, rel in FILES.items():
        path = BASE / rel
        if not path.exists():
            print(f"MISSING {key}: {path}", file=sys.stderr)
            continue
        r = scan(path)
        out[key] = r
        print(f"\n=== {key} ===")
        print(f"页数 {r['pages']}  总字符 {r['total_chars']}  空页 {r['empty_pages']}  含图页 {r['img_pages']}")
        print(f"上下标片段 {r['sup_sub_spans']}")
        print("字体 top5:", list(r["fonts"].items())[:5])
        print("颜色 top5:", list(r["colors"].items())[:5])
        math_fonts = [f for f in r["fonts"] if any(h in f.lower() for h in MATH_FONT_HINTS)]
        print("疑似数学字体:", math_fonts)
        hit_pages = [p["p"] for p in r["detail"] if p["kw"]]
        print(f"含关键词页 {len(hit_pages)}: {hit_pages[:40]}")
    Path("_probe").mkdir(exist_ok=True)
    Path("_probe/chem_scan.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print("\n写入 _probe/chem_scan.json")


if __name__ == "__main__":
    main()
