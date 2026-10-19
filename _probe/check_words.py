import sqlite3
import sys
from pathlib import Path

db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/老郑荡的妙妙小工具/data/db/app.db")
course = sys.argv[2] if len(sys.argv) > 2 else "药理学"
c = sqlite3.connect(db)
cid = c.execute("SELECT id FROM course WHERE name=?", (course,)).fetchone()[0]
rows = [r[0] for r in c.execute(
    "SELECT front FROM card WHERE course_id=? AND status='active'", (cid,))]
print(f"{course} 共 {len(rows)} 张")
for w in ("祛痰作用", "缓泻作用", "制酵作用", "收敛作用", "健胃作用",
          "抗酸强度", "起效时间", "持续时间", "思密达", "抗菌药"):
    print(("  有  " if w in rows else "  无  ") + w)
