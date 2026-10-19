"""试验：从课件正文里用句式规则抽"包含关系"，看能抽到多少。"""

import re
import sqlite3

c = sqlite3.connect("data/db/app.db")

PAT = re.compile(
    r"(?P<parent>[\u4e00-\u9fffA-Za-z0-9\-]{2,12})\s*"
    r"(?:包括|分为|可分|有以下|主要有|种类有|通常分为|又分)"
    r"[：:，,]?\s*(?P<kids>[^。；\n]{2,80})"
)

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
        for line in (text or "").split("\n"):
            m = PAT.search(line)
            if not m:
                continue
            parent = m.group("parent").strip()
            if parent not in fronts:
                continue
            kids = [k.strip(" 、，,：:（）()") for k in re.split(r"[、，,\s]+", m.group("kids"))]
            kids = [k for k in kids if k in fronts and k != parent]
            if len(kids) >= 2:
                hits.append((parent, kids))
    print(f"--- {name}: {len(hits)} 条包含关系 ---")
    for h in hits[:8]:
        print("  ", h[0], "→", "、".join(h[1]))
