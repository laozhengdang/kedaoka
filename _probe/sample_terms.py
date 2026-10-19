import sqlite3

c = sqlite3.connect("data/db/app.db")
for name in ("药理学", "病理学", "免疫学"):
    cid = c.execute("SELECT id FROM course WHERE name=?", (name,)).fetchone()[0]
    print(f"--- {name} (总 {c.execute('SELECT COUNT(*) FROM card WHERE course_id=?', (cid,)).fetchone()[0]}) ---")
    for r in c.execute(
        "SELECT front, importance, source_page FROM card WHERE course_id=? "
        "ORDER BY importance DESC, source_page LIMIT 10", (cid,)
    ):
        print(f"  {r[1]}★ p{r[2]:<4} {r[0]}")
