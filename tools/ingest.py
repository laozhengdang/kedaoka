"""ingest.py —— 把一份 PDF 课件变成卡片（无 AI 降级模式，见文档 24.10）

做的事：
  1. sha256 去重，同一份文件不会导入两次
  2. 逐页抽文本 + 颜色
  3. 红色 span 合并成候选术语
  4. 术语 → concept（一个概念一个首选词）
  5. 卡背 = 该词所在页的原文片段（老师原话，100% 可溯源）
  6. 星级 = 跨页频率 + 颜色等级（不需要模型）

用法：
  python tools/ingest.py --file "path/to.pdf" --course-name "免疫学" [--profession 兽医学]
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MIAOMIAO_DATA") or (ROOT / "data"))
DB = DATA_DIR / "db" / "app.db"
REPORT = ROOT / "_probe" / "ingest_report.json"

REDS = {0xFF0000, 0xC00000, 0xFF3300, 0xE00000, 0xD00000}
STRONG = {0xFF0000, 0xC00000}
BLUES = {0x0000FF, 0x003399}

CJK = re.compile(r"[\u4e00-\u9fff]")
BAD_TAIL = re.compile(r"[，。、；：,.;:（）()\[\]【】\s\-—－]+$")
MIN_LEN, MAX_LEN = 2, 10
# 出现这些虚词，基本是句子/短语，不是术语
FUNC_WORDS = set("的了是与和有或就都也把被让使")
# 这些后缀的多半是章节标题
BAD_SUFFIX = ("分类", "组成", "功能", "调节", "疾病", "要点", "概述", "过程", "用途", "应用", "方法", "原理")

# 章节标题样式的泛词，不是术语（第一版先硬编码，以后可以学习）
STOPWORDS = {
    "概念", "基本概念", "应用", "特性", "优点", "缺点", "比较", "诊断", "种类", "本章要点",
    "制备过程", "主要用途", "目的", "意义", "分类", "方法", "步骤", "原理", "注意", "小结",
    "总结", "概述", "定义", "特点", "作用", "组成", "结构", "功能", "类型", "条件", "原则",
    "要求", "流程", "结果", "结论", "重点", "难点", "概述", "引言", "前言", "目录", "思考题",
    "复习思考题", "学习目标", "掌握", "熟悉", "了解", "举例", "实例", "例题", "习题",
    "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def uid(p=""):
    return p + uuid.uuid4().hex[:8]


def norm(s: str) -> str:
    s = re.sub(r"\s+", "", s or "")
    # 去掉「1.」「2、」「（3）」这类序号
    s = re.sub(r"^[（(]?[0-9０-９]{1,2}[）).．、:：]\s*", "", s)
    s = BAD_TAIL.sub("", s)
    s = s.lstrip("【（(《「『[<〈・·•◆■●▶►◇○△▲☆★① ②③④⑤⑥⑦⑧⑨⑩")
    s = BAD_TAIL.sub("", s)
    return s.strip()


def split_chunk(chunk: str):
    """一个红字块里可能挤了好几个术语，按标点/空白拆开"""
    parts = re.split(r"[、，,；;：:\s/／]+", chunk)
    return [p for p in (norm(x) for x in parts) if p]


def looks_like_term(s: str) -> bool:
    if not (MIN_LEN <= len(s) <= MAX_LEN):
        return False
    if not CJK.search(s):
        return False
    if s in STOPWORDS:
        return False
    if any(ch in FUNC_WORDS for ch in s):
        return False
    if s.endswith(BAD_SUFFIX):
        return False
    if re.fullmatch(r"[0-9０-９.．%]+", s):
        return False
    if s.count("。") or s.count("，") > 1:
        return False
    return True


def page_lines(page):
    """把一页拆成行，每行返回 (text, color_max, size_max, red_ratio)"""
    d = page.get_text("dict")
    out = []
    for block in d.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            txt = "".join(s.get("text", "") for s in spans)
            if not txt.strip():
                continue
            red_chars = 0
            total = 0
            color = 0
            size = 0
            for s in spans:
                t = s.get("text", "")
                total += len(t)
                size = max(size, s.get("size", 0))
                c = s.get("color", 0)
                if c in REDS:
                    red_chars += len(t)
                    color = c
            out.append({
                "text": txt.strip(),
                "color": color,
                "size": round(size, 1),
                "red_ratio": red_chars / max(total, 1),
            })
    return out


def red_terms_on_page(page):
    """按"相邻红字"聚合，再按标点拆开——一行里可能有好几个术语"""
    d = page.get_text("dict")
    terms = []
    for block in d.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines", []):
            buf = []
            last_x1 = None
            for s in line.get("spans", []):
                c = s.get("color", 0)
                t = s.get("text", "")
                x0 = s.get("bbox", [0, 0, 0, 0])[0]
                x1 = s.get("bbox", [0, 0, 0, 0])[2]
                is_red = c in REDS and s.get("size", 0) >= 11
                adjacent = last_x1 is not None and (x0 - last_x1) < 3.0
                if is_red and (not buf or adjacent):
                    buf.append(t)
                    last_x1 = x1
                else:
                    if buf:
                        terms.extend(_expand("".join(buf), c))
                    buf = [t] if is_red else []
                    last_x1 = x1 if is_red else None
            if buf:
                terms.extend(_expand("".join(buf), sorted(REDS)[0]))
    return terms


def _expand(chunk: str, color: int):
    """拆标点、去括号里的英文、过滤不像术语的"""
    out = []
    for part in split_chunk(chunk):
        # "多克隆抗体（Polyclonal" -> "多克隆抗体"；英文名留作别名以后再抽
        core = re.split(r"[（(]", part)[0]
        core = norm(core)
        if looks_like_term(core):
            out.append((core, color))
    return out


def context_for(page, term, all_lines):
    """卡背：优先取含该词的行 + 它后面两行；否则取前几行"""
    idx = None
    for i, ln in enumerate(all_lines):
        if term in ln["text"]:
            idx = i
            break
    if idx is None:
        picked = [ln["text"] for ln in all_lines[:6]]
    else:
        lo = max(0, idx - 1)
        picked = [ln["text"] for ln in all_lines[lo:idx + 3]]
    text = "\n".join(picked).strip()
    return text[:600]


def clean_page_text(lines):
    out = []
    for ln in lines:
        t = ln["text"]
        if re.fullmatch(r"\d{1,3}", t):  # 页码
            continue
        out.append(t)
    return "\n".join(out)


def ensure_course(conn, name, profession):
    row = conn.execute("SELECT id FROM course WHERE name=?", (name,)).fetchone()
    if row:
        return row[0]
    prof = conn.execute("SELECT id FROM profession WHERE name=?", (profession,)).fetchone()
    if prof:
        prof_id = prof[0]
    else:
        prof_id = uid("prof_")
        conn.execute("INSERT INTO profession(id,name) VALUES(?,?)", (prof_id, profession))
    cid = uid("course_")
    conn.execute(
        "INSERT INTO course(id,profession_id,name,mode,state,created_at) VALUES(?,?,?,?,?,?)",
        (cid, prof_id, name, "concept", "active", now()),
    )
    return cid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--course-name", required=True)
    ap.add_argument("--profession", default="兽医学")
    ap.add_argument("--reparse", action="store_true", help="同一文件重新解析（先删旧数据）")
    args = ap.parse_args()

    path = Path(args.file).resolve()
    if not path.exists():
        raise SystemExit(f"文件不存在: {path}")

    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()

    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA foreign_keys = ON")

    exist = conn.execute("SELECT id, course_id FROM source_file WHERE sha256=?", (sha,)).fetchone()
    if exist and not args.reparse:
        print(json.dumps({"ok": True, "skipped": True, "reason": "already imported",
                          "file_id": exist[0], "course_id": exist[1]}, ensure_ascii=False))
        return
    if exist and args.reparse:
        fid = exist[0]
        conn.execute("DELETE FROM page WHERE file_id=?", (fid,))
        conn.execute("DELETE FROM source_file WHERE id=?", (fid,))

    course_id = ensure_course(conn, args.course_name, args.profession)

    doc = pymupdf.open(path)
    fid = uid("file_")
    conn.execute(
        "INSERT INTO source_file(id,course_id,path,sha256,pages,imported_at) VALUES(?,?,?,?,?,?)",
        (fid, course_id, str(path), sha, len(doc), now()),
    )

    # 1) 存页
    page_cache = {}
    for pno in range(len(doc)):
        page = doc[pno]
        lines = page_lines(page)
        page_cache[pno + 1] = lines
        conn.execute(
            "INSERT INTO page(file_id,page_no,text,has_formula) VALUES(?,?,?,?)",
            (fid, pno + 1, clean_page_text(lines), 1 if any(ln["color"] in BLUES for ln in lines) else 0),
        )

    # 2) 抽红字术语（跨页聚合）
    found = {}  # term -> {"pages": set, "color": int, "first_page": int}
    for pno in range(len(doc)):
        for term, color in red_terms_on_page(doc[pno]):
            d = found.setdefault(term, {"pages": set(), "color": color, "first_page": pno + 1})
            d["pages"].add(pno + 1)
            if color in STRONG:
                d["color"] = color
    doc.close()

    # 3) 概念 + 卡片
    created = 0
    for term, info in found.items():
        row = conn.execute(
            "SELECT c.id FROM term t JOIN concept c ON c.id=t.concept_id "
            "WHERE t.text=? AND c.course_id=? AND t.kind='preferred'", (term, course_id)
        ).fetchone()
        if row:
            continue
        concept_id = uid("cp_")
        conn.execute("INSERT INTO concept(id,course_id,type,created_at) VALUES(?,?,?,?)",
                     (concept_id, course_id, "unknown", now()))
        conn.execute("INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)",
                     (concept_id, term, "preferred", "ppt"))

        first = info["first_page"]
        back = context_for(None, term, page_cache.get(first, []))
        n_pages = len(info["pages"])
        star = 2 + min(3, n_pages - 1) + (1 if info["color"] in STRONG else 0)
        star = max(1, min(5, star))

        card_id = uid("card_")
        conn.execute(
            "INSERT INTO card(id,course_id,concept_id,front,back,source_page,source_text,"
            "importance,origin,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (card_id, course_id, concept_id, term, back, first, back, star, "ppt", "active", now()),
        )
        conn.execute("INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?)",
                     (card_id, "new", now()))
        created += 1

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM card WHERE course_id=?", (course_id,)).fetchone()[0]
    report = {
        "ok": True, "file": str(path), "pages": len(page_cache),
        "terms_found": len(found), "cards_created": created,
        "course_id": course_id, "cards_total_in_course": total,
        "sample": [{"term": t, "pages": sorted(v["pages"]), "color": f"#{v['color']:06x}"}
                   for t, v in list(found.items())[:10]],
    }
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("ok", "pages", "terms_found", "cards_created", "cards_total_in_course", "course_id")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
