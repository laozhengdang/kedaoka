"""看 AI 精修的效果：本次到底接的是真 API 还是 mock、抽了哪些词、质量如何。"""

import json
import sqlite3
import sys
from pathlib import Path

paths = []
for p in ("build/老郑荡的妙妙小工具/data/db/app.db", "data/db/app.db"):
    if Path(p).exists():
        paths.append(p)

for db in paths:
    print("=" * 60)
    print("库:", db)
    c = sqlite3.connect(db)
    prof = dict(c.execute("SELECT key, value FROM profile").fetchall())
    base = prof.get("ai_base_url", "").strip('"')
    model = prof.get("ai_model", "").strip('"')
    key = prof.get("ai_api_key", "").strip('"')
    print(f"接口: {base}  模型: {model}  key: {'已填 ' + key[:4] + '…' if key else '空'}")
    try:
        n_cache = c.execute("SELECT COUNT(*) FROM ai_cache").fetchone()[0]
    except sqlite3.OperationalError:
        n_cache = "无表（没调用过）"
    print("AI 缓存条数:", n_cache)
    for (name, total, ai) in c.execute("""
        SELECT co.name, COUNT(ca.id), SUM(CASE WHEN ca.origin='ai' THEN 1 ELSE 0 END)
        FROM course co LEFT JOIN card ca ON ca.course_id=co.id AND ca.status='active'
        GROUP BY co.name"""):
        print(f"  {name}: 共 {total} 张，其中 AI 产出 {ai}")
    rows = c.execute("""
        SELECT front, substr(back,1,90), importance, source_page
        FROM card WHERE origin='ai' AND status='active'
        ORDER BY source_page LIMIT 25""").fetchall()
    if rows:
        print("\n  --- AI 产出的样例 ---")
        for r in rows:
            print(f"  p{r[3]:<4} {r[2]}★ {r[0]}  ::  {r[1]}")
    else:
        print("\n  （还没有 origin=ai 的卡）")
    # 可疑词条
    sus = c.execute("""
        SELECT front FROM card
        WHERE status='active' AND (length(front)>14 OR front LIKE '第%章%' OR front LIKE '%主要%')
        LIMIT 10""").fetchall()
    if sus:
        print("\n  可疑词条:", "、".join(x[0] for x in sus))
