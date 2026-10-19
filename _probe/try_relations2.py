"""从课件正文（按页拼接，不按行）里抽"包含关系"。"""

import re
import sqlite3

c = sqlite3.connect("data/db/app.db")

KEYS = ("包括", "分为", "可分", "有以下", "主要有", "种类有", "可分为", "分成", "又分")


def find_parent(text: str, pos: int, fronts):
    """在关键词前 20 字内，找一个以它为结尾的已有术语（取最长）"""
    head = text[max(0, pos - 20):pos]
    head = head.strip("：:，,、 \n")
    best = None
    for f in fronts:
        if head.endswith(f) and (best is None or len(f) > len(best)):
            best = f
    return best


def split_kids(seg: str):
    seg = seg[:90]
    seg = re.split(r"[。；;]", seg)[0]
    return [x.strip(" 、，,：:（）()\n") for x in re.split(r"[、，,\s]+", seg) if x.strip()]


for name in ("免疫学", "药理学", "病理学"):
    row = c.execute("SELECT id FROM course WHERE name=?", (name,)).fetchone()
    if not row:
        continue
    cid = row[0]
    fronts = {r[0] for r in c.execute("SELECT front FROM card WHERE course_id=?", (cid,))}
    hits = []
    for (text,) in c.execute(
        "SELECT p.text FROM page p JOIN source_file f ON f.id=p.file_id WHERE f.course_id=?", (cid,)
    ):
        joined = "".join((text or "").split("\n"))
        for kw in KEYS:
            for m in re.finditer(re.escape(kw), joined):
                parent = find_parent(joined, m.start(), fronts)
                if not parent:
                    continue
                kids = [k for k in split_kids(joined[m.end():m.end() + 90]) if k in fronts and k != parent]
                if len(kids) >= 2:
                    hits.append((parent, kids))
    # 去重
    seen = set()
    uniq = []
    for p, ks in hits:
        k = (p, tuple(sorted(ks)))
        if k in seen:
            continue
        seen.add(k)
        uniq.append((p, ks))
    print(f"--- {name}: {len(uniq)} 条包含关系 ---")
    for p, ks in uniq[:10]:
        print("  ", p, "→", "、".join(ks))
