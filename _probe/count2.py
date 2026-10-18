import pymupdf, os, sys
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
tot=0; g=Counter()
print(f"{'课件':<15}{'页':>4}{'纯文字':>7}{'图注图':>7}{'全图无字':>8}{'白页':>5}{'需VLM页码'}")
print("-"*95)
for key,(h,name) in FILES.items():
    doc=pymupdf.open(os.path.join(ATT, name)); c=Counter(); vl=[]
    for i,pg in enumerate(doc):
        a=pg.rect.width*pg.rect.height; mx=0.0
        for im in pg.get_images(full=True):
            try:
                for r in pg.get_image_rects(im[0]): mx=max(mx,(r.width*r.height)/a)
            except Exception: pass
        t=pg.get_text("text").strip(); n=len(t)
        if n==0 and mx>=0.25: c["vlm"]+=1; vl.append(i+1)
        elif n==0: c["blank"]+=1
        elif n<=60 and mx>=0.25: c["cap"]+=1
        else: c["text"]+=1
    tot+=len(doc)
    for k in c: g[k]+=c[k]
    print(f"{key:<15}{len(doc):>4}{c['text']:>7}{c['cap']:>7}{c['vlm']:>8}{c['blank']:>5}  {vl}")
    doc.close()
print("-"*95)
print(f"{'合计':<15}{tot:>4}{g['text']:>7}{g['cap']:>7}{g['vlm']:>8}{g['blank']:>5}")
print(f"\n真正需要看图(VLM)的页: {g['vlm']}/{tot} = {g['vlm']/tot*100:.1f}%")
