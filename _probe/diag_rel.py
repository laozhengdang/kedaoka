import re
import sqlite3

c = sqlite3.connect("data/db/app.db")
cid = c.execute("SELECT id FROM course WHERE name='药理学'").fetchone()[0]
terms = {r[0] for r in c.execute("SELECT front FROM card WHERE course_id=?", (cid,))}

pages = c.execute(
    "SELECT p.page_no, p.text FROM page p JOIN source_file f ON f.id=p.file_id WHERE f.course_id=? ORDER BY p.page_no",
    (cid,),
).fetchall()

KEYS = ("包括", "分为", "可分", "有以下", "主要有", "种类有", "分成", "又分")
n = 0
for pno, text in pages:
    joined = "".join((text or "").split("\n"))
    if not any(k in joined for k in KEYS):
        continue
    n += 1
    if n > 12:
        break
    # 找关键词前最近的、以它结尾的已知术语
    hits = []
    for kw in KEYS:
        for m in re.finditer(re.escape(kw), joined):
            head = joined[max(0, m.start() - 22):m.start()]
            best = None
            for t in terms:
                if head.endswith(t) and (best is None or len(t) > len(best)):
                    best = t
            seg = re.split(r"[。；;]", joined[m.end():m.end() + 60])[0]
            kids = [x.strip(" 、，,：:（）()") for x in re.split(r"[、，,\s]+", seg)]
            kids_ok = [k for k in kids if k in terms]
            if len(kids_ok) >= 2:
                hits.append((best, kids_ok[:5]))
    print(f"p{pno}: {hits[:3]}")
