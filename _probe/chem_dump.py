import json
from pathlib import Path

d = json.loads(Path("_probe/chem_scan.json").read_text(encoding="utf-8"))

picks = {
    "ch2_热力学": [20, 24, 25, 35],
    "ch4_动力学": [18, 19],
    "ch1_分散系": [23, 25],
}
lines = []
for key, pages in picks.items():
    for p in d[key]["detail"]:
        if p["p"] in pages:
            lines.append("=" * 70)
            lines.append(f"{key}  p{p}  chars={p['chars']} imgs={p['imgs']} draws={p['draws']} sup={p['sup']}")
            lines.append(f"fonts={p['fonts']} colors={p['colors']}")
            lines.append("-" * 70)
            lines.append(p["text"])
Path("_probe/chem_pages.txt").write_text("\n".join(lines), encoding="utf-8")
print("ok", len("\n".join(lines)))
