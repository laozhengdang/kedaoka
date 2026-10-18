import pymupdf, os, sys, json

sys.stdout.reconfigure(encoding="utf-8")

from pathlib import Path as _Path
ATT = str(_Path(__file__).resolve().parent.parent / "data" / "source_pdfs")
OUT = str(_Path(__file__).resolve().parent / "png")
os.makedirs(OUT, exist_ok=True)

FILES = {
 "im3": (r"85\8599c0f1c4fd8cd652feb58eaf1fe786127e3567ff19dfa8104484b09d80089c", "2026兽医免疫学课件-第三章2026.9.30.pdf"),
 "im4": (r"1a\1abfc94e355ae3035e1c5acada51b4a2432afc5feeb0f30a357afeeb0f4bd08c", "第4章 免疫系统.pdf"),
 "im5": (r"d0\d076d93b4d480ac5a92746ea6640d594487a5d0ad747e95b21a8ef54da0f1a7c", "第5章 免疫学技术概论.pdf"),
 "bl1": (r"c1\c1bab4d2c21fd4f6b1ad1246986226881757d8f16dc915f6305eacde7e6f771e", "第二章 血液循环障碍 -1充血、出血、缺血、.pdf"),
 "bl2": (r"0b\0bf8ef4bebb18ea9386e3509c77693e88d85a4acdd20558fe5295f017874eb55", "第二章 血液循环障碍-2 血栓形成 栓塞 20260922.pdf"),
 "yl": (r"25\2533ac23d3afcc1876bab17d8af887799971106cf5a17d16950c0e48f3f4be75", "8-消化系统药物.pdf"),
 "yl2": (r"0c\0cb314276f83a00b0b5f60d051f08d815f750c85838ba95022b5ea1b83b36500", "9-呼吸系统药物.pdf"),
}

# 每份 PDF 的矢量绘图密度（判断机制图是否为矢量绘制而非嵌入图片）
print("== 矢量绘图密度（drawings 数 / 页）==")
for key, (h, name) in FILES.items():
    doc = pymupdf.open(os.path.join(ATT, name))
    rows = []
    for i, page in enumerate(doc):
        n = len(page.get_drawings())
        if n >= 40:
            rows.append((i + 1, n))
    print(f"  {key:5} 总页={len(doc):>4}  drawings>=40 的页: {rows[:40]}")
    doc.close()

RENDER = [
 ("im3", 12), ("im3", 13),
 ("im4", 49),
 ("im5", 33),
 ("bl1", 40), ("bl1", 2),
 ("bl2", 34),
 ("yl", 2), ("yl", 4), ("yl", 12), ("yl", 142),
]
print("\n== 渲染 ==")
for key, pno in RENDER:
    h, name = FILES[key]
    doc = pymupdf.open(os.path.join(ATT, name))
    page = doc[pno - 1]
    pix = page.get_pixmap(dpi=130)
    fn = os.path.join(OUT, f"{key}_p{pno:03d}.png")
    pix.save(fn)
    print(f"  {fn}  {pix.width}x{pix.height}")
    doc.close()
