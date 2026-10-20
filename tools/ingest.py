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


def pick_main_term(page):
    """这一页的标题：页面**上部**、且字号接近本页最大字的那一行。

    两道过滤（都是为了别把正文小字当标题）：
      1) 只在页面上 45% 区域找
      2) 字号 >= 本页最大字号 × 0.9
    """
    top_limit = page.rect.height * 0.45
    cands = []
    max_size = 0
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines", []):
            y = line.get("bbox", [0, 0, 0, 0])[1]
            for s in line.get("spans", []):
                t = norm(s.get("text", ""))
                if not looks_like_term(t):
                    continue
                size = s.get("size", 0)
                max_size = max(max_size, size)
                cands.append((size, y, t, y <= top_limit))
    if not cands:
        return None
    pool = [c for c in cands if c[0] >= max_size * 0.9]
    top = [c for c in pool if c[3]]
    pool = top or pool
    # 字号最大，其次最靠上
    pool.sort(key=lambda c: (-c[0], c[1]))
    return pool[0][2]


# ---------------- 图片抽取 ----------------
MIN_IMG_AREA_RATIO = 0.04   # 小于整页 4% 的多半是校徽/图标
MIN_IMG_SIDE = 120          # 宽或高小于 120px 的丢掉


def extract_page_images(doc, page, out_dir: Path, course_id: str, page_no: int):
    """把这一页上"像内容"的图存下来，返回 [(相对路径, 面积)]，按面积从大到小"""
    saved = []
    page_area = page.rect.width * page.rect.height
    for idx, img in enumerate(page.get_images(full=True)):
        xref = img[0]
        try:
            rects = page.get_image_rects(xref)
        except Exception:
            rects = []
        if not rects:
            continue
        area = max(r.width * r.height for r in rects)
        if page_area <= 0 or area / page_area < MIN_IMG_AREA_RATIO:
            continue
        try:
            info = doc.extract_image(xref)
        except Exception:
            continue
        w, h = info.get("width", 0), info.get("height", 0)
        if w < MIN_IMG_SIDE or h < MIN_IMG_SIDE:
            continue
        ext = info.get("ext", "png")
        if ext not in ("png", "jpeg", "jpg", "webp"):
            continue
        name = f"p{page_no:03d}_{idx}.{ext}"
        target = out_dir / name
        if not target.exists():
            target.write_bytes(info["image"])
        saved.append((f"images/{course_id}/{name}", area))
    saved.sort(key=lambda x: -x[1])
    return saved


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
    # 带标点的多半是句子片段，不是术语
    if any(ch in s for ch in "、，,：:；;。()（）【】[]/／"):
        return False
    if re.fullmatch(r"[0-9０-９.．%]+", s):
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


REL_KEYS = ("包括", "分为", "可分", "有以下", "主要有", "种类有", "可分为", "分成", "又分")


def build_relations(conn, course_id, page_cache, page_main_term):
    """从"X 包括 A、B、C"这类句式抽包含关系。

    上位概念不用猜——直接用这一页的"主术语"（字号最大的红字），
    因为课件里这种列举句几乎都出现在"该页主题"下面。
    """
    pairs = conn.execute(
        "SELECT t.text, c.id FROM term t JOIN concept c ON c.id=t.concept_id "
        "WHERE c.course_id=? AND t.kind='preferred'", (course_id,)
    ).fetchall()
    term2concept = {t: cid for t, cid in pairs}
    if not term2concept:
        return 0

    existing = set()
    added = 0
    for pno, lines in page_cache.items():
        parent = page_main_term.get(pno)
        if not parent or parent not in term2concept:
            continue
        joined = "".join(ln["text"] for ln in lines)
        parent_c = term2concept[parent]
        for kw in REL_KEYS:
            start = 0
            while True:
                pos = joined.find(kw, start)
                if pos < 0:
                    break
                start = pos + len(kw)
                seg = joined[start:start + 90]
                seg = re.split(r"[。；;]", seg)[0]
                kids = [norm(x) for x in re.split(r"[、，,\s]+", seg)]
                kids = [k for k in kids if k in term2concept and k != parent]
                if len(kids) < 2:
                    continue
                for k in kids[:8]:
                    key = (parent_c, term2concept[k])
                    if key in existing:
                        continue
                    existing.add(key)
                    conn.execute(
                        "INSERT INTO relation(course_id,from_concept,to_concept,kind) VALUES(?,?,?,?)",
                        (course_id, key[0], key[1], "contains"),
                    )
                    added += 1
    return added


CHAPTER_RE = re.compile(r"^第\s*[一二三四五六七八九十0-9]+\s*[节章][\s、.．:：]*")


