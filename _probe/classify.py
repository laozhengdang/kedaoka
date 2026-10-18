import pymupdf, os, sys, json
from collections import Counter

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

RED = 0xFF0000
def is_reddish(c):
    r, g, b = (c >> 16) & 255, (c >> 8) & 255, c & 255
    return r >= 150 and g <= 110 and b <= 110

total_pages = 0
grand = Counter()
print(f"{'课程':<14}{'页数':>5}{'文字页':>7}{'图注页':>7}{'无字纯图':>9}{'分隔/空':>8}{'着重号':>7}{'红字段':>7}{'需VLM':>7}")
print("-" * 78)

detail = {}
for key, (h, name) in FILES.items():
    doc = pymupdf.open(os.path.join(ATT, name))
    cnt = Counter()
    pages_need_vlm = []
    pages_caption = []
    for i, page in enumerate(doc):
        pr = page.rect
        area = pr.width * pr.height
        maxcov = 0.0
        for img in page.get_images(full=True):
            try:
                for r in page.get_image_rects(img[0]):
                    maxcov = max(maxcov, (r.width * r.height) / area)
            except Exception:
                pass
        txt = page.get_text("text").strip()
        n = len(txt)

        d = page.get_text("dict")
        dots = 0
        redspans = 0
        red_chars = 0
        for b in d["blocks"]:
            if b["type"] != 0:
                continue
            for l in b["lines"]:
                for s in l["spans"]:
                    if "Wingdings" in s["font"] and s["text"].strip() in ("\uf09f", "\uf09e", "\uf0a1"):
                        dots += 1
                    elif is_reddish(s["color"]) and s["text"].strip():
                        redspans += 1
                        red_chars += len(s["text"].strip())

        if n < 10 and maxcov >= 0.30:
            cnt["vlm"] += 1
            pages_need_vlm.append(i + 1)
        elif n < 60 and maxcov >= 0.25:
            cnt["caption"] += 1
            pages_caption.append((i + 1, txt.replace("\n", " ")[:34]))
        elif n < 20:
            cnt["divider"] += 1
        else:
            cnt["text"] += 1
        cnt["dots"] += dots
        cnt["redspans"] += redspans
        cnt["redchars"] += red_chars
    total_pages += len(doc)
    print(f"{key:<14}{len(doc):>5}{cnt['text']:>7}{cnt['caption']:>7}{cnt['vlm']:>9}"
          f"{cnt['divider']:>8}{cnt['dots']:>7}{cnt['redchars']:>7}{cnt['vlm']:>7}")
    for k in ("text", "caption", "vlm", "divider", "dots", "redspans", "redchars"):
        grand[k] += cnt[k]
    detail[key] = {"pages": len(doc), "vlm_pages": pages_need_vlm, "caption_pages": pages_caption}
    doc.close()

print("-" * 78)
print(f"{'合计':<14}{total_pages:>5}{grand['text']:>7}{grand['caption']:>7}{grand['vlm']:>9}"
      f"{grand['divider']:>8}{grand['dots']:>7}{grand['redchars']:>7}{grand['vlm']:>7}")
print(f"\n需要 VLM 的页占总页数: {grand['vlm']}/{total_pages} = {grand['vlm']/total_pages*100:.1f}%")

print("\n== 各课需要 VLM 的具体页码 ==")
for k, v in detail.items():
    print(f"  {k:<14} {v['vlm_pages']}")

print("\n== 病理『图注页』样本（验证图注可结构化）==")
for k in ("病理-循环障碍1", "病理-循环障碍2"):
    print(f"  -- {k}")
    for p, t in detail[k]["caption_pages"][:14]:
        print(f"     p{p:>3} {t}")

json.dump(detail, open(str(_Path(__file__).resolve().parent / "detail.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
