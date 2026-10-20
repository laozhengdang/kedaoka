# 第三方组件与许可

本项目以 **AGPL-3.0** 发布（见 `LICENSE`）。之所以选 AGPL 而不是 MIT，是因为它**打包了 PyMuPDF**，
而 PyMuPDF 及其依赖 MuPDF 是 AGPL 协议 —— 分发的成品必须同样以 AGPL 提供源代码。

| 组件 | 用途 | 许可 | 是否随成品分发 |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | 桌面外壳（Chromium + Node） | MIT | 是（`build/.../` 里的 Chromium） |
| [PyMuPDF](https://pymupdf.readthedocs.io/) / [MuPDF](https://mupdf.com/) | 解析 PDF、抽文字与图 | **AGPL-3.0** | 是（`resources/app/runtime/python/`） |
| [Python 3.12 embeddable](https://www.python.org/) | 运行上面的解析脚本 | PSF License | 是 |
| Node.js 内置模块 `node:sqlite` | 数据库 | MIT（Node.js） | 是（随 Electron） |

## 我们自己的代码

`app/`、`tools/`、`docs/` 下的内容：AGPL-3.0。

## 不分发的东西

- **课程课件与卡片数据**（`data/`）：属于老师与本人，**不在仓库里**，也不随成品分发。
- **API Key**：只存在本机数据库的 `profile` 表，仓库里没有。

## 如果你要二次分发

你需要同时满足 AGPL-3.0：

1. 附上完整源代码（或提供下载地址）
2. 保留本文件与 `LICENSE`
3. 修改过的版本也要以 AGPL 发布

如果只是想自己用，不用管这些。
