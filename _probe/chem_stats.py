import json
from pathlib import Path

d = json.loads(Path("_probe/chem_scan.json").read_text(encoding="utf-8"))

# 统计：例题、解答、内嵌选择题、课后题、解题要领
PAT = {
    "例题(例：)": lambda t: ("例：" in t) or ("例:" in t),
    "解答(解：)": lambda t: ("解：" in t) or ("解:" in t),
    "内嵌选择题": lambda t: ("单选题" in t) or ("多选题" in t),
    "解题要领": lambda t: "解题要领" in t,
    "课后/习题": lambda t: ("课后" in t) or ("习题" in t) or ("作业" in t),
    "思考题": lambda t: "思考" in t,
}
lines = []
grand = {k: 0 for k in PAT}
for key, r in d.items():
    det = r["detail"]
    cnt = {}
    for label, fn in PAT.items():
        pages = [p["p"] for p in det if fn(p["text"])]
        cnt[label] = pages
        grand[label] += len(pages)
    lines.append(f"### {key}  共 {r['pages']} 页，字符 {r['total_chars']}")
    for label, pages in cnt.items():
        lines.append(f"  {label}: {len(pages)} 页 {pages[:25]}")
    lines.append("")

lines.append("### 合计")
for k, v in grand.items():
    lines.append(f"  {k}: {v} 页")

# 页字符分布
lines.append("")
lines.append("### 每页字符数分布")
for key, r in d.items():
    cs = [p["chars"] for p in r["detail"]]
    cs_sorted = sorted(cs)
    lines.append(f"  {key}: min={cs_sorted[0]} 中位={cs_sorted[len(cs)//2]} max={cs_sorted[-1]}")

Path("_probe/chem_stats.txt").write_text("\n".join(lines), encoding="utf-8")
print("ok")
