import sqlite3
import sys
from pathlib import Path

db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/老郑荡的妙妙小工具/data/db/app.db")
c = sqlite3.connect(db)
for name in ("免疫学", "药理学", "病理学"):
    row = c.execute("SELECT id FROM course WHERE name=?", (name,)).fetchone()
    if not row:
        continue
    rows = c.execute(
        "SELECT front, importance FROM card WHERE course_id=? AND status='active' "
        "ORDER BY source_page, importance DESC", (row[0],)
    ).fetchall()
    print(f"=== {name}：{len(rows)} 张 ===")
    print(" | ".join(f"{f}{i}" for f, i in rows[:80]))
    print()
