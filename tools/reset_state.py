"""把复习状态重置为初始（星级与卡片本身不动）。

用途：跑完自动化测试后清场，避免测试消耗掉真实的复习进度。
"""

import sqlite3
import sys
from pathlib import Path

db = Path(sys.argv[1] if len(sys.argv) > 1 else "data/db/app.db")
c = sqlite3.connect(db)
c.execute("DELETE FROM review_log")
c.execute("DELETE FROM daily_queue")
c.execute(
    """UPDATE card_state SET state='new', interval_days=0, due_at=NULL,
       streak_forgot=0, leech=0, last_rating=NULL, last_review_at=NULL"""
)
c.commit()
logs = c.execute("SELECT COUNT(*) FROM review_log").fetchone()[0]
queues = c.execute("SELECT COUNT(*) FROM daily_queue").fetchone()[0]
cards = c.execute("SELECT COUNT(*) FROM card").fetchone()[0]
print(f"reset ok: cards={cards} review_log={logs} daily_queue={queues}")
