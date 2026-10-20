import sqlite3
import sys
from pathlib import Path

db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/老郑荡的妙妙小工具/data/db/app.db")
c = sqlite3.connect(db)
print("professions:", c.execute("SELECT id,name FROM profession").fetchall())
print("courses:", c.execute("SELECT name, profession_id FROM course").fetchall())
row = c.execute("SELECT value FROM profile WHERE key='profession'").fetchone()
print("profile.profession:", row)