def detect_chapter(lines):
    """从这页的文字里找"第一节 / 第二章"这样的行，返回章节标题（去掉编号）"""
    for ln in lines:
        t = ln["text"].strip()
        m = CHAPTER_RE.match(t)
        if m:
            rest = norm(t[m.end():])
            rest = re.split(r"[（(]", rest)[0]
            rest = norm(rest)
            if 2 <= len(rest) <= 20:
                return rest
    return None


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
    ap.add_argument("--kind", default="theory", choices=["theory", "lab"],
                    help="theory=理论课，lab=实验课")
    ap.add_argument("--doc-type", default="ppt",
                    choices=["ppt", "exam", "notes", "syllabus"],
                    help="ppt=授课课件，exam=题库真题，notes=复习资料，syllabus=考纲提纲")
    ap.add_argument("--reparse", action="store_true", help="同一文件重新解析（先删旧数据）")
    ap.add_argument("--probe", action="store_true", help="只探测，不写库：输出页数/图片数/字数")
    args = ap.parse_args()

    path = Path(args.file).resolve()
    if not path.exists():
        raise SystemExit(f"文件不存在: {path}")

    if args.probe:
        doc = pymupdf.open(path)
        imgs = 0
        chars = 0
        for pg in doc:
            chars += len(pg.get_text("text"))
            imgs += len(pg.get_images(full=True))
        print(json.dumps({
            "ok": True, "probe": True, "pages": len(doc),
            "images": imgs, "chars": chars,
            "sizeMB": round(path.stat().st_size / 1048576, 1),
        }, ensure_ascii=False))
        return

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
        "INSERT INTO source_file(id,course_id,path,sha256,pages,imported_at,kind,doc_type) VALUES(?,?,?,?,?,?,?,?)",
        (fid, course_id, str(path), sha, len(doc), now(), args.kind, args.doc_type),
    )

    # 1) 存页 + 抽图
    img_dir = DATA_DIR / "images" / course_id
    img_dir.mkdir(parents=True, exist_ok=True)
    page_cache = {}
    page_images = {}   # page_no -> 最像内容的那张图（相对路径）
    page_main_term = {}  # page_no -> 这一页的"主术语"（字号最大的红字）
    page_chapter = {}    # page_no -> 所属章节名
    current_chapter = None
    for pno in range(len(doc)):
        page = doc[pno]
        lines = page_lines(page)
        page_cache[pno + 1] = lines
        imgs = extract_page_images(doc, page, img_dir, course_id, pno + 1)
        if imgs:
            page_images[pno + 1] = imgs[0][0]
        page_main_term[pno + 1] = pick_main_term(page)
        if (pno + 1) % 10 == 0:
            print(f"[page] {{}}/{{}}".format(pno + 1, len(doc)), flush=True)
        ch = detect_chapter(lines)
        if ch:
            current_chapter = ch
        page_chapter[pno + 1] = current_chapter
        conn.execute(
            "INSERT INTO page(file_id,page_no,text,has_formula,chapter) VALUES(?,?,?,?,?)",
            (fid, pno + 1, clean_page_text(lines), 1 if any(ln["color"] in BLUES for ln in lines) else 0,
             current_chapter),
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

    # 2.2) 考纲：不按颜色猜，直接按行拆考点
    if args.doc_type == "syllabus":
        syllabus_cards = 0
        heading_re = re.compile(r"^(第[一二三四五六七八九十0-9]+[章节]|[一二三四五六七八九十]+、|[0-9]{1,2}[.、])")
        for pno in sorted(page_cache):
            for ln in page_cache[pno]:
                text = norm(ln.get("text", ""))
                if not (4 <= len(text) <= 40):
                    continue
                name = re.sub(r"^[0-9０-９]{1,2}[.、)）]\s*", "", text)
                name = re.sub(r"^[（(][0-9０-９]{1,2}[)）]\s*", "", name).strip()
                if not name or name in ("目录", "前言", "附录"):
                    continue
                is_heading = bool(heading_re.match(name)) and len(name) <= 20
                exists = conn.execute(
                    "SELECT c.id FROM term t JOIN concept c ON c.id=t.concept_id "
                    "WHERE t.text=? AND c.course_id=? AND t.kind='preferred'", (name, course_id)
                ).fetchone()
                if exists:
                    continue
                concept_id = uid("cp_")
                conn.execute("INSERT INTO concept(id,course_id,type,created_at) VALUES(?,?,?,?)",
                             (concept_id, course_id, "unknown", now()))
                conn.execute("INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)",
                             (concept_id, name, "preferred", "syllabus"))
                card_id = uid("card_")
                conn.execute(
                    "INSERT INTO card(id,course_id,concept_id,front,back,image_path,source_page,source_text,"
                    "importance,origin,status,is_title,file_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (card_id, course_id, concept_id, name, "（考纲要求，释义待补）", None, pno, text,
                     5 if not is_heading else 4, args.doc_type, "active", 1 if is_heading else 0, fid, now()),
                )
                conn.execute("INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?)",
                             (card_id, "new", now()))
                syllabus_cards += 1
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM card WHERE course_id=?", (course_id,)).fetchone()[0]
        print(json.dumps({
            "ok": True, "kind": "syllabus", "created": syllabus_cards,
            "file_id": fid, "course_id": course_id, "total_cards": total,
        }, ensure_ascii=False))
        return

    # 2.3) 题库：按「题号 … 答案」切成一道道题
    if args.doc_type == "exam":
        exam_cards = 0
        q_start = re.compile(r"^[（(]?([0-9]{1,3})[）).．、]")
        ans_re = re.compile(r"(参考|正确)?答案[：:]\s*([A-Da-d对错√×]{1,4})")
        cur = None   # {"no":int,"page":int,"lines":[]}

        def flush():
            nonlocal exam_cards, cur
            if not cur:
                return
            body = "\n".join(cur["lines"]).strip()
            if len(body) < 8:
                cur = None
                return
            # 题干 = 第一行（去掉题号）；其余是选项/答案/解析
            first, _, rest = body.partition("\n")
            stem = re.sub(r"^[（(]?[0-9]{1,3}[）).．、]\s*", "", first).strip()
            if len(stem) < 4:
                stem = first[:60]
            m = ans_re.search(body)
            answer = m.group(2) if m else ""
            back = body if len(body) <= 400 else body[:400] + "…"
            if answer:
                back = f"答案：{answer}\n\n{back}"
            exists = conn.execute(
                "SELECT c.id FROM term t JOIN concept c ON c.id=t.concept_id "
                "WHERE t.text=? AND c.course_id=? AND t.kind='preferred'", (stem[:40], course_id)
            ).fetchone()
            if not exists:
                concept_id = uid("cp_")
                conn.execute("INSERT INTO concept(id,course_id,type,created_at) VALUES(?,?,?,?)",
                             (concept_id, course_id, "unknown", now()))
                conn.execute("INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)",
                             (concept_id, stem[:40], "preferred", "exam"))
                card_id = uid("card_")
                conn.execute(
                    "INSERT INTO card(id,course_id,concept_id,front,back,image_path,source_page,source_text,"
                    "importance,origin,status,is_title,file_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (card_id, course_id, concept_id, stem[:60], back, None, cur["page"], body[:400],
                     4, "exam", "active", 0, fid, now()),
                )
                conn.execute("INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?)",
                             (card_id, "new", now()))
                exam_cards += 1
            cur = None

        for pno in sorted(page_cache):
            for ln in page_cache[pno]:
                raw = (ln.get("text") or "").strip()
                if not raw:
                    continue
                # PDF 抽出来的字常有空格（"1 . 下列…"），比对前先压掉空白
                compact = re.sub(r"\s+", "", raw)
                if q_start.match(compact):
                    flush()
                    cur = {"no": 0, "page": pno, "lines": [compact]}
                elif cur:
                    cur["lines"].append(compact)
        flush()
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM card WHERE course_id=?", (course_id,)).fetchone()[0]
        print(json.dumps({
            "ok": True, "kind": "exam", "created": exam_cards,
            "file_id": fid, "course_id": course_id, "total_cards": total,
        }, ensure_ascii=False))
        return


    for pno, t in page_main_term.items():
        if not t or t in found:
            continue
        if not looks_like_term(t):
            continue
        found[t] = {"pages": {pno}, "color": 0x000000, "first_page": pno, "is_title": True}

    # 3) 概念 + 卡片
    print("[stage] cards", flush=True)
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
        img = page_images.get(first)
        is_title = 1 if info.get("is_title") else 0
        conn.execute(
            "INSERT INTO card(id,course_id,concept_id,front,back,image_path,source_page,source_text,"
            "importance,origin,status,is_title,file_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (card_id, course_id, concept_id, term, back, img, first, back,
             4 if is_title else star, "ppt", "active", is_title, fid, now()),
        )
        conn.execute("INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?)",
                     (card_id, "new", now()))
        created += 1

    print("[stage] relations", flush=True)
    # 4) 关系：从"X 包括/分为 A、B、C"这类句式抽包含关系
    rel_count = build_relations(conn, course_id, page_cache, page_main_term)

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM card WHERE course_id=?", (course_id,)).fetchone()[0]
    report = {
        "ok": True, "file": str(path), "pages": len(page_cache),
        "images": len(page_images),
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
