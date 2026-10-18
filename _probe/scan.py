import pymupdf, os, json, sys, io

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

out = {}
for key, (h, name) in FILES.items():
    path = os.path.join(ATT, name)
    doc = pymupdf.open(path)
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        imgs = page.get_images(full=True)
        d = page.get_text("dict")
        spans = []
        for b in d["blocks"]:
            if b["type"] != 0:
                continue
            for l in b["lines"]:
                for s in l["spans"]:
                    spans.append(s)
        nonblack = [s for s in spans if s["color"] != 0]
        bold = [s for s in spans if "Bold" in s["font"] or "bold" in s["font"] or "Hei" in s["font"]]
        sizes = sorted({round(s["size"], 1) for s in spans})
        pages.append({
            "p": i + 1,
            "chars": len(text.strip()),
            "imgs": len(imgs),
            "spans": len(spans),
            "nonblack_colors": sorted({hex(s["color"]) for s in nonblack}),
            "n_nonblack": len(nonblack),
            "n_bold": len(bold),
            "nested_sizes": sizes[-4:],
            "text": text,
        })
    out[key] = {"file": name, "n_pages": len(doc), "pages": pages}
    doc.close()
    print(f"=== {key} | {name} | {len(pages)} pages")
    for pg in pages:
        flag = "IMG" if pg["imgs"] else "   "
        print(f"  p{pg['p']:>3} {flag} chars={pg['chars']:>5} imgs={pg['imgs']:>2} "
              f"span={pg['spans']:>4} color={len(pg['nonblack_colors']):>2} bold={pg['n_bold']:>3}")

with open(str(_Path(__file__).resolve().parent / "scan.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print("\nJSON written.")
