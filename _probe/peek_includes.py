import re
import sqlite3

c = sqlite3.connect("data/db/app.db")
rows = c.execute(
    "SELECT p.text FROM page p JOIN source_file f ON f.id=p.file_id "
    "WHERE f.course_id=(SELECT id FROM course WHERE name='药理学')"
).fetchall()

n = 0
for (text,) in rows:
    for line in (text or "").split("\n"):
        if any(w in line for w in ("包括", "分为", "有以下", "主要有")):
            print(repr(line[:90]))
            n += 1
            if n >= 20:
                raise SystemExit
