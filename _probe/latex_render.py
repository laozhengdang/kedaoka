"""验证：把识别出的公式写成 LaTeX，再用 matplotlib 渲染回图片。

目的：证明"识别 -> LaTeX -> 渲染"这条链在本机不需要装 TeX 也能跑通。
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

FORMULAS = [
    r"$x_{\mathrm{B}}=\dfrac{n_{\mathrm{B}}}{n_{\mathrm{A}}+n_{\mathrm{B}}}"
    r"\approx\dfrac{n_{\mathrm{B}}}{n_{\mathrm{A}}}"
    r"=\dfrac{n_{\mathrm{B}}}{m_{\mathrm{A}}/M_{\mathrm{A}}}"
    r"=b_{\mathrm{B}}M_{\mathrm{A}}$",
    r"$\Delta p=p^{*}\cdot x_{\mathrm{B}}=p^{*}\cdot M_{\mathrm{A}}\cdot b_{\mathrm{B}}$",
    r"$\Delta U=Q-p\Delta V=40.6\ \mathrm{kJ}-3.1\ \mathrm{kJ}=37.5\ \mathrm{kJ}$",
    r"$F=8.15>F_{0.05}(4,23)=2.80\ \Rightarrow\ \mathrm{reject}\ H_0$",
]

fig, axes = plt.subplots(len(FORMULAS), 1, figsize=(11, 1.2 * len(FORMULAS)))
for ax, f in zip(axes, FORMULAS):
    ax.axis("off")
    ax.text(0.02, 0.5, f, fontsize=20, va="center")
out = Path("_probe/latex_render.png")
fig.savefig(out, dpi=160, bbox_inches="tight", facecolor="white")
print("saved", out)
