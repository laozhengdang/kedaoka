import re
from pathlib import Path

import pymupdf

BASE = Path(r"C:\Users\ZHENG\.dsh\attachments\v1\files")
FILES = {
    "ch0": r"f0\f0fbf9b7cf6d581bebe5019a72eab326767512f729d5183285f49067e5ec9b79\第0章 绪论-1学时.pdf",
    "ch1": r"09\0906deb1de6f94d499de2d2a8be645f81e8fabd0f59c1efb5ea1cc6c4ce3c8bd\第1章 分散系-2学时.pdf",
    "ch2": r"a5\a59bcf038bd44212931a554900ef67c0205e904b5352d1ab4608b50a507bc1c2\第2章 化学热力学基础-4学时.pdf",
    "ch3": r"ce\cee3b486d0e312ebc9680be3cf2f323066486deec2ad4590552f55ee4533837f\第3章 化学平衡-4学时.pdf",
    "ch4": r"2d\2d6a76512c8cc9b348df90b0920123e4ca473f1e15ab8f21de5c2d53a3162acb\第4章 化学动力学-2学时.pdf",
    "ans": r"70\7030d48a8fb0965bed9c07ed0a1c0d70c0095816bb0c9b836a19107167725d65\第一章课后题答案.pdf",
}

MATH_CHARS = set("Δ≈≤≥±×÷→⇌∑∫√∝·⁻¹²³₁₂₃ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω")
out = []
for key, rel in FILES.items():
    doc = pymupdf.open(BASE / rel)
    n = len(doc)
    sup_pages = 0
    bigimg_pages = 0
    frag_pages = 0
    math_pages = 0
    for pno in range(n):
        page = doc[pno]
        d = page.get_text("dict")
        sup = 0
        lines = []
        math_hits = 0
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                txt = "".join(s.get("text", "") for s in line.get("spans", []))
                lines.append(txt.strip())
                for s in line.get("spans", []):
                    if s.get("flags", 0) & 1:
                        sup += 1
                    math_hits += sum(1 for ch in s.get("text", "") if ch in MATH_CHARS)
        if sup > 0:
            sup_pages += 1
        if math_hits > 0:
            math_pages += 1
        # 图片覆盖面积
        area = page.rect.width * page.rect.height
        covered = 0
        for img in page.get_images(full=True):
            for r in page.get_image_rects(img[0]):
                covered += r.width * r.height
        if area and covered / area > 0.15:
            bigimg_pages += 1
        # 碎片化：短行占比
        nonempty = [l for l in lines if l]
        if nonempty:
            short = sum(1 for l in nonempty if len(l) <= 4)
            if short / len(nonempty) > 0.3:
                frag_pages += 1
    out.append((key, n, sup_pages, math_pages, bigimg_pages, frag_pages))
    doc.close()

print(f"{'file':5} {'pages':>5} {'有上下标':>8} {'有数学符号':>9} {'大图页':>6} {'碎片页':>6}")
for row in out:
    print(f"{row[0]:5} {row[1]:5} {row[2]:8} {row[3]:9} {row[4]:6} {row[5]:6}")
tot = [sum(r[i] for r in out) for i in range(1, 6)]
print(f"{'合计':5} {tot[0]:5} {tot[1]:8} {tot[2]:9} {tot[3]:6} {tot[4]:6}")
