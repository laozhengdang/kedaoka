"""给历史卡片补齐 file_id：靠"这一页有没有出现过这个词"来认领文件。"""

import sqlite3
import sys
from pathlib import Path

db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/老郑荡的妙妙小工具/data/db/app.db")
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row

courses = c.execute("SELECT id, name FROM course").fetchall()
total_fixed = 0
for co in courses:
    files = c.execute("SELECT id, path FROM source_file WHERE course_id=?", (co["id"],)).fetchall()
    if len(files) < 2:
        # 只有一个文件，直接全标
        if files:
            n = c.execute(
                "UPDATE card SET file_id=? WHERE course_id=? AND file_id IS NULL AND status='active'",
                (files[0]["id"], co["id"])).rowcount
            total_fixed += n
        continue

    fixed = 0
    unknown = 0
    cards = c.execute(
        "SELECT id, front, source_page FROM card WHERE course_id=? AND file_id IS NULL",
        (co["id"],)).fetchall()
    for card in cards:
        hit = None
        for f in files:
            row = c.execute(
                "SELECT text FROM page WHERE file_id=? AND page_no=?",
                (f["id"], card["source_page"])).fetchone()
            if row and card["front"] and card["front"] in (row["text"] or ""):
                hit = f["id"]
                break
        if hit:
            c.execute("UPDATE card SET file_id=? WHERE id=?", (hit, card["id"]))
            fixed += 1
        else:
            unknown += 1
    total_fixed += fixed
    print(f"{co['name']}: 认领 {fixed} 张，认不出 {unknown} 张")

c.commit()
print("共补齐", total_fixed, "张")
