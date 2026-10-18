import pymupdf, os, sys

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

print("===== A. 病理短文本页（验证『图注即名词』）=====")
for key in ["病理-循环障碍1", "病理-循环障碍2"]:
    h, name = FILES[key]
    doc = pymupdf.open(os.path.join(ATT, name))
    print(f"\n--- {key}")
    for i, page in enumerate(doc):
        t = page.get_text("text").strip()
        if 0 < len(t) < 40:
            print(f"  p{i+1:>3} [{len(t)}] {t!r}")
    doc.close()

print("\n\n===== B. 每份的开头 3 页 / 结尾 3 页 =====")
for key, (h, name) in FILES.items():
    doc = pymupdf.open(os.path.join(ATT, name))
    n = len(doc)
    print(f"\n--- {key} ({n}p)")
    for idx in [1, 2, 3, n - 2, n - 1, n]:
        if 1 <= idx <= n:
            t = doc[idx - 1].get_text("text").strip().replace("\n", " | ")
            print(f"  p{idx:>3}: {t[:220]!r}")
    doc.close()

print("\n\n===== C. 着重号/项目符号字符 & 颜色分布（免疫3章 p13）=====")
h, name = FILES["免疫-第3章"]
doc = pymupdf.open(os.path.join(ATT, name))
page = doc[12]
d = page.get_text("dict")
for b in d["blocks"]:
    if b["type"] != 0:
        continue
    for l in b["lines"]:
        for s in l["spans"]:
            print(f"  color={hex(s['color'])} size={s['size']:.1f} font={s['font'][:28]:<28} "
                  f"{s['text']!r}")
doc.close()

print("\n\n===== D. 免疫3章 p22（62个drawings）与 免疫4章 p9（539个drawings）=====")
for key, pno in [("免疫-第3章", 22), ("免疫-第4章", 9)]:
    h, name = FILES[key]
    doc = pymupdf.open(os.path.join(ATT, name))
    page = doc[pno - 1]
    print(f"\n--- {key} p{pno}  drawings={len(page.get_drawings())}")
    print(repr(page.get_text("text").strip()[:400]))
    doc.close()

print("\n\n===== E. 免疫5章 p33 思考题全文 =====")
h, name = FILES["免疫-第5章"]
doc = pymupdf.open(os.path.join(ATT, name))
print(doc[32].get_text("text"))
doc.close()
