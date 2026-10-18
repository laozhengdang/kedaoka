import pymupdf, os, json, sys, re

sys.stdout.reconfigure(encoding="utf-8")

from pathlib import Path as _Path
ATT = str(_Path(__file__).resolve().parent.parent / "data" / "source_pdfs")
FILES = {
 "免疫-第3章": (r"85\8599c0f1c4fd8cd652feb58eaf1fe786127e3567ff19dfa8104484b09d80089c", "2026兽医免疫学课件-第三章2026.9.30.pdf"),
 "免疫-第4章": (r"1a\1abfc94e355ae3035e1c5acada51b4a2432afc5feeb0f30a357afeeb0f4bd08c", "第4章 免疫系统.pdf"),
 "免疫-第5章": (r"d0\d076d93b4d480ac5a92746ea6640d594487a5d0ad747e95b21a8ef54da0f1a7c", "第5章 免疫学技术概论.pdf"),
 "病理-循环障碍1": (r"c1\c1bab4d2c21fd4f6b1ad1246986226881757d8f16dc915f6305eacde7e6f771e", "第二章 血液循环障碍 -1充血、出血、缺血、.pdf"),
 "病理-循环障碍2": (r"0b\0bf8ef4bebb18ea9386e3509c77693e88d85a4acdd20558fe5295f017874eb55", "第二章 血液循环障碍-2 血栓形成 栓塞 20260922.pdf"),
 "药理-消化": (r"25\2533ac23d3afcc1876bab17d8af887799971106cf5a17d16950c0e48f3f4be75", "8-消化系统药物.pdf"),
 "药理-呼吸": (r"0c\0cb314276f83a00b0b5f60d051f08d815f750c85838ba95022b5ea1b83b36500", "9-呼吸系统药物.pdf"),
}

KEY = re.compile(r"(思考题|名词解释|复习题|思考|小结|本节重点|重点掌握|掌握|了解|熟悉|作业)")

for key, (h, name) in FILES.items():
    path = os.path.join(ATT, name)
    doc = pymupdf.open(path)
    print(f"\n########## {key}  ({len(doc)}p)")
    # --- image bbox coverage per page ---
    print("-- 图片尺寸/覆盖（面积占比>8% 记为内容图；<3% 视为装饰）--")
    for i, page in enumerate(doc):
        pr = page.rect
        area = pr.width * pr.height
        info = []
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                rects = page.get_image_rects(xref)
            except Exception:
                rects = []
            for r in rects:
                cov = (r.width * r.height) / area
                if cov >= 0.08:
                    info.append(f"{cov*100:.0f}%")
        txt = page.get_text("text").strip()
        tiny = len(txt) < 40
        if info or tiny:
            print(f"  p{i+1:>3} chars={len(txt):>4} content_imgs={info} {'<<无正文' if tiny else ''}")
    # --- keyword hits ---
    print("-- 关键词命中 --")
    for i, page in enumerate(doc):
        t = page.get_text("text")
        hits = KEY.findall(t)
        if hits:
            print(f"  p{i+1:>3} {sorted(set(hits))} :: {t.strip()[:90]!r}")
    doc.close()
